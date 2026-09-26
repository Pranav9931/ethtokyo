// Persistence on Postgres (Supabase). Enabled when DATABASE_URL is set; otherwise every call is a no-op and
// the app runs in memory. In-memory state stays the source of truth at runtime; the DB is written through on
// every change and read once at boot, so a restart never loses jobs, payouts, worker wallets or used proofs.
import postgres from 'postgres';

const SCHEMA = `
create table if not exists workers (
  nullifier text primary key,
  payout_address text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create table if not exists jobs (
  id text primary key,
  reason text not null,
  title text not null,
  detail text,
  urgency text,
  reward numeric(18,6) not null,
  state text not null,
  worker_nullifier text references workers(nullifier),
  posted_at timestamptz not null,
  activated_at timestamptz,
  done_at timestamptz,
  history jsonb not null default '[]'::jsonb
);
create table if not exists payments (
  id bigserial primary key,
  job_id text references jobs(id),
  nullifier text not null,
  amount numeric(18,6) not null,
  to_address text,
  status text not null,
  tx_hash text,
  tx_url text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists used_proofs (
  key text primary key,
  used_at timestamptz not null default now()
);
create index if not exists payments_nullifier_idx on payments(nullifier);
alter table jobs add column if not exists spec jsonb;
alter table jobs add column if not exists review jsonb;
alter table jobs add column if not exists paid numeric(18,6);
create table if not exists worker_aliases (
  nullifier text primary key,
  canonical text not null,
  linked_at timestamptz not null default now()
);
`;

const ts = (ms) => (ms ? new Date(ms) : null);

export async function createDb(url = process.env.DATABASE_URL) {
  if (!url) return { enabled: false, saveJob: async () => {}, saveWorker: async () => {}, savePayment: async () => 0, saveAlias: async () => {}, claimProof: async () => true, loadAll: async () => null, close: async () => {} };
  const sql = postgres(url, { ssl: 'require', max: 4, idle_timeout: 20, prepare: false, onnotice: () => {} }); // prepare:false for Supabase's transaction pooler
  await sql.unsafe(SCHEMA);

  return {
    enabled: true,
    async saveJob(j) {
      if (j.workerSub) await this.saveWorker(j.workerSub);
      const spec = { steps: j.steps, acceptance: j.acceptance, agent: j.agent, context: j.context, telemetry: j.telemetry };
      await sql`insert into jobs ${sql({ id: j.id, reason: j.reason, title: j.title, detail: j.detail, urgency: j.urgency, reward: j.reward, state: j.state, worker_nullifier: j.workerSub || null, posted_at: ts(j.postedAt), activated_at: ts(j.activatedAt), done_at: ts(j.doneAt), history: j.history, spec, review: j.review || null, paid: j.paid ?? null })}
        on conflict (id) do update set state = excluded.state, worker_nullifier = excluded.worker_nullifier, activated_at = excluded.activated_at, done_at = excluded.done_at, history = excluded.history, spec = excluded.spec, review = excluded.review, paid = excluded.paid`;
    },
    async saveWorker(nullifier, payoutAddress) {
      await sql`insert into workers (nullifier, payout_address) values (${nullifier}, ${payoutAddress ?? null})
        on conflict (nullifier) do update set payout_address = coalesce(${payoutAddress ?? null}, workers.payout_address), last_seen = now()`;
    },
    // Returns the DB id (assigned on first save; the in-memory record keeps it as dbId).
    async savePayment(p) {
      await this.saveWorker(p.sub);
      if (!p.dbId) {
        const [row] = await sql`insert into payments (job_id, nullifier, amount, to_address, status, tx_hash, tx_url, error) values (${p.jobId}, ${p.sub}, ${p.amount}, ${p.to}, ${p.status}, ${p.hash}, ${p.url}, ${p.error}) returning id`;
        p.dbId = Number(row.id);
      } else {
        await sql`update payments set to_address = ${p.to}, status = ${p.status}, tx_hash = ${p.hash}, tx_url = ${p.url}, error = ${p.error}, updated_at = now() where id = ${p.dbId}`;
      }
      return p.dbId;
    },
    async saveAlias(nullifier, canonical) {
      await sql`insert into worker_aliases (nullifier, canonical) values (${nullifier}, ${canonical}) on conflict (nullifier) do update set canonical = excluded.canonical`;
      await sql`update payments set nullifier = ${canonical} where nullifier = ${nullifier}`;
      await sql`update jobs set worker_nullifier = ${canonical} where worker_nullifier = ${nullifier}`;
    },
    // Atomic replay guard: true if this proof key was never seen before.
    async claimProof(key) {
      const rows = await sql`insert into used_proofs (key) values (${key}) on conflict do nothing returning key`;
      return rows.length === 1;
    },
    async loadAll() {
      const [workers, jobs, payments, aliases] = await Promise.all([
        sql`select * from workers`,
        sql`select * from jobs where state = 'done' order by posted_at desc limit 200`,
        sql`select * from payments order by id desc limit 500`,
        sql`select * from worker_aliases`,
      ]);
      return {
        aliases: aliases.map((a) => ({ nullifier: a.nullifier, canonical: a.canonical })),
        workers: workers.map((w) => ({ nullifier: w.nullifier, payoutAddress: w.payout_address })),
        jobs: jobs.map((j) => { const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v); return { id: j.id, reason: j.reason, title: j.title, detail: j.detail, urgency: j.urgency, reward: Number(j.reward), state: j.state, workerSub: j.worker_nullifier, postedAt: +new Date(j.posted_at), activatedAt: j.activated_at ? +new Date(j.activated_at) : null, doneAt: j.done_at ? +new Date(j.done_at) : null, claimedBy: null, claimExpiresAt: null, history: J(j.history) || [], ...(J(j.spec) || {}), review: J(j.review) || null, paid: j.paid == null ? null : Number(j.paid) }; }),
        payments: payments.map((p) => ({ dbId: Number(p.id), id: Number(p.id), jobId: p.job_id, sub: p.nullifier, amount: Number(p.amount), to: p.to_address, status: p.status, hash: p.tx_hash, url: p.tx_url, error: p.error, at: +new Date(p.created_at) })),
      };
    },
    close: () => sql.end(),
  };
}
