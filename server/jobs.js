// Job pool + claim state machine. In-memory; a demo doesn't need more.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const CLAIM_TTL_MS = 120_000; // verification must complete within 2 minutes

export class Jobs extends EventEmitter {
  constructor(db) { super(); this.jobs = new Map(); this.log = []; this.db = db; }
  hydrate(rows) { for (const j of rows) this.jobs.set(j.id, j); }

  post({ reason, title, detail, urgency, reward }) {
    const job = {
      id: randomUUID().slice(0, 8), reason, title, detail, urgency, reward,
      state: 'open',                 // open | claimed | active | done
      postedAt: Date.now(), claimedBy: null, claimExpiresAt: null, workerSub: null, activatedAt: null, doneAt: null,
      history: [],
    };
    this.jobs.set(job.id, job);
    this.note(job, 'posted to the global pool');
    return job;
  }
  clear() { this.jobs.clear(); this.log.length = 0; this.emit('change', null); }
  get(id) { return this.jobs.get(id); }
  list() { return [...this.jobs.values()].sort((a, b) => b.postedAt - a.postedAt); }
  current() { return this.list().find(j => j.state !== 'done') || null; }

  claim(id, sessionId) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'open') return null;
    job.state = 'claimed'; job.claimedBy = sessionId; job.claimExpiresAt = Date.now() + CLAIM_TTL_MS;
    this.note(job, 'claimed, awaiting World ID verification');
    return job;
  }
  activate(id, sessionId, sub) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'claimed' || job.claimedBy !== sessionId) return null;
    if (Date.now() > job.claimExpiresAt) { this.release(id, 'claim expired before verification finished'); return null; }
    job.state = 'active'; job.workerSub = sub; job.activatedAt = Date.now(); job.claimExpiresAt = null;
    this.note(job, 'World ID verified, control unlocked');
    return job;
  }
  release(id, why) {
    const job = this.jobs.get(id);
    if (!job || job.state === 'done' || job.state === 'open') return null;
    job.state = 'open'; job.claimedBy = null; job.claimExpiresAt = null; job.workerSub = null;
    this.note(job, `back in the pool: ${why}`);
    return job;
  }
  complete(id, sessionId) {
    const job = this.jobs.get(id);
    if (!job || job.state !== 'active' || job.claimedBy !== sessionId) return null;
    job.state = 'done'; job.doneAt = Date.now();
    this.note(job, `completed, ${job.reward} WLD paid to ${job.workerSub.slice(0, 10)}…`);
    return job;
  }
  sweepExpired() {
    const now = Date.now(), expired = [];
    for (const j of this.jobs.values()) if (j.state === 'claimed' && now > j.claimExpiresAt) { this.release(j.id, 'verification timed out'); expired.push(j); }
    return expired;
  }
  note(job, msg) {
    const entry = { at: Date.now(), msg };
    job.history.push(entry);
    this.log.unshift({ jobId: job.id, ...entry }); this.log.length = Math.min(this.log.length, 50);
    this.emit('change', job);
    this.db?.saveJob(job).catch((e) => console.error('[db] saveJob', e.message));
  }
}

// Payouts keyed by the World ID `sub`. Same human => same sub => one balance.
// Payouts keyed by the World ID identity (nullifier): same human => same identity => one balance, one payout wallet.
// Payment: { id, sub, amount, jobId, to, status: simulated | pending_address | submitting | submitted | confirmed | failed, hash, url, error, at }
export class Ledger extends EventEmitter {
  constructor(payments, db) { super(); this.payments = payments; this.db = db; this.list = []; this.addresses = new Map(); this.seq = 0; }
  hydrate({ workers, payments }) {
    for (const w of workers) if (w.payoutAddress) this.addresses.set(w.nullifier, w.payoutAddress);
    this.list = payments; this.seq = payments.reduce((m, p) => Math.max(m, p.id), 0);
  }
  persist(p) { this.db?.savePayment(p).catch((e) => console.error('[db] savePayment', e.message)); }
  address(sub) { return this.addresses.get(sub) || null; }
  setAddress(sub, address) {
    this.addresses.set(sub, address);
    this.db?.saveWorker(sub, address).catch((e) => console.error('[db] saveWorker', e.message));
    for (const p of this.list) if (p.sub === sub && p.status === 'pending_address') { p.to = address; this.submit(p); }
    this.emit('change');
  }
  pay(sub, amount, jobId) {
    const p = { id: ++this.seq, sub, amount, jobId, to: this.address(sub), status: 'simulated', hash: null, url: null, error: null, at: Date.now() };
    this.list.unshift(p);
    if (this.payments?.info().enabled) { if (p.to) this.submit(p); else p.status = 'pending_address'; }
    this.persist(p);
    this.emit('change');
    return p;
  }
  async submit(p) {
    p.status = 'submitting'; p.error = null; this.emit('change');
    try {
      const { hash, url, confirmed } = await this.payments.send(p.to, p.amount);
      p.hash = hash; p.url = url; p.status = 'submitted'; this.persist(p); this.emit('change');
      confirmed.then((ok) => { p.status = ok ? 'confirmed' : 'failed'; if (!ok) p.error = 'transaction reverted'; this.persist(p); this.emit('change'); })
        .catch((e) => { p.status = 'failed'; p.error = (e.shortMessage || e.message || '').slice(0, 200); this.persist(p); this.emit('change'); });
    } catch (e) { p.status = 'failed'; p.error = (e.shortMessage || e.message || '').slice(0, 200); this.persist(p); this.emit('change'); }
  }
  retry(id) { const p = this.list.find((x) => x.id === id); if (p && p.status === 'failed' && p.to) this.submit(p); return p; }
  balance(sub) { return +this.list.filter((p) => p.sub === sub && p.status !== 'failed').reduce((a, p) => a + p.amount, 0).toFixed(4); }
  summary() {
    const by = new Map();
    for (const p of this.list) {
      const e = by.get(p.sub) || { sub: p.sub, total: 0, jobs: 0, address: this.address(p.sub), payments: [] };
      if (p.status !== 'failed') e.total = +(e.total + p.amount).toFixed(4);
      e.jobs++;
      e.payments.push({ id: p.id, amount: p.amount, jobId: p.jobId, status: p.status, hash: p.hash, url: p.url, error: p.error, at: p.at });
      by.set(p.sub, e);
    }
    return [...by.values()];
  }
}
