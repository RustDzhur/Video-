import type { GenerationResult } from './gateway.ts';
import type { QaDecision, QualityScore, ShotSpec } from './types.ts';

/** Plug-in point for the real evaluator (VLM judge, face/artifact metrics, ...). */
export interface QualityEvaluator {
  evaluate(result: GenerationResult, shot: ShotSpec): Promise<QualityScore>;
}

export function computeOverall(s: Omit<QualityScore, 'overall'>, weights: Partial<Record<keyof Omit<QualityScore, 'overall'>, number>> = {}): number {
  let sum = 0, w = 0;
  for (const [k, v] of Object.entries(s)) {
    if (typeof v !== 'number') continue;
    const wk = weights[k as keyof typeof weights] ?? 1;
    sum += v * wk;
    w += wk;
  }
  return w ? sum / w : 0;
}

export function decideQa(o: {
  overall: number;
  required: number;
  attemptsInTier: number;
  maxAttemptsInTier: number;
  regenerateGap: number;
}): QaDecision {
  if (o.overall >= o.required) return 'PASS';
  if (o.attemptsInTier < o.maxAttemptsInTier && o.required - o.overall <= o.regenerateGap) return 'REGENERATE';
  return 'ESCALATE';
}
