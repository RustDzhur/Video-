export interface HealthConfig {
  windowSize: number;
  minSamples: number;
  errorRateThreshold: number;
  cooldownMs: number;
}

const DEFAULTS: HealthConfig = { windowSize: 20, minSamples: 5, errorRateThreshold: 0.5, cooldownMs: 60_000 };

interface KeyState {
  results: boolean[];
  openedAt?: number;
}

/** Circuit breaker per key (provider or provider/model). After cooldown a probe is allowed (half-open). */
export class ProviderHealth {
  private cfg: HealthConfig;
  private now: () => number;
  private s = new Map<string, KeyState>();

  constructor(cfg: Partial<HealthConfig> = {}, now: () => number = Date.now) {
    this.cfg = { ...DEFAULTS, ...cfg };
    this.now = now;
  }

  record(key: string, ok: boolean): void {
    const st = this.s.get(key) ?? { results: [] };
    this.s.set(key, st);
    if (st.openedAt !== undefined) {
      if (this.now() - st.openedAt < this.cfg.cooldownMs) return;
      if (ok) {
        st.results = [];
        st.openedAt = undefined;
      } else {
        st.openedAt = this.now();
      }
      return;
    }
    st.results.push(ok);
    if (st.results.length > this.cfg.windowSize) st.results.shift();
    if (st.results.length >= this.cfg.minSamples && this.errorRate(key) > this.cfg.errorRateThreshold) st.openedAt = this.now();
  }

  errorRate(key: string): number {
    const r = this.s.get(key)?.results ?? [];
    return r.length ? r.filter((x) => !x).length / r.length : 0;
  }

  successRate(key: string): number | undefined {
    const r = this.s.get(key)?.results ?? [];
    return r.length >= this.cfg.minSamples ? 1 - this.errorRate(key) : undefined;
  }

  isOpen(key: string): boolean {
    const st = this.s.get(key);
    return !!st && st.openedAt !== undefined && this.now() - st.openedAt < this.cfg.cooldownMs;
  }
}
