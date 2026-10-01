import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FallbackProvider, GatewayError, OmniRouteAdapter, ProviderDiscoveryWorker, ModelRegistry, retryWithBackoff } from '../src/index.ts';
import type { GenerationRequest } from '../src/index.ts';
import { cfg, FakeProvider } from './helpers.ts';

const req: GenerationRequest = { tenantId: 't', projectId: 'p', shotId: 's', jobId: 'j', requestId: 'r', idempotencyKey: 'k', model: 'prov/vid', prompt: 'hi', durationSec: 5 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('adapter calls /v1/videos/generations with idempotency header and parses cost', async () => {
  let seen: { url: string; headers: Headers; body: any } | undefined;
  const a = new OmniRouteAdapter({
    baseUrl: 'http://gw/', apiKey: 'K',
    fetch: (async (url: string, init: RequestInit) => {
      seen = { url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) };
      return json({ data: [{ url: 'http://x/v.mp4' }], usage: { cost: 0.12, currency: 'USD' } });
    }) as unknown as typeof fetch,
  });
  const r = await a.generateVideo(req);
  assert.equal(seen!.url, 'http://gw/v1/videos/generations');
  assert.equal(seen!.headers.get('idempotency-key'), 'k');
  assert.equal(seen!.headers.get('authorization'), 'Bearer K');
  assert.equal(seen!.body.model, 'prov/vid');
  assert.equal(r.reportedCost, 0.12);
  assert.equal(r.assets[0]!.url, 'http://x/v.mp4');
});

test('adapter maps HTTP errors to GatewayError kinds', async () => {
  const mk = (status: number) => new OmniRouteAdapter({ baseUrl: 'http://gw', fetch: (async () => json({}, status)) as unknown as typeof fetch });
  await assert.rejects(mk(429).generateImage(req), (e: GatewayError) => e.kind === 'rate_limited' && e.retryable);
  await assert.rejects(mk(503).generateImage(req), (e: GatewayError) => e.kind === 'unavailable');
  await assert.rejects(mk(400).generateImage(req), (e: GatewayError) => e.kind === 'rejected' && !e.retryable);
});

test('direct-provider fallback only on transient gateway failure', async () => {
  const direct = new FakeProvider();
  const down = new OmniRouteAdapter({ baseUrl: 'http://gw', fetch: (async () => json({}, 503)) as unknown as typeof fetch });
  const fb = new FallbackProvider(down, [{ provider: direct, handles: (m) => m.startsWith('prov/') }]);
  await fb.generateVideo(req);
  assert.equal(direct.calls.length, 1);
  const rejecting = new OmniRouteAdapter({ baseUrl: 'http://gw', fetch: (async () => json({}, 400)) as unknown as typeof fetch });
  await assert.rejects(new FallbackProvider(rejecting, [{ provider: direct, handles: () => true }]).generateVideo(req));
  assert.equal(direct.calls.length, 1);
});

test('discovery syncs live catalog with metadata, marks vanished models unavailable, leaves unclassified out', async () => {
  const registry = new ModelRegistry(cfg);
  let live = [{ id: 'a/m1' }, { id: 'a/m2' }, { id: 'zzz/unknown' }];
  const provider = new FakeProvider();
  provider.listModels = async () => live;
  const meta = {
    'a/*': { modality: 'video' as const, capabilities: { textToVideo: true }, quality: { overall: 7 }, economics: { currency: 'EUR', costPerSecond: 0.03 } },
  };
  const w = new ProviderDiscoveryWorker(provider, registry, () => meta);
  const r1 = await w.runOnce();
  assert.equal(r1.registered, 2);
  assert.deepEqual(r1.unclassified, ['zzz/unknown']);
  assert.equal(registry.get('a/m1')!.tier, 'cheap');
  live = [{ id: 'a/m1' }];
  const r2 = await w.runOnce();
  assert.deepEqual(r2.markedUnavailable, ['a/m2']);
  provider.listModels = async () => { throw new Error('down'); };
  assert.ok((await w.runOnce()).error);
  assert.equal(registry.get('a/m1')!.status, 'available'); // outage keeps last known state
});

test('retry: exponential backoff with jitter, stops on non-retryable', async () => {
  const sleeps: number[] = [];
  let n = 0;
  const v = await retryWithBackoff(async () => { if (++n < 3) throw new Error('x'); return 'ok'; }, {
    retries: 3, baseMs: 100, maxMs: 1000, sleep: async (ms) => { sleeps.push(ms); }, random: () => 1,
  });
  assert.equal(v, 'ok');
  assert.deepEqual(sleeps, [100, 200]);
  await assert.rejects(retryWithBackoff(async () => { throw new Error('no'); }, { retries: 5, baseMs: 1, maxMs: 1, shouldRetry: () => false, sleep: async () => {} }));
});
