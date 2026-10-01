import type { GenerationProvider, GenerationResult } from './gateway.ts';
import { computeOverall } from './qa.ts';
import type { QualityEvaluator } from './qa.ts';
import { resultUri } from './assets.ts';
import type { Modality, QualityScore, ShotSpec } from './types.ts';

export type FrameExtractor = (uri: string, n: number) => Promise<string[]>;

export function resultText(r: GenerationResult): string {
  const a = r.assets[0];
  return a?.b64 ? Buffer.from(a.b64, 'base64').toString('utf8') : '';
}

export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in model output');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

const DIMS = [
  'visual_quality', 'motion_quality', 'character_consistency', 'face_quality', 'scene_consistency',
  'prompt_adherence', 'camera_quality', 'temporal_stability', 'artifact_score',
] as const;

const clamp = (n: number) => Math.min(10, Math.max(0, n));

export interface VlmJudgeOptions {
  provider: GenerationProvider;
  /** `provider/model` of a vision-capable chat model reachable through the gateway. */
  model: string;
  frames: FrameExtractor;
  framesPerClip?: number;
  /** Judge calls cost money too: report it so the budget controller can account for it. */
  onCost?: (amount: number, currency: string | undefined) => void;
}

/** LLM-as-judge quality evaluator and continuity checker. Scores are model opinions, not ground truth. */
export class VlmJudge implements QualityEvaluator {
  private o: VlmJudgeOptions;
  private n = 0;

  constructor(o: VlmJudgeOptions) {
    this.o = o;
  }

  private async ask(prompt: string, images: string[], shotId: string, tenantId = 'judge', projectId = 'judge'): Promise<Record<string, unknown>> {
    const r = await this.o.provider.generateText({
      tenantId, projectId, shotId, jobId: `judge-${++this.n}`, requestId: `judge-${shotId}-${this.n}`,
      idempotencyKey: `judge-${shotId}-${this.n}`, model: this.o.model, prompt, inputAssets: images,
      params: { temperature: 0 },
    });
    if (r.reportedCost !== undefined) this.o.onCost?.(r.reportedCost, r.costCurrency);
    return parseJsonObject(resultText(r));
  }

  async evaluate(result: GenerationResult, shot: ShotSpec): Promise<QualityScore> {
    const uri = resultUri(result);
    if (!uri) throw new Error('result has no asset to evaluate');
    const images = await this.o.frames(uri, this.o.framesPerClip ?? 3);
    const prompt =
      `You are a strict film QA reviewer. The ${shot.modality} was generated from this prompt:\n"${shot.prompt}"\n` +
      `Attached are ${images.length} frame(s). Score each from 0 (unusable) to 10 (flawless): ${DIMS.join(', ')}. ` +
      `Penalize artifacts, distorted faces/hands, flicker, wrong subject. Reply with ONLY a JSON object with those keys as numbers.`;
    const j = await this.ask(prompt, images, shot.shotId, shot.tenantId, shot.projectId);
    const dims: Partial<Record<(typeof DIMS)[number], number>> = {};
    for (const k of DIMS) if (typeof j[k] === 'number') dims[k] = clamp(j[k] as number);
    if (Object.keys(dims).length === 0) throw new Error('judge returned no numeric scores');
    return { ...dims, overall: computeOverall(dims) };
  }

  /** Compares sampled frames of several shots of one scene; returns consistency score and flagged shots. */
  async continuity(shots: { shotId: string; uri: string }[]): Promise<{ score: number; issues: { shotId: string; note: string }[] }> {
    if (shots.length < 2) return { score: 10, issues: [] };
    const images: string[] = [];
    const order: string[] = [];
    for (const s of shots) {
      images.push(...(await this.o.frames(s.uri, 1)));
      order.push(s.shotId);
    }
    const prompt =
      `These images are one frame from each of ${order.length} consecutive shots in order: ${order.join(', ')}. ` +
      `Judge continuity of characters (face, clothes), setting and visual style. Reply with ONLY JSON: ` +
      `{"score": <0-10>, "issues": [{"shotId": "<id>", "note": "<what differs>"}]}`;
    const j = await this.ask(prompt, images, `continuity-${order.join('+')}`);
    const issues = Array.isArray(j.issues)
      ? (j.issues as { shotId?: unknown; note?: unknown }[])
          .filter((i) => typeof i.shotId === 'string' && order.includes(i.shotId))
          .map((i) => ({ shotId: i.shotId as string, note: String(i.note ?? '') }))
      : [];
    return { score: typeof j.score === 'number' ? clamp(j.score) : 0, issues };
  }
}

/** Per-modality evaluator dispatch. Modalities without an evaluator are explicitly UNVERIFIED (score == required). */
export class ModalityQa implements QualityEvaluator {
  private by: Partial<Record<Modality, QualityEvaluator>>;
  readonly unverified = new Set<string>();

  constructor(by: Partial<Record<Modality, QualityEvaluator>>) {
    this.by = by;
  }

  async evaluate(result: GenerationResult, shot: ShotSpec): Promise<QualityScore> {
    const e = this.by[shot.modality];
    if (e) return e.evaluate(result, shot);
    this.unverified.add(shot.shotId);
    return { overall: shot.requiredQuality };
  }
}
