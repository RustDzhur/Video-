import type { Importance, Modality, Tier } from './types.ts';

/** Operator-tunable policy. Contains NO model names and NO provider prices. */
export interface RouterConfig {
  baseCurrency: string;
  /** Units of baseCurrency per 1 unit of the given currency. */
  fxRates: Record<string, number>;
  /** Unit price (baseCurrency) ceilings used to classify paid models into tiers. */
  tierThresholds: Record<Modality, { cheapMax: number; standardMax: number }>;
  baseRequiredQuality: Record<Importance, number>;
  allowedTiersByImportance: Record<Importance, Tier[]>;
  weights: { quality: number; reliability: number; continuity: number; cost: number; latency: number };
  latencyRefSec: number;
  defaultSuccessRate: number;
  maxAttemptsPerTier: Record<Tier, number>;
  maxTotalAttempts: number;
  /** If required - overall <= gap, regenerate on same tier; else escalate immediately. */
  regenerateGap: number;
  maxQualityBump: number;
  emergencyThreshold: number;
  maxChainLength: number;
  statsMinSamples: number;
  staleAfterMs: number;
}

export const DEFAULT_CONFIG: RouterConfig = {
  baseCurrency: 'EUR',
  fxRates: { EUR: 1 },
  tierThresholds: {
    video: { cheapMax: 0.05, standardMax: 0.2 },
    image: { cheapMax: 0.02, standardMax: 0.08 },
    audio: { cheapMax: 0.01, standardMax: 0.05 },
    text: { cheapMax: 0.002, standardMax: 0.02 },
  },
  baseRequiredQuality: { background: 6, normal: 7, important: 8, hero: 9 },
  allowedTiersByImportance: {
    background: ['free', 'free_tier', 'cheap'],
    normal: ['free', 'free_tier', 'cheap', 'standard'],
    important: ['free', 'free_tier', 'cheap', 'standard'],
    hero: ['free', 'free_tier', 'cheap', 'standard', 'premium'],
  },
  weights: { quality: 1, reliability: 0.5, continuity: 0.8, cost: 0.6, latency: 0.1 },
  latencyRefSec: 120,
  defaultSuccessRate: 0.8,
  maxAttemptsPerTier: { free: 2, free_tier: 2, cheap: 2, standard: 2, premium: 2 },
  maxTotalAttempts: 10,
  regenerateGap: 1.0,
  maxQualityBump: 1.0,
  emergencyThreshold: 0.1,
  maxChainLength: 8,
  statsMinSamples: 20,
  staleAfterMs: 24 * 3600 * 1000,
};

export class FxConverter {
  readonly base: string;
  private rates: Record<string, number>;
  constructor(base: string, rates: Record<string, number>) {
    this.base = base;
    this.rates = { ...rates, [base]: 1 };
  }
  /** Returns null if the currency has no configured rate. */
  toBase(amount: number, currency: string): number | null {
    const r = this.rates[currency];
    return r === undefined ? null : amount * r;
  }
}
