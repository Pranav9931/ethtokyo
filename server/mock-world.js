// Stand-in for the World App when no sandbox credentials are configured.
// The browser shows the normal "Connect your World ID" modal with a QR code;
// that QR encodes a link to this page, which plays the phone's role and lets
// the presenter choose the outcome: verify, cancel, or hand back a tampered proof.
import { randomUUID } from 'node:crypto';
import express from 'express';

export function createMockWorldApp(worldId) {
  const router = express.Router();

  router.get('/connect', (req, res) => {
    const id = String(req.query.r || '');
    const person = req.cookies?.mock_person || randomUUID();
    res.cookie('mock_person', person, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    const st = worldId.mockStatus(id);
    const done = st.status !== 'pending';
    res.type('html').send(`<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><title>World App (mock)</title>
<style>
:root{--g0:#fff;--g100:#F3F4F5;--g200:#EBECEF;--g500:#717680;--g900:#181818;--ok:#00C230;--err:#F2280D}
body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--g100);color:var(--g900);display:grid;place-items:center;min-height:100vh}
.phone{width:360px;max-width:calc(100vw - 32px);background:var(--g0);border-radius:28px;padding:24px;box-shadow:0 20px 60px rgba(0,0,0,.12)}
.top{display:flex;align-items:center;gap:10px;color:var(--g500);font-size:13px;margin-bottom:20px}
.mark{width:28px;height:28px;border-radius:50%;border:3px solid var(--g900);position:relative}.mark:after{content:'';position:absolute;inset:6px;border-radius:50%;background:var(--g900)}
h1{font-size:22px;letter-spacing:-.01em;margin:0 0 6px}p{color:var(--g500);margin:0 0 20px;font-size:14px}
.req{background:var(--g100);border-radius:16px;padding:14px 16px;font-size:13px;margin-bottom:20px}.req b{display:block;color:var(--g900)}
a{display:block;text-align:center;padding:14px;border-radius:999px;margin-top:10px;text-decoration:none;font-weight:600;font-size:15px;color:#fff;background:var(--g900)}
a.sec{background:var(--g100);color:var(--g900)}a.bad{background:#FEE9E7;color:var(--err)}
.done{text-align:center;padding:30px 0}.done .ic{width:56px;height:56px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;color:#fff;font-size:26px;background:var(--ok)}
.done.fail .ic{background:var(--err)}small{display:block;text-align:center;color:var(--g500);margin-top:18px;font-size:12px}
</style>
<div class=phone>
<div class=top><span class=mark></span> World App · sandbox (mock)</div>
${done ? `<div class="done ${st.status === 'confirmed' ? '' : 'fail'}"><div class=ic>${st.status === 'confirmed' ? '✓' : '✕'}</div><h1>${st.status === 'confirmed' ? 'Verified' : 'Request cancelled'}</h1><p>You can close this and go back to the job.</p></div>`
: st.status === 'unknown' ? `<h1>Request expired</h1><p>Go back and start the verification again.</p>`
: `<h1>Verify you're human</h1><p><b>Robot Rescue</b> wants to confirm you are a unique human before unlocking robot control.</p>
<div class=req>Action <b>rescue-robot</b></div>
<a href="/mock-world/act?r=${id}&o=verify">Verify with World ID</a>
<a class=sec href="/mock-world/act?r=${id}&o=cancel">Cancel</a>
<a class=bad href="/mock-world/act?r=${id}&o=tamper">Return a tampered proof (demo)</a>
<small>This page stands in for the phone. Configure WORLD_APP_ID / WORLD_RP_ID / WORLD_SIGNING_KEY to use the real sandbox World App.</small>`}
</div>`);
  });

  router.get('/act', (req, res) => {
    const person = req.cookies?.mock_person || randomUUID();
    res.cookie('mock_person', person, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
    worldId.mockComplete(String(req.query.r || ''), String(req.query.o || ''), person);
    res.redirect(`/mock-world/connect?r=${encodeURIComponent(String(req.query.r || ''))}`);
  });
  return router;
}
