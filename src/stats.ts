export interface ModelStat {
  attempts: number;
  passes: number;
  successRate: number;
  avgQa: number | undefined;
  avgCost: number;
  avgLatencySec: number | undefined;
}

/** Self-collected model performance (feeds the learning router). Keyed by tenant-agnostic model id. */
export class ModelStats {
  private m = new Map<string, { attempts: number; passes: number; qaSum: number; qaN: number; cost: number; latSum: number; latN: number }>();

  record(modelId: string, o: { passed: boolean; qa?: number; cost: number; latencySec?: number }): void {
    const s = this.m.get(modelId) ?? { attempts: 0, passes: 0, qaSum: 0, qaN: 0, cost: 0, latSum: 0, latN: 0 };
    s.attempts++;
    if (o.passed) s.passes++;
    if (o.qa !== undefined) { s.qaSum += o.qa; s.qaN++; }
    s.cost += o.cost;
    if (o.latencySec !== undefined) { s.latSum += o.latencySec; s.latN++; }
    this.m.set(modelId, s);
  }

  get(modelId: string): ModelStat | undefined {
    const s = this.m.get(modelId);
    if (!s) return undefined;
    return {
      attempts: s.attempts,
      passes: s.passes,
      successRate: s.passes / s.attempts,
      avgQa: s.qaN ? s.qaSum / s.qaN : undefined,
      avgCost: s.cost / s.attempts,
      avgLatencySec: s.latN ? s.latSum / s.latN : undefined,
    };
  }
}
