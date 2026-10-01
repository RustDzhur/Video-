import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelRegistry, ProviderHealth } from '../src/index.ts';
import { cfg, model, shot, world } from './helpers.ts';

const budget = (remaining = 50, shotSpent = 0, emergency = false) => ({ remaining, shotSpent, emergency });

test('tiers derive from config thresholds, never from model names', () => {
  const r = new ModelRegistry(cfg);
  assert.equal(r.upsert(model('a', 'x', { free: true })).tier, 'free');
  assert.equal(r.upsert(model('a', 'y', { freeQuota: true })).tier, 'free_tier');
  assert.equal(r.upsert(model('a', 'c', { cps: 0.03 })).tier, 'cheap');
  assert.equal(r.upsert(model('a', 's', { cps: 0.1 })).tier, 'standard');
  assert.equal(r.upsert(model('a', 'p', { cps: 0.5 })).tier, 'premium');
});

test('background shot uses the FREE model (spec §6)', () => {
  const w = world([model('f', 'free', { free: true, q: 6.2 }), model('p', 'prem', { cps: 0.5, q: 9.2 })]);
  const res = w.router.select({ shot: shot(), budget: budget(), mode: 'balanced' });
  assert.equal(res.strategy?.tier, 'free');
  assert.equal(res.strategy?.estimatedCost, 0);
});

test('hero shot rejects free/cheap/standard by quality and accepts premium (spec §7)', () => {
  const w = world([
    model('f', 'free', { free: true, q: 5.8 }), model('c', 'cheap', { cps: 0.03, q: 7.2 }),
    model('s', 'std', { cps: 0.1, q: 8.3 }), model('p', 'prem', { cps: 0.5, q: 9.1 }),
  ]);
  const res = w.router.select({
    shot: shot({ importance: 'hero', requiredQuality: 9, budget: { preferred: 2, max: 4, hardLimit: 5 } }), budget: budget(), mode: 'balanced',
  });
  assert.equal(`${res.strategy?.provider}/${res.strategy?.model}`, 'p/prem');
  const rejected = res.decisions.filter((d) => d.verdict === 'rejected').map((d) => d.modelId);
  assert.deepEqual(rejected.sort(), ['c/cheap', 'f/free', 's/std']);
  assert.match(res.decisions.find((d) => d.modelId === 'f/free')!.reason, /quality 5\.8 < required 9\.0/);
});

test('hard budget limit is absolute; background never reaches premium', () => {
  const w = world([model('p', 'prem', { cps: 0.5, q: 9.5 })]);
  const hero = shot({ importance: 'hero', requiredQuality: 9, budget: { preferred: 1, max: 2, hardLimit: 2 } }); // 5s*0.5=2.5 > 2
  const res = w.router.select({ shot: hero, budget: budget(), mode: 'balanced' });
  assert.equal(res.strategy, null);
  assert.match(res.decisions[0]!.reason, /hard limit/);
  const bg = w.router.select({ shot: shot({ requiredQuality: 6 }), budget: budget(), mode: 'balanced' });
  assert.equal(bg.strategy, null);
});

test('capability check excludes models that cannot do the shot', () => {
  const w = world([
    model('a', 'nochar', { cps: 0.02, q: 9, capabilities: { textToVideo: true } }),
    model('b', 'char', { cps: 0.04, q: 9 }),
  ]);
  const res = w.router.select({ shot: shot({ needs: { characterReference: true } }), budget: budget(), mode: 'balanced' });
  assert.equal(res.strategy?.model, 'char');
  assert.match(res.decisions.find((d) => d.modelId === 'a/nochar')!.reason, /character_reference/);
});

test('quota-aware: exhausted free provider is skipped, falls to next', () => {
  const w = world([model('f1', 'a', { freeQuota: true, q: 8 }), model('f2', 'b', { freeQuota: true, q: 7 })]);
  w.quotas.set('f1', { remaining: 0, resetAt: Date.now() + 3600_000 });
  const res = w.router.select({ shot: shot(), budget: budget(), mode: 'balanced' });
  assert.equal(res.strategy?.provider, 'f2');
  assert.match(res.decisions.find((d) => d.modelId === 'f1/a')!.reason, /quota exhausted/);
});

test('quota resets at resetAt', () => {
  const w = world([model('f1', 'a', { freeQuota: true, q: 8 })]);
  w.quotas.set('f1', { remaining: 0, limit: 10, resetAt: 1000 });
  assert.equal(w.quotas.canUse('f1', 1, 999), false);
  assert.equal(w.quotas.canUse('f1', 1, 1001), true);
});

test('circuit breaker opens on high error rate and recovers after cooldown', () => {
  let t = 0;
  const h = new ProviderHealth({ minSamples: 4, cooldownMs: 1000 }, () => t);
  for (let i = 0; i < 4; i++) h.record('p', false);
  assert.equal(h.isOpen('p'), true);
  t = 1500;
  assert.equal(h.isOpen('p'), false); // half-open probe
  h.record('p', true);
  assert.equal(h.isOpen('p'), false);
});

test('model lock: only locked model on QA path; fallback only when it is unavailable', () => {
  const w = world([model('a', 'locked', { cps: 0.08, q: 8 }), model('b', 'other', { cps: 0.02, q: 9 })]);
  const s = shot({ modelLock: { modelId: 'a/locked' }, importance: 'important', requiredQuality: 8 });
  const r1 = w.router.select({ shot: s, budget: budget(), mode: 'balanced' });
  assert.equal(r1.strategy?.model, 'locked');
  assert.equal(r1.strategy?.fallbackChain[1]?.availabilityFallbackOnly, true);
  const r2 = w.router.select({ shot: s, budget: budget(), mode: 'balanced', unavailable: new Set(['a/locked']) });
  assert.equal(r2.strategy?.model, 'other');
});

test('continuity anchor keeps the same model first even if a cheaper tier exists', () => {
  const w = world([model('f', 'free', { free: true, q: 8, family: 'F' }), model('c', 'cheap', { cps: 0.03, q: 8, family: 'C' })]);
  const r = w.router.select({
    shot: shot({ continuity: { groupId: 'CG-1' } }), budget: budget(), mode: 'balanced', continuityAnchor: { modelId: 'c/cheap', family: 'C' },
  });
  assert.equal(r.strategy?.model, 'cheap');
});

test('emergency mode disables premium and restricts standard', () => {
  const w = world([model('s', 'std', { cps: 0.1, q: 9 }), model('p', 'prem', { cps: 0.5, q: 9.5 }), model('c', 'cheap', { cps: 0.03, q: 7 })]);
  const hero = shot({ importance: 'hero', requiredQuality: 9, budget: { preferred: 5, max: 5, hardLimit: 5 } });
  const r = w.router.select({ shot: hero, budget: budget(50, 0, true), mode: 'balanced' });
  assert.equal(r.strategy?.model, 'std');
  const normal = w.router.select({ shot: shot({ importance: 'normal', requiredQuality: 7 }), budget: budget(50, 0, true), mode: 'balanced' });
  assert.equal(normal.strategy?.model, 'cheap');
});

test('policy: forceTier premium for a non-hero shot; allowPremium=false blocks it', () => {
  const w = world([model('c', 'cheap', { cps: 0.03, q: 8 }), model('p', 'prem', { cps: 0.5, q: 9.5 })]);
  const s = shot({ importance: 'normal', requiredQuality: 7, budget: { preferred: 3, max: 3, hardLimit: 3 } });
  assert.equal(w.router.select({ shot: s, budget: budget(), mode: 'balanced', policy: { forceTier: 'premium' } }).strategy?.model, 'prem');
  assert.equal(w.router.select({ shot: s, budget: budget(), mode: 'balanced', policy: { allowPremium: false } }).strategy?.model, 'cheap');
});

test('unknown pricing or missing quality data is rejected, not guessed', () => {
  const w = world([model('a', 'noprice', { q: 9 }), model('b', 'noq', { cps: 0.03, quality: {} })]);
  const r = w.router.select({ shot: shot(), budget: budget(), mode: 'balanced' });
  assert.equal(r.strategy, null);
});
