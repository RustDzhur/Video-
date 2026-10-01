import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AssetLibrary, AssetPipeline, FilmAgent, GenerationPlanner, ModalityQa, VlmJudge, extractFrames, parseScript, probe, renderFilm,
} from '../src/index.ts';
import type { GenerationRequest, GenerationResult, ModelEntryInput, QualityEvaluator } from '../src/index.ts';
import { cfg, FakeProvider, model, world } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'film-'));
let n = 0;
const ff = (...a: string[]) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a]);
const mkVideo = (sec = 1) => { const f = join(dir, `v${n++}.mp4`); ff('-f', 'lavfi', '-i', `testsrc=size=320x240:rate=24:duration=${sec}`, '-pix_fmt', 'yuv420p', f); return f; };
const mkImage = () => { const f = join(dir, `i${n++}.png`); ff('-f', 'lavfi', '-i', 'color=c=blue:s=320x240', '-frames:v', '1', f); return f; };
const mkAudio = () => { const f = join(dir, `a${n++}.wav`); ff('-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', f); return f; };
const txt = (s: string): GenerationResult => ({ assets: [{ b64: Buffer.from(s).toString('base64'), mimeType: 'text/plain' }], latencyMs: 1 });

const SCRIPT = JSON.stringify({
  title: 'Test Film',
  characters: [{ key: 'hero', description: 'a pilot' }],
  locations: [{ key: 'ship', description: 'cockpit' }],
  scenes: [
    { id: 'sc1', summary: 'a', shots: [
      { id: 'sh1', description: 'pilot walks in', durationSec: 1, characters: ['hero'], location: 'ship', complexity: { character: 4, motion: 3, narrative: 3, visual: 3 } },
      { id: 'sh2', description: 'close up face', durationSec: 1, characters: ['hero'], location: 'ship', complexity: { character: 8, motion: 5, narrative: 9, visual: 9 } },
    ] },
  ],
});

class MediaProvider extends FakeProvider {
  override generateText = async (r: GenerationRequest) => { this.calls.push(r); return txt(r.model === 'judge/vlm' ? '{"score":8.5,"issues":[]}' : SCRIPT); };
  override generateImage = async (r: GenerationRequest) => { this.calls.push(r); return { assets: [{ url: mkImage() }], latencyMs: 1 }; };
  override generateVideo = async (r: GenerationRequest) => { this.calls.push(r); return { assets: [{ url: mkVideo(1) }], latencyMs: 1 }; };
  override generateAudio = async (r: GenerationRequest) => { this.calls.push(r); return { assets: [{ url: mkAudio() }], latencyMs: 1 }; };
}

const mdl = (provider: string, name: string, modality: 'image' | 'audio', q = 8): ModelEntryInput => ({
  provider, model: name, modality, capabilities: {}, quality: { overall: q }, economics: { currency: 'EUR', free: true },
});

test('ffmpeg: render concatenates clips, mixes audio, probes result', async () => {
  const out = join(dir, 'r.mp4');
  const info = await renderFilm({ clips: [mkVideo(1), mkVideo(2)], tracks: [{ uri: mkAudio(), volume: 0.5 }], out, workDir: join(dir, 'w1'), width: 640, height: 360 });
  assert.ok(info.hasVideo && info.hasAudio);
  assert.ok(Math.abs(info.durationSec - 3) < 0.3);
  assert.equal(info.height, 360);
});

test('frames extraction + VLM judge parses scores and clamps', async () => {
  const frames = await extractFrames(mkVideo(2), 3, join(dir, 'fr'));
  assert.equal(frames.length, 3);
  assert.ok(frames[0]!.startsWith('data:image/jpeg;base64,'));
  const p = new FakeProvider();
  let seen: GenerationRequest | undefined;
  p.generateText = async (r) => { seen = r; return txt('Sure! {"visual_quality": 9, "artifact_score": 14, "prompt_adherence": 7}'); };
  const j = new VlmJudge({ provider: p, model: 'judge/vlm', frames: async () => frames });
  const s = await j.evaluate({ assets: [{ url: 'x' }], latencyMs: 1 }, { ...(await import('./helpers.ts')).shot(), prompt: 'a man' });
  assert.equal(s.artifact_score, 10);
  assert.ok(Math.abs(s.overall - (9 + 10 + 7) / 3) < 1e-9);
  assert.equal(seen!.inputAssets!.length, 3);
});

test('ModalityQa marks modalities without an evaluator as unverified', async () => {
  const q = new ModalityQa({});
  const s = await q.evaluate({ assets: [], latencyMs: 1 }, { ...(await import('./helpers.ts')).shot(), modality: 'audio' });
  assert.equal(s.overall, 6);
  assert.ok(q.unverified.has('sh1'));
});

test('parseScript tolerates prose around JSON and rejects empty scripts', () => {
  assert.equal(parseScript(`here: ${SCRIPT} done`).scenes[0]!.shots.length, 2);
  assert.throws(() => parseScript('{"scenes":[]}'));
});

function build(approve?: (p: unknown) => Promise<boolean>) {
  const provider = new MediaProvider();
  const w = world([model('v', 'cheap', { cps: 0.03, q: 9.6 }), mdl('i', 'img', 'image'), mdl('m', 'music', 'audio')], 20);
  const passQa: QualityEvaluator = { evaluate: async () => ({ overall: 10 }) };
  const orch = new (w.orch.constructor as any)({
    router: w.router, registry: w.registry, budget: w.budget, quotas: w.quotas, health: w.health, stats: w.stats,
    ledger: w.ledger, decisionLog: w.decisionLog, provider, qa: passQa, config: cfg, retry: { retries: 0 },
  });
  const judge = new VlmJudge({ provider, model: 'judge/vlm', frames: (u, k) => extractFrames(u, k, join(dir, 'jf')) });
  const agent = new FilmAgent({
    provider, plannerModel: 'plan/llm', registry: w.registry, budget: w.budget, orchestrator: orch,
    pipeline: new AssetPipeline(new AssetLibrary(), orch), planner: new GenerationPlanner({ registry: w.registry, health: w.health, quotas: w.quotas, config: cfg }),
    ledger: w.ledger, config: cfg, judge, workDir: join(dir, 'films'), approvePlan: approve as any,
  });
  return { w, provider, agent };
}
const req = { tenantId: 't1', projectId: 'p1', filmId: 'f1', idea: 'x', durationSec: 2, style: 'cinematic sci-fi', minQuality: 7, mode: 'balanced' as const, approval: 'auto' as const };

test('FULL AUTO: idea -> script -> plan -> references -> keyframes -> video -> music -> continuity -> final film', async () => {
  const { w, agent, provider } = build();
  const r = await agent.run({ ...req, withMusic: true, upscaleHeight: 1080 });
  assert.equal(r.status, 'completed', r.failure);
  assert.equal(r.shots.filter((s) => s.status === 'passed').length, 2);
  assert.ok(r.final!.hasAudio && r.final!.height === 1080);
  assert.equal(r.continuity[0]!.score, 8.5);
  // hero reference + location generated once, reused by shot 2 (2 refs + 2 keyframes = 4 images)
  assert.equal(provider.calls.filter((c) => c.model === 'i/img').length, 4);
  assert.ok(r.cost.actual > 0 && r.cost.actual <= 20);
  assert.equal(r.budget.spent, r.cost.actual);
  assert.ok(r.plan!.estimatedCost > 0);
  assert.equal(w.ledger.summary({ tenantId: 'other' }).count, 0);
});

test('SEMI-AUTO: rejected plan spends nothing', async () => {
  const { agent, provider } = build(async () => false);
  const r = await agent.run({ ...req, approval: 'semi_auto' });
  assert.equal(r.status, 'rejected');
  assert.equal(provider.calls.filter((c) => c.model !== 'plan/llm').length, 0);
});
