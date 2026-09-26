// Tiny client for an external agent session. Usage:
//   node scripts/agent-cli.mjs hello                      announce the agent
//   node scripts/agent-cli.mjs pending                    list open tasks (full payloads)
//   node scripts/agent-cli.mjs respond <taskId> <json>    post a JobSpec / Verdict
//   node scripts/agent-cli.mjs withdraw <jobId> [reason]  take an open/claimed job back (nobody is paid)
import fs from 'node:fs';
const env = Object.fromEntries(fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
const BASE = process.env.BASE || `http://localhost:${env.PORT || 8787}`;
const NAME = process.env.AGENT_NAME || 'Claude Code session';
const H = { authorization: `Bearer ${env.AGENT_TOKEN}`, 'x-agent-name': NAME, 'content-type': 'application/json' };
const [cmd, id, json] = process.argv.slice(2);
const out = (o) => console.log(JSON.stringify(o, null, 1));
if (cmd === 'hello') out(await (await fetch(`${BASE}/api/agent/hello`, { method: 'POST', headers: H })).json());
else if (cmd === 'pending') out(await (await fetch(`${BASE}/api/agent/tasks`, { headers: H })).json());
else if (cmd === 'respond') { const r = await fetch(`${BASE}/api/agent/tasks/${id}`, { method: 'POST', headers: H, body: json }); console.log(r.status, await r.text()); }
else if (cmd === 'withdraw') { const r = await fetch(`${BASE}/api/agent/jobs/${id}/withdraw`, { method: 'POST', headers: H, body: JSON.stringify({ reason: json || 'no longer needed' }) }); console.log(r.status, await r.text()); }
else console.log('usage: hello | pending | respond <taskId> <json> | withdraw <jobId> [reason]');
