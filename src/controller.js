// Robot Rescue Controller: the phone app. Connect (pair with a verified session, or run solo), then drive the
// robot from a cockpit: dual sticks over four joints of the selected limb, shoulder buttons to switch limbs and
// joint pages, A/B/X for the job's actions, Y keyframe, HOLD to freeze, START to submit.
import QRCode from 'qrcode';
import { createViewer } from './viewer.js';
import { createTalker, createSpeaker, createBubble } from './voice.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };
function toast(msg, level = 'info') { const el = document.createElement('div'); el.className = `toast ${level}`; el.textContent = msg; $('#toasts').appendChild(el); setTimeout(() => el.remove(), 5000); }
async function api(path, opts = {}) { const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts }); const b = await r.json().catch(() => ({})); if (!r.ok) throw new Error(b.error || r.statusText); return b; }

const viewer = createViewer($('#view'));
// Always landscape: when the phone is upright, rotate the whole app with CSS and render the 3D view at swapped dimensions.
const portraitQ = matchMedia('(orientation: portrait)');
function applyOrientation() {
  // measured viewport, so the rotated app is exactly screen-sized (100vh/100vw overflow on phones)
  const vw = window.visualViewport?.width || innerWidth, vh = window.visualViewport?.height || innerHeight;
  document.documentElement.style.setProperty('--vw', `${Math.round(vw)}px`); document.documentElement.style.setProperty('--vh', `${Math.round(vh)}px`);
  window.scrollTo(0, 0);
  const upright = vh > vw;
  document.body.classList.toggle('force-landscape', upright);
  viewer.setSize(upright ? vh : vw, upright ? vw : vh);
}
portraitQ.addEventListener?.('change', applyOrientation); addEventListener('resize', applyOrientation); window.visualViewport?.addEventListener('resize', applyOrientation); addEventListener('orientationchange', () => setTimeout(applyOrientation, 150)); applyOrientation();
const state = { me: null, robot: null, jobs: [], actuators: [], limbs: [], job: null, linked: false };
const ctl = { limb: 4, page: 0, sticks: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } }, rate: 1.4, targets: [], dirty: false, hold: false, kf: [] };
let ws;

// ---------- connect ----------
async function probeRobot() {
  try {
    const r = await api('/api/robot');
    $('#robot-name').textContent = r.name; $('#robot-host').textContent = location.host; $('#robot-dot').classList.add('on');
    $('#robot-state').textContent = `${r.robot.mode}${r.job ? ' · job: ' + r.job.title : ''}`;
  } catch { $('#robot-host').textContent = 'robot unreachable'; $('#robot-dot').classList.remove('on'); }
}
async function pair(code) {
  try { const r = await api('/api/pair/redeem', { method: 'POST', body: JSON.stringify({ code }) }); buzz(30); toast(`Paired to job ${r.jobId}`, 'ok'); await enterCockpit(r.jobId); }
  catch (e) { $('#connect-msg').textContent = e.message; buzz(60); }
}
$('#pair-btn').onclick = () => pair($('#pair-code').value);
$('#pair-code').addEventListener('input', (ev) => { if (ev.target.value.replace(/\D/g, '').length === 6) pair(ev.target.value); });
$('#solo-btn').onclick = () => enterCockpit(null);
$('#scan-btn').onclick = async () => {
  if (!('BarcodeDetector' in window)) return ($('#connect-msg').textContent = 'QR scanning is not supported in this browser: type the code instead.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const video = Object.assign(document.createElement('video'), { srcObject: stream, playsInline: true, muted: true });
    Object.assign(video.style, { position: 'fixed', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 50 });
    document.body.appendChild(video); await video.play();
    const det = new BarcodeDetector({ formats: ['qr_code'] });
    const stop = () => { stream.getTracks().forEach((t) => t.stop()); video.remove(); };
    video.onclick = stop;
    const tick = async () => { if (!video.isConnected) return; try { const codes = await det.detect(video); const m = codes[0]?.rawValue?.match(/pair=(\d{6})/); if (m) { stop(); return pair(m[1]); } } catch {} setTimeout(tick, 250); };
    tick();
  } catch (e) { $('#connect-msg').textContent = 'Camera unavailable: ' + e.message; }
};
const urlPair = new URLSearchParams(location.search).get('pair');
probeRobot();
if (urlPair) { $('#pair-code').value = urlPair; pair(urlPair); }

// ---------- cockpit ----------
async function enterCockpit(jobId) {
  $('#connect').hidden = true; $('#cockpit').hidden = false; document.body.classList.add('cockpit');
  try { await document.documentElement.requestFullscreen?.(); } catch {}
  try { await screen.orientation?.lock?.('landscape'); } catch {}
  state.me = await api('/api/me');
  if (jobId) state.pinnedJob = jobId;
  connect();
  requestAnimationFrame(loop);
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => { state.linked = true; $('#tele-link').classList.remove('off'); };
  ws.onclose = () => { state.linked = false; $('#tele-link').classList.add('off'); setTimeout(connect, 1000); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'init') { viewer.setGeoms(m); state.actuators = m.actuators; state.limbs = m.limbs || []; Object.assign(state, { robot: m.robot, jobs: m.jobs }); renderAll(); }
    else if (m.t === 'state') { viewer.setPoses(m.poses); viewer.setPerson(m.robot.person); state.robot = m.robot; renderHud(); }
    else if (m.t === 'robot_voice') { if (m.kind === 'transcript') bubble.show(m.text, m.final); else if (!talker.active) speaker.handle(m); }
    else if (m.t === 'robot') { state.robot = m.robot; renderAll(); }
    else if (m.t === 'jobs') { state.jobs = m.jobs; api('/api/me').then((me) => { state.me = me; renderAll(); }); }
    else if (m.t === 'toast') toast(m.msg, m.level);
    else if (m.t === 'denied') toast(m.msg, 'error');
  };
}
function currentJob() {
  const mine = state.jobs.find((j) => j.claimedBy === state.me?.sessionId && ['claimed', 'active', 'reviewing'].includes(j.state));
  return mine || state.jobs.find((j) => j.id === state.pinnedJob) || state.jobs.find((j) => j.state !== 'done') || state.jobs[0] || null;
}
function inControl() { const j = currentJob(); return !!(j && j.state === 'active' && j.claimedBy === state.me?.sessionId && state.robot?.mode === 'teleop'); }
function limbJoints() { const key = state.limbs[ctl.limb]?.key; return state.actuators.map((a, i) => ({ ...a, i })).filter((a) => a.limb === key); }
function axes() { const js = limbJoints(), o = ctl.page * 4; return { Lx: js[o], Ly: js[o + 1], Rx: js[o + 2], Ry: js[o + 3] }; }

// ---------- control loop: sticks -> targets at 30 Hz ----------
let last = 0, lastSend = 0;
function loop(now) {
  const dt = Math.min(0.05, (now - (last || now)) / 1000); last = now;
  if (inControl() && !ctl.hold) {
    const ax = axes();
    const apply = (j, v) => { if (!j || Math.abs(v) < 0.08) return; const cur = ctl.targets[j.i] ?? state.robot.ctrl[j.i]; ctl.targets[j.i] = Math.min(j.range[1], Math.max(j.range[0], cur + v * ctl.rate * dt)); ctl.dirty = true; };
    apply(ax.Lx, ctl.sticks.L.x); apply(ax.Ly, -ctl.sticks.L.y); apply(ax.Rx, ctl.sticks.R.x); apply(ax.Ry, -ctl.sticks.R.y);
    if (ctl.dirty && now - lastSend > 40 && ws?.readyState === 1) { ws.send(JSON.stringify({ t: 'ctrl', targets: ctl.targets })); ctl.dirty = false; lastSend = now; }
  }
  requestAnimationFrame(loop);
}
function syncTargets() { if (state.robot) ctl.targets = Array.from(state.robot.ctrl); ctl.dirty = false; }

// ---------- voice (push-to-talk on the TALK button) ----------
const bubble = createBubble($('#app'), () => viewer.projectHead());
const speaker = createSpeaker({ onTranscript: (t, f) => bubble.show(t, f) });
const talker = createTalker({
  send: (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); },
  onState: (st) => { const b = $('#btn-talk'); if (st.error) return toast(st.error, 'error'); b.classList.toggle('live', !!st.talking); b.querySelector('small').textContent = st.talking ? 'release to stop' : 'hold to speak'; buzz(st.talking ? 30 : 10); },
  onLocalTranscript: (t, f) => bubble.show(t, f),
});
$('#btn-talk').addEventListener('pointerdown', (ev) => { ev.preventDefault(); if (inControl()) talker.start(); else toast('Accept the job to use the speaker', 'warn'); });
['pointerup', 'pointercancel', 'pointerleave'].forEach((t) => $('#btn-talk').addEventListener(t, () => talker.active && talker.stop()));

// ---------- sticks ----------
document.querySelectorAll('.stick').forEach((el) => {
  const id = el.dataset.stick, knob = el.querySelector('.knob'); let pid = null;
  // offsetX/Y are in the element's own (untransformed) space, so sticks read correctly in forced-landscape mode too
  const set = (ev) => { const rad = el.clientWidth / 2; let x = (ev.offsetX - rad) / rad, y = (ev.offsetY - rad) / rad; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; } ctl.sticks[id] = { x, y }; knob.style.transform = `translate(${x * rad * .58}px, ${y * rad * .58}px)`; };
  const end = () => { pid = null; ctl.sticks[id] = { x: 0, y: 0 }; knob.style.transform = ''; el.classList.remove('active'); };
  el.addEventListener('pointerdown', (ev) => { pid = ev.pointerId; el.setPointerCapture(pid); el.classList.add('active'); set(ev); buzz(8); ev.preventDefault(); });
  el.addEventListener('pointermove', (ev) => { if (ev.pointerId === pid) set(ev); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) => el.addEventListener(t, end));
});

// ---------- buttons ----------
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const job = currentJob();
  try {
    if (b.dataset.limbPrev) { ctl.limb = (ctl.limb + state.limbs.length - 1) % state.limbs.length; ctl.page = 0; buzz(); renderAll(); }
    else if (b.dataset.limbNext) { ctl.limb = (ctl.limb + 1) % state.limbs.length; ctl.page = 0; buzz(); renderAll(); }
    else if (b.dataset.page) { ctl.page = (ctl.page + 1) % Math.max(1, Math.ceil(limbJoints().length / 4)); buzz(); renderAll(); }
    else if (b.dataset.limb) { ctl.limb = +b.dataset.limb; ctl.page = 0; buzz(); renderAll(); }
    else if (b.dataset.act != null) { const a = state.robot?.actions?.[+b.dataset.act]; if (!a || !job) return; buzz(25); await api(`/api/jobs/${job.id}/action`, { method: 'POST', body: JSON.stringify({ action: a.id }) }); setTimeout(syncTargets, 150); }
    else if (b.dataset.kf) { if (state.robot) { ctl.kf.push(Array.from(state.robot.ctrl)); buzz(20); toast(`Keyframe ${ctl.kf.length} saved`, 'ok'); } }
    else if (b.id === 'btn-estop') { ctl.hold = !ctl.hold; b.classList.toggle('armed', ctl.hold); b.textContent = ctl.hold ? 'HELD' : 'HOLD'; buzz(40); if (ctl.hold && ws?.readyState === 1 && state.robot) { ctl.targets = state.robot.qpos.map((q, i) => Math.min(state.actuators[i].range[1], Math.max(state.actuators[i].range[0], q))); ws.send(JSON.stringify({ t: 'ctrl', targets: ctl.targets })); } }
    else if (b.id === 'btn-start') { if (!job) return; buzz(30); await api(`/api/jobs/${job.id}/complete`, { method: 'POST' }); toast('Submitted. The agent is reviewing.', 'ok'); }
    else if (b.id === 'btn-select' || b.id === 'btn-menu') openSheet();
    else if (b.id === 'sheet-close') $('#sheet').hidden = true;
    else if (b.dataset.claim) { const c = await api(`/api/jobs/${b.dataset.claim}/claim`, { method: 'POST' }); $('#sheet').hidden = true; await verifyOnPhone(c); }
    else if (b.dataset.cancel) { await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); $('#sheet').hidden = true; }
    else if (b.dataset.exit) { location.href = '/controller.html'; }
  } catch (e) { toast(e.message, 'error'); buzz(60); }
});

// Solo mode: verify with World ID on the phone itself (same SDK flow as the desktop page).
async function verifyOnPhone(claim) {
  const job = claim.job, req = claim.request;
  if (claim.mode === 'redirect') { location.href = claim.authUrl; return; }
  const sheet = $('#sheet'); sheet.hidden = false; $('#sheet-title').textContent = 'Verify with World ID';
  $('#sheet-body').innerHTML = `<div class="muted small">Open World App on this phone and approve, or scan from another device.</div><div style="display:flex;gap:14px;align-items:center;margin-top:10px"><canvas class="qr" id="wid-qr"></canvas><div><a id="wid-open"><button class="wid">Open World App</button></a><div class="muted small" id="wid-state" style="margin-top:8px">Waiting…</div></div></div>`;
  let completion;
  if (req.mode === 'idkit') {
    const { IDKit, proofOfHuman, CredentialRequest } = await import('@worldcoin/idkit-core');
    const cfg = { app_id: req.app_id, environment: req.environment, rp_context: req.rp_context };
    const human = CredentialRequest('proof_of_human', { signal: req.signal });
    const request = req.kind === 'createSession' ? await IDKit.createSession(cfg).constraints(human) : req.kind === 'proveSession' ? await IDKit.proveSession(req.session_id, cfg).constraints(human) : await IDKit.request({ ...cfg, action: req.action, allow_legacy_proofs: false }).preset(proofOfHuman({ signal: req.signal }));
    QRCode.toCanvas($('#wid-qr'), request.connectorURI, { width: 144, margin: 0 }); $('#wid-open').href = request.connectorURI;
    completion = await request.pollUntilCompletion({ pollInterval: 1500, timeout: 120_000 });
  } else {
    QRCode.toCanvas($('#wid-qr'), req.connectorURI, { width: 144, margin: 0 }); $('#wid-open').href = req.connectorURI; $('#wid-open').target = '_blank';
    completion = await new Promise((res) => { const t = setInterval(async () => { const st = await api(`/api/worldid/mock/status?r=${encodeURIComponent(req.requestId)}`).catch(() => ({ status: 'unknown' })); if (st.status === 'confirmed') { clearInterval(t); res({ success: true, result: st.result }); } else if (st.status !== 'pending') { clearInterval(t); res({ success: false, error: st.error || st.status }); } }, 1000); });
  }
  if (!completion.success) { await api(`/api/jobs/${job.id}/cancel`, { method: 'POST' }).catch(() => {}); $('#wid-state').textContent = `Cancelled: ${completion.error}`; return; }
  $('#wid-state').textContent = 'Verifying on the server…';
  try { await api(`/api/jobs/${job.id}/verify`, { method: 'POST', body: JSON.stringify({ requestId: req.requestId, result: completion.result }) }); state.me = await api('/api/me'); sheet.hidden = true; buzz(50); toast("Verified. You're in control.", 'ok'); syncTargets(); renderAll(); }
  catch (e) { $('#wid-state').textContent = 'Rejected: ' + e.message; }
}

// ---------- rendering ----------
function renderHud() {
  const r = state.robot; if (!r) return;
  const job = currentJob();
  $('#hud-mode').textContent = { auto: 'autonomous', stuck: 'stuck · ' + r.stuckReason, teleop: inControl() ? 'you are in control' : 'human in control' }[r.mode] || r.mode;
  $('#hud-mode').className = 'mode ' + r.mode;
  $('#hud-job').textContent = job ? `${job.title} · ${job.state === 'reviewing' ? 'agent reviewing' : job.state}` : 'no job';
  $('#tele-t').textContent = `boxes ${r.boxesProcessed ?? 0}${r.holding ? ' ·✋' : ''}`; $('#tele-con').textContent = `t ${r.time.toFixed(0)}s · c${r.ncon}`;
  $('#resume-note').textContent = inControl() ? (r.resume || 'safe to resume: press START') : job?.state === 'open' ? 'SELECT → accept the job to operate' : '';
  $('#btn-start').disabled = !inControl() || !!r.resume;
  $('#btn-talk').hidden = !(job && job.reason === 'hazard');
  const ax = axes(); const nm = (j) => (j ? j.name.replace(/^(left|right)_/, '') : '–');
  $('#lab-L').innerHTML = `↔ ${esc(nm(ax.Lx))}<br>↕ ${esc(nm(ax.Ly))}`; $('#lab-R').innerHTML = `↔ ${esc(nm(ax.Rx))}<br>↕ ${esc(nm(ax.Ry))}`;
  (r.actions || []).forEach((a, i) => { const b = document.querySelector(`.abx[data-act="${i}"]`); if (!b) return; b.querySelector('small').textContent = a.label; b.disabled = !inControl() || !a.available; b.classList.toggle('done', a.done); });
  for (let i = (r.actions || []).length; i < 3; i++) { const b = document.querySelector(`.abx[data-act="${i}"]`); if (b) { b.querySelector('small').textContent = ''; b.disabled = true; } }
  document.querySelector('.abx.y').disabled = !inControl();
  document.querySelectorAll('.stick').forEach((s) => s.style.opacity = inControl() ? 1 : .45);
}
function renderAll() {
  renderHud();
  $('#limb-strip').innerHTML = state.limbs.map((l, i) => `<button class="chip ${i === ctl.limb ? 'on' : ''}" data-limb="${i}">${esc(l.label)}</button>`).join('');
  if (inControl() && !ctl.targets.length) syncTargets();
}
function openSheet() {
  const job = currentJob(); const sheet = $('#sheet'); sheet.hidden = false;
  $('#sheet-title').textContent = job ? job.title : 'No job';
  if (!job) { $('#sheet-body').innerHTML = '<div class="muted">The robot is working autonomously. Jobs appear here when it gets stuck.</div><div class="row"><button data-exit="1">Disconnect</button></div>'; return; }
  const mine = job.claimedBy === state.me?.sessionId;
  $('#sheet-body').innerHTML = `
    <div class="muted small">#${job.id} · ${esc(job.urgency)} urgency · ${job.reward} WLD · ${job.agent?.model || job.agent?.source ? 'written by ' + esc(job.agent.model || job.agent.source) : ''}</div>
    <p>${esc(job.detail)}</p>
    ${job.steps?.length ? `<div class="k">Steps</div><ol>${job.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${job.acceptance?.length ? `<div class="k">Done when</div><ul>${job.acceptance.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
    ${job.review ? `<div class="verdict ${job.review.approved ? '' : 'bad'}"><b>${job.review.approved ? `Approved · ${job.review.efficiency}% · ${job.paid} WLD` : 'Rejected'}</b><div class="muted small">${esc(job.review.summary)}</div></div>` : ''}
    <div class="row">
      ${job.state === 'open' ? `<button class="wid" data-claim="${job.id}">Accept · Verify with World ID</button>` : ''}
      ${job.state === 'claimed' && mine ? `<button data-cancel="${job.id}">Cancel claim</button>` : ''}
      <button data-exit="1">Disconnect</button>
    </div>`;
}
