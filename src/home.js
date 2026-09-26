// Resqueue home: a hero that opens into the job board. Live jobs link straight to the stuck robot's page.
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`; };
const short = (id) => (id ? id.slice(0, 10) + '…' : '');
const REASON = { hazard: 'Person in the cell', obstructed: 'Path blocked', lowconf: 'Lost the box' };
const HDR = { headers: { 'ngrok-skip-browser-warning': '1' } };

const state = { robot: null, jobs: [], ledger: [], robotName: 'Unitree G1', agent: null, authoring: false };
const LIVE = new Set(['open', 'claimed', 'active', 'reviewing']);

// ───────── View switching: hero ⇄ dashboard, driven by the URL hash ─────────
function setView(view, push = true) {
  document.body.dataset.view = view;
  const hash = view === 'dashboard' ? '#dashboard' : '';
  if (push && location.hash !== hash) history.pushState(null, '', location.pathname + hash);
  if (view === 'dashboard') window.scrollTo({ top: 0, behavior: 'instant' });
  if (view === 'hero') field.start(); else field.stop();
}
function viewFromHash() { return location.hash === '#dashboard' ? 'dashboard' : 'hero'; }
document.addEventListener('click', (ev) => {
  const link = ev.target.closest('[data-view-link]');
  if (link) { ev.preventDefault(); setView(link.dataset.viewLink); return; }
  if (ev.target.closest('[data-stop]')) return;
  const card = ev.target.closest('.card[data-href]'); if (card) location.href = card.dataset.href;
});
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches?.('.card[data-href]')) location.href = ev.target.dataset.href; });
window.addEventListener('popstate', () => setView(viewFromHash(), false));

// ───────── Hero background: a drifting signal field on a canvas ─────────
const field = (() => {
  const c = $('#field'); const ctx = c.getContext('2d');
  let w = 0, h = 0, dpr = 1, pts = [], raf = 0, running = false, t0 = performance.now();
  const N = () => Math.round(Math.min(140, (w * h) / 14000));
  function resize() {
    dpr = Math.min(2, window.devicePixelRatio || 1);
    w = c.clientWidth; h = c.clientHeight; c.width = w * dpr; c.height = h * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = N();
    while (pts.length < n) pts.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - .5) * .25, vy: (Math.random() - .5) * .25, r: 1 + Math.random() * 1.6, p: Math.random() * Math.PI * 2 });
    pts.length = n;
  }
  function frame(now) {
    if (!running) return;
    const t = (now - t0) / 1000;
    ctx.clearRect(0, 0, w, h);
    // faint grid
    ctx.strokeStyle = 'rgba(24,24,24,.045)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = (w / 2) % 64; x < w; x += 64) { ctx.moveTo(x, 0); ctx.lineTo(x, h); }
    for (let y = (h / 2) % 64; y < h; y += 64) { ctx.moveTo(0, y); ctx.lineTo(w, y); }
    ctx.stroke();
    // move points; gently attracted toward the centre so the field feels like a signal converging on the robot
    const cx = w / 2, cy = h / 2;
    for (const p of pts) {
      p.vx += (cx - p.x) * 0.000012 + Math.cos(t * .4 + p.p) * .004;
      p.vy += (cy - p.y) * 0.000012 + Math.sin(t * .4 + p.p) * .004;
      p.vx *= .995; p.vy *= .995; p.x += p.vx; p.y += p.vy;
      if (p.x < -20) p.x = w + 20; if (p.x > w + 20) p.x = -20; if (p.y < -20) p.y = h + 20; if (p.y > h + 20) p.y = -20;
    }
    // links between neighbours
    const L = 110;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i], b = pts[j], dx = a.x - b.x, dy = a.y - b.y, d = dx * dx + dy * dy;
      if (d < L * L) { const k = 1 - Math.sqrt(d) / L; ctx.strokeStyle = `rgba(63,219,237,${(.35 * k).toFixed(3)})`; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    }
    // points
    for (const p of pts) {
      const glow = .5 + .5 * Math.sin(t * 1.6 + p.p);
      ctx.fillStyle = `rgba(24,24,24,${(.25 + .45 * glow).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
    }
    raf = requestAnimationFrame(frame);
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return {
    start() { if (running || reduced) { if (reduced && !running) { resize(); running = true; frame(performance.now()); running = false; } return; } resize(); running = true; raf = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(raf); },
    resize,
  };
})();
window.addEventListener('resize', () => field.resize());
document.addEventListener('visibilitychange', () => { if (document.hidden) field.stop(); else if (document.body.dataset.view === 'hero') field.start(); });

// ───────── Data ─────────
async function load() {
  const [st, robot, me] = await Promise.all([
    fetch('/api/state', HDR).then((r) => r.json()),
    fetch('/api/robot', HDR).then((r) => r.json()).catch(() => null),
    fetch('/api/me', HDR).then((r) => r.json()).catch(() => null),
  ]);
  Object.assign(state, { robot: st.robot, jobs: st.jobs, ledger: st.ledger, robotName: robot?.name || state.robotName, agent: me?.agent || null });
  render();
}
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.t === 'init' || m.t === 'robot' || m.t === 'state') { state.robot = m.robot; if (m.jobs) state.jobs = m.jobs; if (m.ledger) state.ledger = m.ledger; if (m.robotName) state.robotName = m.robotName; renderStats(); if (m.t !== 'state') render(); }
    else if (m.t === 'jobs') { state.jobs = m.jobs; state.ledger = m.ledger; render(); }
    else if (m.t === 'agent') { state.authoring = m.phase === 'authoring'; renderLine(); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
function robotLine() {
  const r = state.robot; if (!r) return { text: 'Robot offline', cls: 'off' };
  if (state.authoring) return { text: `${state.robotName} is stuck: its agent is writing a job…`, cls: 'warn' };
  return r.mode === 'auto' ? { text: `${state.robotName} is working: ${r.boxesProcessed ?? 0} boxes this shift`, cls: '' }
    : r.mode === 'stuck' ? { text: `${state.robotName} is stuck (${REASON[r.stuckReason] || r.stuckReason}) and needs a human`, cls: 'warn' }
    : { text: `${state.robotName} is being teleoperated by a verified human`, cls: '' };
}
function renderLine(override) {
  const { text, cls } = override || robotLine();
  for (const el of $$('#robot-line, #robot-line-dash')) el.textContent = text;
  for (const d of $$('.eyebrow .live-dot')) d.className = 'live-dot ' + cls;
}
function paymentFor(jobId) { for (const l of state.ledger) for (const p of l.payments) if (p.jobId === jobId) return p; return null; }

function renderStats() {
  const r = state.robot;
  renderLine();
  $('#st-robots').textContent = r ? '1' : '0';
  $('#st-boxes').textContent = r?.boxesProcessed ?? '–';
  const done = state.jobs.filter((j) => j.state === 'done');
  $('#st-jobs').textContent = done.length;
  const paid = state.ledger.flatMap((l) => l.payments).filter((p) => p.status === 'confirmed' || p.status === 'simulated' || p.status === 'submitted').reduce((a, p) => a + p.amount, 0);
  $('#st-paid').textContent = paid ? paid.toFixed(3).replace(/\.?0+$/, '') : '0';
}
function jobCard(j, live) {
  const agent = j.agent?.model || j.agent?.source;
  const stateTag = j.state === 'open' ? 'Open · take it' : j.state === 'claimed' ? 'Being claimed' : j.state === 'active' ? 'Human in control' : j.state === 'reviewing' ? 'Agent reviewing' : '';
  return `<div class="card ${live ? 'live' : ''}" data-href="/console.html#/job/${j.id}" role="link" tabindex="0">
    <div class="card-top"><h3>${esc(j.title)}</h3><span class="reward">${j.reward} WLD</span></div>
    <div class="brief">${esc(j.detail)}</div>
    <div class="tags"><span class="tag ${esc(j.urgency)}">${esc(j.urgency)}</span><span class="tag robot">${esc(state.robotName)}</span>${agent ? `<span class="tag agent">agent · ${esc(agent)}</span>` : ''}${live && stateTag ? `<span class="tag state">${stateTag}</span>` : ''}<span>${ago(j.postedAt)}</span></div>
    ${live ? `<div class="card-cta"><span>${j.state === 'open' ? 'Open the robot and accept with World ID' : 'Open the robot'}</span><span class="arrow">→</span></div>` : ''}
    ${!live ? verdictLine(j) : ''}
  </div>`;
}
function verdictLine(j) {
  const p = paymentFor(j.id);
  if (!j.review) return `<div class="verdict"><span class="muted">completed ${j.doneAt ? ago(j.doneAt) : ''}</span></div>`;
  return `<div class="verdict">${j.review.approved ? `<span class="ok">Approved · ${j.review.efficiency}%</span>` : '<span class="bad">Rejected</span>'}
    ${j.review.approved ? `<span>${j.paid} WLD</span>` : ''}${j.workerSub ? `<span class="human"><span class="wmark"></span>human · <code>${esc(short(j.workerSub))}</code></span>` : ''}
    ${p?.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener" data-stop="1">${p.status === 'confirmed' ? 'paid on-chain ↗' : esc(p.status) + ' ↗'}</a>` : p ? `<span class="muted">${esc(p.status)}</span>` : ''}
    <span class="muted">${j.doneAt ? ago(j.doneAt) : ''}</span></div>`;
}
function render() {
  renderStats();
  const live = state.jobs.filter((j) => LIVE.has(j.state)).sort((a, b) => b.postedAt - a.postedAt);
  const prev = state.jobs.filter((j) => j.state === 'done').sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
  $('#quiet').hidden = live.length > 0;
  $('#live-count').textContent = live.length ? `${live.length} posted by agents` : '';
  $('#live-jobs').innerHTML = live.map((j) => jobCard(j, true)).join('');
  $('#prev-count').textContent = prev.length ? `${prev.length}` : '';
  $('#prev-jobs').innerHTML = prev.length ? prev.slice(0, 30).map((j) => jobCard(j, false)).join('') : '<div class="empty">No completed jobs yet.</div>';
}
setInterval(() => { if (state.jobs.length) render(); }, 30_000);

setView(viewFromHash(), false);
load().then(connect).catch(() => { renderLine({ text: 'Robot fleet unreachable', cls: 'off' }); setTimeout(() => load().then(connect), 3000); });
