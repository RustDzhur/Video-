import { createHash } from 'node:crypto';
import type { GenerationResult } from './gateway.ts';

export type AssetType =
  | 'character' | 'location' | 'prop' | 'vehicle' | 'costume' | 'keyframe' | 'reference_image'
  | 'video' | 'audio' | 'music' | 'sfx';

export interface Asset {
  tenantId: string;
  projectId: string;
  assetId: string;
  type: AssetType;
  /** Logical identity, e.g. `main_hero`, `berlin_street`, `shot_127`. Versions share a key. */
  key: string;
  version: number;
  provider: string;
  model: string;
  generationCost: number;
  createdAt: number;
  hash: string;
  uri: string;
  /** QA score at creation; reuse can require a minimum. */
  quality?: number;
  metadata: Record<string, unknown>;
}

export interface AssetQuery {
  tenantId: string; // mandatory: tenant isolation
  projectId: string;
  type: AssetType;
  key: string;
  minQuality?: number;
}

/** Storage seam: replace with Mongo/MinIO-backed implementation. */
export interface AssetStore {
  put(a: Asset): void;
  all(tenantId: string, projectId: string): Asset[];
}

export class InMemoryAssetStore implements AssetStore {
  private rows: Asset[] = [];
  put(a: Asset): void { this.rows.push(a); }
  all(tenantId: string, projectId: string): Asset[] {
    return this.rows.filter((a) => a.tenantId === tenantId && a.projectId === projectId);
  }
}

export function resultUri(r: GenerationResult): string | undefined {
  const a = r.assets[0];
  if (!a) return undefined;
  return a.url ?? (a.b64 ? `data:${a.mimeType ?? 'application/octet-stream'};base64,${a.b64}` : undefined);
}

export class AssetLibrary {
  private store: AssetStore;
  private now: () => number;
  private seq = 0;

  constructor(store: AssetStore = new InMemoryAssetStore(), now: () => number = Date.now) {
    this.store = store;
    this.now = now;
  }

  /** Latest version of (type,key) satisfying the quality floor, or undefined. */
  find(q: AssetQuery): Asset | undefined {
    return this.store
      .all(q.tenantId, q.projectId)
      .filter((a) => a.type === q.type && a.key === q.key && (q.minQuality === undefined || (a.quality ?? 0) >= q.minQuality))
      .sort((a, b) => b.version - a.version)[0];
  }

  /** Registers an asset; identical content (hash) under the same key is not duplicated. */
  add(i: Omit<Asset, 'assetId' | 'version' | 'createdAt' | 'hash' | 'metadata'> & { metadata?: Record<string, unknown> }): Asset {
    const hash = createHash('sha256').update(i.uri).digest('hex');
    const existing = this.store.all(i.tenantId, i.projectId).filter((a) => a.type === i.type && a.key === i.key);
    const dup = existing.find((a) => a.hash === hash);
    if (dup) return dup;
    const asset: Asset = {
      ...i, hash, metadata: i.metadata ?? {}, createdAt: this.now(),
      version: existing.reduce((m, a) => Math.max(m, a.version), 0) + 1,
      assetId: `ast_${(++this.seq).toString(36)}_${hash.slice(0, 8)}`,
    };
    this.store.put(asset);
    return asset;
  }

  list(tenantId: string, projectId: string, type?: AssetType): Asset[] {
    return this.store.all(tenantId, projectId).filter((a) => !type || a.type === type);
  }
}
