import type { RouterConfig } from './config.ts';
import type { ProviderHealth } from './health.ts';
import type { QuotaTracker } from './quota.ts';
import type { ModelRegistry } from './registry.ts';
import type { ModelStats } from './stats.ts';
import type {
  Capabilities, ChainEntry, Complexity, DecisionEntry, ModelEntry, RoutingMode, ShotGenerationPolicy, ShotSpec, Strategy, Tier,
} from './types.ts';
import { tierRank } from './types.ts';

export interface RouteInput {
  shot: ShotSpec;
  budget: { remaining: number; shotSpent: number; emergency: boolean };
  mode: RoutingMode;
  policy?: ShotGenerationPolicy;
  /** Models that failed for availability reasons during this shot's run. */
  unavailable?: Set<string>;
  /** First model that passed QA in this continuity group. */
  continuityAnchor?: { modelId: string; family?: string };
  now?: number;
}

export interface RouteResult {
  strategy: Strategy | null;
  decisions: DecisionEntry[];
  /** Why no strategy could be produced (needs user/system authorization or a different request). */
  failure?: string;
}

export interface RouterDeps {
  registry: ModelRegistry;
  quotas: QuotaTracker;
  health: ProviderHealth;
  config: RouterConfig;
  stats?: ModelStats;
}

interface Cand {
  m: ModelEntry;
  cost: number;
  q: number;
  score: number;
  stretch: boolean;
}

const avg = (...v: (number | undefined)[]): number => {
  const x = v.filter((n): n is number => typeof n === 'number');
  return x.length ? x.reduce((a, b) => a + b, 0) / x.length : 0;
};

function missingCapabilities(c: Capabilities, shot: ShotSpec): string[] {
  const n = shot.needs ?? {};
  const miss: string[] = [];
  if (shot.modality === 'video') {
    const i2v = n.imageToVideo || (shot.inputAssets?.length ?? 0) > 0;
    if (i2v && !c.imageToVideo) miss.push('image_to_video');
    if (!i2v && !c.textToVideo) miss.push('text_to_video');
  }
  if (n.characterReference && !c.characterReference) miss.push('character_reference');
  if (n.cameraControl && !c.cameraControl) miss.push('camera_control');
  if (n.audio && !c.audio) miss.push('audio');
  if (n.seed && !c.seed) miss.push('seed');
  if (n.negativePrompt && !c.negativePrompt) miss.push('negative_prompt');
  if (n.height && (c.maxHeight ?? 0) < n.height) miss.push(`resolution>=${n.height}p`);
  if (n.aspectRatio && c.aspectRatios && !c.aspectRatios.includes(n.aspectRatio)) miss.push(`aspect_ratio ${n.aspectRatio}`);
  if (shot.durationSec && c.maxDurationSec !== undefined && c.maxDurationSec < shot.durationSec) miss.push(`duration>=${shot.durationSec}s`);
  return miss;
}

export class CostQualityRouter {
  private d: RouterDeps;
  constructor(deps: RouterDeps) {
    this.d = deps;
  }

  /** Expected quality for this shot: profile dims weighted by shot complexity, blended with observed QA. */
  expectedQuality(m: ModelEntry, c: Partial<Complexity> = {}): number {
    const q = m.quality;
    const w = {
      cinematic: 1 + (2 * Math.max(c.camera ?? 0, c.lighting ?? 0, c.environment ?? 0)) / 10,
      motion: 1 + (2 * (c.motion ?? 0)) / 10,
      characters: 1 + (2 * (c.character ?? 0)) / 10,
      consistency: 0.5 + (2 * (c.continuity ?? 0)) / 10,
    };
    let sum = 0, wsum = 0;
    for (const k of ['cinematic', 'motion', 'characters', 'consistency'] as const) {
      const v = q[k];
      if (typeof v === 'number') { sum += v * w[k]; wsum += w[k]; }
    }
    let prior = wsum ? sum / wsum : q.overall ?? 0;
    const st = this.d.stats?.get(m.id);
    if (st && st.attempts >= this.d.config.statsMinSamples && st.avgQa !== undefined && prior > 0) prior = 0.5 * prior + 0.5 * st.avgQa;
    return prior;
  }

  private allowedTiers(i: RouteInput): Tier[] {
    const cfg = this.d.config, p = i.policy ?? {};
    if (p.forceTier) return [p.forceTier];
    let t = [...(p.allowedTiers ?? cfg.allowedTiersByImportance[i.shot.importance])];
    const hero = i.shot.importance === 'hero';
    if (i.budget.emergency) {
      t = t.filter((x) => x !== 'premium');
      if (!hero && i.shot.importance !== 'important') t = t.filter((x) => x !== 'standard');
    }
    if (i.mode === 'lowest_cost') t = t.filter((x) => x !== 'premium' && (x !== 'standard' || hero));
    if (p.allowPremium === false) t = t.filter((x) => x !== 'premium');
    if (p.allowFree === false) t = t.filter((x) => x !== 'free' && x !== 'free_tier');
    return t;
  }

  select(i: RouteInput): RouteResult {
    const { registry, quotas, health, config: cfg } = this.d;
    const shot = i.shot, p = i.policy ?? {}, now = i.now ?? Date.now();
    const decisions: DecisionEntry[] = [];
    const required = shot.requiredQuality + (i.mode === 'max_quality' ? cfg.maxQualityBump : 0);
    const tiers = this.allowedTiers(i);
    const hardLimit = Math.min(
      shot.budget.hardLimit - i.budget.shotSpent,
      p.maxCost !== undefined ? p.maxCost - i.budget.shotSpent : Infinity,
      i.budget.remaining,
    );
    const lockId = shot.modelLock?.modelId;
    const cands: Cand[] = [];
    let lockRejection: { reason: string; availability: boolean } | undefined;

    const reject = (m: ModelEntry, reason: string, availability = false, extra: Partial<DecisionEntry> = {}) => {
      decisions.push({ modelId: m.id, tier: m.tier, verdict: 'rejected', reason, ...extra });
      if (m.id === lockId) lockRejection = { reason, availability };
    };

    for (const m of registry.list({ modality: shot.modality })) {
      if (i.unavailable?.has(m.id)) { reject(m, 'failed earlier for this shot', true); continue; }
      if (m.status !== 'available') { reject(m, `model ${m.status}`, true); continue; }
      if (health.isOpen(m.provider) || health.isOpen(m.id)) { reject(m, 'circuit open (provider unhealthy)', true); continue; }
      const miss = missingCapabilities(m.capabilities, shot);
      if (miss.length) { reject(m, `missing capabilities: ${miss.join(', ')}`); continue; }
      if (!quotas.canUse(m.provider, 1, now)) {
        const reset = quotas.resetAt(m.provider);
        reject(m, `quota exhausted${reset ? ` (resets ${new Date(reset).toISOString()})` : ''}`, true);
        continue;
      }
      if (!tiers.includes(m.tier)) { reject(m, `tier ${m.tier} not allowed for ${shot.importance}${i.budget.emergency ? ' (budget emergency)' : ''}`); continue; }
      const est = registry.estimateCost(m, shot);
      if (!est) { reject(m, 'no pricing / fx rate configured'); continue; }
      if (est.amount > hardLimit + 1e-9) { reject(m, `cost ${est.amount.toFixed(4)} > hard limit ${Math.max(0, hardLimit).toFixed(4)}`, false, { estimatedCost: est.amount }); continue; }
      const q = this.expectedQuality(m, shot.complexity);
      if (q <= 0) { reject(m, 'no quality data', false, { estimatedCost: est.amount }); continue; }
      if (q < required && m.id !== lockId) {
        reject(m, `quality ${q.toFixed(1)} < required ${required.toFixed(1)}`, false, { expectedQuality: q, estimatedCost: est.amount });
        continue;
      }
      const st = this.d.stats?.get(m.id);
      const reliability = (st && st.attempts >= cfg.statsMinSamples ? st.successRate : health.successRate(m.provider) ?? cfg.defaultSuccessRate) * 10;
      const anchor = i.continuityAnchor;
      const cont = anchor ? (anchor.modelId === m.id ? 10 : anchor.family && m.family === anchor.family ? 7 : 0) : 0;
      const costNorm = hardLimit > 0 && Number.isFinite(hardLimit) ? Math.min(10, (est.amount / hardLimit) * 10) : 0;
      const lat = Math.min(10, ((st?.avgLatencySec ?? m.latencySec ?? 0) / cfg.latencyRefSec) * 10);
      const w = cfg.weights;
      const score = q * w.quality + reliability * w.reliability + cont * w.continuity - costNorm * w.cost - lat * w.latency;
      cands.push({ m, cost: est.amount, q, score, stretch: est.amount > shot.budget.max + 1e-9 });
    }

    if (lockId && lockRejection && !(lockRejection as { availability: boolean }).availability) {
      const why = (lockRejection as { reason: string }).reason;
      return { strategy: null, decisions, failure: `locked model ${lockId} cannot be used: ${why}` };
    }

    const sorters: Record<RoutingMode, (a: Cand, b: Cand) => number> = {
      balanced: (a, b) => tierRank(a.m.tier) - tierRank(b.m.tier) || b.score - a.score,
      user_budget: (a, b) => tierRank(a.m.tier) - tierRank(b.m.tier) || b.score - a.score,
      lowest_cost: (a, b) => a.cost - b.cost || tierRank(a.m.tier) - tierRank(b.m.tier) || b.score - a.score,
      max_quality: (a, b) => b.q - a.q || a.cost - b.cost,
    };
    cands.sort((a, b) => Number(a.stretch) - Number(b.stretch) || sorters[i.mode](a, b));

    const front = (pred: (c: Cand) => boolean) => {
      const idx = cands.findIndex(pred);
      if (idx > 0) cands.unshift(...cands.splice(idx, 1));
    };
    if (p.preferredTier) {
      const pref = cands.filter((c) => c.m.tier === p.preferredTier);
      cands.splice(0, cands.length, ...pref, ...cands.filter((c) => c.m.tier !== p.preferredTier));
    }
    const anchor = i.continuityAnchor;
    if (anchor && shot.continuity?.strict !== false) front((c) => c.m.id === anchor.modelId);
    let lockedFirst = false;
    if (lockId) {
      const idx = cands.findIndex((c) => c.m.id === lockId);
      if (idx >= 0) { front((c) => c.m.id === lockId); lockedFirst = true; }
    }

    if (cands.length === 0) {
      return { strategy: null, decisions, failure: `no model satisfies quality ${required.toFixed(1)} within budget/quota/capabilities` };
    }

    let chain: ChainEntry[] = cands.slice(0, cfg.maxChainLength).map((c, idx) => ({
      modelId: c.m.id, provider: c.m.provider, model: c.m.model, tier: c.m.tier,
      estimatedCost: c.cost, expectedQuality: c.q,
      ...(lockedFirst && idx > 0 ? { availabilityFallbackOnly: true } : {}),
    }));
    if (p.allowFallback === false) chain = chain.slice(0, 1);

    decisions.push(...chain.map((c, idx): DecisionEntry => ({
      modelId: c.modelId, tier: c.tier, verdict: 'accepted', expectedQuality: c.expectedQuality, estimatedCost: c.estimatedCost,
      reason: idx === 0 ? 'selected: cheapest viable' : 'fallback candidate',
    })));

    const first = chain[0]!;
    const premiumCosts = registry.list({ modality: shot.modality })
      .filter((m) => m.tier === 'premium' && !missingCapabilities(m.capabilities, shot).length)
      .map((m) => registry.estimateCost(m, shot)?.amount)
      .filter((x): x is number => x !== undefined);

    return {
      decisions,
      strategy: {
        provider: first.provider, model: first.model, tier: first.tier,
        estimatedCost: first.estimatedCost, expectedQuality: first.expectedQuality,
        fallbackChain: chain,
        premiumBaselineCost: premiumCosts.length ? Math.min(...premiumCosts) : undefined,
        reason: lockedFirst
          ? 'model lock'
          : `meets required quality ${required.toFixed(1)} (expected ${first.expectedQuality.toFixed(1)}) at tier ${first.tier} within budget`,
      },
    };
  }
}

/** Spec entry-point name; thin wrapper over the router. */
export function selectBestGenerationStrategy(router: CostQualityRouter, input: RouteInput): RouteResult {
  return router.select(input);
}
