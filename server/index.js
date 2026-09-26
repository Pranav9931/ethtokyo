import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes, createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Sim, SCENE_DIR } from './sim.js';
import { Jobs, Ledger } from './jobs.js';
import { createAuth } from './auth.js';
import { createWorldId } from './worldid.js';
import { createMockWorldApp } from './mock-world.js';
import { createPayments } from './payments.js';
import { createDb } from './db.js';
import { createAgent } from './agent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +(process.env.PORT || 8787);
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
// ---------- World ID: official SDK (IDKit) against the sandbox, OIDC sign-in, or a local mock ----------
const MODE = process.env.WORLD_APP_ID && process.env.WORLD_RP_ID && process.env.WORLD_SIGNING_KEY ? 'idkit'
  : process.env.WORLD_CLIENT_ID ? 'oidc' : 'mock';

const app = express();
app.use(express.json());
app.use(cookieParser());

// ---------- persistence (Supabase Postgres when DATABASE_URL is set) ----------
let db;
try { db = await createDb(); } catch (e) { console.error('[db] connection failed, running in memory:', e.message); db = await createDb(null); }

let auth = null, worldId = null;
if (MODE === 'oidc') {
  auth = createAuth({
    issuer: process.env.WORLD_ISSUER || 'https://sandbox.auth.world.org',
    clientId: process.env.WORLD_CLIENT_ID, clientSecret: process.env.WORLD_CLIENT_SECRET,
    redirectUri: process.env.WORLD_REDIRECT_URI || `${PUBLIC_URL}/auth/callback`,
  });
} else {
  worldId = createWorldId({
    mode: MODE, appId: process.env.WORLD_APP_ID, rpId: process.env.WORLD_RP_ID, signingKey: process.env.WORLD_SIGNING_KEY,
    environment: process.env.WORLD_ENVIRONMENT || 'sandbox', publicUrl: PUBLIC_URL, db,
  });
  if (MODE === 'mock') app.use('/mock-world', createMockWorldApp(worldId));
}

// ---------- state ----------
const sim = await Sim.create();
const jobs = new Jobs(db);
const payments = createPayments();
const ledger = new Ledger(payments, db);
if (db.enabled) {
  const snap = await db.loadAll();
  jobs.hydrate(snap.jobs); ledger.hydrate(snap);
  console.log(`[db] loaded ${snap.workers.length} workers, ${snap.jobs.length} finished jobs, ${snap.payments.length} payments`);
}
ledger.on('change', () => broadcast({ t: 'jobs', jobs: jobs.list(), log: jobs.log, ledger: ledger.summary() }));
const sessions = new Map(); // sid -> { id, sub?, lastAuthAt?, lastError? }

// The worker's identity also travels in a signed cookie, so it survives server restarts (sessions are in memory).
const SESSION_SECRET = process.env.SESSION_SECRET || createHmac('sha256', 'robot-rescue').update(process.env.AGENT_TOKEN || process.env.WORLD_SIGNING_KEY || 'dev').digest('hex');
const signIdentity = (id) => `${id}.${createHmac('sha256', SESSION_SECRET).update(id).digest('base64url')}`;
function readIdentity(cookie) { if (!cookie) return null; const i = cookie.lastIndexOf('.'); if (i < 0) return null; const id = cookie.slice(0, i); return signIdentity(id) === cookie ? id : null; }
function rememberIdentity(res, id) { res?.cookie('wid', signIdentity(id), { httpOnly: true, sameSite: 'lax', maxAge: 180 * 24 * 3600 * 1000 }); }
function session(req, res) {
  let sid = req.cookies.sid;
  if (!sid || !sessions.has(sid)) {
    if (!sid) { sid = randomBytes(18).toString('base64url'); res?.cookie('sid', sid, { httpOnly: true, sameSite: 'lax' }); }
    sessions.set(sid, { id: sid, sub: readIdentity(req.cookies.wid) || undefined });
  }
  return sessions.get(sid);
}

// ---------- robot events -> jobs ----------
// ---------- the robot's agent: writes the job when stuck, reviews the work when done ----------
const agent = createAgent();
let authoring = false;
sim.on('stuck', async (info) => {
  if (jobs.current() || authoring) return; // one open job per stuck event
  authoring = true;
  const st = sim.status();
  broadcast({ t: 'toast', level: 'warn', msg: `Robot stuck (${info.reason}). Its agent is assessing the situation…` });
  broadcast({ t: 'agent', phase: 'authoring' });
  const situation = {
    reason: info.reason, template: info,
    telemetry: { time_s: st.time, stuck_reason: info.reason, person_near: st.personNear, obstacle_in_path: st.obstacleInPath, target_displaced: st.targetDisplaced, contacts: st.ncon, last_routine_step: st.waypoint, joint_positions_rad: st.qpos },
    actions: st.actions.map(({ id, label, desc }) => ({ id, label, desc })), resumeCondition: st.resume || 'safe to resume',
  };
  try {
    const spec = await agent.authorJob(situation);
    const job = jobs.post({ reason: info.reason, title: spec.title, detail: spec.brief, urgency: spec.urgency, reward: spec.reward_wld, steps: spec.steps, acceptance: spec.acceptance,
      agent: { source: spec.source, model: spec.source === 'fallback' ? null : spec.source, reasoning: spec.reasoning, authoredAt: Date.now() }, context: situation.telemetry });
    broadcast({ t: 'toast', level: 'warn', msg: `Job ${job.id} posted by the agent: ${job.title} (${job.reward} WLD).` });
  } finally { authoring = false; broadcast({ t: 'agent', phase: 'idle' }); }
});
sim.on('status', () => broadcast({ t: 'robot', robot: sim.status() }));
jobs.on('change', () => broadcast({ t: 'jobs', jobs: jobs.list(), log: jobs.log, ledger: ledger.summary() }));

// ---------- HTTP API ----------
app.get('/api/me', (req, res) => {
  const s = session(req, res);
  res.json({ sessionId: s.id, sub: s.sub || null, balance: s.sub ? ledger.balance(s.sub) : 0, payoutAddress: s.sub ? ledger.address(s.sub) : null, lastError: s.lastError || null, mode: MODE, environment: MODE === 'idkit' ? (process.env.WORLD_ENVIRONMENT || 'sandbox') : null, payments: payments.info(), agent: agent.info() });
});
// The verified human tells us where to send WLD. Stored against their World ID identity, so it persists across jobs;
// any payout that was waiting for a wallet is sent right away.
app.post('/api/me/payout-address', (req, res) => {
  const s = session(req, res);
  if (!s.sub) return res.status(401).json({ error: 'verify with World ID first' });
  const address = String(req.body.address || '').trim();
  if (!payments.isAddress(address)) return res.status(400).json({ error: 'not a valid 0x address' });
  ledger.setAddress(s.sub, address);
  res.json({ ok: true, payoutAddress: address });
});
app.get('/api/payments', async (_req, res) => {
  try { res.json({ ...payments.info(), balances: await payments.balances() }); }
  catch (e) { res.json({ ...payments.info(), error: e.shortMessage || e.message }); }
});
app.post('/api/payments/:id/retry', (req, res) => res.json({ ok: !!ledger.retry(+req.params.id) }));
app.get('/api/state', (req, res) => res.json({ robot: sim.status(), jobs: jobs.list(), log: jobs.log, ledger: ledger.summary() }));

// Step 3: a human accepts a job -> fresh World ID authentication starts.
app.post('/api/jobs/:id/claim', async (req, res) => {
  const s = session(req, res);
  const job = jobs.claim(req.params.id, s.id);
  if (!job) return res.status(409).json({ error: 'job is not open' });
  s.lastError = null;
  if (MODE === 'oidc') { const { url } = await auth.start({ sessionId: s.id, jobId: job.id }); return res.json({ job, mode: 'redirect', authUrl: url }); }
  try { res.json({ job, mode: MODE, request: await worldId.createRequest({ jobId: job.id, sessionId: s.id }) }); }
  catch (e) { jobs.release(job.id, `could not start verification: ${e.message}`); res.status(502).json({ error: `could not start verification: ${e.message}` }); }
});

// IDKit path: the browser polled World App (or the mock) and hands us the proof. We verify it, then unlock.
app.post('/api/jobs/:id/verify', async (req, res) => {
  const s = session(req, res);
  if (!worldId) return res.status(400).json({ error: 'not in IDKit mode' });
  const r = await worldId.verify({ requestId: req.body.requestId, sessionId: s.id, result: req.body.result });
  if (!r.ok) {
    s.lastError = r.error;
    if (r.jobId) { jobs.release(r.jobId, r.error); sim.releaseToPool(); }
    broadcast({ t: 'toast', level: 'error', msg: `Verification failed: ${r.error}` });
    return res.status(401).json({ error: r.error });
  }
  const identity = s.sub ? ledger.link(r.nullifier, s.sub) : ledger.canonical(r.nullifier);
  const job = jobs.activate(r.jobId, s.id, identity);
  if (!job) { s.lastError = 'claim expired or was taken back'; return res.status(409).json({ error: s.lastError }); }
  s.sub = identity; s.lastAuthAt = Date.now(); rememberIdentity(res, identity);
  sim.beginTeleop();
  broadcast({ t: 'toast', level: 'ok', msg: `Job ${job.id}: verified human ${r.nullifier.slice(0, 10)}… now in control.` });
  res.json({ job });
});
app.get('/api/worldid/mock/status', (req, res) => res.json(worldId?.mockStatus(String(req.query.r || '')) || { status: 'unknown' }));

app.get('/auth/callback', async (req, res) => {
  const s = session(req, res);
  if (!auth) return res.redirect('/');
  const r = await auth.callback(req.query, s.id);
  if (!r.ok) {
    s.lastError = r.error;
    if (r.jobId) { jobs.release(r.jobId, r.error); sim.releaseToPool(); }
    broadcast({ t: 'toast', level: 'error', msg: `Verification failed: ${r.error}` });
    return res.redirect(`/#/job/${r.jobId || ''}?auth=failed`);
  }
  const job = jobs.activate(r.jobId, s.id, r.sub);
  if (!job) { s.lastError = 'claim expired or was taken back'; return res.redirect(`/#/job/${r.jobId}?auth=expired`); }
  s.sub = r.sub; s.lastAuthAt = Date.now();
  sim.beginTeleop();
  broadcast({ t: 'toast', level: 'ok', msg: `Job ${job.id}: verified human ${r.sub.slice(0, 10)}… now in control.` });
  res.redirect(`/#/job/${job.id}`);
});

// Step 4b: the human gives up on verification => job returns to the pool, robot stays paused.
app.post('/api/jobs/:id/cancel', (req, res) => {
  const s = session(req, res);
  const job = jobs.get(req.params.id);
  if (!job || job.claimedBy !== s.id) return res.status(403).json({ error: 'not your claim' });
  jobs.release(job.id, 'cancelled by the worker'); sim.releaseToPool();
  res.json({ job });
});

// Step 4c: the verified human performs one of the job's actions (retract, ask person to step back, detour, ...).
app.post('/api/jobs/:id/action', (req, res) => {
  const s = session(req, res);
  const job = jobs.get(req.params.id);
  if (!job || job.state !== 'active' || job.claimedBy !== s.id) return res.status(403).json({ error: 'job is not active for this session' });
  const err = sim.humanAction(String(req.body.action || ''));
  if (err) return res.status(409).json({ error: err });
  jobs.track(job.id, 'actions', { action: req.body.action, at_s: +((Date.now() - job.activatedAt) / 1000).toFixed(1) });
  jobs.note(job, `human action: ${req.body.action}`);
  res.json({ ok: true, robot: sim.status() });
});

// Step 5: done => resume robot, pay the sub. Refused until the job's resume condition holds.
app.post('/api/jobs/:id/complete', async (req, res) => {
  const s = session(req, res);
  const cur = jobs.get(req.params.id);
  if (!cur || cur.state !== 'active' || cur.claimedBy !== s.id) return res.status(403).json({ error: 'job is not active for this session' });
  const preBlocker = sim.resumeCheck();
  if (preBlocker) { jobs.track(cur.id, 'premature_complete_attempts'); return res.status(409).json({ error: `Not safe to resume yet: ${preBlocker}` }); }
  const finalStatus = sim.status();
  sim.endTeleop();                                   // robot goes back to work now; payment waits for the agent's verdict
  const job = jobs.submit(cur.id, s.id);
  res.json({ job });
  broadcast({ t: 'toast', level: 'ok', msg: `Job ${job.id} submitted. Robot resuming; the agent is verifying the work.` });
  const telemetry = {
    ...job.telemetry, seconds_in_control: +((job.doneAt - job.activatedAt) / 1000).toFixed(1),
    final_state: { person_near: finalStatus.personNear, obstacle_in_path: finalStatus.obstacleInPath, target_displaced: finalStatus.targetDisplaced, actions_done: finalStatus.actionsDone },
    resume_blocker: finalStatus.resume,
  };
  const review = await agent.reviewJob(job, telemetry);
  const paid = review.approved ? +(job.reward * review.payout_fraction).toFixed(4) : 0;
  jobs.finish(job.id, review, paid);
  if (paid > 0) {
    const payment = ledger.pay(job.workerSub, paid, job.id);
    const how = payment.status === 'simulated' ? 'credited (simulated)' : payment.status === 'pending_address' ? 'queued until a payout wallet is set' : 'being sent on World Chain';
    broadcast({ t: 'toast', level: 'ok', msg: `Job ${job.id} approved at ${review.efficiency}%: ${paid} WLD ${how}.` });
  } else broadcast({ t: 'toast', level: 'error', msg: `Job ${job.id} rejected by the agent: ${review.summary}` });
});

// ---------- phone pairing: the verified session hands its controls to the controller app ----------
// Desktop (session with the active job) mints a 6-digit code; the phone redeems it within 5 minutes and receives the
// same session cookie, so its sticks are accepted by the same claim check as the desktop's sliders.
const pairCodes = new Map(); // code -> { sessionId, jobId, expiresAt }
app.post('/api/pair/code', (req, res) => {
  const s = session(req, res);
  const job = jobs.current();
  if (!job || job.claimedBy !== s.id || !['claimed', 'active'].includes(job.state)) return res.status(403).json({ error: 'claim a job first, then pair' });
  for (const [c, v] of pairCodes) if (v.sessionId === s.id || v.expiresAt < Date.now()) pairCodes.delete(c);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  pairCodes.set(code, { sessionId: s.id, jobId: job.id, expiresAt: Date.now() + 5 * 60_000 });
  res.json({ code, expiresAt: Date.now() + 5 * 60_000, url: `${PUBLIC_URL}/controller.html?pair=${code}` });
});
app.post('/api/pair/redeem', (req, res) => {
  const code = String(req.body.code || '').replace(/\D/g, '');
  const v = pairCodes.get(code);
  if (!v || v.expiresAt < Date.now()) return res.status(404).json({ error: 'invalid or expired pairing code' });
  pairCodes.delete(code);
  res.cookie('sid', v.sessionId, { httpOnly: true, sameSite: 'lax' });
  const owner = sessions.get(v.sessionId); if (owner?.sub) rememberIdentity(res, owner.sub);
  broadcast({ t: 'toast', level: 'ok', msg: `A controller paired to job ${v.jobId}.` });
  res.json({ ok: true, jobId: v.jobId });
});
app.get('/api/robot', (_req, res) => res.json({ name: 'Unitree G1', host: PUBLIC_URL, robot: sim.status(), job: jobs.current() }));

// ---------- external agent API (bearer AGENT_TOKEN): the robot's agent picks up tasks and posts decisions ----------
function agentAuth(req, res, next) {
  const tok = process.env.AGENT_TOKEN;
  if (!tok) return res.status(503).json({ error: 'AGENT_TOKEN not configured' });
  if ((req.headers.authorization || '') !== `Bearer ${tok}`) return res.status(401).json({ error: 'bad agent token' });
  agent.heartbeat(req.headers['x-agent-name']);
  next();
}
app.post('/api/admin/link-identity', agentAuth, (req, res) => { const c = ledger.link(String(req.body.nullifier || ''), String(req.body.canonical || '')); res.json({ ok: true, canonical: c, address: ledger.address(c) }); });
app.get('/api/agent/tasks', agentAuth, (_req, res) => res.json({ mode: agent.info().mode, tasks: agent.pendingTasks(), robot: sim.status() }));
app.post('/api/agent/tasks/:id', agentAuth, (req, res) => {
  const r = agent.resolveTask(req.params.id, req.body);
  if (!r.ok) return res.status(400).json(r);
  broadcast({ t: 'toast', level: 'ok', msg: `Agent (${agent.info().model}) answered ${req.params.id.split('-')[0]} task.` });
  res.json(r);
});
app.post('/api/agent/hello', agentAuth, (req, res) => { broadcast({ t: 'jobs', jobs: jobs.list(), log: jobs.log, ledger: ledger.summary() }); res.json({ ok: true, name: agent.info().model, pending: agent.pendingTasks().length }); });

// Demo failure path: a client posts a forged/tampered callback straight to the backend.
app.post('/api/demo/forge', async (req, res) => {
  const s = session(req, res);
  const r = auth ? await auth.callback({ code: 'forged-code', state: 'forged-state' }, s.id)
    : await worldId.verify({ requestId: 'forged', sessionId: s.id, result: { nonce: '0x00', action: 'rescue-robot', responses: [{ nullifier: '0xdeadbeef', proof: 'ff' }] } });
  res.status(401).json({ rejected: true, error: r.error });
});

// Scenario controls (the "world" acting on the robot). Open in a demo; lock behind a token in real life.
app.post('/api/scenario/:name', (req, res) => {
  const map = { obstacle: () => sim.spawnObstacle(), person: () => sim.personEnter(), knock: () => sim.knockTarget(), reset: () => { sim.reset(); jobs.clear(); } };
  if (!map[req.params.name]) return res.status(404).end();
  map[req.params.name]();
  res.json({ ok: true });
});

// robot meshes for the viewer
app.use('/scenes/unitree_g1/assets', express.static(path.join(SCENE_DIR, 'assets'), { maxAge: '1d', immutable: true }));
app.use('/scenes/people', express.static(path.join(SCENE_DIR, '..', 'people'), { maxAge: '1d', immutable: true }));

// ---------- static (production) ----------
const dist = path.join(__dirname, '..', 'dist');
if (fs.existsSync(dist)) { app.use(express.static(dist)); app.get('/{*any}', (_, res) => res.sendFile(path.join(dist, 'index.html'))); }

// ---------- WebSocket: state stream + teleop input ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();
function broadcast(msg) { const s = JSON.stringify(msg); for (const c of clients) if (c.readyState === 1) c.send(s); }

wss.on('connection', (ws, req) => {
  const cookies = parseCookies(req.headers.cookie || '');
  ws.sessionId = cookies.sid;
  clients.add(ws);
  ws.send(JSON.stringify({ t: 'init', ...sim.describe(), robot: sim.status(), jobs: jobs.list(), log: jobs.log, ledger: ledger.summary() }));
  ws.on('close', () => clients.delete(ws));
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.t === 'ctrl') {
      // Control only flows if this socket's session holds the *active* (verified) job.
      const job = jobs.current();
      if (!job || job.state !== 'active' || job.claimedBy !== ws.sessionId) return ws.send(JSON.stringify({ t: 'denied', msg: 'control locked: no verified claim for this session' }));
      sim.setTeleop(m.targets); jobs.track(job.id, 'ctrl_messages');
    } else if (m.t === 'voice') {
      // Operator's microphone: audio chunks are relayed to every other client (the robot's "speaker"),
      // transcripts are shown over the robot, logged to the job, and the person in the cell reacts to them.
      const job = jobs.current();
      if (!job || job.state !== 'active' || job.claimedBy !== ws.sessionId) return ws.send(JSON.stringify({ t: 'denied', msg: 'microphone locked: no verified claim for this session' }));
      if (m.kind === 'start' || m.kind === 'audio' || m.kind === 'stop') { const s = JSON.stringify({ t: 'robot_voice', kind: m.kind, data: m.data, mime: m.mime, seq: m.seq }); for (const c of clients) if (c !== ws && c.readyState === 1) c.send(s); }
      if (m.kind === 'transcript') {
        const text = String(m.text || '').slice(0, 300);
        broadcast({ t: 'robot_voice', kind: 'transcript', text, final: !!m.final, at: Date.now() });
        if (m.final && text.trim()) {
          jobs.track(job.id, 'actions', { action: 'speak', text, at_s: +((Date.now() - job.activatedAt) / 1000).toFixed(1) });
          jobs.note(job, `robot said: "${text}"`);
          if (job.reason === 'hazard' && sim.stuckReason === 'hazard') { const left = sim.personHeard(); if (left) broadcast({ t: 'toast', level: 'ok', msg: 'The person heard the robot and is leaving the cell.' }); }
        }
      }
    } else if (m.t === 'drag') {
      const job = jobs.current();
      if (!job || job.state !== 'active' || job.claimedBy !== ws.sessionId) return;
      if (m.body != null) jobs.track(job.id, 'drag_events');
      sim.setDrag(m.body == null ? null : Number(m.body), Array.isArray(m.target) ? m.target : [0, 0, 0]);
    }
  });
});

// ---------- main loop ----------
let last = process.hrtime.bigint();
setInterval(() => {
  const now = process.hrtime.bigint();
  const dt = Math.min(Number(now - last) / 1e9, 0.1); last = now;
  sim.advance(dt);
  for (const j of jobs.sweepExpired()) { sim.releaseToPool(); broadcast({ t: 'toast', level: 'warn', msg: `Job ${j.id} verification expired; back in the pool.` }); }
}, 1000 / 60);
setInterval(() => broadcast({ t: 'state', time: +sim.data.time.toFixed(3), poses: sim.poses(), robot: sim.status() }), 1000 / 30);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[server] port ${PORT} is already in use: another Robot Rescue backend is running (for example the agent session).\n[server] Open ${PUBLIC_URL} in your browser instead of starting a second one, or stop it with: lsof -ti :${PORT} | xargs kill\n`);
    process.exit(0);
  }
  throw e;
});
process.on('uncaughtException', (e) => { console.error('[server] uncaught exception (kept running):', e?.stack || e); });
process.on('unhandledRejection', (e) => { console.error('[server] unhandled rejection (kept running):', e?.stack || e); });
server.listen(PORT, () => {
  console.log(`robot server on ${PUBLIC_URL}  (World ID mode: ${MODE}${MODE === 'idkit' ? ', env ' + (process.env.WORLD_ENVIRONMENT || 'sandbox') : ''}; payouts ${payments.info().enabled ? 'LIVE on ' + payments.info().chain : 'simulated'}; db ${db.enabled ? 'postgres' : 'memory'}; agent ${agent.info().model})`);
});

// ---------- tiny helpers ----------
function parseCookies(str) { return Object.fromEntries(str.split(';').map(s => s.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
function cookieParser() { return (req, _res, next) => { req.cookies = parseCookies(req.headers.cookie || ''); next(); }; }
