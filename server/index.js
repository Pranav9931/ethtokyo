import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { Sim } from './sim.js';
import { Jobs, Ledger } from './jobs.js';
import { createAuth } from './auth.js';
import { createWorldId } from './worldid.js';
import { createMockWorldApp } from './mock-world.js';
import { createPayments } from './payments.js';
import { createDb } from './db.js';

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

function session(req, res) {
  let sid = req.cookies.sid;
  if (!sid || !sessions.has(sid)) {
    sid = randomBytes(18).toString('base64url');
    sessions.set(sid, { id: sid });
    res?.cookie('sid', sid, { httpOnly: true, sameSite: 'lax' });
  }
  return sessions.get(sid);
}

// ---------- robot events -> jobs ----------
sim.on('stuck', (info) => {
  if (jobs.current()) return; // one open job per stuck event
  const job = jobs.post(info);
  broadcast({ t: 'toast', level: 'warn', msg: `Robot stuck: ${job.title}. Job ${job.id} posted (${job.reward} WLD).` });
});
sim.on('status', () => broadcast({ t: 'robot', robot: sim.status() }));
jobs.on('change', () => broadcast({ t: 'jobs', jobs: jobs.list(), log: jobs.log, ledger: ledger.summary() }));

// ---------- HTTP API ----------
app.get('/api/me', (req, res) => {
  const s = session(req, res);
  res.json({ sessionId: s.id, sub: s.sub || null, balance: s.sub ? ledger.balance(s.sub) : 0, payoutAddress: s.sub ? ledger.address(s.sub) : null, lastError: s.lastError || null, mode: MODE, environment: MODE === 'idkit' ? (process.env.WORLD_ENVIRONMENT || 'sandbox') : null, payments: payments.info() });
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
  const job = jobs.activate(r.jobId, s.id, r.nullifier);
  if (!job) { s.lastError = 'claim expired or was taken back'; return res.status(409).json({ error: s.lastError }); }
  s.sub = r.nullifier; s.lastAuthAt = Date.now();
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
  jobs.note(job, `human action: ${req.body.action}`);
  res.json({ ok: true, robot: sim.status() });
});

// Step 5: done => resume robot, pay the sub. Refused until the job's resume condition holds.
app.post('/api/jobs/:id/complete', (req, res) => {
  const s = session(req, res);
  const cur = jobs.get(req.params.id);
  if (!cur || cur.state !== 'active' || cur.claimedBy !== s.id) return res.status(403).json({ error: 'job is not active for this session' });
  const blocker = sim.endTeleop();
  if (blocker) return res.status(409).json({ error: `Not safe to resume yet: ${blocker}` });
  const job = jobs.complete(req.params.id, s.id);
  const payment = ledger.pay(job.workerSub, job.reward, job.id);
  jobs.emit('change', job);
  const how = payment.status === 'simulated' ? 'credited (simulated: no treasury configured)' : payment.status === 'pending_address' ? 'queued until you set a payout wallet' : 'being sent on World Chain';
  broadcast({ t: 'toast', level: 'ok', msg: `Job ${job.id} complete. ${job.reward} WLD ${how}. Robot resuming.` });
  res.json({ job, payment, balance: ledger.balance(job.workerSub) });
});

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
      sim.setTeleop(m.targets);
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

server.listen(PORT, () => {
  console.log(`robot server on ${PUBLIC_URL}  (World ID mode: ${MODE}${MODE === 'idkit' ? ', env ' + (process.env.WORLD_ENVIRONMENT || 'sandbox') : ''}; payouts ${payments.info().enabled ? 'LIVE on ' + payments.info().chain : 'simulated'}; db ${db.enabled ? 'postgres' : 'memory'})`);
});

// ---------- tiny helpers ----------
function parseCookies(str) { return Object.fromEntries(str.split(';').map(s => s.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }
function cookieParser() { return (req, _res, next) => { req.cookies = parseCookies(req.headers.cookie || ''); next(); }; }
