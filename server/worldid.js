// World ID verification via the official SDK (@worldcoin/idkit-core).
//
//   real:  backend signs an RP context with `signRequest`, the browser builds an
//          IDKit request against the *sandbox* environment, World App produces a
//          proof, and the backend forwards it to the Developer Portal verify
//          endpoint. The RP-scoped nullifier is the worker's stable identity.
//   mock:  same request/verify shape, but proofs are HMACs minted by the local
//          mock World App page so the flow can be demoed without sandbox access.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { signRequest } from '@worldcoin/idkit-core/signing';

// One fixed action => same human, same nullifier, one balance. Register it in the Developer Portal with
// max verifications = unlimited (0). World keeps a nullifier registry per action, so a burned action name
// answers `nullifier_replayed` forever: pick a fresh WORLD_ACTION if that happens.
export const ACTION = process.env.WORLD_ACTION || 'rescue-robot';
const VERIFY_URL = (rpId) => `https://developer.world.org/api/v4/verify/${rpId}`;

// PROOF_MODE 'session' (default): World ID session proofs. The worker's first job creates a session
// (proof of human), later jobs prove the same session with a fresh proof. Repeatable by design and needs
// no portal action. 'uniqueness': one action-scoped proof per person, which World treats as one-time.
export const PROOF_MODE = process.env.WORLD_PROOF_MODE || 'session';

// Per-job actions: World ID 4.0 uniqueness proofs are one per person per action, so every job gets its own action
// (`<ACTION>-<jobId>`), registered on demand through the Developer Portal MCP. The nullifier is RP-scoped, so the same
// human keeps the same identity (and balance) across jobs.
const PORTAL_MCP = 'https://developer.world.org/api/mcp';
async function ensureAction({ appId, apiKey, action, environment }) {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_world_id_action', arguments: { app_id: appId, action, description: 'Robot rescue job ' + action, environment: environment === 'production' ? 'production' : 'staging' } } };
  const res = await fetch(PORTAL_MCP, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) });
  let text = await res.text(); const line = text.split('\n').find((l) => l.startsWith('data:')); if (line) text = line.replace(/^data:\s*/, '');
  const j = JSON.parse(text);
  if (j.error || j.result?.isError) throw new Error(`portal: ${JSON.stringify(j.error || j.result?.content?.[0]?.text).slice(0, 200)}`);
  return true;
}

export function createWorldId({ mode, appId, rpId, signingKey, environment = 'sandbox', publicUrl, db }) {
  const apiKey = process.env.WORLD_PORTAL_API_KEY;
  const perJobActions = mode === 'idkit' && PROOF_MODE !== 'session' && !!apiKey;
  const knownActions = new Set();
  async function actionForJob(jobId, attemptId) {
    if (!perJobActions) return ACTION;
    // per attempt, not per job: an approved-but-lost proof would otherwise make the job's action replay forever
    const action = `${ACTION}-${jobId}-${attemptId.slice(0, 6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`;
    if (!knownActions.has(action)) { await ensureAction({ appId, apiKey, action, environment }); knownActions.add(action); console.log(`[worldid] registered action ${action} (${environment})`); }
    return action;
  }
  const requests = new Map();  // requestId -> { jobId, sessionId, nonce, signal, status, result, createdAt }
  const usedNullifierNonces = new Set();
  const worldSessions = new Map(); // browser session id -> World ID session_id
  const mockSecret = randomBytes(32);

  function sweep() { const now = Date.now(); for (const [id, r] of requests) if (now - r.createdAt > 10 * 60_000) requests.delete(id); }

  // Step 1: a claimed job asks for a verification request bound to (session, job).
  async function createRequest({ jobId, sessionId }) {
    sweep();
    const id = randomBytes(12).toString('base64url');
    const signal = `${jobId}:${sessionId}:${id}`;   // proof is bound to this claim and this attempt
    const rec = { id, jobId, sessionId, signal, status: 'pending', result: null, createdAt: Date.now() };
    if (mode === 'idkit') {
      const session = PROOF_MODE === 'session';
      const known = session ? worldSessions.get(sessionId) : undefined;
      const action = session ? undefined : await actionForJob(jobId, id);
      const sig = signRequest({ ...(session ? {} : { action }), signingKeyHex: signingKey, ttl: 300 });
      rec.nonce = sig.nonce; rec.kind = session ? (known ? 'proveSession' : 'createSession') : 'request'; rec.worldSession = known; rec.action = action;
      requests.set(id, rec);
      console.log(`[worldid] request ${id}: ${rec.kind} app ${appId} rp ${rpId} ${session ? 'session ' + (known || 'new') : 'action ' + action} env ${environment} signal ${signal}`);
      return {
        mode, requestId: id, kind: rec.kind, session_id: known, app_id: appId, action, environment, signal,
        rp_context: { rp_id: rpId, nonce: sig.nonce, created_at: sig.createdAt, expires_at: sig.expiresAt, signature: sig.sig },
      };
    }
    rec.nonce = '0x' + randomBytes(32).toString('hex');
    requests.set(id, rec);
    return { mode, requestId: id, action: ACTION, environment, signal, connectorURI: `${publicUrl}/mock-world/connect?r=${id}` };
  }

  // Step 2 (mock only): the "World App" page reports what the human did.
  function mockComplete(id, outcome, personId) {
    const r = requests.get(id);
    if (!r || r.status !== 'pending') return null;
    if (outcome === 'cancel') { r.status = 'failed'; r.error = 'request_cancelled'; return r; }
    const nullifier = '0x' + createHmac('sha256', 'mock-nullifier').update(`${personId}:${ACTION}`).digest('hex');
    const proof = mockProof(r.nonce, nullifier, r.signal);
    r.result = {
      protocol_version: '4.0', nonce: r.nonce, action: ACTION, environment: 'sandbox',
      responses: [{ nullifier, proof: outcome === 'tamper' ? proof.replace(/.$/, (c) => (c === '0' ? '1' : '0')) : proof, signal: r.signal, verification_level: 'orb' }],
    };
    r.status = 'confirmed';
    return r;
  }
  function mockProof(nonce, nullifier, signal) { return createHmac('sha256', mockSecret).update(`${nonce}|${nullifier}|${signal}`).digest('hex'); }
  function mockStatus(id) { const r = requests.get(id); return r ? { status: r.status, result: r.result, error: r.error } : { status: 'unknown' }; }

  // Step 3: the browser hands the IDKit result to us; we never trust it until the portal (or the mock signer) confirms.
  async function verify({ requestId, sessionId, result }) {
    const r = requests.get(requestId);
    if (!r) return { ok: false, error: 'unknown or expired verification request' };
    if (r.sessionId !== sessionId) return { ok: false, jobId: r.jobId, error: 'request belongs to a different browser session' };
    const ctx = { jobId: r.jobId };
    if (!result || typeof result !== 'object') return { ok: false, ...ctx, error: 'no proof' };
    if (result.nonce !== r.nonce) return { ok: false, ...ctx, error: 'nonce mismatch (proof not issued for this request)' };
    const isSession = r.kind === 'createSession' || r.kind === 'proveSession';
    if (isSession) {
      if (!/^session_[0-9a-fA-F]+$/.test(result.session_id || '')) return { ok: false, ...ctx, error: 'expected a session proof' };
      if (r.kind === 'proveSession' && result.session_id !== r.worldSession) return { ok: false, ...ctx, error: 'proof is for a different World ID session' };
    } else if (result.action !== (r.action || ACTION)) return { ok: false, ...ctx, error: `unexpected action ${result.action}` };
    requests.delete(requestId); // single use

    let nullifier, level;
    if (mode === 'idkit') {
      let body;
      // Forward the IDKit result unchanged. WORLD_STRIP_INTEGRITY_BUNDLE=1 drops the optional device-attestation
      // bundle (only mandatory for Selfie Check) for sandbox builds whose attestation the portal cannot verify.
      const payload = process.env.WORLD_STRIP_INTEGRITY_BUNDLE === '1' ? (({ integrity_bundle, ...rest }) => rest)(result) : result;
      try {
        // Sandbox/staging proofs are only verified inside a staging window opened via the Developer Portal MCP
        // (set_world_id_staging_verification); the token it issues must accompany every verify call.
        const headers = { 'content-type': 'application/json' };
        if (process.env.WORLD_STAGING_VERIFICATION_TOKEN) headers['x-staging-verification-token'] = process.env.WORLD_STAGING_VERIFICATION_TOKEN;
        const res = await fetch(VERIFY_URL(rpId), { method: 'POST', headers, body: JSON.stringify(payload) });
        body = await res.json();
        console.log(`[worldid] portal verify -> ${res.status} ${body.success ? 'success' : body.code + (body.detail ? ' - ' + body.detail : '')}`,
          `| env ${result.environment} | proto ${result.protocol_version} | responses ${result.responses?.length} | bundle ${result.integrity_bundle ? 'v' + result.integrity_bundle.version + ' ' + result.integrity_bundle.signature_format : 'none'}${payload.integrity_bundle ? '' : ' (stripped)'}`);
      } catch (e) { return { ok: false, ...ctx, error: `Developer Portal unreachable: ${e.message}` }; }
      if (!body.success) {
        console.log('[worldid] portal response body:', JSON.stringify(body));
        console.log('[worldid] forwarded payload (proofs redacted):', JSON.stringify({ ...payload, responses: payload.responses?.map((x) => ({ ...x, proof: x.proof ? '<redacted>' : undefined })) }));
        const per = (body.results || []).map((x, i) => `#${i + 1} ${x.identifier || x.issuer_schema_id || ''} ${x.success ? 'ok' : (x.code || x.error || 'failed')}${x.detail ? ': ' + x.detail : ''}`).join('; ');
        return { ok: false, ...ctx, error: `Developer Portal rejected proof: ${body.code || 'unknown'}${body.detail ? ' - ' + body.detail : ''}${per ? ' [' + per + ']' : ''}` };
      }
      if (body.environment !== environment) return { ok: false, ...ctx, error: `proof came from ${body.environment}, expected ${environment}` };
      if (isSession) {
        if (body.session_id !== result.session_id) return { ok: false, ...ctx, error: 'portal session mismatch' };
        // Identity = the World ID session. Per-proof replay protection = session_nullifier[0].
        nullifier = body.session_id;
        const sn = result.responses?.[0]?.session_nullifier?.[0];
        if (sn) { if (usedNullifierNonces.has(sn) || !(await (db?.claimProof(sn) ?? true))) return { ok: false, ...ctx, error: 'session proof already consumed (replay)' }; usedNullifierNonces.add(sn); }
        worldSessions.set(sessionId, body.session_id);
      } else {
        if (body.action !== (r.action || ACTION)) return { ok: false, ...ctx, error: 'portal action mismatch' };
        nullifier = body.nullifier;
      }
      level = body.results?.[0]?.verification_level;
    } else {
      const item = result.responses?.[0];
      const expected = Buffer.from(mockProof(r.nonce, item?.nullifier || '', item?.signal || ''));
      const got = Buffer.from(String(item?.proof || ''));
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, ...ctx, error: 'proof signature invalid (tampered or forged)' };
      if (item.signal !== r.signal) return { ok: false, ...ctx, error: 'proof bound to a different claim' };
      nullifier = item.nullifier; level = item.verification_level;
    }
    const key = `${nullifier}:${r.nonce}`;
    if (usedNullifierNonces.has(key) || !(await (db?.claimProof(key) ?? true))) return { ok: false, ...ctx, error: 'proof already consumed (replay)' };
    usedNullifierNonces.add(key);
    return { ok: true, ...ctx, nullifier, verification_level: level };
  }

  function cancel(requestId, sessionId) { const r = requests.get(requestId); if (r && r.sessionId === sessionId) requests.delete(requestId); return r || null; }
  return { mode, createRequest, verify, cancel, mockComplete, mockStatus };
}
