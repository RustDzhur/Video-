import type { DecisionEntry, QaDecision, Tier } from './types.ts';
import { TIERS } from './types.ts';

export interface GenerationTransaction {
  tenantId: string;
  projectId: string;
  filmId?: string;
  sceneId: string;
  shotId: string;
  jobId: string;
  attempt: number;
  idempotencyKey: string;
  provider: string;
  model: string;
  tier: Tier;
  estimatedCost: number;
  actualCost: number;
  costSource: 'reported' | 'estimated' | 'none';
  /** Cheapest premium-tier alternative for the same shot (savings accounting). */
  premiumBaselineCost?: number;
  durationSeconds?: number;
  qualityScore?: number;
  qaDecision?: QaDecision;
  status: 'success' | 'failed' | 'qa_failed' | 'cached';
  error?: string;
  createdAt: number;
}

export interface TxFilter {
  tenantId: string; // mandatory: tenant isolation
  projectId?: string;
  filmId?: string;
  sceneId?: string;
  shotId?: string;
}

export interface LedgerSummary {
  count: number;
  estimated: number;
  actual: number;
  failedCost: number;
  successCount: number;
  costPerSuccess: number | undefined;
  byTier: Record<Tier, { count: number; cost: number; share: number }>;
  /** Σ premium baseline of passed shots − Σ actual cost of those shots; internal accounting only. */
  premiumBaseline: number;
  saved: number;
  byScene: Record<string, number>;
  byShot: Record<string, number>;
}

export class TransactionLedger {
  private tx: GenerationTransaction[] = [];

  add(t: GenerationTransaction): void {
    this.tx.push(t);
  }

  list(f: TxFilter): GenerationTransaction[] {
    return this.tx.filter(
      (t) =>
        t.tenantId === f.tenantId &&
        (!f.projectId || t.projectId === f.projectId) &&
        (!f.filmId || t.filmId === f.filmId) &&
        (!f.sceneId || t.sceneId === f.sceneId) &&
        (!f.shotId || t.shotId === f.shotId),
    );
  }

  summary(f: TxFilter): LedgerSummary {
    const rows = this.list(f);
    const byTier = Object.fromEntries(TIERS.map((t) => [t, { count: 0, cost: 0, share: 0 }])) as LedgerSummary['byTier'];
    const byScene: Record<string, number> = {};
    const byShot: Record<string, number> = {};
    let estimated = 0, actual = 0, failedCost = 0, successCount = 0;
    const passedShots = new Map<string, number>(); // shotId -> baseline
    for (const r of rows) {
      estimated += r.estimatedCost;
      actual += r.actualCost;
      byTier[r.tier].count++;
      byTier[r.tier].cost += r.actualCost;
      byScene[r.sceneId] = (byScene[r.sceneId] ?? 0) + r.actualCost;
      byShot[r.shotId] = (byShot[r.shotId] ?? 0) + r.actualCost;
      if (r.status === 'success' || r.status === 'cached') {
        successCount++;
        if (r.premiumBaselineCost !== undefined) passedShots.set(r.shotId, r.premiumBaselineCost);
      } else failedCost += r.actualCost;
    }
    const n = rows.length || 1;
    for (const t of TIERS) byTier[t].share = byTier[t].count / n;
    let premiumBaseline = 0, actualOfPassed = 0;
    for (const [shotId, base] of passedShots) {
      premiumBaseline += base;
      actualOfPassed += byShot[shotId] ?? 0;
    }
    return {
      count: rows.length, estimated, actual, failedCost, successCount,
      costPerSuccess: successCount ? actual / successCount : undefined,
      byTier, premiumBaseline, saved: premiumBaseline - actualOfPassed, byScene, byShot,
    };
  }
}

export interface RoutingDecisionRecord {
  tenantId: string;
  shotId: string;
  attempt: number;
  decisions: DecisionEntry[];
  chosen?: string;
  createdAt: number;
}

export class DecisionLog {
  private rows: RoutingDecisionRecord[] = [];
  add(r: RoutingDecisionRecord): void { this.rows.push(r); }
  forShot(tenantId: string, shotId: string): RoutingDecisionRecord[] {
    return this.rows.filter((r) => r.tenantId === tenantId && r.shotId === shotId);
  }
}
