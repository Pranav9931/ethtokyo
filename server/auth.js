// OIDC relying party for "Sign in with World ID" (sandbox by default).
// Authorization-code flow with PKCE; ID token verified against the issuer's JWKS.
// Every job claim triggers a *fresh* authentication: state + nonce are bound to (session, job).
import { randomBytes, createHash } from 'node:crypto';
import * as jose from 'jose';

export function createAuth({ issuer, clientId, clientSecret, redirectUri, discovery }) {
  const pending = new Map(); // state -> { sessionId, jobId, nonce, verifier, createdAt }
  let meta = null, jwks = null;

  async function metadata() {
    if (meta) return meta;
    if (discovery) meta = discovery;
    else {
      const r = await fetch(new URL('/.well-known/openid-configuration', issuer));
      if (!r.ok) throw new Error(`discovery failed: ${r.status}`);
      meta = await r.json();
    }
    jwks = jose.createRemoteJWKSet(new URL(meta.jwks_uri));
    return meta;
  }

  const b64url = (buf) => buf.toString('base64url');

  async function start({ sessionId, jobId }) {
    const m = await metadata();
    const state = b64url(randomBytes(24)), nonce = b64url(randomBytes(24)), verifier = b64url(randomBytes(32));
    pending.set(state, { sessionId, jobId, nonce, verifier, createdAt: Date.now() });
    const u = new URL(m.authorization_endpoint);
    u.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid',
      state, nonce, code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
      prompt: 'login', // force a fresh verification for every job
    }).toString();
    return { url: u.toString(), state };
  }

  // Returns { ok, sub, jobId, sessionId } or { ok:false, error, jobId?, sessionId? }.
  async function callback(query, sessionId) {
    const p = query.state ? pending.get(query.state) : null;
    if (p) pending.delete(query.state);
    if (!p) return { ok: false, error: 'unknown or reused state (possible forgery/replay)' };
    const ctx = { jobId: p.jobId, sessionId: p.sessionId };
    if (p.sessionId !== sessionId) return { ok: false, ...ctx, error: 'state belongs to a different browser session' };
    if (Date.now() - p.createdAt > 10 * 60_000) return { ok: false, ...ctx, error: 'authentication request expired' };
    if (query.error) return { ok: false, ...ctx, error: `provider returned ${query.error}${query.error_description ? ': ' + query.error_description : ''}` };
    if (!query.code) return { ok: false, ...ctx, error: 'no authorization code' };

    const m = await metadata();
    let tok;
    try {
      const r = await fetch(m.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64') },
        body: new URLSearchParams({ grant_type: 'authorization_code', code: query.code, redirect_uri: redirectUri, code_verifier: p.verifier, client_id: clientId }),
      });
      tok = await r.json();
      if (!r.ok || !tok.id_token) return { ok: false, ...ctx, error: `token exchange rejected: ${tok.error || r.status}` };
    } catch (e) { return { ok: false, ...ctx, error: `token endpoint unreachable: ${e.message}` }; }

    try {
      const { payload } = await jose.jwtVerify(tok.id_token, jwks, { issuer: m.issuer, audience: clientId, algorithms: ['RS256'] });
      if (payload.nonce !== p.nonce) return { ok: false, ...ctx, error: 'nonce mismatch (token not issued for this request)' };
      if (!payload.sub) return { ok: false, ...ctx, error: 'no sub in ID token' };
      return { ok: true, ...ctx, sub: payload.sub, acr: payload.acr, verification_level: payload['https://id.worldcoin.org/v1']?.verification_level };
    } catch (e) { return { ok: false, ...ctx, error: `ID token invalid: ${e.code || e.message}` }; }
  }

  function cancel(state) { const p = pending.get(state); pending.delete(state); return p; }
  return { start, callback, cancel, metadata };
}
