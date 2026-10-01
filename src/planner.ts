import type { RouterConfig } from './config.ts';
import type { ProviderHealth } from './health.ts';
import type { QuotaTracker } from './quota.ts';
import type { ModelRegistry } from './registry.ts';
import { CostQualityRouter } from './router.ts';
import type { ModelStats } from './stats.ts';
import type { RoutingMode, ShotGenerationPolicy, ShotSpec, Tier } from './types.ts';
import { TIERS } from './types.ts';

export interface PlannedShot {
  shotId: string;
  modelId: string;
  tier: Tier;
  estimatedCost: number;
  expectedQuality: number;
  premiumBaselineCost?: number;
}

export interface GenerationPlan {
  shots: PlannedShot[];
  tierCounts: Record<Tier, number>;
  /** Σ first-choice cost (optimistic, every shot passes first time). */
  estimatedCost: number;
  /** Adds a retry allowance from observed (or default) success rates. */
  estimatedCostWithRetries: number;
  allPremiumCost: number;
  potentialSaving: number;
  unroutable: { shotId: string; reason: string }[];
  withinBudget: boolean;
}

/** Film-level cost optimizer: dry-runs the router over all shots with simulated quota and budget. */
export class GenerationPlanner {
  private d: { registry: ModelRegistry; health: ProviderHealth; quotas: QuotaTracker; config: RouterConfig; stats?: ModelStats };
  constructor(deps: GenerationPlanner['d']) {
    this.d = deps;
  }

  plan(o: {
    shots: ShotSpec[];
    budgetRemaining: number;
    budgetTotal: number;
    mode: RoutingMode;
    policies?: Map<string, ShotGenerationPolicy>;
  }): GenerationPlan {
    const cfg = this.d.config;
    const quotas = this.d.quotas.fork(); // quota spreading across shots (never double-spend a provider's quota)
    const router = new CostQualityRouter({ ...this.d, quotas });
    const anchors = new Map<string, { modelId: string; family?: string }>();
    const plan: GenerationPlan = {
      shots: [], tierCounts: Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>,
      estimatedCost: 0, estimatedCostWithRetries: 0, allPremiumCost: 0, potentialSaving: 0, unroutable: [], withinBudget: true,
    };
    let remaining = o.budgetRemaining;
    // demanding shots first: they have the fewest viable models, scarce free quota should not be eaten by easy ones
    const ordered = [...o.shots].sort((a, b) => b.requiredQuality - a.requiredQuality);
    for (const shot of ordered) {
      const gk = shot.continuity ? `${shot.projectId}:${shot.continuity.groupId}` : undefined;
      const r = router.select({
        shot, mode: o.mode, policy: o.policies?.get(shot.shotId), continuityAnchor: gk ? anchors.get(gk) : undefined,
        budget: { remaining, shotSpent: 0, emergency: o.budgetTotal > 0 && remaining / o.budgetTotal < cfg.emergencyThreshold },
      });
      const s = r.strategy;
      if (!s) { plan.unroutable.push({ shotId: shot.shotId, reason: r.failure ?? 'no viable model' }); continue; }
      const id = `${s.provider}/${s.model}`;
      quotas.consume(s.provider, 1);
      remaining -= s.estimatedCost;
      if (gk && !anchors.has(gk)) anchors.set(gk, { modelId: id, family: this.d.registry.get(id)?.family });
      plan.shots.push({ shotId: shot.shotId, modelId: id, tier: s.tier, estimatedCost: s.estimatedCost, expectedQuality: s.expectedQuality, premiumBaselineCost: s.premiumBaselineCost });
      plan.tierCounts[s.tier]++;
      plan.estimatedCost += s.estimatedCost;
      const sr = this.d.stats?.get(id);
      const successRate = sr && sr.attempts >= cfg.statsMinSamples ? sr.successRate : cfg.defaultSuccessRate;
      plan.estimatedCostWithRetries += s.estimatedCost / Math.max(0.33, successRate);
      plan.allPremiumCost += s.premiumBaselineCost ?? s.estimatedCost;
    }
    plan.potentialSaving = plan.allPremiumCost - plan.estimatedCost;
    plan.withinBudget = plan.unroutable.length === 0 && plan.estimatedCostWithRetries <= o.budgetRemaining;
    return plan;
  }
}
