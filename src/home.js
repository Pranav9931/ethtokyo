// Resqueue home: where humans find jobs. Live jobs link straight to the stuck robot's page.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ago = (t) => { const s = Math.max(0, (Date.now() - t) / 1000); return s < 60 ? `${s | 0}s ago` : s < 3600 ? `${(s / 60) | 0}m ago` : s < 86400 ? `${(s / 3600) | 0}h ago` : `${(s / 86400) | 0}d ago`; };
const short = (id) => (id ? id.slice(0, 10) + '…' : '');
const REASON = { hazard: 'Person in the cell', obstructed: 'Path blocked', lowconf: 'Lost the box' };

const state = { robot: null, jobs: [], ledger: [], robotName: 'Unitree G1', agent: null };
const LIVE = new Set(['open', 'claimed', 'active', 'reviewing']);

async function load() {
  const [st, robot, me] = await Promise.all([
    fetch('/api/state', { headers: { 'ngrok-skip-browser-warning': '1' } }).then((r) => r.json()),
    fetch('/api/robot', { headers: { 'ngrok-skip-browser-warning': '1' } }).then((r) => r.json()).catch(() => null),
    fetch('/api/me', { headers: { 'ngrok-skip-browser-warning': '1' } }).then((r) => r.json()).catch(() => null),
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
    else if (m.t === 'agent') { $('#robot-line').textContent = m.phase === 'authoring' ? `${state.robotName} is stuck: its agent is writing a job…` : robotLine(); }
  };
  ws.onclose = () => setTimeout(connect, 1500);
}
function robotLine() {
  const r = state.robot; if (!r) return 'Robot offline';
  const dot = $('.eyebrow .live-dot'); dot.className = 'live-dot ' + (r.mode === 'auto' ? '' : r.mode === 'stuck' ? 'warn' : '');
  return r.mode === 'auto' ? `${state.robotName} is working: ${r.boxesProcessed ?? 0} boxes this shift` : r.mode === 'stuck' ? `${state.robotName} is stuck (${REASON[r.stuckReason] || r.stuckReason}) and needs a human` : `${state.robotName} is being teleoperated by a verified human`;
}
function paymentFor(jobId) { for (const l of state.ledger) for (const p of l.payments) if (p.jobId === jobId) return p; return null; }

function renderStats() {
  const r = state.robot;
  $('#robot-line').textContent = robotLine();
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
  $('#live').hidden = live.length === 0; $('#quiet').hidden = live.length > 0;
  $('#live-count').textContent = live.length ? `${live.length} posted by agents` : '';
  $('#live-jobs').innerHTML = live.map((j) => jobCard(j, true)).join('');
  $('#prev-count').textContent = prev.length ? `${prev.length}` : '';
  $('#prev-jobs').innerHTML = prev.length ? prev.slice(0, 30).map((j) => jobCard(j, false)).join('') : '<div class="empty">No completed jobs yet.</div>';
}
document.addEventListener('click', (ev) => { if (ev.target.closest('[data-stop]')) return; const card = ev.target.closest('.card[data-href]'); if (card) location.href = card.dataset.href; });
document.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && ev.target.matches?.('.card[data-href]')) location.href = ev.target.dataset.href; });
setInterval(() => { if (state.jobs.length) render(); }, 30_000);
load().then(connect).catch(() => { $('#robot-line').textContent = 'Robot fleet unreachable'; setTimeout(() => load().then(connect), 3000); });
