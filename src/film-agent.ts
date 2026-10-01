import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { resultUri } from './assets.ts';
import type { BudgetController } from './budget.ts';
import { deriveImportance, requiredQualityFor } from './classifier.ts';
import type { RouterConfig } from './config.ts';
import { probe, renderFilm, upscale } from './ffmpeg.ts';
import type { ProbeInfo } from './ffmpeg.ts';
import type { GenerationProvider } from './gateway.ts';
import type { TransactionLedger, LedgerSummary } from './ledger.ts';
import type { GenerationOrchestrator, ShotOutcome } from './orchestrator.ts';
import type { AssetPipeline, EnsureAssetSpec } from './pipeline.ts';
import type { GenerationPlan, GenerationPlanner } from './planner.ts';
import type { ModelRegistry } from './registry.ts';
import type { ApprovalMode, Complexity, Importance, RoutingMode, ShotSpec } from './types.ts';
import { parseJsonObject, resultText } from './vlm.ts';
import type { VlmJudge } from './vlm.ts';

export interface FilmRequest {
  tenantId: string;
  projectId: string;
  filmId: string;
  idea: string;
  durationSec: number;
  style: string;
  characters?: string[];
  minQuality: number;
  mode: RoutingMode;
  approval: ApprovalMode;
  withMusic?: boolean;
  useKeyframes?: boolean;
  upscaleHeight?: number;
  /** Accept the best below-threshold result for shots that never passed QA (otherwise they are dropped). */
  acceptBestEffort?: boolean;
}

export interface FilmDeps {
  provider: GenerationProvider;
  /** Text model used for script/storyboard planning. */
  plannerModel: string;
  registry: ModelRegistry;
  budget: BudgetController;
  orchestrator: GenerationOrchestrator;
  pipeline: AssetPipeline;
  planner: GenerationPlanner;
  ledger: TransactionLedger;
  config: RouterConfig;
  judge?: VlmJudge;
  approvePlan?: (plan: GenerationPlan) => Promise<boolean>;
  workDir: string;
}

interface ScriptShot {
  id: string;
  description: string;
  durationSec: number;
  characters: string[];
  location?: string;
  complexity: Partial<Complexity>;
}
interface Script {
  title: string;
  characters: { key: string; description: string }[];
  locations: { key: string; description: string }[];
  scenes: { id: string; summary: string; shots: ScriptShot[] }[];
}

export interface FilmResult {
  status: 'completed' | 'rejected' | 'failed';
  title?: string;
  plan?: GenerationPlan;
  outputPath?: string;
  final?: ProbeInfo;
  shots: { shotId: string; sceneId: string; status: 'passed' | 'best_effort' | 'dropped'; modelId?: string; tier?: string; quality?: number }[];
  continuity: { sceneId: string; score: number; issues: { shotId: string; note: string }[] }[];
  cost: LedgerSummary;
  budget: ReturnType<BudgetController['snapshot']>;
  warnings: string[];
  failure?: string;
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cx = (v: unknown): Partial<Complexity> => {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const out: Partial<Complexity> = {};
  for (const k of ['character', 'motion', 'camera', 'environment', 'lighting', 'continuity', 'narrative', 'visual'] as const) {
    if (typeof o[k] === 'number') out[k] = Math.min(10, Math.max(0, o[k] as number));
  }
  return out;
};

export function parseScript(text: string): Script {
  const j = parseJsonObject(text) as Record<string, any>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : []);
  const scenes = arr(j.scenes).map((s: any, si: number) => ({
    id: String(s.id ?? `scene_${si + 1}`),
    summary: String(s.summary ?? ''),
    shots: arr(s.shots).map((h: any, hi: number): ScriptShot => ({
      id: String(h.id ?? `s${si + 1}_${hi + 1}`),
      description: String(h.description ?? ''),
      durationSec: Math.max(1, num(h.durationSec, 5)),
      characters: arr(h.characters).map(String),
      location: h.location ? String(h.location) : undefined,
      complexity: cx(h.complexity),
    })).filter((h) => h.description),
  })).filter((s) => s.shots.length);
  if (!scenes.length) throw new Error('script has no scenes/shots');
  const ent = (v: unknown) => arr(v).map((e: any) => ({ key: String(e.key), description: String(e.description ?? e.key) })).filter((e) => e.key !== 'undefined');
  return { title: String(j.title ?? 'Untitled'), characters: ent(j.characters), locations: ent(j.locations), scenes };
}

const IMPORTANCE_WEIGHT: Record<Importance, number> = { background: 0.5, normal: 1, important: 2, hero: 4 };

/** Idea -> script -> shots -> plan -> (approval) -> generation -> QA/escalation -> continuity -> render. */
export class FilmAgent {
  private d: FilmDeps;
  constructor(deps: FilmDeps) {
    this.d = deps;
  }

  private async writeScript(r: FilmRequest, warnings: string[]): Promise<Script> {
    const prompt =
      `You are a film writer and shot planner. Idea: ${r.idea}\nStyle: ${r.style}\nTarget total duration: ${r.durationSec} seconds.\n` +
      `${r.characters?.length ? `Characters: ${r.characters.join('; ')}\n` : ''}` +
      `Reply with ONLY JSON: {"title":str,"characters":[{"key":str,"description":str}],"locations":[{"key":str,"description":str}],` +
      `"scenes":[{"id":str,"summary":str,"shots":[{"id":str,"description":str,"durationSec":number,"characters":[key],"location":key,` +
      `"complexity":{"character":0-10,"motion":0-10,"camera":0-10,"environment":0-10,"lighting":0-10,"continuity":0-10,"narrative":0-10,"visual":0-10}}]}]}. ` +
      `Shot durations should sum to about the target.`;
    let lastErr: unknown;
    for (let i = 0; i < 2; i++) {
      const res = await this.d.provider.generateText({
        tenantId: r.tenantId, projectId: r.projectId, shotId: 'script', jobId: `script-${i}`, requestId: `script-${r.filmId}-${i}`,
        idempotencyKey: `script-${r.filmId}-${i}`, model: this.d.plannerModel, prompt,
      });
      if (res.reportedCost !== undefined) this.commitExternalCost(res.reportedCost, res.costCurrency);
      try {
        return parseScript(resultText(res));
      } catch (e) {
        lastErr = e;
        warnings.push(`script attempt ${i + 1} unparseable: ${String(e)}`);
      }
    }
    throw new Error(`script generation failed: ${String(lastErr)}`);
  }

  commitExternalCost(amount: number, currency?: string): void {
    const base = this.d.registry.convert(amount, currency ?? this.d.config.baseCurrency) ?? amount;
    const resv = this.d.budget.reserve('overhead', 0);
    if (resv) this.d.budget.commit(resv, base);
  }

  async run(r: FilmRequest): Promise<FilmResult> {
    const d = this.d;
    const warnings: string[] = [];
    const filter = { tenantId: r.tenantId, projectId: r.projectId, filmId: r.filmId };
    const finish = (p: Partial<FilmResult>): FilmResult => ({
      status: 'failed', shots: [], continuity: [], warnings, cost: d.ledger.summary(filter), budget: d.budget.snapshot(), ...p,
    });

    let script: Script;
    try {
      script = await this.writeScript(r, warnings);
    } catch (e) {
      return finish({ failure: String(e) });
    }

    // ---- shot specs with importance, required quality, per-shot budgets
    const sceneIds = script.scenes.map((s) => s.id);
    const flat = script.scenes.flatMap((s) => s.shots.map((h) => ({ scene: s.id, h })));
    const meta = flat.map(({ scene, h }) => {
      const importance = deriveImportance(h.complexity);
      return { scene, h, importance, required: requiredQualityFor(h.complexity, importance, d.config, r.minQuality) };
    });
    const totalW = meta.reduce((a, m) => a + IMPORTANCE_WEIGHT[m.importance], 0);
    const pool = d.budget.snapshot().remaining * 0.85; // keep headroom for references/keyframes/music/judging
    const shots: ShotSpec[] = meta.map((m) => {
      const share = (pool * IMPORTANCE_WEIGHT[m.importance]) / totalW;
      const hasChars = m.h.characters.length > 0;
      return {
        tenantId: r.tenantId, projectId: r.projectId, filmId: r.filmId, sceneId: m.scene, shotId: m.h.id, modality: 'video',
        prompt: `${r.style}. ${m.h.description}`, durationSec: m.h.durationSec, importance: m.importance,
        requiredQuality: m.required, complexity: m.h.complexity,
        needs: { characterReference: hasChars || undefined },
        budget: { preferred: share * 0.5, max: share, hardLimit: share * 2 },
        continuity: hasChars ? { groupId: `${m.scene}` } : undefined,
      };
    });

    // ---- generation plan, shown/approved BEFORE spending
    const snap = d.budget.snapshot();
    const plan = d.planner.plan({ shots, budgetRemaining: snap.remaining, budgetTotal: snap.total, mode: r.mode });
    if (plan.unroutable.length) warnings.push(`${plan.unroutable.length} shot(s) have no viable model: ${plan.unroutable.map((u) => `${u.shotId} (${u.reason})`).join('; ')}`);
    if (r.approval !== 'auto') {
      const ok = d.approvePlan ? await d.approvePlan(plan) : false;
      if (!ok) return finish({ status: 'rejected', title: script.title, plan, failure: 'generation plan not approved' });
    }

    // ---- reference assets, keyframes, video
    const imgSpec = (shotId: string, prompt: string, over: Partial<ShotSpec> = {}): ShotSpec => ({
      tenantId: r.tenantId, projectId: r.projectId, filmId: r.filmId, sceneId: 'assets', shotId, modality: 'image', prompt,
      count: 1, importance: 'normal', requiredQuality: Math.max(6, r.minQuality - 1),
      budget: { preferred: 0.02 * pool / 10, max: 0.05 * pool / 10, hardLimit: 0.1 * pool / 10 }, ...over,
    });
    const refSpecs = new Map<string, EnsureAssetSpec>();
    for (const c of script.characters) refSpecs.set(`c:${c.key}`, { type: 'character', key: c.key, spec: imgSpec(`ref-char-${c.key}`, `${r.style}. Character reference sheet: ${c.description}`) });
    for (const l of script.locations) refSpecs.set(`l:${l.key}`, { type: 'location', key: l.key, spec: imgSpec(`ref-loc-${l.key}`, `${r.style}. Location establishing frame: ${l.description}`) });

    const outcomes = new Map<string, { outcome: ShotOutcome; uri?: string }>();
    for (const [i, shot] of shots.entries()) {
      const h = meta[i]!.h;
      const references = [...h.characters.map((k) => refSpecs.get(`c:${k}`)), h.location ? refSpecs.get(`l:${h.location}`) : undefined]
        .filter((x): x is EnsureAssetSpec => !!x);
      const res = await d.pipeline.produceVideoShot({
        video: shot, references,
        keyframe: r.useKeyframes === false ? undefined : { type: 'keyframe', key: shot.shotId, spec: imgSpec(`kf-${shot.shotId}`, `${shot.prompt} (first frame)`) },
        mode: r.mode,
      });
      outcomes.set(shot.shotId, { outcome: res.outcome, uri: res.video?.uri });
      if (res.outcome.status === 'failed') warnings.push(`shot ${shot.shotId} failed: ${res.outcome.failure}`);
    }

    // ---- collect clips (passed, or best effort if allowed)
    const shotReport: FilmResult['shots'] = [];
    const clips: { shotId: string; sceneId: string; uri: string }[] = [];
    for (const shot of shots) {
      const { outcome, uri } = outcomes.get(shot.shotId)!;
      if (outcome.status === 'passed' && uri) {
        clips.push({ shotId: shot.shotId, sceneId: shot.sceneId, uri });
        shotReport.push({ shotId: shot.shotId, sceneId: shot.sceneId, status: 'passed', modelId: outcome.modelId, tier: outcome.tier, quality: outcome.quality });
      } else if (r.acceptBestEffort && outcome.bestEffort?.result && resultUri(outcome.bestEffort.result)) {
        clips.push({ shotId: shot.shotId, sceneId: shot.sceneId, uri: resultUri(outcome.bestEffort.result)! });
        shotReport.push({ shotId: shot.shotId, sceneId: shot.sceneId, status: 'best_effort', modelId: outcome.bestEffort.modelId, quality: outcome.bestEffort.score?.overall });
      } else {
        shotReport.push({ shotId: shot.shotId, sceneId: shot.sceneId, status: 'dropped' });
      }
    }
    if (!clips.length) return finish({ title: script.title, plan, shots: shotReport, failure: 'no shot passed QA' });

    // ---- continuity (reported, not auto-fixed)
    const continuity: FilmResult['continuity'] = [];
    if (d.judge) {
      for (const sid of sceneIds) {
        const sc = clips.filter((c) => c.sceneId === sid);
        try {
          const c = await d.judge.continuity(sc.map(({ shotId, uri }) => ({ shotId, uri })));
          continuity.push({ sceneId: sid, ...c });
        } catch (e) {
          warnings.push(`continuity check failed for ${sid}: ${String(e)}`);
        }
      }
    }

    // ---- music (optional; unverified by QA)
    const tracks: { uri: string; volume: number }[] = [];
    if (r.withMusic) {
      const m = await d.orchestrator.produceShot({
        tenantId: r.tenantId, projectId: r.projectId, filmId: r.filmId, sceneId: 'audio', shotId: 'music', modality: 'audio',
        prompt: `${r.style} instrumental score for: ${script.title}`, durationSec: r.durationSec, importance: 'background',
        requiredQuality: 6, budget: { preferred: 0.02 * pool, max: 0.05 * pool, hardLimit: 0.1 * pool },
      }, { mode: r.mode });
      const u = m.result ? resultUri(m.result) : undefined;
      if (m.status === 'passed' && u) tracks.push({ uri: u, volume: 0.5 });
      else warnings.push(`music not generated: ${m.failure ?? 'failed'}`);
    }

    // ---- render + final QA
    const out = join(d.workDir, r.filmId);
    await mkdir(out, { recursive: true });
    try {
      let outputPath = join(out, 'film.mp4');
      let final = await renderFilm({ clips: clips.map((c) => c.uri), tracks, out: outputPath, workDir: join(out, 'work') });
      if (r.upscaleHeight && (final.height ?? 0) < r.upscaleHeight) {
        const up = join(out, 'film-upscaled.mp4');
        final = await upscale(outputPath, up, r.upscaleHeight);
        outputPath = up;
      }
      const check = await probe(outputPath);
      if (!check.hasVideo || check.durationSec <= 0) return finish({ title: script.title, plan, shots: shotReport, continuity, failure: 'final QA: rendered file has no video' });
      const expected = clips.reduce((a, c) => a + (shots.find((s) => s.shotId === c.shotId)?.durationSec ?? 0), 0);
      if (Math.abs(check.durationSec - expected) > Math.max(2, expected * 0.25)) warnings.push(`final QA: duration ${check.durationSec.toFixed(1)}s differs from planned ${expected}s (provider clip lengths)`);
      return finish({ status: 'completed', title: script.title, plan, outputPath, final: check, shots: shotReport, continuity });
    } catch (e) {
      return finish({ title: script.title, plan, shots: shotReport, continuity, failure: `render failed: ${String(e)}` });
    }
  }
}
