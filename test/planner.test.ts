import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GenerationPlanner } from '../src/index.ts';
import { cfg, model, shot, world } from './helpers.ts';

test('plan spreads limited free quota; demanding shots served first; excess goes to cheap', () => {
  const w = world([model('f', 'free', { freeQuota: true, q: 7 }), model('c', 'cheap', { cps: 0.03, q: 8 })]);
  w.quotas.set('f', { remaining: 3 });
  const shots = Array.from({ length: 5 }, (_, i) => shot({ shotId: `s${i}`, prompt: `p${i}`, requiredQuality: 6 }));
  const plan = new GenerationPlanner({ registry: w.registry, health: w.health, quotas: w.quotas, config: cfg }).plan({
    shots, budgetRemaining: 50, budgetTotal: 50, mode: 'balanced',
  });
  assert.equal(plan.tierCounts.free_tier, 3);
  assert.equal(plan.tierCounts.cheap, 2);
  assert.ok(Math.abs(plan.estimatedCost - 0.3) < 1e-9);
  assert.equal(w.quotas.remaining('f'), 3); // planning must not consume real quota
  assert.equal(plan.withinBudget, true);
});

test('plan flags unroutable shots and over-budget plans', () => {
  const w = world([model('c', 'cheap', { cps: 0.03, q: 8 })]);
  const plan = new GenerationPlanner({ registry: w.registry, health: w.health, quotas: w.quotas, config: cfg }).plan({
    shots: [shot({ shotId: 'a' }), shot({ shotId: 'b', importance: 'hero', requiredQuality: 9.9 })],
    budgetRemaining: 0.1, budgetTotal: 0.1, mode: 'balanced',
  });
  assert.equal(plan.unroutable.length >= 1, true);
  assert.equal(plan.withinBudget, false);
});
