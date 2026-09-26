import QRCode from 'qrcode';
import { createViewer } from './viewer.js';
import { createTalker, createSpeaker, createBubble } from './voice.js';

const $ = (s) => document.querySelector(s);
const viewer = createViewer($('#view'));

const state = { me: null, robot: null, jobs: [], log: [], ledger: [], actuators: [], denied: null };

// ---------- helpers ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1', ...(opts.headers || {}) } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(body.error || r.statusText), { body });
  return body;
}
function toast(msg, level = 'info') {
  const el = document.createElement('div'); el.className = `toast ${level}`; el.textContent = msg;
  $('#toasts').appendChild(el); setTimeout(() => el.remove(), 6000);
}
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${s | 0}s ago` : `${(s / 60) | 0}m ago`; };
const short = (id) => (id ? id.slice(0, 10) + '…' : '');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const humanBadge = (id) => `<span class="human" title="${esc(id)}"><span class="wmark"></span>human · <code>${esc(short(id))}</code></span>`;

// ---------- routing ----------
function currentJobId() { const m = location.hash.match(/^#\/job\/([^?]+)/); return m ? m[1] : null; }
addEventListener('hashchange', render);

// ---------- WebSocket ----------
let ws;
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'init') { viewer.setGeoms(m); state.actuators = m.actuators; state.limbs = m.limbs || []; state.robotName = m.robotName; Object.assign(state, { robot: m.robot, jobs: m.jobs, log: m.log, ledger: m.ledger }); render(); }
    else if (m.t === 'state') { viewer.setPoses(m.poses); viewer.setPerson(m.robot.person); state.robot = m.robot; renderRobot(); renderJointReadout(); }
    else if (m.t === 'robot') { state.robot = m.robot; render(); }
    else if (m.t === 'jobs') { Object.assign(state, { jobs: m.jobs, log: m.log, ledger: m.ledger }); refreshMe(); render(); }
    else if (m.t === 'toast') toast(m.msg, m.level);
    else if (m.t === 'denied') { state.denied = m.msg; render(); }
    else if (m.t === 'paired') { if (wid.open && wid.pairing && m.sessionId === state.me?.sessionId) { widClose(); toast('Phone paired. The controller has the controls now.', 'ok'); } }
    else if (m.t === 'agent') { state.agentPhase = m.phase; renderRobot(); }
    else if (m.t === 'robot_voice') { if (m.kind === 'transcript') bubble.show(m.text, m.final); else if (!talker.active) speaker.handle(m); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
async function refreshMe() { state.me = await api('/api/me'); renderMe(); }

// ---------- teleop input ----------
const targets = [];
let sendTimer = null, dirty = false; // only send after the human moved a slider, so server-side actions (retract...) aren't overwritten
function startSending() { if (!sendTimer) sendTimer = setInterval(() => { if (dirty && ws?.readyState === 1) { ws.send(JSON.stringify({ t: 'ctrl', targets })); dirty = false; } }, 50); }
function stopSending() { clearInterval(sendTimer); sendTimer = null; viewer.setDragEnabled(false); }
// Drag-to-pose: viewer reports grab/move/release; the server relaxes that limb and pulls the body to the target.
let lastDragSend = 0;
viewer.onDrag = ({ body, target }) => {
  if (ws?.readyState !== 1) return;
  if (body == null) { ws.send(JSON.stringify({ t: 'drag', body: null })); syncSlidersFromRobot(); return; }
  const now = performance.now(); if (now - lastDragSend < 33) return; lastDragSend = now;
  ws.send(JSON.stringify({ t: 'drag', body, target }));
};
function syncSlidersFromRobot() {
  // after a drag or an action the server owns the pose; pull the sliders to it so they don't fight it
  setTimeout(() => { const c = state.robot?.ctrl; if (!c) return; for (let i = 0; i < state.actuators.length; i++) targets[i] = c[i]; document.querySelectorAll('#job-view input[type=range]').forEach((inp) => { inp.value = targets[+inp.dataset.i]; }); dirty = false; }, 120);
}

// ---------- keyframe recorder + video export (client side; playback streams targets like sliders do) ----------
const kf = { frames: [], playing: false, recorder: null, chunks: [] };
function kfSave() { if (!state.robot) return; kf.frames.push(Array.from(state.robot.ctrl)); toast(`Keyframe ${kf.frames.length} saved`, 'ok'); renderKf(); }
function kfUndo() { kf.frames.pop(); renderKf(); }
function kfClear() { kf.frames = []; renderKf(); }
async function kfPlay(duration = 1.2) {
  if (kf.frames.length < 2 || kf.playing) return;
  kf.playing = true; renderKf();
  const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  for (let i = 0; i < kf.frames.length - 1 && kf.playing; i++) {
    const t0 = performance.now();
    while (kf.playing) {
      const t = Math.min(1, (performance.now() - t0) / (duration * 1000)), e = t * t * (3 - 2 * t);
      const pose = lerp(kf.frames[i], kf.frames[i + 1], e);
      for (let j = 0; j < pose.length; j++) targets[j] = pose[j]; dirty = true;
      if (t >= 1) break;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  document.querySelectorAll('#job-view input[type=range]').forEach((inp) => { inp.value = targets[+inp.dataset.i]; });
  kf.playing = false; renderKf();
}
async function kfExport() {
  if (kf.frames.length < 2) return toast('Save at least two keyframes first', 'warn');
  const stream = viewer.canvas.captureStream(30);
  const mime = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
  kf.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 }); kf.chunks = [];
  kf.recorder.ondataavailable = (e) => e.data.size && kf.chunks.push(e.data);
  const done = new Promise((r) => { kf.recorder.onstop = r; });
  kf.recorder.start(); renderKf();
  await new Promise((r) => setTimeout(r, 400));
  await kfPlay();
  await new Promise((r) => setTimeout(r, 600));
  kf.recorder.stop(); await done;
  const blob = new Blob(kf.chunks, { type: mime }); const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `robot-rescue-${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}` });
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
  kf.recorder = null; renderKf(); toast('Video exported', 'ok');
}
function renderKf() {
  const el = $('#kf-status'); if (!el) return;
  el.textContent = `${kf.frames.length} keyframe${kf.frames.length === 1 ? '' : 's'}${kf.playing ? ' · playing…' : ''}${kf.recorder ? ' · recording' : ''}`;
  el.parentElement.querySelectorAll('button').forEach((b) => { b.disabled = kf.playing || !!kf.recorder ? !b.dataset.kfStop : (b.dataset.kf === 'play' || b.dataset.kf === 'export') && kf.frames.length < 2; });
}
// ---------- voice: push-to-talk through the robot's speaker ----------
const bubble = createBubble(document.body, () => { const p = viewer.projectHead(); if (!p) return null; const r = viewer.canvas.getBoundingClientRect(); return { x: p.x + r.left, y: p.y + r.top }; });
const speaker = createSpeaker({ onTranscript: (t, f) => bubble.show(t, f) });
const talker = createTalker({
  send: (m) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); },
  onState: (st) => { const b = $('#talk-btn'); if (!b) return; if (st.error) { toast(st.error, 'error'); return; } b.classList.toggle('live', !!st.talking); b.textContent = st.talking ? '● Speaking through the robot… release to stop' : '🎙 Hold to talk to the person'; if (st.talking && !st.transcription) toast('Live transcription needs Chrome or Edge; audio still plays.', 'warn'); },
  onLocalTranscript: (t, f) => bubble.show(t, f),
});
document.addEventListener('pointerdown', (ev) => { const b = ev.target.closest('#talk-btn'); if (b && !b.disabled) { ev.preventDefault(); talker.start(); } });
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, () => { if (talker.active) talker.stop(); }));
document.addEventListener('keydown', (ev) => { if (ev.key === 'v' && !ev.repeat && $('#talk-btn') && !$('#talk-btn').disabled && document.activeElement?.tagName !== 'INPUT') talker.start(); });
document.addEventListener('keyup', (ev) => { if (ev.key === 'v' && talker.active) talker.stop(); });

// ---------- gamepad teleoperation (touch) ----------
// Two virtual sticks drive four joints of the selected limb as velocities (rad/s ∝ deflection); A/B/X fire the
// job's actions; START submits. Shown automatically on coarse-pointer devices, toggleable anywhere.
const pad = { on: false, limb: 4, page: 0, sticks: { L: { x: 0, y: 0 }, R: { x: 0, y: 0 } }, raf: null, last: 0, rate: 1.4 };
function padJoints() { const key = state.limbs?.[pad.limb]?.key; return state.actuators.map((a, i) => ({ ...a, i })).filter((a) => a.limb === key); }
function padAxes() { const js = padJoints(); const o = pad.page * 4; return { Lx: js[o], Ly: js[o + 1], Rx: js[o + 2], Ry: js[o + 3] }; }
const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch {} };
function padTick(now) {
  if (!pad.on) { pad.raf = null; return; }
  const dt = Math.min(0.05, (now - (pad.last || now)) / 1000); pad.last = now;
  const ax = padAxes();
  const apply = (j, v) => { if (!j || Math.abs(v) < 0.08) return; const cur = targets[j.i] ?? state.robot?.ctrl?.[j.i] ?? 0; targets[j.i] = Math.min(j.range[1], Math.max(j.range[0], cur + v * pad.rate * dt)); dirty = true; const inp = document.querySelector(`#job-view input[type=range][data-i="${j.i}"]`); if (inp) inp.value = targets[j.i]; };
  apply(ax.Lx, pad.sticks.L.x); apply(ax.Ly, -pad.sticks.L.y); apply(ax.Rx, pad.sticks.R.x); apply(ax.Ry, -pad.sticks.R.y);
  pad.raf = requestAnimationFrame(padTick);
}
function padShow(on) {
  pad.on = on; document.body.classList.toggle('pad-mode', on);
  if (on) { renderPad(); pad.last = 0; if (!pad.raf) pad.raf = requestAnimationFrame(padTick); }
  else { pad.sticks.L = { x: 0, y: 0 }; pad.sticks.R = { x: 0, y: 0 }; }
}
function renderPad() {
  const el = $('#pad'); if (!el) return;
  const job = state.jobs.find((j) => j.id === currentJobId()); const r = state.robot || {};
  const inControl = job && job.state === 'active' && state.me && job.claimedBy === state.me.sessionId && r.mode === 'teleop';
  if (!pad.on || !job) { el.hidden = true; return; }
  el.hidden = false;
  const ax = padAxes(); const nm = (j) => (j ? esc(j.name.replace(/^(left|right)_/, '')) : '–');
  const pages = Math.ceil(padJoints().length / 4);
  el.innerHTML = `
    <div class="pad-top">
      <button class="pad-back" data-pad-off="1">▾ Details</button>
      <div class="pad-title"><b>${esc(job.title)}</b><span>${inControl ? 'operating' : job.state === 'reviewing' ? 'agent reviewing' : 'view only · accept to operate'}${r.resume && inControl ? ' · ' + esc(r.resume) : ''}</span></div>
      ${inControl ? `<button class="pad-start" data-complete="${job.id}" ${r.resume ? 'disabled' : ''}>START ▶<small>submit</small></button><button class="pad-start pad-cancel" data-cancel="${job.id}">✕<small>cancel</small></button>` : job.state === 'open' ? `<button class="pad-start" data-claim="${job.id}">ACCEPT<small>World ID</small></button>` : ''}
    </div>
    <div class="pad-chips">${(state.limbs || []).map((l, i) => `<button class="chip ${i === pad.limb ? 'on' : ''}" data-pad-limb="${i}">${esc(l.label)}</button>`).join('')}${pages > 1 ? `<button class="chip alt" data-pad-page="1">joints ${pad.page * 4 + 1}–${Math.min(padJoints().length, pad.page * 4 + 4)} ⟳</button>` : ''}</div>
    <div class="pad-body ${inControl ? '' : 'pad-locked'}">
      <div class="stick-wrap"><div class="stick" data-stick="L"><div class="knob"></div></div><div class="stick-label">↔ ${nm(ax.Lx)}<br>↕ ${nm(ax.Ly)}</div></div>
      <div class="pad-buttons">
        ${(r.actions || []).slice(0, 3).map((a, i) => `<button class="abx ${['a', 'b', 'x'][i]} ${a.done ? 'done' : ''}" data-action="${a.id}" data-job="${job.id}" ${inControl && a.available ? '' : 'disabled'}><span>${['A', 'B', 'X'][i]}</span><small>${esc(a.label)}</small></button>`).join('')}
        <button class="abx y" data-kf="save" ${inControl ? '' : 'disabled'}><span>Y</span><small>keyframe</small></button>
      </div>
      <div class="stick-wrap"><div class="stick" data-stick="R"><div class="knob"></div></div><div class="stick-label">↔ ${nm(ax.Rx)}<br>↕ ${nm(ax.Ry)}</div></div>
    </div>`;
  el.querySelectorAll('.stick').forEach(bindStick);
}
function bindStick(stickEl) {
  const id = stickEl.dataset.stick, knob = stickEl.querySelector('.knob'); let pid = null;
  const set = (ev) => { const rct = stickEl.getBoundingClientRect(); const rad = rct.width / 2; let x = (ev.clientX - rct.left - rad) / rad, y = (ev.clientY - rct.top - rad) / rad; const m = Math.hypot(x, y); if (m > 1) { x /= m; y /= m; } pad.sticks[id] = { x, y }; knob.style.transform = `translate(${x * rad * 0.6}px, ${y * rad * 0.6}px)`; };
  const end = () => { pid = null; pad.sticks[id] = { x: 0, y: 0 }; knob.style.transform = ''; };
  stickEl.addEventListener('pointerdown', (ev) => { pid = ev.pointerId; stickEl.setPointerCapture(pid); set(ev); buzz(8); ev.preventDefault(); });
  stickEl.addEventListener('pointermove', (ev) => { if (ev.pointerId === pid) set(ev); });
  stickEl.addEventListener('pointerup', end); stickEl.addEventListener('pointercancel', end); stickEl.addEventListener('lostpointercapture', end);
}
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.pair) {
    api('/api/pair/code', { method: 'POST' }).then((r) => {
      widShow(`<h3 id="wid-title">Pair your phone</h3><p>Open the controller app on your phone and scan this, or type the code. The phone takes over this session's controls; it expires in 5 minutes.</p>
        <div class="wid-qr"><canvas id="wid-canvas"></canvas></div>
        <div class="wid-state" style="font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:.25em">${r.code}</div>
        <div class="wid-actions"><a href="${esc(r.url)}" target="_blank" rel="noopener"><button class="sec btn-world" type="button">Open controller on this device</button></a></div>`);
      wid.job = null; wid.pairing = true; QRCode.toCanvas($('#wid-canvas'), r.url, { width: 208, margin: 0, color: { dark: '#181818', light: '#ffffff' } });
    }).catch((e) => toast(e.message, 'error'));
  }
  else if (b.dataset.padOff) padShow(false);
  else if (b.dataset.padOn) padShow(true);
  else if (b.dataset.padLimb) { pad.limb = +b.dataset.padLimb; pad.page = 0; buzz(); renderPad(); }
  else if (b.dataset.padPage) { pad.page = (pad.page + 1) % Math.ceil(padJoints().length / 4); buzz(); renderPad(); }
  else if (b.classList.contains('abx')) buzz(20);
});
const coarse = matchMedia('(pointer: coarse)').matches;

// ---------- keyboard teleoperation ----------
// 1-5 pick a limb · [ ] step through its joints · ← → nudge (Shift = coarse) · 0 zero the joint
// Q W E fire the job's actions in order · Enter submit · Space play keyframes · K save keyframe · Esc deselect
const kb = { limb: 0, joint: 0, step: 0.05 };
function kbJoints() { const key = state.limbs?.[kb.limb]?.key; return state.actuators.map((a, i) => ({ ...a, i })).filter((a) => a.limb === key); }
function kbSelected() { const js = kbJoints(); return js.length ? js[Math.min(kb.joint, js.length - 1)] : null; }
function kbHighlight() {
  const sel = kbSelected();
  document.querySelectorAll('#job-view .joint').forEach((el) => el.classList.remove('kb-selected'));
  document.querySelectorAll('#job-view details.limb').forEach((el, i) => { if (i === kb.limb && sel) el.open = true; });
  if (sel) { const inp = document.querySelector(`#job-view input[type=range][data-i="${sel.i}"]`); inp?.closest('.joint')?.classList.add('kb-selected'); inp?.scrollIntoView({ block: 'nearest' }); }
  const hint = $('#kb-hint'); if (hint) hint.innerHTML = sel ? `<b>${esc(state.limbs[kb.limb].label)} · ${esc(sel.name.replace(/^(left|right)_/, ''))}</b> ← → nudge (Shift ×5) · [ ] next joint · 1–5 limb · 0 zero · Q/W/E actions · Enter submit` : `<b>Keyboard:</b> 1–5 pick a limb, then ← → to move joints · Q/W/E actions · Enter submit`;
}
function kbNudge(dir, coarse) {
  const sel = kbSelected(); if (!sel) return;
  const step = kb.step * (coarse ? 5 : 1);
  const v = Math.min(sel.range[1], Math.max(sel.range[0], (targets[sel.i] ?? state.robot?.ctrl?.[sel.i] ?? 0) + dir * step));
  targets[sel.i] = v; dirty = true;
  const inp = document.querySelector(`#job-view input[type=range][data-i="${sel.i}"]`); if (inp) inp.value = v;
}
document.addEventListener('keydown', (ev) => {
  const typing = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) && document.activeElement.type !== 'range';
  if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
  const job = state.jobs.find((j) => j.id === currentJobId());
  const inControl = job && job.state === 'active' && state.me && job.claimedBy === state.me.sessionId && state.robot?.mode === 'teleop';
  if (ev.key === 'k' && $('#kf-status')) { kfSave(); return; }
  if (!inControl) return;
  const k = ev.key;
  if (/^[1-5]$/.test(k)) { kb.limb = +k - 1; kb.joint = 0; kbHighlight(); }
  else if (k === '[' || k === ']') { const n = kbJoints().length; if (n) kb.joint = (kb.joint + (k === ']' ? 1 : n - 1)) % n; kbHighlight(); }
  else if (k === 'ArrowLeft' || k === 'ArrowRight') { kbNudge(k === 'ArrowRight' ? 1 : -1, ev.shiftKey); ev.preventDefault(); }
  else if (k === '0') { const sel = kbSelected(); if (sel) { targets[sel.i] = 0; dirty = true; const inp = document.querySelector(`#job-view input[type=range][data-i="${sel.i}"]`); if (inp) inp.value = 0; } }
  else if (/^[qwe]$/i.test(k)) { const btn = document.querySelectorAll('#job-view button.action')['qwe'.indexOf(k.toLowerCase())]; if (btn && !btn.disabled) btn.click(); }
  else if (/^[po]$/i.test(k)) { const btn = document.querySelector(`#job-view button[data-action="${k.toLowerCase() === 'p' ? 'pick' : 'drop'}"]`); if (btn && !btn.disabled) btn.click(); }
  else if (k === 'Enter') { const btn = document.querySelector('#job-view button[data-complete]'); if (btn && !btn.disabled) btn.click(); }
  else if (k === ' ') { if (kf.frames.length >= 2 && !kf.playing) { kfPlay(); ev.preventDefault(); } }
  else if (k === 'Escape') { document.querySelectorAll('#job-view .joint').forEach((el) => el.classList.remove('kb-selected')); const hint = $('#kb-hint'); if (hint) kbHighlight(); }
});

// ---------- World ID modal ----------
// Real mode uses the official SDK (@worldcoin/idkit-core) against the sandbox; mock mode uses the same
// modal, but the QR points at the local stand-in for World App.
const wid = { open: false, abort: null };
function widShow(html) { $('#wid-body').innerHTML = html; $('#wid').hidden = false; wid.open = true; }
function widClose() { $('#wid').hidden = true; wid.open = false; wid.pairing = false; wid.abort?.abort(); wid.abort = null; }
$('#wid-close').onclick = async () => { if (wid.job) { await api(`/api/jobs/${wid.job}/cancel`, { method: 'POST' }).catch(() => {}); toast('Verification cancelled. Job returned to the pool, robot stays paused.', 'warn'); } widClose(); };

function widQr(text, hint) {
  widShow(`<h3 id="wid-title">Connect your World ID</h3><p>Scan the QR code with World App to verify you're a unique human. Control unlocks only after the proof is verified on the server.</p>
    <div class="wid-qr"><canvas id="wid-canvas"></canvas></div>
    <div class="wid-state"><span class="spinner"></span> Waiting for World App…</div>
    <div class="wid-actions">${hint || ''}</div>`);
  QRCode.toCanvas($('#wid-canvas'), text, { width: 208, margin: 0, color: { dark: '#181818', light: '#ffffff' } });
}
function widResult(ok, title, detail) {
  wid.job = null; // closing from here must not cancel anything
  widShow(`<div class="wid-done ${ok ? '' : 'bad'}">${ok ? '✓' : '✕'}</div><h3 id="wid-title">${esc(title)}</h3><p>${esc(detail || '')}</p>
    <div class="wid-actions"><button id="wid-ok">${ok ? 'Start teleoperating' : 'Back to job'}</button></div>`);
  $('#wid-ok').onclick = widClose;
}

async function verifyForJob(jobId) {
  const claim = await api(`/api/jobs/${jobId}/claim`, { method: 'POST' });
  location.hash = `#/job/${jobId}`;
  if (claim.mode === 'redirect') { location.href = claim.authUrl; return; } // OIDC sign-in mode
  const req = claim.request;
  wid.job = jobId; wid.abort = new AbortController();
  const signal = wid.abort.signal;

  let completion;
  if (req.mode === 'idkit') {
    widQr('loading', '');
    const { IDKit, proofOfHuman, CredentialRequest } = await import('@worldcoin/idkit-core');
    const cfg = { app_id: req.app_id, environment: req.environment, rp_context: req.rp_context };
    // Session flows take constraints (no presets); uniqueness flows can use the preset with legacy fallback.
    const human = CredentialRequest('proof_of_human', { signal: req.signal });
    const request = req.kind === 'createSession' ? await IDKit.createSession(cfg).constraints(human)
      : req.kind === 'proveSession' ? await IDKit.proveSession(req.session_id, cfg).constraints(human)
      : await IDKit.request({ ...cfg, action: req.action, allow_legacy_proofs: false }).preset(proofOfHuman({ signal: req.signal }));
    window.__idkitRequest = request; // debug: request.getDebugReport() in the devtools console
    if (signal.aborted) return;
    widQr(request.connectorURI, `<a href="${esc(request.connectorURI)}" target="_blank" rel="noopener"><button class="sec btn-world" type="button">Open World App on this device</button></a>`);
    // Poll manually so the modal can show where the flow is: request fetched by the phone, awaiting confirmation, done.
    const labels = { waiting_for_connection: 'Waiting for World App to scan…', awaiting_confirmation: 'World App connected. Confirm on your phone…' };
    const started = Date.now();
    let transient = 0; // bridge hiccups (connection_failed / fetch errors) are retried a few times before giving up
    completion = await new Promise((resolve) => {
      const tick = async () => {
        if (signal.aborted) return resolve(null);
        if (Date.now() - started > 120_000) return resolve({ success: false, error: 'timed_out' });
        let st;
        try { st = await request.pollOnce(); } catch (e) { st = { type: 'failed', error: e.message || 'poll_failed' }; }
        if (st.type === 'confirmed') return resolve({ success: true, result: st.result });
        if (st.type === 'failed') {
          if (/connection_failed|poll_failed|fetch/i.test(st.error || '') && ++transient <= 5) { setTimeout(tick, 2000); return; }
          return resolve({ success: false, error: st.error || 'failed' });
        }
        transient = 0;
        const el = $('.wid-state'); if (el) el.innerHTML = `<span class="spinner"></span> ${labels[st.type] || st.type}`;
        setTimeout(tick, 1500);
      };
      tick();
    });
  } else {
    widQr(req.connectorURI, `<a href="${esc(req.connectorURI)}" target="_blank" rel="noopener"><button class="sec btn-world" type="button">Open World App (mock) on this device</button></a>`);
    completion = await new Promise((resolve) => {
      const t = setInterval(async () => {
        if (signal.aborted) { clearInterval(t); return resolve(null); }
        const st = await api(`/api/worldid/mock/status?r=${encodeURIComponent(req.requestId)}`).catch(() => ({ status: 'unknown' }));
        if (st.status === 'confirmed') { clearInterval(t); resolve({ success: true, result: st.result }); }
        else if (st.status === 'failed' || st.status === 'unknown') { clearInterval(t); resolve({ success: false, error: st.error || st.status }); }
      }, 1000);
    });
  }
  if (!completion || signal.aborted) return;
  if (!completion.success) {
    await api(`/api/jobs/${jobId}/cancel`, { method: 'POST' }).catch(() => {});
    return widResult(false, 'Request cancelled', `World App reported: ${completion.error}. The job is back in the pool and the robot stays paused.`);
  }
  $('.wid-state').innerHTML = '<span class="spinner"></span> Proof received, verifying on the server…';
  try {
    await api(`/api/jobs/${jobId}/verify`, { method: 'POST', body: JSON.stringify({ requestId: req.requestId, result: completion.result }) });
    await refreshMe();
    widResult(true, "You're verified", 'Robot control is unlocked for this job. Reward goes to your World ID.');
  } catch (e) {
    await refreshMe();
    widResult(false, 'Verification rejected', e.message);
  }
}

// ---------- rendering ----------
function renderRobot() {
  const r = state.robot; if (!r) return;
  const pill = $('#robot-pill');
  const label = { auto: `Autonomous · ${r.waypoint}`, stuck: state.agentPhase === 'authoring' ? `Stuck · ${r.stuckReason} · agent writing the job…` : `Stuck · ${r.stuckReason} · waiting for a human`, teleop: 'Human in control' }[r.mode];
  pill.textContent = `${label} · ${r.boxesProcessed ?? 0} boxes${r.holding ? ' · holding' : ''} · ${r.time}s`; pill.className = `pill ${r.mode}`;
}
function renderMe() {
  const me = state.me; if (!me) return;
  const modeLabel = { idkit: `World ID ${me.environment || ''}`.trim(), oidc: 'World ID sign-in', mock: 'World ID (mock)' }[me.mode] || me.mode;
  $('#me').innerHTML = me.sub
    ? `${humanBadge(me.sub)} <b style="color:var(--success-700)">${me.balance} WLD</b>`
    : `Not verified · ${esc(modeLabel)}`;
  const ag = me.agent; if (ag) $('#agent-info').textContent = ag.enabled ? `Agent: ${ag.model}` : 'Agent: rule-based (set ANTHROPIC_API_KEY)';
}
function renderJointReadout() {
  const r = state.robot; if (!r) return;
  document.querySelectorAll('#job-view .joint .val').forEach((el) => { const i = +el.dataset.i; if (r.qpos[i] != null) el.textContent = `${r.qpos[i].toFixed(2)}`; });
}
// The pool shows one card so it is fully visible without scrolling; the rest sit behind a show-more button.
const POOL_VISIBLE = 1; let poolExpanded = false;
function renderBoard() {
  const open = state.jobs.filter((j) => j.state !== 'done' && j.state !== 'reviewing');
  $('#pool-count').textContent = open.length ? `${open.length} open` : '';
  const shown = poolExpanded ? state.jobs : state.jobs.slice(0, POOL_VISIBLE);
  const hidden = state.jobs.length - shown.length;
  $('#jobs').innerHTML = state.jobs.length ? shown.map((j) => `
    <div class="job ${j.state}">
      <div class="title"><span class="urg ${j.urgency}">${j.urgency}</span>${esc(j.title)}</div>
      <div class="reward">${j.reward} WLD</div>
      <div class="meta">#${j.id} · ${j.state === 'reviewing' ? 'agent reviewing' : j.state === 'done' && j.review ? (j.review.approved ? `approved ${j.review.efficiency}% · ${j.paid} WLD` : j.review.withdrawn ? 'withdrawn' : 'rejected') : j.state}${j.workerSub ? ' · ' + esc(short(j.workerSub)) : ''} · ${j.agent?.model ? 'by agent' : 'by rules'} · ${ago(j.postedAt)}</div>
      <div class="actions">
        ${j.state === 'open' ? `<button class="btn-world" data-claim="${j.id}"><span class="wmark"></span>Accept · Verify with World ID</button>` : ''}
        ${j.state !== 'open' ? `<button class="sec small" data-open="${j.id}">View</button>` : ''}
      </div>
    </div>`).join('') + (state.jobs.length > POOL_VISIBLE ? `<button class="sec small show-more" data-pool-toggle="1">${poolExpanded ? 'Show less' : `Show ${hidden} more`}</button>` : '')
    : '<div class="empty">No jobs. The robot is working autonomously. Use the scenario buttons to get it stuck.</div>';
}
const PAY_VISIBLE = 3; let payExpanded = false;
function renderLog() {
  $('#log').innerHTML = state.log.map((e) => `<div><b>#${e.jobId}</b> ${esc(e.msg)} <span class="muted">· ${ago(e.at)}</span></div>`).join('') || '<div class="empty">nothing yet</div>';
  const STATUS = { simulated: 'simulated', pending_address: 'waiting for wallet', submitting: 'sending…', submitted: 'sent, confirming…', confirmed: 'confirmed', failed: 'failed' };
  // Each human shows their three most recent payouts; older ones sit behind a show-more button.
  let hiddenPays = 0;
  $('#ledger').innerHTML = state.ledger.length ? state.ledger.map((l) => {
    const pays = payExpanded ? l.payments : l.payments.slice(-PAY_VISIBLE); hiddenPays += l.payments.length - pays.length;
    return `
    <div>${humanBadge(l.sub)}<span>${l.jobs} job${l.jobs > 1 ? 's' : ''} · <b style="color:var(--success-700)">${l.total} WLD</b></span></div>
    ${l.address ? `<div class="pay-addr">→ <code>${esc(l.address.slice(0, 8))}…${esc(l.address.slice(-6))}</code></div>` : ''}
    ${pays.map((p) => `<div class="pay ${p.status}"><span>#${p.jobId} · ${p.amount} WLD</span><span class="pay-status">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${STATUS[p.status] || p.status} ↗</a>` : esc(STATUS[p.status] || p.status)}${p.status === 'failed' ? ` <button class="small sec" data-retry-pay="${p.id}" title="${esc(p.error || '')}">retry</button>` : ''}</span></div>`).join('')}`;
  }).join('') + (hiddenPays > 0 || payExpanded ? `<button class="sec small show-more" data-pay-toggle="1">${payExpanded ? 'Show less' : `Show ${hiddenPays} more`}</button>` : '') : '<span class="muted">no payouts yet</span>';
  const pi = state.me?.payments;
  $('#pay-info').textContent = pi ? (pi.enabled ? `Real payouts in WLD on ${pi.chain} from treasury ${pi.treasury.slice(0, 6)}…${pi.treasury.slice(-4)}` : 'Simulated payouts: set TREASURY_PRIVATE_KEY to pay real WLD on World Chain') : '';
}
let jobViewKey = null;
function renderJobView() {
  const id = currentJobId(), view = $('#job-view');
  const job = id && state.jobs.find((j) => j.id === id);
  if (!job) { view.hidden = true; stopSending(); jobViewKey = null; if (pad.on) padShow(false); return; }
  view.hidden = false;
  const mine = state.me && job.claimedBy === state.me.sessionId;
  const inControl = job.state === 'active' && mine && state.robot?.mode === 'teleop';
  const authFailed = location.hash.includes('auth=') ? state.me?.lastError : null;

  // Only rebuild the DOM when something structural changed; otherwise a rebuild mid-drag resets the sliders.
  const r = state.robot || {};
  const key = JSON.stringify([job.id, job.state, mine, inControl, authFailed, state.denied, wid.open, job.doneAt, r.actions, r.resume, state.me?.payoutAddress, state.me?.payments?.enabled, job.review, r.manualActions, r.held, r.macroRunning, r.macroError]);
  if (key === jobViewKey) {
    const cd = view.querySelector('.countdown');
    if (cd) cd.textContent = `${Math.max(0, (job.claimExpiresAt - Date.now()) / 1000) | 0}s`;
    renderJointReadout();
    return;
  }
  jobViewKey = key;

  let cls = 'warn', stateLine;
  if (job.state === 'done' && job.review) { cls = job.review.approved ? 'ok' : job.review.withdrawn ? '' : 'bad'; stateLine = job.review.approved ? `Approved by the agent at <b>${job.review.efficiency}%</b> efficiency: <b>${job.paid} WLD</b> of ${job.reward} to ${humanBadge(job.workerSub)}<br><span class="muted">${esc(job.review.summary)}</span>` : job.review.withdrawn ? `Withdrawn by the agent.<br><span class="muted">${esc(job.review.summary)}</span>` : `Rejected by the agent, no payout.<br><span class="muted">${esc(job.review.summary)}</span>`; }
  else if (job.state === 'done') { cls = 'ok'; stateLine = `Completed. ${job.reward} WLD paid to ${humanBadge(job.workerSub)}`; }
  else if (job.state === 'reviewing') { stateLine = `<span class="spinner"></span> Submitted. The robot's agent is verifying the work and scoring efficiency…`; }
  else if (inControl) { cls = 'ok'; stateLine = `${humanBadge(job.workerSub)} You are teleoperating the robot.`; }
  else if (job.state === 'active') stateLine = 'Another verified human is in control.';
  else if (job.state === 'claimed' && mine) stateLine = `Claimed by you. Verification pending, expires in <span class="countdown">${Math.max(0, (job.claimExpiresAt - Date.now()) / 1000) | 0}s</span>.`;
  else if (job.state === 'claimed') stateLine = 'Claimed by someone else, verification pending.';
  else { cls = 'bad'; stateLine = 'Open. Not verified: control stays locked.'; }
  if (authFailed) { cls = 'bad'; stateLine += `<br>Server rejected verification: ${esc(authFailed)}`; }
  if (state.denied) { cls = 'bad'; stateLine += `<br>${esc(state.denied)}`; }

  view.innerHTML = `
    <h2>${esc(job.title)} <span class="muted">${job.reward} WLD</span></h2>
    <div class="agent-line">${job.agent?.model ? `<span class="agent-badge">agent · ${esc(job.agent.model)}</span>` : `<span class="agent-badge">agent · rules</span>`} <span class="muted">#${job.id} · ${esc(job.urgency)} urgency · posted ${ago(job.postedAt)}</span></div>
    <p class="brief">${esc(job.detail)}</p>
    ${job.steps?.length ? `<ol class="steps">${job.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}
    ${job.acceptance?.length ? `<div class="acceptance"><b>Done when</b><ul>${job.acceptance.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${job.context ? `<details class="snapshot"><summary>Situation snapshot from the robot <span class="muted">t=${job.context.time_s}s</span></summary>
      <div class="snap-grid">
        <span>Reason</span><b>${esc(job.context.stuck_reason)}</b>
        <span>Person near</span><b>${job.context.person_near ? 'yes' : 'no'}</b>
        <span>Obstacle in path</span><b>${job.context.obstacle_in_path ? 'yes' : 'no'}</b>
        <span>Part displaced</span><b>${job.context.target_displaced ? 'yes' : 'no'}</b>
        <span>Contacts</span><b>${job.context.contacts}</b>
        <span>Routine step</span><b>${esc(job.context.last_routine_step || '')}</b>
      </div>${job.agent?.reasoning ? `<div class="muted" style="margin-top:8px">Agent: ${esc(job.agent.reasoning)}</div>` : ''}</details>` : ''}
    <div class="session-line">${inControl ? '<span class="dot ok"></span> Session: operating' : job.state === 'done' ? '<span class="dot"></span> Session: closed' : job.state === 'reviewing' ? '<span class="dot warn"></span> Session: under review' : '<span class="dot warn"></span> Session: viewing only, teleoperation locked'}</div>
    <div class="state-line ${cls}"><span>${stateLine}</span></div>
    ${job.state !== 'done' && job.state !== 'reviewing' ? `<div class="${inControl ? '' : 'locked'}" data-lock="${job.state === 'active' ? 'Another verified human is in control.' : 'Actions unlock after World ID verification.'}">
      <div class="actions-list">
        ${(r.actions || []).map((a, i) => `<button class="action ${a.done ? 'done' : ''}" data-action="${a.id}" data-job="${job.id}" ${inControl && a.available ? '' : 'disabled'}>
          <span class="tick">${a.done ? '✓' : ''}</span><span><b>${esc(a.label)}</b><small>${esc(a.desc)}</small></span><kbd>${'QWE'[i] || ''}</kbd></button>`).join('')}
      </div>
      ${inControl && (r.manualActions || []).length ? `<div class="manual-row">${r.manualActions.map((a, i) => `<button class="sec small" data-action="${a.id}" data-job="${job.id}" ${a.available ? '' : 'disabled'} title="${esc(a.desc)}">${a.id === 'pick' ? '✊' : '🖐'} ${esc(a.label)} <kbd>${['P', 'O'][i]}</kbd></button>`).join('')}${r.held ? `<span class="muted">holding the ${esc(r.held)}</span>` : ''}${r.macroRunning ? '<span class="muted"><span class="spinner"></span> moving…</span>' : ''}${r.macroError ? `<span style="color:var(--error-700)">${esc(r.macroError)}</span>` : ''}</div>` : ''}
      ${job.reason === 'hazard' ? `<button id="talk-btn" class="talk ${inControl ? '' : ''}" ${inControl && talker.supported ? '' : 'disabled'} title="Hold (or press V) to speak through the robot">🎙 Hold to talk to the person</button>` : ''}
      <details class="override" ${inControl && (r.actionsDone || []).includes('manual_nudge') ? 'open' : ''}><summary>Manual control · ${esc(state.robotName || 'robot')} <span class="muted">drag a limb in the 3D view, or use the joint sliders</span></summary>
        <div id="kb-hint" class="kb-hint"><b>Keyboard:</b> 1–5 pick a limb, then ← → to move joints · Q/W/E actions · Enter submit</div>
        <div class="limbs">
        ${(state.limbs || []).map((l) => `<details class="limb"><summary>${esc(l.label)} <span class="muted">${state.actuators.filter((a) => a.limb === l.key).length} joints</span></summary>
          ${state.actuators.map((a, i) => a.limb !== l.key ? '' : `<div class="joint"><label><span>${esc(a.name.replace(/^(left|right)_/, ''))}</span><span class="val" data-i="${i}">–</span></label>
            <input type="range" min="${a.range[0]}" max="${a.range[1]}" step="0.01" value="${r.ctrl?.[i] ?? 0}" data-i="${i}" ${inControl ? '' : 'disabled'}></div>`).join('')}
        </details>`).join('')}
        </div>
        <div class="studio">
          <div class="studio-head"><b>Keyframes</b> <span id="kf-status" class="muted"></span></div>
          <div class="studio-row">
            <button class="small sec" data-kf="save" title="or press K">Save pose</button><button class="small sec" data-kf="undo">Undo</button>
            <button class="small sec" data-kf="play">Play</button><button class="small" data-kf="export">Export video</button><button class="small sec" data-kf="stop" data-kf-stop="1">Stop</button>
          </div>
        </div>
      </details>
    </div>` : ''}
    ${inControl && r.resume ? `<div class="blocker">${esc(r.resume)}</div>` : ''}
    ${mine && state.me?.sub && state.me?.payments?.enabled ? `<div class="payout-box">
      <label>Where to send your ${job.reward} WLD <span class="muted">(${esc(state.me.payments.chain)}; a World ID proof carries no wallet address, so tell us once and it's remembered)</span></label>
      ${state.me.payoutAddress ? `<div class="payout-set">Paying to <code>${esc(state.me.payoutAddress)}</code></div>` : `<div class="payout-row"><button class="small btn-connect" data-connect-wallet="1">${window.ethereum ? 'Connect wallet' : 'No browser wallet found'}</button><span class="muted">or paste an address</span></div>`}
      <div class="payout-row"><input id="payout-addr" placeholder="0x…" value="${esc(state.me.payoutAddress || '')}" spellcheck="false"><button class="small" data-save-addr="1">${state.me.payoutAddress ? 'Update' : 'Save'}</button></div>
    </div>` : ''}
    <div class="row">
      ${job.state === 'open' ? `<button class="btn-world" data-claim="${job.id}"><span class="wmark"></span>Accept · Verify with World ID</button>` : ''}
      ${job.state === 'claimed' && mine && !wid.open ? `<button data-retry="${job.id}">Retry verification</button><button class="sec" data-cancel="${job.id}">Cancel claim</button>` : ''}
      ${inControl ? `<button data-complete="${job.id}" ${r.resume ? 'disabled' : ''}>Submit &amp; resume robot <kbd>⏎</kbd></button><button class="sec" data-cancel="${job.id}" title="Give the job back to the pool; the robot stays paused">Cancel job</button>` : ''}
      ${job.state !== 'done' && !inControl ? `<button class="bad" data-forge="${job.id}" title="Posts a fabricated proof straight to the backend">Try a forged proof</button>` : ''}
      ${mine && ['claimed', 'active'].includes(job.state) ? `<button class="ghost" data-pair="1" title="Hand the controls to your phone">📱 Pair phone</button>` : ''}
      <button class="ghost" data-pad-on="1" title="Game-pad controls">🎮 Pad</button>
      <button class="ghost" data-back="1">Back</button>
    </div>`;

  if (inControl) {
    for (let i = 0; i < state.actuators.length; i++) targets[i] = state.robot.ctrl[i];
    view.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => { targets[+inp.dataset.i] = +inp.value; dirty = true; }));
    startSending(); viewer.setDragEnabled(true); renderKf(); kbHighlight();
    if (coarse && !pad.on) padShow(true);
  } else stopSending();
  renderJointReadout();
}
function render() { renderRobot(); renderMe(); renderBoard(); renderLog(); renderJobView(); renderPad(); }

// ---------- actions ----------
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  if (b.dataset.poolToggle) { poolExpanded = !poolExpanded; renderBoard(); return; }
  if (b.dataset.payToggle) { payExpanded = !payExpanded; renderLog(); return; }
  try {
    if (b.dataset.claim || b.dataset.retry) {
      const id = b.dataset.claim || b.dataset.retry;
      if (b.dataset.retry) await api(`/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
      await verifyForJob(id);
    } else if (b.dataset.action) {
      const r = await api(`/api/jobs/${b.dataset.job}/action`, { method: 'POST', body: JSON.stringify({ action: b.dataset.action }) });
      // an action may move the arm: resync the manual-override sliders so they don't fight it
      syncSlidersFromRobot();
      toast(`Action sent: ${b.textContent.trim().split('\n')[0]}`, 'ok');
    } else if (b.dataset.cancel) { stopSending(); await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); await refreshMe(); toast('Job cancelled and returned to the pool. Robot stays paused.', 'warn'); }
    else if (b.dataset.complete) { await api(`/api/jobs/${b.dataset.complete}/complete`, { method: 'POST' }); stopSending(); await refreshMe(); }
    else if (b.dataset.connectWallet) {
      if (!window.ethereum) return toast('No browser wallet detected. Paste your address instead.', 'warn');
      const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      await api('/api/me/payout-address', { method: 'POST', body: JSON.stringify({ address }) });
      await refreshMe(); toast(`Payout wallet connected: ${address.slice(0, 8)}…`, 'ok'); jobViewKey = null; render();
    }
    else if (b.dataset.saveAddr) { const address = $('#payout-addr').value.trim(); await api('/api/me/payout-address', { method: 'POST', body: JSON.stringify({ address }) }); await refreshMe(); toast('Payout wallet saved. Pending payouts are being sent.', 'ok'); jobViewKey = null; render(); }
    else if (b.dataset.kf) { ({ save: kfSave, undo: kfUndo, play: () => kfPlay(), export: kfExport, stop: () => { kf.playing = false; kf.recorder?.state === 'recording' && kf.recorder.stop(); } })[b.dataset.kf]?.(); }
    else if (b.dataset.resetCam) viewer.resetCamera();
    else if (b.dataset.retryPay) { await api(`/api/payments/${b.dataset.retryPay}/retry`, { method: 'POST' }); }
    else if (b.dataset.forge) { const r = await fetch('/api/demo/forge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json()); toast(`Server rejected the forged proof: ${r.error}`, 'error'); }
    else if (b.dataset.open) location.hash = `#/job/${b.dataset.open}`;
    else if (b.dataset.back) location.hash = '#/';
    else if (b.dataset.s) { await api(`/api/scenario/${b.dataset.s}`, { method: 'POST' }); }
  } catch (e) { toast(e.message, 'error'); widClose(); }
});

setInterval(() => { if (currentJobId()) renderJobView(); }, 1000);
// The backend takes a few seconds to load the robot meshes on a cold start; keep trying instead of dying.
(async function boot() { for (;;) { try { await refreshMe(); break; } catch { $('#robot-pill').textContent = 'waiting for server…'; await new Promise((r) => setTimeout(r, 1500)); } } connect(); })();
