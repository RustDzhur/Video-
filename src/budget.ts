export interface BudgetSnapshot {
  total: number;
  spent: number;
  reserved: number;
  remaining: number;
  emergency: boolean;
}

export interface Reservation {
  id: number;
  shotId: string;
  amount: number;
}

/** One instance per (tenant, project). `remaining` excludes active reservations. */
export class BudgetController {
  readonly tenantId: string;
  readonly projectId: string;
  readonly currency: string;
  private total: number;
  private spent = 0;
  private reserved = 0;
  private emergencyThreshold: number;
  private nextId = 1;
  private open = new Map<number, Reservation>();
  private perShot = new Map<string, number>();

  constructor(o: { tenantId: string; projectId: string; total: number; currency: string; emergencyThreshold?: number }) {
    this.tenantId = o.tenantId;
    this.projectId = o.projectId;
    this.total = o.total;
    this.currency = o.currency;
    this.emergencyThreshold = o.emergencyThreshold ?? 0.1;
  }

  snapshot(): BudgetSnapshot {
    const remaining = Math.max(0, this.total - this.spent - this.reserved);
    return {
      total: this.total,
      spent: this.spent,
      reserved: this.reserved,
      remaining,
      emergency: this.total > 0 && remaining / this.total < this.emergencyThreshold,
    };
  }

  shotSpent(shotId: string): number {
    return this.perShot.get(shotId) ?? 0;
  }

  /** Returns null when the amount does not fit the remaining budget. */
  reserve(shotId: string, amount: number): Reservation | null {
    if (amount < 0 || amount > this.snapshot().remaining + 1e-9) return null;
    const r = { id: this.nextId++, shotId, amount };
    this.open.set(r.id, r);
    this.reserved += amount;
    return r;
  }

  commit(r: Reservation, actual: number): void {
    if (!this.open.delete(r.id)) return;
    this.reserved -= r.amount;
    this.spent += actual;
    this.perShot.set(r.shotId, this.shotSpent(r.shotId) + actual);
  }

  release(r: Reservation): void {
    if (!this.open.delete(r.id)) return;
    this.reserved -= r.amount;
  }

  /** Raising the budget is an explicit, authorized operation — never done by the optimizer. */
  authorizeIncrease(by: number): void {
    if (by > 0) this.total += by;
  }
}
