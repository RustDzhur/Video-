import { BudgetController, CostQualityRouter, DecisionLog, DEFAULT_CONFIG, GenerationOrchestrator, ModelRegistry, ModelStats, ProviderHealth, QuotaTracker, TransactionLedger } from '../src/index.ts';
import type { LiveModel, GenerationProvider, GenerationRequest, GenerationResult, ModelEntryInput, QualityEvaluator, RouterConfig, ShotSpec, QualityScore } from '../src/index.ts';

export const cfg: RouterConfig = { ...DEFAULT_CONFIG };

export function model(provider: string, name: string, over: Partial<ModelEntryInput> & { q?: number; cps?: number; free?: boolean; freeQuota?: boolean } = {}): ModelEntryInput {
  const q = over.q ?? 8;
  return {
    provider, model: name, modality: 'video',
    capabilities: { textToVideo: true, imageToVideo: true, characterReference: true, cameraControl: true, maxDurationSec: 10, maxHeight: 1080 },
    quality: { cinematic: q, motion: q, characters: q, consistency: q },
    economics: { currency: 'EUR', costPerSecond: over.cps, free: over.free, freeQuota: over.freeQuota },
    ...over,
  };
}

export function shot(over: Partial<ShotSpec> = {}): ShotSpec {
  return {
    tenantId: 't1', projectId: 'p1', sceneId: 's1', shotId: 'sh1', modality: 'video', prompt: 'a man walks',
    durationSec: 5, importance: 'background', requiredQuality: 6, budget: { preferred: 0.1, max: 0.5, hardLimit: 1 }, ...over,
  };
}

export class FakeProvider implements GenerationProvider {
  calls: GenerationRequest[] = [];
  failModels = new Set<string>();
  async listModels(): Promise<LiveModel[]> { return []; }
  private async gen(r: GenerationRequest): Promise<GenerationResult> {
    this.calls.push(r);
    if (this.failModels.has(r.model)) throw new Error('boom');
    return { assets: [{ url: `mem://${r.model}/${this.calls.length}` }], latencyMs: 10 };
  }
  generateText = (r: GenerationRequest) => this.gen(r);
  generateImage = (r: GenerationRequest) => this.gen(r);
  generateVideo = (r: GenerationRequest) => this.gen(r);
  generateAudio = (r: GenerationRequest) => this.gen(r);
}

/** QA returning scripted scores per model id (default 9). */
export class ScriptedQa implements QualityEvaluator {
  scores = new Map<string, number[]>();
  private lookup: (r: GenerationResult) => string;
  constructor(lookup: (r: GenerationResult) => string) { this.lookup = lookup; }
  async evaluate(r: GenerationResult): Promise<QualityScore> {
    const id = this.lookup(r);
    const q = this.scores.get(id);
    return { overall: q?.length ? q.shift()! : 9 };
  }
}

export function world(models: ModelEntryInput[], total = 50) {
  const registry = new ModelRegistry(cfg);
  models.forEach((m) => registry.upsert(m));
  const quotas = new QuotaTracker();
  const health = new ProviderHealth();
  const stats = new ModelStats();
  const router = new CostQualityRouter({ registry, quotas, health, config: cfg, stats });
  const budget = new BudgetController({ tenantId: 't1', projectId: 'p1', total, currency: 'EUR' });
  const ledger = new TransactionLedger();
  const decisionLog = new DecisionLog();
  const provider = new FakeProvider();
  const qa = new ScriptedQa((r) => (r.assets[0]!.url as string).split('/')[2]! + '/' + (r.assets[0]!.url as string).split('/')[3]!);
  const orch = new GenerationOrchestrator({ router, registry, budget, quotas, health, stats, ledger, decisionLog, provider, qa, config: cfg, retry: { retries: 0 } });
  return { registry, quotas, health, stats, router, budget, ledger, decisionLog, provider, qa, orch };
}
