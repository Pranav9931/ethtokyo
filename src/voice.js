// Voice link between the operator and the robot's speaker.
//   sender:   push-to-talk. Microphone -> MediaRecorder (opus) chunks + live transcript (Web Speech API) over the WebSocket.
//   receiver: plays relayed chunks through MediaSource (the robot "speaks" on every other client) and shows the transcript.
const MIME = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m));

export function createTalker({ send, onState = () => {}, onLocalTranscript = () => {} }) {
  let rec = null, stream = null, sr = null, seq = 0, active = false;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const toB64 = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result.split(',')[1]); r.readAsDataURL(blob); });

  async function start() {
    if (active) return; active = true;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
    catch (e) { active = false; onState({ error: 'microphone unavailable: ' + e.message }); return; }
    seq = 0; send({ t: 'voice', kind: 'start', mime: MIME });
    rec = new MediaRecorder(stream, MIME ? { mimeType: MIME, audioBitsPerSecond: 32_000 } : undefined);
    rec.ondataavailable = async (ev) => { if (!ev.data.size) return; send({ t: 'voice', kind: 'audio', seq: seq++, data: await toB64(ev.data) }); };
    rec.start(250);
    if (SR) {
      sr = new SR(); sr.continuous = true; sr.interimResults = true; sr.lang = navigator.language || 'en-US';
      sr.onresult = (ev) => {
        let interim = '', finals = [];
        for (let i = ev.resultIndex; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) finals.push(r[0].transcript.trim()); else interim += r[0].transcript; }
        for (const f of finals) { send({ t: 'voice', kind: 'transcript', text: f, final: true }); onLocalTranscript(f, true); }
        if (interim) { send({ t: 'voice', kind: 'transcript', text: interim, final: false }); onLocalTranscript(interim, false); }
      };
      sr.onerror = () => {};
      try { sr.start(); } catch {}
    }
    onState({ talking: true, transcription: !!SR });
  }
  function stop() {
    if (!active) return; active = false;
    try { rec?.state !== 'inactive' && rec.stop(); } catch {}
    try { sr?.stop(); } catch {}
    stream?.getTracks().forEach((t) => t.stop());
    setTimeout(() => send({ t: 'voice', kind: 'stop' }), 300);
    onState({ talking: false });
  }
  return { start, stop, get active() { return active; }, supported: !!navigator.mediaDevices && !!MIME, transcription: !!SR };
}

export function createSpeaker({ onTranscript = () => {} } = {}) {
  let audio = null, ms = null, sb = null, queue = [], mime = null, muted = false;
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  function reset() { try { audio?.pause(); } catch {} audio = null; ms = null; sb = null; queue = []; }
  function begin(m) {
    reset(); mime = m || 'audio/webm;codecs=opus';
    if (!('MediaSource' in window) || !MediaSource.isTypeSupported(mime)) return;
    ms = new MediaSource(); audio = new Audio(); audio.src = URL.createObjectURL(ms); audio.muted = muted; audio.autoplay = true;
    ms.addEventListener('sourceopen', () => { sb = ms.addSourceBuffer(mime); sb.mode = 'sequence'; sb.addEventListener('updateend', pump); pump(); });
    audio.play().catch(() => {}); // needs a prior user gesture on the page; toasts will still show transcripts
  }
  function pump() { if (!sb || sb.updating || !queue.length) return; try { sb.appendBuffer(queue.shift()); } catch {} }
  function handle(m) {
    if (m.kind === 'start') begin(m.mime);
    else if (m.kind === 'audio') { if (!ms) begin(mime); queue.push(b64(m.data)); pump(); }
    else if (m.kind === 'stop') { setTimeout(() => { try { ms?.readyState === 'open' && !sb?.updating && ms.endOfStream(); } catch {} }, 500); }
    else if (m.kind === 'transcript') onTranscript(m.text, m.final);
  }
  return { handle, set muted(v) { muted = v; if (audio) audio.muted = v; } };
}

// Speech bubble anchored above the robot's head (screen-space, follows the camera).
export function createBubble(container, projectHead) {
  const el = document.createElement('div'); el.className = 'robot-bubble'; el.hidden = true; container.appendChild(el);
  const log = []; let hideTimer = null, current = '';
  function show(text, final) {
    current = text; el.hidden = false; el.classList.toggle('interim', !final); el.textContent = text;
    if (final) { log.unshift({ text, at: Date.now() }); log.length = Math.min(log.length, 8); }
    clearTimeout(hideTimer); hideTimer = setTimeout(() => { el.hidden = true; }, final ? 5000 : 15000);
    el.title = log.map((l) => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`).join('\n');
  }
  function tick() { if (!el.hidden) { const p = projectHead(); if (p) { el.style.left = `${p.x}px`; el.style.top = `${p.y - 28}px`; } } requestAnimationFrame(tick); }
  tick();
  return { show, log };
}
