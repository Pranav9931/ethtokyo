import QRCode from 'qrcode';
import { createViewer } from './viewer.js';

const $ = (s) => document.querySelector(s);
const viewer = createViewer($('#view'));

const state = { me: null, robot: null, jobs: [], log: [], ledger: [], actuators: [], denied: null };

// ---------- helpers ----------
async function api(path, opts = {}) {
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
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
    if (m.t === 'init') { viewer.setGeoms(m.geoms); state.actuators = m.actuators; Object.assign(state, { robot: m.robot, jobs: m.jobs, log: m.log, ledger: m.ledger }); render(); }
    else if (m.t === 'state') { viewer.setPoses(m.poses); state.robot = m.robot; renderRobot(); renderJointReadout(); }
    else if (m.t === 'robot') { state.robot = m.robot; render(); }
    else if (m.t === 'jobs') { Object.assign(state, { jobs: m.jobs, log: m.log, ledger: m.ledger }); refreshMe(); render(); }
    else if (m.t === 'toast') toast(m.msg, m.level);
    else if (m.t === 'denied') { state.denied = m.msg; render(); }
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
async function refreshMe() { state.me = await api('/api/me'); renderMe(); }

// ---------- teleop input ----------
const targets = [];
let sendTimer = null, dirty = false; // only send after the human moved a slider, so server-side actions (retract...) aren't overwritten
function startSending() { if (!sendTimer) sendTimer = setInterval(() => { if (dirty && ws?.readyState === 1) { ws.send(JSON.stringify({ t: 'ctrl', targets })); dirty = false; } }, 50); }
function stopSending() { clearInterval(sendTimer); sendTimer = null; }

// ---------- World ID modal ----------
// Real mode uses the official SDK (@worldcoin/idkit-core) against the sandbox; mock mode uses the same
// modal, but the QR points at the local stand-in for World App.
const wid = { open: false, abort: null };
function widShow(html) { $('#wid-body').innerHTML = html; $('#wid').hidden = false; wid.open = true; }
function widClose() { $('#wid').hidden = true; wid.open = false; wid.abort?.abort(); wid.abort = null; }
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
  const label = { auto: `Autonomous · ${r.waypoint}`, stuck: `Stuck · ${r.stuckReason} · holding position`, teleop: 'Human in control' }[r.mode];
  pill.textContent = `${label} · ${r.time}s`; pill.className = `pill ${r.mode}`;
}
function renderMe() {
  const me = state.me; if (!me) return;
  const modeLabel = { idkit: `World ID ${me.environment || ''}`.trim(), oidc: 'World ID sign-in', mock: 'World ID (mock)' }[me.mode] || me.mode;
  $('#me').innerHTML = me.sub
    ? `${humanBadge(me.sub)} <b style="color:var(--success-700)">${me.balance} WLD</b>`
    : `Not verified · ${esc(modeLabel)}`;
}
function renderJointReadout() {
  const r = state.robot; if (!r) return;
  document.querySelectorAll('#job-view .joint').forEach((el, i) => { el.querySelector('.val').textContent = `${r.qpos[i].toFixed(2)} rad`; });
}
function renderBoard() {
  const open = state.jobs.filter((j) => j.state !== 'done');
  $('#pool-count').textContent = open.length ? `${open.length} open` : '';
  $('#jobs').innerHTML = state.jobs.length ? state.jobs.map((j) => `
    <div class="job ${j.state}">
      <div class="title"><span class="urg ${j.urgency}">${j.urgency}</span>${esc(j.title)}</div>
      <div class="reward">${j.reward} WLD</div>
      <div class="meta">#${j.id} · ${j.state}${j.workerSub ? ' · ' + esc(short(j.workerSub)) : ''} · posted ${ago(j.postedAt)}</div>
      <div class="actions">
        ${j.state === 'open' ? `<button class="btn-world" data-claim="${j.id}"><span class="wmark"></span>Accept · Verify with World ID</button>` : ''}
        ${j.state !== 'open' ? `<button class="sec small" data-open="${j.id}">View</button>` : ''}
      </div>
    </div>`).join('') : '<div class="empty">No jobs. The robot is working autonomously. Use the scenario buttons to get it stuck.</div>';
}
function renderLog() {
  $('#log').innerHTML = state.log.map((e) => `<div><b>#${e.jobId}</b> ${esc(e.msg)} <span class="muted">· ${ago(e.at)}</span></div>`).join('') || '<div class="empty">nothing yet</div>';
  const STATUS = { simulated: 'simulated', pending_address: 'waiting for wallet', submitting: 'sending…', submitted: 'sent, confirming…', confirmed: 'confirmed', failed: 'failed' };
  $('#ledger').innerHTML = state.ledger.length ? state.ledger.map((l) => `
    <div>${humanBadge(l.sub)}<span>${l.jobs} job${l.jobs > 1 ? 's' : ''} · <b style="color:var(--success-700)">${l.total} WLD</b></span></div>
    ${l.address ? `<div class="pay-addr">→ <code>${esc(l.address.slice(0, 8))}…${esc(l.address.slice(-6))}</code></div>` : ''}
    ${l.payments.map((p) => `<div class="pay ${p.status}"><span>#${p.jobId} · ${p.amount} WLD</span><span class="pay-status">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${STATUS[p.status] || p.status} ↗</a>` : esc(STATUS[p.status] || p.status)}${p.status === 'failed' ? ` <button class="small sec" data-retry-pay="${p.id}" title="${esc(p.error || '')}">retry</button>` : ''}</span></div>`).join('')}`).join('') : '<span class="muted">no payouts yet</span>';
  const pi = state.me?.payments;
  $('#pay-info').textContent = pi ? (pi.enabled ? `Real payouts in WLD on ${pi.chain} from treasury ${pi.treasury.slice(0, 6)}…${pi.treasury.slice(-4)}` : 'Simulated payouts: set TREASURY_PRIVATE_KEY to pay real WLD on World Chain') : '';
}
let jobViewKey = null;
function renderJobView() {
  const id = currentJobId(), view = $('#job-view');
  const job = id && state.jobs.find((j) => j.id === id);
  if (!job) { view.hidden = true; stopSending(); jobViewKey = null; return; }
  view.hidden = false;
  const mine = state.me && job.claimedBy === state.me.sessionId;
  const inControl = job.state === 'active' && mine && state.robot?.mode === 'teleop';
  const authFailed = location.hash.includes('auth=') ? state.me?.lastError : null;

  // Only rebuild the DOM when something structural changed; otherwise a rebuild mid-drag resets the sliders.
  const r = state.robot || {};
  const key = JSON.stringify([job.id, job.state, mine, inControl, authFailed, state.denied, wid.open, job.doneAt, r.actions, r.resume, state.me?.payoutAddress, state.me?.payments?.enabled]);
  if (key === jobViewKey) {
    const cd = view.querySelector('.countdown');
    if (cd) cd.textContent = `${Math.max(0, (job.claimExpiresAt - Date.now()) / 1000) | 0}s`;
    renderJointReadout();
    return;
  }
  jobViewKey = key;

  let cls = 'warn', stateLine;
  if (job.state === 'done') { cls = 'ok'; stateLine = `Completed. ${job.reward} WLD paid to ${humanBadge(job.workerSub)}`; }
  else if (inControl) { cls = 'ok'; stateLine = `${humanBadge(job.workerSub)} You are teleoperating the robot.`; }
  else if (job.state === 'active') stateLine = 'Another verified human is in control.';
  else if (job.state === 'claimed' && mine) stateLine = `Claimed by you. Verification pending, expires in <span class="countdown">${Math.max(0, (job.claimExpiresAt - Date.now()) / 1000) | 0}s</span>.`;
  else if (job.state === 'claimed') stateLine = 'Claimed by someone else, verification pending.';
  else { cls = 'bad'; stateLine = 'Open. Not verified: control stays locked.'; }
  if (authFailed) { cls = 'bad'; stateLine += `<br>Server rejected verification: ${esc(authFailed)}`; }
  if (state.denied) { cls = 'bad'; stateLine += `<br>${esc(state.denied)}`; }

  view.innerHTML = `
    <h2>${esc(job.title)} <span class="muted">${job.reward} WLD</span></h2>
    <div class="muted">#${job.id} · ${esc(job.detail)}</div>
    <div class="state-line ${cls}"><span>${stateLine}</span></div>
    ${job.state !== 'done' ? `<div class="${inControl ? '' : 'locked'}" data-lock="${job.state === 'active' ? 'Another verified human is in control.' : 'Actions unlock after World ID verification.'}">
      <div class="actions-list">
        ${(r.actions || []).map((a) => `<button class="action ${a.done ? 'done' : ''}" data-action="${a.id}" data-job="${job.id}" ${inControl && a.available ? '' : 'disabled'}>
          <span class="tick">${a.done ? '✓' : ''}</span><span><b>${esc(a.label)}</b><small>${esc(a.desc)}</small></span></button>`).join('')}
      </div>
      <details class="override" ${inControl && (r.actionsDone || []).includes('manual_nudge') ? 'open' : ''}><summary>Manual override (joint sliders)</summary>
        ${state.actuators.map((a, i) => `<div class="joint"><label><span>${esc(a.name)}</span><span class="val">–</span></label>
          <input type="range" min="${a.range[0]}" max="${a.range[1]}" step="0.01" value="${r.ctrl?.[i] ?? 0}" data-i="${i}" ${inControl ? '' : 'disabled'}></div>`).join('')}
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
      ${inControl ? `<button data-complete="${job.id}" ${r.resume ? 'disabled' : ''}>Resume robot &amp; complete job</button>` : ''}
      ${job.state !== 'done' && !inControl ? `<button class="bad" data-forge="${job.id}" title="Posts a fabricated proof straight to the backend">Try a forged proof</button>` : ''}
      <button class="ghost" data-back="1">Back</button>
    </div>`;

  if (inControl) {
    for (let i = 0; i < state.actuators.length; i++) targets[i] = state.robot.ctrl[i];
    view.querySelectorAll('input[type=range]').forEach((inp) => inp.addEventListener('input', () => { targets[+inp.dataset.i] = +inp.value; dirty = true; }));
    startSending();
  } else stopSending();
  renderJointReadout();
}
function render() { renderRobot(); renderMe(); renderBoard(); renderLog(); renderJobView(); }

// ---------- actions ----------
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  try {
    if (b.dataset.claim || b.dataset.retry) {
      const id = b.dataset.claim || b.dataset.retry;
      if (b.dataset.retry) await api(`/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
      await verifyForJob(id);
    } else if (b.dataset.action) {
      const r = await api(`/api/jobs/${b.dataset.job}/action`, { method: 'POST', body: JSON.stringify({ action: b.dataset.action }) });
      // an action may move the arm: resync the manual-override sliders so they don't fight it
      for (let i = 0; i < state.actuators.length; i++) targets[i] = r.robot.ctrl[i];
      document.querySelectorAll('#job-view input[type=range]').forEach((inp) => { inp.value = targets[+inp.dataset.i]; });
      dirty = false;
      toast(`Action sent: ${b.textContent.trim().split('\n')[0]}`, 'ok');
    } else if (b.dataset.cancel) { await api(`/api/jobs/${b.dataset.cancel}/cancel`, { method: 'POST' }); toast('Claim cancelled, job returned to the pool. Robot stays paused.', 'warn'); }
    else if (b.dataset.complete) { const r = await api(`/api/jobs/${b.dataset.complete}/complete`, { method: 'POST' }); await refreshMe(); }
    else if (b.dataset.connectWallet) {
      if (!window.ethereum) return toast('No browser wallet detected. Paste your address instead.', 'warn');
      const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
      await api('/api/me/payout-address', { method: 'POST', body: JSON.stringify({ address }) });
      await refreshMe(); toast(`Payout wallet connected: ${address.slice(0, 8)}…`, 'ok'); jobViewKey = null; render();
    }
    else if (b.dataset.saveAddr) { const address = $('#payout-addr').value.trim(); await api('/api/me/payout-address', { method: 'POST', body: JSON.stringify({ address }) }); await refreshMe(); toast('Payout wallet saved. Pending payouts are being sent.', 'ok'); jobViewKey = null; render(); }
    else if (b.dataset.retryPay) { await api(`/api/payments/${b.dataset.retryPay}/retry`, { method: 'POST' }); }
    else if (b.dataset.forge) { const r = await fetch('/api/demo/forge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json()); toast(`Server rejected the forged proof: ${r.error}`, 'error'); }
    else if (b.dataset.open) location.hash = `#/job/${b.dataset.open}`;
    else if (b.dataset.back) location.hash = '#/';
    else if (b.dataset.s) { await api(`/api/scenario/${b.dataset.s}`, { method: 'POST' }); }
  } catch (e) { toast(e.message, 'error'); widClose(); }
});

setInterval(() => { if (currentJobId()) renderJobView(); }, 1000);
refreshMe().then(connect);
