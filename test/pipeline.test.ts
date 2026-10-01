import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssetLibrary, AssetPipeline } from '../src/index.ts';
import type { ModelEntryInput } from '../src/index.ts';
import { model, shot, world } from './helpers.ts';

const imageModel = (p: string, n: string, over: Partial<ModelEntryInput> = {}): ModelEntryInput => ({
  provider: p, model: n, modality: 'image', capabilities: {}, quality: { overall: 8 },
  economics: { currency: 'EUR', free: true }, ...over,
});
const img = (over = {}) => shot({ modality: 'image', durationSec: undefined, count: 1, requiredQuality: 7, ...over });

test('reuse-first: second request for the same asset costs nothing and calls no API', async () => {
  const w = world([imageModel('i', 'free')]);
  const p = new AssetPipeline(new AssetLibrary(), w.orch);
  const spec = { type: 'character' as const, key: 'hero', spec: img({ shotId: 'asset-hero', prompt: 'hero portrait' }) };
  const a = await p.ensureAsset(spec, 'balanced');
  const b = await p.ensureAsset({ ...spec, spec: img({ shotId: 'other', prompt: 'different prompt' }) }, 'balanced');
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(b.asset?.assetId, a.asset?.assetId);
  assert.equal(w.provider.calls.length, 1);
});

test('asset below required quality is not reused (new version created)', async () => {
  const w = world([imageModel('i', 'free')]);
  const lib = new AssetLibrary();
  const p = new AssetPipeline(lib, w.orch);
  lib.add({ tenantId: 't1', projectId: 'p1', type: 'location', key: 'street', uri: 'mem://old', provider: 'x', model: 'y', generationCost: 0, quality: 5 });
  const r = await p.ensureAsset({ type: 'location', key: 'street', spec: img({ prompt: 'berlin street', requiredQuality: 7 }) }, 'balanced');
  assert.equal(r.reused, false);
  assert.equal(r.asset?.version, 2);
});

test('assets are tenant/project isolated', () => {
  const lib = new AssetLibrary();
  lib.add({ tenantId: 'A', projectId: 'p', type: 'prop', key: 'k', uri: 'u', provider: 'x', model: 'y', generationCost: 0 });
  assert.equal(lib.find({ tenantId: 'B', projectId: 'p', type: 'prop', key: 'k' }), undefined);
  assert.ok(lib.find({ tenantId: 'A', projectId: 'p', type: 'prop', key: 'k' }));
});

test('keyframe -> image-to-video: video request carries keyframe, references reused across shots', async () => {
  const w = world([imageModel('i', 'free'), model('v', 'i2v', { cps: 0.03, q: 8 })]);
  const lib = new AssetLibrary();
  const p = new AssetPipeline(lib, w.orch);
  const hero = { type: 'character' as const, key: 'hero', spec: img({ shotId: 'ref-hero', prompt: 'hero ref' }) };
  const run = (id: string) => p.produceVideoShot({
    video: shot({ shotId: id, prompt: `video ${id}`, importance: 'normal', requiredQuality: 7 }),
    references: [hero],
    keyframe: { type: 'keyframe', key: id, spec: img({ shotId: `kf-${id}`, prompt: `keyframe ${id}` }) },
    mode: 'balanced',
  });
  const r1 = await run('s1');
  const r2 = await run('s2');
  assert.equal(r1.usedKeyframe, true);
  assert.equal(r1.outcome.status, 'passed');
  const videoCall = w.provider.calls.filter((c) => c.model === 'v/i2v')[0]!;
  assert.equal(videoCall.inputAssets?.[0], r1.keyframe!.uri);
  assert.equal(r1.video?.metadata.keyframe, r1.keyframe!.assetId);
  // hero reference generated once; 2 keyframes + 2 videos + 1 hero = 5 calls
  assert.equal(w.provider.calls.length, 5);
  assert.equal(r2.references[0]!.assetId, r1.references[0]!.assetId);
});

test('keyframe failure falls back to text-to-video', async () => {
  const w = world([imageModel('i', 'bad', { quality: { overall: 8 } }), model('v', 't2v', { cps: 0.03, q: 8 })]);
  w.provider.failModels.add('i/bad');
  const p = new AssetPipeline(new AssetLibrary(), w.orch);
  const r = await p.produceVideoShot({
    video: shot({ prompt: 'vid' }),
    keyframe: { type: 'keyframe', key: 'k', spec: img({ prompt: 'kf' }) },
    mode: 'balanced',
  });
  assert.equal(r.usedKeyframe, false);
  assert.equal(r.outcome.status, 'passed');
});
