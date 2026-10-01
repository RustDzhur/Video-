import type { GenerationProvider } from './gateway.ts';
import type { ModelRegistry } from './registry.ts';
import type { Modality, ModelEntryInput } from './types.ts';

/** Operator-maintained metadata (prices, quality priors, capabilities). Not hardcoded in code. */
export type ModelMetadata = Omit<ModelEntryInput, 'provider' | 'model'> & { modality: Modality };
/** Keys: exact `provider/model` or `provider/*`. */
export type MetadataCatalog = Record<string, ModelMetadata>;

const MODALITIES: Modality[] = ['text', 'image', 'video', 'audio'];

export function lookupMetadata(catalog: MetadataCatalog, id: string): ModelMetadata | undefined {
  const exact = catalog[id];
  if (exact) return exact;
  const slash = id.indexOf('/');
  return slash > 0 ? catalog[`${id.slice(0, slash)}/*`] : undefined;
}

export interface DiscoveryResult {
  discovered: number;
  registered: number;
  unclassified: string[];
  markedUnavailable: string[];
  error?: string;
}

/**
 * Periodically syncs the Model Registry with the live gateway catalog (GET /v1/models),
 * enriched with operator metadata. Models without metadata are not routable (no price/quality).
 */
export class ProviderDiscoveryWorker {
  private provider: GenerationProvider;
  private registry: ModelRegistry;
  private catalog: () => MetadataCatalog;
  private timer: NodeJS.Timeout | undefined;

  constructor(provider: GenerationProvider, registry: ModelRegistry, catalog: () => MetadataCatalog) {
    this.provider = provider;
    this.registry = registry;
    this.catalog = catalog;
  }

  async runOnce(): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { discovered: 0, registered: 0, unclassified: [], markedUnavailable: [] };
    let live;
    try {
      live = await this.provider.listModels();
    } catch (e) {
      result.error = e instanceof Error ? e.message : String(e);
      return result; // keep previous registry state; stale pruning handles long outages
    }
    result.discovered = live.length;
    const seen = new Set<string>();
    const cat = this.catalog();
    for (const { id, modality: hinted } of live) {
      const slash = id.indexOf('/');
      if (slash <= 0) {
        result.unclassified.push(id);
        continue;
      }
      const meta = lookupMetadata(cat, id);
      const modality = meta?.modality ?? (hinted && MODALITIES.includes(hinted) ? hinted : undefined);
      if (!modality) {
        result.unclassified.push(id);
        continue;
      }
      this.registry.upsert({
        quality: {},
        capabilities: {},
        economics: { currency: 'USD' },
        ...meta,
        modality,
        provider: id.slice(0, slash),
        model: id.slice(slash + 1),
        status: 'available',
      });
      seen.add(id);
      result.registered++;
    }
    for (const m of this.registry.list()) {
      if (!seen.has(m.id) && m.status === 'available') {
        this.registry.setStatus(m.id, 'unavailable');
        result.markedUnavailable.push(m.id);
      }
    }
    this.registry.pruneStale();
    return result;
  }

  start(intervalMs = 6 * 3600 * 1000): void {
    this.stop();
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
