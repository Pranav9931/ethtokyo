// Walks every path against the running backend (mock World ID mode). Usage: node scripts/e2e.mjs
import WebSocket from 'ws';
const B = process.env.BASE || 'http://localhost:8787';
let cookie = '';
async function req(path, opts = {}) {
  const r = await fetch(B + path, { redirect: 'manual', ...opts, headers: { cookie, 'content-type': 'application/json', ...(opts.headers || {}) } });
  for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const [k] = kv.split('='); cookie = cookie.split('; ').filter(x => x && !x.startsWith(k + '=')).concat(kv).join('; '); }
  return r;
}
const state = async () => (await req('/api/state')).json();
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log('•', ...a);
const openJob = async () => (await state()).jobs.find(j => j.state !== 'done');

async function claimAndAct(jobId, outcome) {
  const c = await (await req(`/api/jobs/${jobId}/claim`, { method: 'POST' })).json();
  if (c.error) return { error: c.error };
  await req(`/mock-world/act?r=${c.request.requestId}&o=${outcome}`);       // the "phone"
  const st = await (await req(`/api/worldid/mock/status?r=${c.request.requestId}`)).json();
  if (st.status !== 'confirmed') { await req(`/api/jobs/${jobId}/cancel`, { method: 'POST' }); return { cancelled: st.error }; }
  const v = await req(`/api/jobs/${jobId}/verify`, { method: 'POST', body: JSON.stringify({ requestId: c.request.requestId, result: st.result }) });
  return { status: v.status, body: await v.json(), request: c.request, result: st.result };
}

await req('/api/scenario/reset', { method: 'POST' });
await wait(6000); let s = await state(); log('robot cycling:', s.robot.mode, s.robot.waypoint, '| jobs', s.jobs.length);

await req('/api/scenario/obstacle', { method: 'POST' });
const t0 = Date.now(); while (!(await openJob()) && Date.now() - t0 < 40000) await wait(500);
let job = await openJob(); log('stuck after', ((Date.now() - t0) / 1000).toFixed(1), 's ->', job.title);

let r = await claimAndAct(job.id, 'cancel'); log('cancel on phone ->', r.cancelled, '| job', (await openJob()).state, '| robot', (await state()).robot.mode);
r = await claimAndAct(job.id, 'tamper'); log('tampered proof ->', r.status, r.body.error, '| job', (await openJob()).state);
r = await (await req('/api/demo/forge', { method: 'POST', body: '{}' })).json(); log('forged proof ->', r.error);

const ws = new WebSocket(B.replace('http', 'ws') + '/ws', { headers: { cookie } });
await new Promise(res => ws.on('open', res));
const denied = new Promise(res => ws.on('message', d => { const m = JSON.parse(d); if (m.t === 'denied') res(m.msg); }));
ws.send(JSON.stringify({ t: 'ctrl', targets: [1, 0, 0] })); log('ctrl while unverified ->', await denied);

r = await claimAndAct(job.id, 'verify'); log('verify ->', r.status, r.body.job?.state, 'nullifier', r.body.job?.workerSub?.slice(0, 12), '| robot', (await state()).robot.mode);
const replay = await req(`/api/jobs/${job.id}/verify`, { method: 'POST', body: JSON.stringify({ requestId: r.request.requestId, result: r.result }) });
log('replayed proof ->', replay.status, (await replay.json()).error);
ws.send(JSON.stringify({ t: 'ctrl', targets: [-1.0, 0.2, 1.5] })); await wait(2500); log('teleop ctrl applied ->', JSON.stringify((await state()).robot.ctrl));
const act = async (a) => { const x = await req(`/api/jobs/${job.id}/action`, { method: 'POST', body: JSON.stringify({ action: a }) }); return x.status; };
log('complete before actions ->', (await req(`/api/jobs/${job.id}/complete`, { method: 'POST' })).status, '(expected 409)');
log('actions: retract', await act('retract')); await wait(3500); log('  pick_crate', await act('pick_crate')); await wait(4500); log('  drop_on_belt', await act('drop_on_belt')); await wait(8000); log('  blocker now:', (await state()).robot.resume);
r = await (await req(`/api/jobs/${job.id}/complete`, { method: 'POST' })).json(); log('complete -> state', r.job.state, '| robot', (await state()).robot.mode);
for (let i = 0; i < 40; i++) { await wait(1000); const j = (await state()).jobs.find(x => x.id === job.id); if (j.state === 'done') { log('agent verdict:', j.review.approved ? 'approved' : 'rejected', j.review.efficiency + '%', '| paid', j.paid, 'of', j.reward, '| source', j.review.source, '|', j.review.summary.slice(0, 90)); break; } }

await req('/api/scenario/person', { method: 'POST' }); while (!(await openJob())) await wait(500);
job = await openJob(); log('hazard job:', job.title);
r = await claimAndAct(job.id, 'verify');
await req(`/api/jobs/${job.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'retract' }) }); await req(`/api/jobs/${job.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'step_back' }) }); await wait(4500);
await req(`/api/jobs/${job.id}/action`, { method: 'POST', body: JSON.stringify({ action: 'confirm_clear' }) });
log('complete hazard ->', (await req(`/api/jobs/${job.id}/complete`, { method: 'POST' })).status);
for (let i = 0; i < 40; i++) { await wait(1000); const j = (await state()).jobs.find(x => x.id === job.id); if (j.state === 'done') { log('agent verdict:', j.review.approved ? 'approved' : 'rejected', j.review.efficiency + '%', '| paid', j.paid); break; } }
s = await state(); log('ledger (one identity, two jobs expected):', JSON.stringify(s.ledger), '| robot', s.robot.mode, 'personNear', s.robot.personNear);
ws.close(); process.exit(0);
