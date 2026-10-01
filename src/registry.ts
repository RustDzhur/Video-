import type { RouterConfig } from './config.ts';
import { FxConverter } from './config.ts';
import type { Economics, Modality, ModelEntry, ModelEntryInput, ShotSpec, Tier } from './types.ts';

export interface CostEstimate {
  /** In base currency. */
  amount: number;
  native: number;
  currency: string;
}

function unitPrice(e: Economics, modality: Modality): number | undefined {
  if (modality === 'video' || modality === 'audio') return e.costPerSecond ?? e.costPerRequest;
  if (modality === 'image') return e.costPerImage ?? e.costPerRequest;
  return e.costPerRequest;
}

export function estimateNativeCost(e: Economics, shot: Pick<ShotSpec, 'modality' | 'durationSec' | 'count'>): number | null {
  if (e.free || e.freeQuota) return 0;
  const { modality } = shot;
  if ((modality === 'video' || modality === 'audio') && e.costPerSecond !== undefined) {
    return e.costPerSecond * (shot.durationSec ?? 0);
  }
  if (modality === 'image' && e.costPerImage !== undefined) return e.costPerImage * (shot.count ?? 1);
  if (e.costPerRequest !== undefined) return e.costPerRequest * (shot.count ?? 1);
  return null; // unknown pricing => router rejects rather than guessing
}

export class ModelRegistry {
  private models = new Map<string, ModelEntry>();
  private cfg: RouterConfig;
  private fx: FxConverter;
  private now: () => number;

  constructor(cfg: RouterConfig, now: () => number = Date.now) {
    this.cfg = cfg;
    this.fx = new FxConverter(cfg.baseCurrency, cfg.fxRates);
    this.now = now;
  }

  classifyTier(e: Economics, modality: Modality): Tier | null {
    if (e.tierOverride) return e.tierOverride;
    if (e.free) return 'free';
    if (e.freeQuota) return 'free_tier';
    const price = unitPrice(e, modality);
    if (price === undefined) return null;
    if (price === 0) return 'free';
    const base = this.fx.toBase(price, e.currency);
    if (base === null) return null;
    const t = this.cfg.tierThresholds[modality];
    if (base <= t.cheapMax) return 'cheap';
    if (base <= t.standardMax) return 'standard';
    return 'premium';
  }

  /** Models with unknown pricing are stored as 'premium' but the router rejects them (no pricing). */
  upsert(input: ModelEntryInput): ModelEntry {
    const id = `${input.provider}/${input.model}`;
    const tier = this.classifyTier(input.economics, input.modality) ?? 'premium';
    const entry: ModelEntry = { ...input, id, tier, status: input.status ?? 'available', lastSeenAt: this.now() };
    this.models.set(id, entry);
    return entry;
  }

  get(id: string): ModelEntry | undefined {
    return this.models.get(id);
  }

  list(filter: { modality?: Modality } = {}): ModelEntry[] {
    return [...this.models.values()].filter((m) => !filter.modality || m.modality === filter.modality);
  }

  setStatus(id: string, status: ModelEntry['status']): void {
    const m = this.models.get(id);
    if (m) m.status = status;
  }

  /** Mark entries not refreshed within staleAfterMs as stale (router ignores them). */
  pruneStale(): string[] {
    const cutoff = this.now() - this.cfg.staleAfterMs;
    const stale: string[] = [];
    for (const m of this.models.values()) {
      if (m.lastSeenAt < cutoff && m.status === 'available') {
        m.status = 'stale';
        stale.push(m.id);
      }
    }
    return stale;
  }

  convert(amount: number, currency: string): number | null {
    return this.fx.toBase(amount, currency);
  }

  estimateCost(m: ModelEntry, shot: ShotSpec): CostEstimate | null {
    const native = estimateNativeCost(m.economics, shot);
    if (native === null) return null;
    const amount = this.fx.toBase(native, m.economics.currency);
    if (amount === null) return null;
    return { amount, native, currency: m.economics.currency };
  }
}
