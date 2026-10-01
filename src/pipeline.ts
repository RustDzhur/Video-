import type { Asset, AssetLibrary, AssetType } from './assets.ts';
import { resultUri } from './assets.ts';
import type { GenerationOrchestrator, ShotOutcome } from './orchestrator.ts';
import type { RoutingMode, ShotGenerationPolicy, ShotSpec } from './types.ts';

export interface EnsureAssetSpec {
  type: AssetType;
  key: string;
  /** Image-generation shot used if the asset does not exist yet. */
  spec: ShotSpec;
  policy?: ShotGenerationPolicy;
}

export interface EnsureResult {
  asset?: Asset;
  reused: boolean;
  cost: number;
  outcome?: ShotOutcome;
}

export interface VideoShotResult {
  outcome: ShotOutcome;
  video?: Asset;
  keyframe?: Asset;
  references: Asset[];
  usedKeyframe: boolean;
  /** Generation cost of newly created assets (reused assets cost 0). */
  totalCost: number;
}

/**
 * Reuse-first asset pipeline: references -> keyframe -> image-to-video, falling back to text-to-video
 * if the keyframe cannot be produced. Every generated result is registered in the Asset Library.
 */
export class AssetPipeline {
  private lib: AssetLibrary;
  private orch: GenerationOrchestrator;

  constructor(lib: AssetLibrary, orch: GenerationOrchestrator) {
    this.lib = lib;
    this.orch = orch;
  }

  async ensureAsset(s: EnsureAssetSpec, mode: RoutingMode): Promise<EnsureResult> {
    const { tenantId, projectId } = s.spec;
    const hit = this.lib.find({ tenantId, projectId, type: s.type, key: s.key, minQuality: s.spec.requiredQuality });
    if (hit) return { asset: hit, reused: true, cost: 0 };
    return this.generate(s, mode);
  }

  private async generate(s: EnsureAssetSpec, mode: RoutingMode): Promise<EnsureResult> {
    const outcome = await this.orch.produceShot(s.spec, { mode, policy: s.policy });
    const uri = outcome.result ? resultUri(outcome.result) : undefined;
    if (outcome.status !== 'passed' || !uri || !outcome.modelId) return { reused: false, cost: outcome.totalCost, outcome };
    const slash = outcome.modelId.indexOf('/');
    const asset = this.lib.add({
      tenantId: s.spec.tenantId, projectId: s.spec.projectId, type: s.type, key: s.key, uri,
      provider: outcome.modelId.slice(0, slash), model: outcome.modelId.slice(slash + 1),
      generationCost: outcome.totalCost, quality: outcome.quality,
      metadata: { shotId: s.spec.shotId, prompt: s.spec.prompt, cached: outcome.cached ?? false },
    });
    return { asset, reused: false, cost: outcome.totalCost, outcome };
  }

  async produceVideoShot(o: {
    video: ShotSpec;
    references?: EnsureAssetSpec[];
    keyframe?: EnsureAssetSpec; // image spec for the shot's keyframe; omit => text-to-video
    mode: RoutingMode;
    policy?: ShotGenerationPolicy;
  }): Promise<VideoShotResult> {
    let totalCost = 0;
    const references: Asset[] = [];
    for (const r of o.references ?? []) {
      const e = await this.ensureAsset(r, o.mode);
      totalCost += e.cost;
      if (e.asset) references.push(e.asset);
    }

    let keyframe: Asset | undefined;
    if (o.keyframe) {
      const k = { ...o.keyframe, spec: { ...o.keyframe.spec, inputAssets: [...(o.keyframe.spec.inputAssets ?? []), ...references.map((a) => a.uri)] } };
      const e = await this.ensureAsset(k, o.mode);
      totalCost += e.cost;
      keyframe = e.asset;
    }

    const video: ShotSpec = keyframe
      ? { ...o.video, inputAssets: [keyframe.uri, ...(o.video.inputAssets ?? [])], needs: { ...o.video.needs, imageToVideo: true } }
      : o.video;
    const outcome = await this.orch.produceShot(video, { mode: o.mode, policy: o.policy });
    totalCost += outcome.totalCost;

    let videoAsset: Asset | undefined;
    const uri = outcome.result ? resultUri(outcome.result) : undefined;
    if (outcome.status === 'passed' && uri && outcome.modelId) {
      const slash = outcome.modelId.indexOf('/');
      videoAsset = this.lib.add({
        tenantId: o.video.tenantId, projectId: o.video.projectId, type: 'video', key: o.video.shotId, uri,
        provider: outcome.modelId.slice(0, slash), model: outcome.modelId.slice(slash + 1),
        generationCost: outcome.totalCost, quality: outcome.quality,
        metadata: { sceneId: o.video.sceneId, keyframe: keyframe?.assetId, references: references.map((a) => a.assetId) },
      });
    }
    return { outcome, video: videoAsset, keyframe, references, usedKeyframe: !!keyframe, totalCost };
  }
}
