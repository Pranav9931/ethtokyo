// The robot's agent. When the robot gets stuck it is handed the situation and decides what to ask a human
// for: it writes the job (title, brief, steps, acceptance criteria, urgency, reward). When the human is done
// it reviews the telemetry, verifies the outcome and scores efficiency; the payout is scaled by that score.
//
// Backed by Claude (ANTHROPIC_API_KEY). Without a key, or if the model is unreachable, a rule-based fallback
// produces the same shapes so the pipeline never blocks on the agent.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

export const MODEL = process.env.AGENT_MODEL || 'claude-opus-5';
export const REWARD_RANGE = { min: 0.05, max: 0.1 }; // WLD

const JobSpec = z.object({
  title: z.string().max(60).describe('Short headline for the job board'),
  brief: z.string().max(400).describe('What went wrong and what the robot needs, in plain language for a remote operator'),
  steps: z.array(z.string().max(120)).min(1).max(5).describe('What the operator should do, in order, using the available actions'),
  acceptance: z.array(z.string().max(120)).min(1).max(4).describe('What must be true for the job to count as done'),
  urgency: z.enum(['low', 'medium', 'high']),
  reward_wld: z.number().min(REWARD_RANGE.min).max(REWARD_RANGE.max).describe('Reward in WLD within the allowed range; higher for safety-critical or harder recoveries'),
  reasoning: z.string().max(300).describe('One or two sentences on why a human is needed and how the reward was chosen'),
});

const Verdict = z.object({
  approved: z.boolean().describe('Whether the job was completed properly'),
  efficiency: z.number().int().min(0).max(100).describe('0-100 quality/efficiency score'),
  payout_fraction: z.number().min(0).max(1).describe('Fraction of the reward to pay: 1 whenever the job is approved with efficiency above 50, 0 when not approved; only a low-efficiency approval (50 or below) pays a partial amount, efficiency/100'),
  summary: z.string().max(300).describe('Two sentences for the operator: what was done well, what cost points'),
});

const SYSTEM = `You are the onboard agent of an autonomous Unitree G1 humanoid robot working at a bench in a factory cell.
When the robot cannot safely continue on its own, you request help from a verified human teleoperator through a public job board,
and afterwards you verify their work and decide how much of the reward they earned. Be concrete, brief and fair.
Workers are anonymous humans verified with World ID; rewards are paid in WLD tokens. Never ask for anything outside the available actions.`;

// AGENT_MODE: 'external' = a connected agent (e.g. a Claude Code / Codex session) picks tasks up over the HTTP API
// and posts its decisions back; 'claude' = call the Claude API directly; 'rules' = built-in fallback.
export const AGENT_MODE = process.env.AGENT_MODE || (process.env.ANTHROPIC_API_KEY ? 'claude' : 'rules');
export const EXTERNAL_TIMEOUT_MS = +(process.env.AGENT_EXTERNAL_TIMEOUT_MS || 180_000);

// Payout policy: an approved job above 50% efficiency earns the full reward. At or below 50% it earns the
// efficiency share; a rejected job earns nothing. Applied to every verdict, whichever agent produced it.
export function payoutFraction({ approved, efficiency }) {
  if (!approved) return 0;
  return efficiency > 50 ? 1 : Math.max(0, Math.min(1, efficiency / 100));
}

export function createAgent({ apiKey = process.env.ANTHROPIC_API_KEY, mode = AGENT_MODE } = {}) {
  const client = mode === 'claude' && apiKey ? new Anthropic({ apiKey }) : null;
  const info = () => ({ enabled: mode === 'external' || !!client, mode, model: mode === 'external' ? (external.name || 'external agent (waiting for connection)') : client ? MODEL : 'rule-based fallback' });

  // ---- external agent task queue: { id, type: 'author'|'review', payload, createdAt, resolve }
  const external = { name: null, lastSeen: 0, tasks: new Map(), seq: 0, log: [] };
  function enqueue(type, payload, fallback) {
    const id = `${type}-${++external.seq}-${Date.now().toString(36)}`;
    return new Promise((resolve) => {
      const task = { id, type, payload, createdAt: Date.now(), resolve: (r) => { external.tasks.delete(id); clearTimeout(task.timer); resolve(r); } };
      task.timer = setTimeout(() => { console.warn(`[agent] external agent did not answer ${id} in time; using fallback`); task.resolve(fallback()); }, EXTERNAL_TIMEOUT_MS);
      external.tasks.set(id, task);
    });
  }
  const pendingTasks = () => [...external.tasks.values()].map(({ id, type, payload, createdAt }) => ({ id, type, payload, createdAt, ageSeconds: Math.round((Date.now() - createdAt) / 1000) }));
  function heartbeat(name) { external.name = name || external.name || 'external agent'; external.lastSeen = Date.now(); }
  function resolveTask(id, result) {
    const task = external.tasks.get(id); if (!task) return { ok: false, error: 'unknown or expired task' };
    let parsed;
    try { parsed = task.type === 'author' ? JobSpec.parse(result) : Verdict.parse(result); }
    catch (e) { return { ok: false, error: 'result does not match the schema: ' + (e.issues || []).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }; }
    if (task.type === 'author') parsed = { ...parsed, reward_wld: +Math.min(REWARD_RANGE.max, Math.max(REWARD_RANGE.min, parsed.reward_wld)).toFixed(4), source: external.name || 'external agent' };
    else parsed = { ...parsed, payout_fraction: payoutFraction(parsed), source: external.name || 'external agent' };
    external.log.unshift({ id, type: task.type, at: Date.now() }); external.log.length = Math.min(external.log.length, 50);
    task.resolve(parsed);
    return { ok: true };
  }

  async function callParsed(schema, user, { effort = 'low', timeoutMs = 25_000 } = {}) {
    if (!client) return null;
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await client.messages.parse({
        model: MODEL, max_tokens: 4000,
        thinking: { type: 'adaptive' }, output_config: { effort, format: zodOutputFormat(schema) },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: user }],
      }, { signal: ctrl.signal });
      if (res.stop_reason === 'refusal') { console.warn('[agent] refusal', res.stop_details?.category); return null; }
      return res.parsed_output ?? null;
    } catch (e) {
      if (e instanceof Anthropic.RateLimitError) console.warn('[agent] rate limited');
      else if (e instanceof Anthropic.AuthenticationError) console.warn('[agent] invalid ANTHROPIC_API_KEY');
      else if (e instanceof Anthropic.APIError) console.warn(`[agent] API error ${e.status}: ${e.message}`);
      else console.warn('[agent]', e.name === 'AbortError' ? `timed out after ${timeoutMs} ms` : e.message);
      return null;
    } finally { clearTimeout(timer); }
  }

  // ---- 1. The robot is stuck: decide what to ask for and post it.
  async function authorJob(situation) {
    const fallback = {
      title: situation.template.title, brief: situation.template.detail,
      steps: situation.actions.map((a) => a.label), acceptance: [situation.resumeCondition],
      urgency: situation.template.urgency, reward_wld: situation.template.reward,
      reasoning: 'Rule-based fallback: no agent model configured.', source: 'fallback',
    };
    const user = `The robot just stopped and is holding position. Write the help request.

Situation (from onboard telemetry):
${JSON.stringify(situation.telemetry, null, 1)}

Stuck reason code: ${situation.reason}
Actions the operator will be able to trigger (use these names in the steps): ${situation.actions.map((a) => `${a.id} = "${a.label}": ${a.desc}`).join('; ')}
The operator can also pose the robot manually (drag limbs, joint sliders).
Condition the robot needs before it may resume: ${situation.resumeCondition}
Reward must be between ${REWARD_RANGE.min} and ${REWARD_RANGE.max} WLD. Expected effort: ${situation.template.urgency} urgency.`;
    if (mode === 'external') return enqueue('author', { instructions: user, situation, schema: 'JobSpec' }, () => fallback);
    const spec = await callParsed(JobSpec, user, { effort: 'low', timeoutMs: 25_000 });
    if (!spec) return fallback;
    return { ...spec, reward_wld: +Math.min(REWARD_RANGE.max, Math.max(REWARD_RANGE.min, spec.reward_wld)).toFixed(4), source: MODEL };
  }

  // ---- 2. The human says they are done: verify and score.
  async function reviewJob(job, telemetry) {
    const fallback = () => {
      const ok = !telemetry.resume_blocker;
      const eff = ok ? Math.max(40, 100 - 5 * telemetry.premature_complete_attempts - Math.max(0, Math.round((telemetry.seconds_in_control - 60) / 10))) : 0;
      const v = { approved: ok, efficiency: eff, summary: ok ? 'Rule-based review: resume condition met.' : 'Rule-based review: resume condition not met.', source: 'fallback' };
      return { ...v, payout_fraction: payoutFraction(v) };
    };
    const user = `Review this completed teleoperation job and score it.

Job you posted: ${JSON.stringify({ title: job.title, brief: job.detail, steps: job.steps, acceptance: job.acceptance, reward_wld: job.reward }, null, 1)}

Telemetry from the session:
${JSON.stringify(telemetry, null, 1)}

Scoring guidance: approve if the acceptance criteria are met and the robot can safely resume. Efficiency rewards doing the right actions
in a sensible order without unnecessary manual flailing, finishing in reasonable time, and not attempting to resume before it was safe.
payout_fraction is 0 when not approved; when approved with efficiency above 50 it is exactly 1 (the full reward is paid); an approved job at 50 or below pays efficiency/100.`;
    if (mode === 'external') return enqueue('review', { instructions: user, job: { id: job.id, title: job.title, brief: job.detail, steps: job.steps, acceptance: job.acceptance, reward_wld: job.reward }, telemetry, schema: 'Verdict' }, fallback);
    const v = await callParsed(Verdict, user, { effort: 'low', timeoutMs: 25_000 });
    if (!v) return fallback();
    return { ...v, payout_fraction: payoutFraction(v), source: MODEL };
  }

  return { info, authorJob, reviewJob, pendingTasks, resolveTask, heartbeat, external, schemas: { JobSpec, Verdict } };
}
