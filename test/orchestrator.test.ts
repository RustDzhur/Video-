import { test } from 'node:test';
import assert from 'node:assert/strict';
import { model, shot, world } from './helpers.ts';

test('FREE fails QA -> escalates to CHEAP -> PASS (spec §9)', async () => {
  const w = world([model('f', 'free', { free: true, q: 7 }), model('c', 'cheap', { cps: 0.03, q: 8 })]);
  w.qa.scores.set('f/free', [5.9]);
  w.qa.scores.set('c/cheap', [7.8]);
  const out = await w.orch.produceShot(shot({ importance: 'normal', requiredQuality: 7 }), { mode: 'balanced' });
  assert.equal(out.status, 'passed');
  assert.equal(out.tier, 'cheap');
  assert.deepEqual(out.attempts.map((a) => a.decision), ['ESCALATE', 'PASS']);
  assert.ok(Math.abs(out.totalCost - 0.15) < 1e-9);
});

test('small QA miss regenerates in-tier but never exceeds max_attempts_per_tier', async () => {
  const w = world([model('f', 'free', { free: true, q: 7 }), model('c', 'cheap', { cps: 0.03, q: 8 })]);
  w.qa.scores.set('f/free', [6.6, 6.6, 6.6, 6.6]);
  w.qa.scores.set('c/cheap', [8]);
  const out = await w.orch.produceShot(shot({ importance: 'normal', requiredQuality: 7 }), { mode: 'balanced' });
  const free = out.attempts.filter((a) => a.tier === 'free');
  assert.equal(free.length, 2); // FREE: 2 attempts, then escalate
  assert.equal(out.tier, 'cheap');
});

test('failure with every tier exhausted returns best effort, status failed', async () => {
  const w = world([model('f', 'free', { free: true, q: 7 })]);
  w.qa.scores.set('f/free', [6.5, 6.2, 6.0, 6.0]);
  const out = await w.orch.produceShot(shot({ importance: 'normal', requiredQuality: 7 }), { mode: 'balanced' });
  assert.equal(out.status, 'failed');
  assert.equal(out.attempts.length, 2);
  assert.equal(out.bestEffort?.score?.overall, 6.5);
});

test('provider failure is not charged, releases reservation and falls to next model', async () => {
  const w = world([model('c1', 'a', { cps: 0.02, q: 8 }), model('c2', 'b', { cps: 0.03, q: 8 })]);
  w.provider.failModels.add('c1/a');
  const out = await w.orch.produceShot(shot(), { mode: 'balanced' });
  assert.equal(out.status, 'passed');
  assert.equal(out.modelId, 'c2/b');
  assert.equal(w.budget.snapshot().reserved, 0);
  const s = w.ledger.summary({ tenantId: 't1' });
  assert.equal(s.failedCost, 0);
  assert.equal(s.count, 2);
});

test('budget: hard limit stops spending; spent is tracked per tenant/project', async () => {
  const w = world([model('c', 'cheap', { cps: 0.1, q: 8 })], 0.3); // 5s * 0.1 = 0.5 > 0.3
  const out = await w.orch.produceShot(shot(), { mode: 'balanced' });
  assert.equal(out.status, 'failed');
  assert.equal(w.provider.calls.length, 0);
  assert.equal(w.budget.snapshot().spent, 0);
});

test('result cache returns existing result with zero cost (no second API call)', async () => {
  const w = world([model('c', 'cheap', { cps: 0.03, q: 8 })]);
  const a = await w.orch.produceShot(shot(), { mode: 'balanced' });
  const b = await w.orch.produceShot(shot({ shotId: 'sh2' }), { mode: 'balanced' });
  assert.equal(a.status, 'passed');
  assert.equal(b.cached, true);
  assert.equal(w.provider.calls.length, 1);
  assert.equal(w.ledger.summary({ tenantId: 't1' }).actual, a.totalCost);
});

test('idempotency: identical idempotency keys are never paid twice', async () => {
  const w = world([model('c', 'cheap', { cps: 0.03, q: 8 })]);
  w.qa.scores.set('c/cheap', [5, 5]); // forces non-cacheable fail
  const s = shot({ requiredQuality: 7 });
  await w.orch.produceShot(s, { mode: 'balanced' });
  const calls = w.provider.calls.length;
  const spent = w.budget.snapshot().spent;
  const again = await w.orch.produceShot(s, { mode: 'balanced' });
  assert.equal(w.provider.calls.length, calls);
  assert.equal(w.budget.snapshot().spent, spent);
  assert.ok(again.attempts.every((a) => a.replayed));
});

test('continuity: first passing model becomes the group anchor for later shots', async () => {
  const w = world([model('f', 'free', { free: true, q: 7.5, family: 'F' }), model('c', 'cheap', { cps: 0.03, q: 8, family: 'C' })]);
  w.qa.scores.set('f/free', [4]); // shot 1: free fails, cheap passes -> anchor = cheap
  const s1 = shot({ shotId: 'a', prompt: 'p1', importance: 'normal', requiredQuality: 7, continuity: { groupId: 'CG' } });
  const s2 = shot({ shotId: 'b', prompt: 'p2', importance: 'normal', requiredQuality: 7, continuity: { groupId: 'CG' } });
  const o1 = await w.orch.produceShot(s1, { mode: 'balanced' });
  const o2 = await w.orch.produceShot(s2, { mode: 'balanced' });
  assert.equal(o1.modelId, 'c/cheap');
  assert.equal(o2.modelId, 'c/cheap'); // would have been free without the continuity lock
});

test('ledger summary: tier shares, per-shot cost, savings vs all-premium', async () => {
  const w = world([model('f', 'free', { free: true, q: 7 }), model('p', 'prem', { cps: 0.5, q: 9 })]);
  await w.orch.produceShot(shot({ prompt: 'x' }), { mode: 'balanced' });
  const s = w.ledger.summary({ tenantId: 't1' });
  assert.equal(s.byTier.free.count, 1);
  assert.equal(s.premiumBaseline, 2.5);
  assert.equal(s.saved, 2.5);
  assert.equal(w.ledger.summary({ tenantId: 'other' }).count, 0); // tenant isolation
  assert.equal(w.decisionLog.forShot('t1', 'sh1').length, 1);
});
