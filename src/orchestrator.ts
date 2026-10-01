import { createHash, randomUUID } from 'node:crypto';
import type { RouterConfig } from './config.ts';
import type { BudgetController } from './budget.ts';
import { GatewayError, generateByModality } from './gateway.ts';
import type { GenerationProvider, GenerationResult } from './gateway.ts';
import type { ProviderHealth } from './health.ts';
import type { DecisionLog, TransactionLedger } from './ledger.ts';
import { decideQa } from './qa.ts';
import type { QualityEvaluator } from './qa.ts';
import type { QuotaTracker } from './quota.ts';
import type { ModelRegistry } from './registry.ts';
import { retryWithBackoff } from './retry.ts';
import type { RetryOptions } from './retry.ts';
import type { CostQualityRouter } from './router.ts';
import type { ModelStats } from './stats.ts';
import type { ChainEntry, QaDecision, QualityScore, RoutingMode, ShotGenerationPolicy, ShotSpec, Tier } from './types.ts';
import { TIERS } from './types.ts';

export interface AttemptRecord {
  attempt: number;
  modelId: string;
  tier: Tier;
  cost: number;
  decision?: QaDecision;
  score?: QualityScore;
  result?: GenerationResult;
  error?: string;
  replayed?: boolean;
}

export interface ShotOutcome {
  status: 'passed' | 'failed';
  shotId: string;
  modelId?: string;
  tier?: Tier;
  result?: GenerationResult;
  quality?: number;
  attempts: AttemptRecord[];
  totalCost: number;
  cached?: boolean;
  failure?: string;
  /** Best below-threshold result when status === 'failed' (caller may accept it explicitly). */
  bestEffort?: AttemptRecord;
}

export interface OrchestratorDeps {
  router: CostQualityRouter;
  registry: ModelRegistry;
  budget: BudgetController;
  quotas: QuotaTracker;
  health: ProviderHealth;
  stats: ModelStats;
  ledger: TransactionLedger;
  decisionLog: DecisionLog;
  provider: GenerationProvider;
  qa: QualityEvaluator;
  config: RouterConfig;
  retry?: Partial<RetryOptions>;
  now?: () => number;
}

const sha = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Per-shot execution: route -> reserve budget -> generate -> QA -> (regenerate | escalate | pass).
 * State (jobs, cache, anchors) is in-memory behind this class; swap for Redis/Mongo-backed stores in Firmspace.
 */
export class GenerationOrchestrator {
  private d: OrchestratorDeps;
  private jobs = new Map<string, Promise<AttemptRecord>>();
  private cache = new Map<string, ShotOutcome>();
  private anchors = new Map<string, { modelId: string; family?: string }>();

  constructor(deps: OrchestratorDeps) {
    this.d = deps;
  }

  private cacheKey(s: ShotSpec): string {
    return sha(s.tenantId, s.modality, s.prompt, s.durationSec, s.count, s.params, [...(s.inputAssets ?? [])].sort(), s.needs);
  }

  async produceShot(shot: ShotSpec, opts: { mode: RoutingMode; policy?: ShotGenerationPolicy }): Promise<ShotOutcome> {
    const { d } = this;
    const cfg = d.config;
    const now = d.now ?? Date.now;

    const ck = this.cacheKey(shot);
    const hit = this.cache.get(ck);
    if (hit && (hit.quality ?? 0) >= shot.requiredQuality) {
      d.ledger.add({
        tenantId: shot.tenantId, projectId: shot.projectId, filmId: shot.filmId, sceneId: shot.sceneId, shotId: shot.shotId,
        jobId: `${shot.shotId}:cache`, attempt: 0, idempotencyKey: ck, provider: hit.modelId!.split('/')[0]!,
        model: hit.modelId!.split('/').slice(1).join('/'), tier: hit.tier!, estimatedCost: 0, actualCost: 0, costSource: 'none',
        qualityScore: hit.quality, status: 'cached', createdAt: now(),
      });
      return { ...hit, cached: true, attempts: [], totalCost: 0 };
    }

    const attemptsByTier = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
    const perModel = new Map<string, number>();
    const unavailable = new Set<string>();
    const attempts: AttemptRecord[] = [];
    let totalCost = 0;
    let best: AttemptRecord | undefined;
    let failure = 'attempt limit reached';
    const anchorKey = shot.continuity ? `${shot.tenantId}:${shot.projectId}:${shot.continuity.groupId}` : undefined;

    for (let n = 0; n < cfg.maxTotalAttempts; n++) {
      const anchor = anchorKey ? this.anchors.get(anchorKey) : undefined;
      const snap = d.budget.snapshot();
      const route = d.router.select({
        shot, mode: opts.mode, policy: opts.policy, unavailable, continuityAnchor: anchor, now: now(),
        budget: { remaining: snap.remaining, shotSpent: d.budget.shotSpent(shot.shotId), emergency: snap.emergency },
      });
      d.decisionLog.add({
        tenantId: shot.tenantId, shotId: shot.shotId, attempt: attempts.length + 1, decisions: route.decisions,
        chosen: route.strategy ? `${route.strategy.provider}/${route.strategy.model}` : undefined, createdAt: now(),
      });
      if (!route.strategy) { failure = route.failure ?? 'no viable model'; break; }

      const entry = this.pickEntry(route.strategy.fallbackChain, attemptsByTier, perModel, !!(shot.modelLock || (anchor && shot.continuity?.strict !== false)));
      if (!entry) { failure = 'all permitted tiers exhausted without passing QA'; break; }

      const rec = await this.attempt(shot, entry, attempts.length + 1, route.strategy.premiumBaselineCost, attemptsByTier, unavailable);
      if (!rec) continue; // could not reserve budget; router re-evaluates (entry marked unavailable)
      attemptsByTier[entry.tier]++;
      perModel.set(entry.modelId, (perModel.get(entry.modelId) ?? 0) + 1);
      attempts.push(rec);
      totalCost += rec.cost;

      if (rec.score && (!best?.score || rec.score.overall > best.score.overall)) best = rec;
      if (rec.decision === 'PASS') {
        const outcome: ShotOutcome = {
          status: 'passed', shotId: shot.shotId, modelId: entry.modelId, tier: entry.tier,
          result: rec.result, quality: rec.score?.overall, attempts, totalCost,
        };
        this.cache.set(ck, outcome);
        if (anchorKey && !anchor) this.anchors.set(anchorKey, { modelId: entry.modelId, family: d.registry.get(entry.modelId)?.family });
        return outcome;
      }
      if (rec.decision === 'ESCALATE') attemptsByTier[entry.tier] = cfg.maxAttemptsPerTier[entry.tier];
    }
    return { status: 'failed', shotId: shot.shotId, attempts, totalCost, failure, bestEffort: best };
  }

  private pickEntry(chain: ChainEntry[], byTier: Record<Tier, number>, perModel: Map<string, number>, sticky: boolean): ChainEntry | undefined {
    const max = this.d.config.maxAttemptsPerTier;
    const usable = chain.filter((e) => !e.availabilityFallbackOnly && byTier[e.tier] < max[e.tier]);
    const first = usable[0];
    if (!first || sticky) return first;
    // spread same-tier attempts across models: a different model may avoid the failure mode
    return usable.filter((e) => e.tier === first.tier).sort((a, b) => (perModel.get(a.modelId) ?? 0) - (perModel.get(b.modelId) ?? 0))[0];
  }

  private async attempt(
    shot: ShotSpec, e: ChainEntry, attemptNo: number, baseline: number | undefined,
    byTier: Record<Tier, number>, unavailable: Set<string>,
  ): Promise<AttemptRecord | null> {
    const { d } = this;
    const now = d.now ?? Date.now;
    const key = sha(shot.tenantId, shot.shotId, attemptNo, e.modelId, shot.prompt, shot.params, shot.inputAssets);
    const existing = this.jobs.get(key);
    if (existing) return { ...(await existing), replayed: true, cost: 0 }; // idempotent: never pay twice

    const run = (async (): Promise<AttemptRecord> => {
      const resv = d.budget.reserve(shot.shotId, e.estimatedCost);
      if (!resv) throw Object.assign(new Error('budget'), { budget: true });
      const jobId = `${shot.shotId}:${attemptNo}`;
      const tx = {
        tenantId: shot.tenantId, projectId: shot.projectId, filmId: shot.filmId, sceneId: shot.sceneId, shotId: shot.shotId,
        jobId, attempt: attemptNo, idempotencyKey: key, provider: e.provider, model: e.model, tier: e.tier,
        estimatedCost: e.estimatedCost, premiumBaselineCost: baseline, durationSeconds: shot.durationSec,
      };
      const base: AttemptRecord = { attempt: attemptNo, modelId: e.modelId, tier: e.tier, cost: 0 };
      let result: GenerationResult;
      try {
        result = await retryWithBackoff(
          () => generateByModality(d.provider, shot.modality, {
            tenantId: shot.tenantId, projectId: shot.projectId, shotId: shot.shotId, jobId, requestId: randomUUID(),
            idempotencyKey: key, model: e.modelId, prompt: shot.prompt, durationSec: shot.durationSec,
            params: shot.params, inputAssets: shot.inputAssets,
          }),
          { retries: 2, baseMs: 1000, maxMs: 15_000, shouldRetry: (x) => x instanceof GatewayError && x.retryable, ...d.retry },
        );
      } catch (err) {
        d.budget.release(resv);
        d.health.record(e.provider, false);
        d.health.record(e.modelId, false);
        d.stats.record(e.modelId, { passed: false, cost: 0 });
        unavailable.add(e.modelId);
        const msg = err instanceof Error ? err.message : String(err);
        d.ledger.add({ ...tx, actualCost: 0, costSource: 'none', status: 'failed', error: msg, createdAt: now() });
        return { ...base, error: msg };
      }

      d.health.record(e.provider, true);
      d.health.record(e.modelId, true);
      d.quotas.consume(e.provider, 1, now());
      let actual = e.estimatedCost;
      let costSource: 'reported' | 'estimated' = 'estimated';
      if (result.reportedCost !== undefined) {
        const conv = d.registry.convert(result.reportedCost, result.costCurrency ?? d.registry.get(e.modelId)?.economics.currency ?? d.config.baseCurrency);
        if (conv !== null) { actual = conv; costSource = 'reported'; }
      }
      d.budget.commit(resv, actual);

      let score: QualityScore;
      try {
        score = await d.qa.evaluate(result, shot);
      } catch (err) {
        const msg = `QA failed: ${err instanceof Error ? err.message : String(err)}`;
        d.ledger.add({ ...tx, actualCost: actual, costSource, status: 'qa_failed', error: msg, createdAt: now() });
        d.stats.record(e.modelId, { passed: false, cost: actual, latencySec: result.latencyMs / 1000 });
        return { ...base, cost: actual, result, error: msg, decision: 'REGENERATE' };
      }
      const decision = decideQa({
        overall: score.overall, required: shot.requiredQuality, attemptsInTier: byTier[e.tier] + 1,
        maxAttemptsInTier: d.config.maxAttemptsPerTier[e.tier], regenerateGap: d.config.regenerateGap,
      });
      d.ledger.add({
        ...tx, actualCost: actual, costSource, qualityScore: score.overall, qaDecision: decision,
        status: decision === 'PASS' ? 'success' : 'qa_failed', createdAt: now(),
      });
      d.stats.record(e.modelId, { passed: decision === 'PASS', qa: score.overall, cost: actual, latencySec: result.latencyMs / 1000 });
      return { ...base, cost: actual, result, score, decision };
    })();

    this.jobs.set(key, run);
    try {
      return await run;
    } catch (err) {
      this.jobs.delete(key);
      if ((err as { budget?: boolean }).budget) { unavailable.add(e.modelId); return null; }
      throw err;
    }
  }
}
