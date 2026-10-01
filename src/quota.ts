export interface QuotaState {
  remaining: number;
  limit?: number;
  resetAt?: number;
  /** If set, the window advances by this period after a reset. */
  resetPeriodMs?: number;
  unit?: 'requests' | 'credits' | 'seconds';
}

/** Provider quota with reset-time awareness. Unknown quota is treated as unmetered. */
export class QuotaTracker {
  private q = new Map<string, QuotaState>();

  set(provider: string, s: QuotaState): void {
    this.q.set(provider, { ...s });
  }

  private refresh(provider: string, now: number): QuotaState | undefined {
    const s = this.q.get(provider);
    if (s && s.resetAt !== undefined && now >= s.resetAt && s.limit !== undefined) {
      s.remaining = s.limit;
      s.resetAt = s.resetPeriodMs ? s.resetAt + s.resetPeriodMs * Math.max(1, Math.ceil((now - s.resetAt + 1) / s.resetPeriodMs)) : undefined;
    }
    return s;
  }

  remaining(provider: string, now = Date.now()): number {
    return this.refresh(provider, now)?.remaining ?? Infinity;
  }

  resetAt(provider: string): number | undefined {
    return this.q.get(provider)?.resetAt;
  }

  canUse(provider: string, amount = 1, now = Date.now()): boolean {
    return this.remaining(provider, now) >= amount;
  }

  consume(provider: string, amount = 1, now = Date.now()): void {
    const s = this.refresh(provider, now);
    if (s) s.remaining = Math.max(0, s.remaining - amount);
  }

  /** Independent copy, used by the planner to simulate quota distribution. */
  fork(): QuotaTracker {
    const f = new QuotaTracker();
    for (const [k, v] of this.q) f.q.set(k, { ...v });
    return f;
  }
}
