import type { Modality } from './types.ts';

export type GatewayErrorKind = 'unavailable' | 'rate_limited' | 'rejected' | 'timeout';

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status: number | undefined;
  constructor(kind: GatewayErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'GatewayError';
    this.kind = kind;
    this.status = status;
  }
  /** Transient: worth retrying on the same model. */
  get retryable(): boolean {
    return this.kind !== 'rejected';
  }
}

export interface GenerationRequest {
  tenantId: string;
  projectId: string;
  shotId: string;
  jobId: string;
  requestId: string;
  idempotencyKey: string;
  /** `provider/model` */
  model: string;
  prompt: string;
  durationSec?: number;
  params?: Record<string, unknown>;
  inputAssets?: string[];
}

export interface GeneratedAsset {
  url?: string;
  b64?: string;
  mimeType?: string;
}

export interface GenerationResult {
  assets: GeneratedAsset[];
  /** Cost reported by the gateway/provider, in `costCurrency`. Absent => estimate is used. */
  reportedCost?: number;
  costCurrency?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface LiveModel {
  id: string;
  modality?: Modality;
}

/** The only surface the Film Agent depends on. Gateways and direct providers implement it. */
export interface GenerationProvider {
  listModels(): Promise<LiveModel[]>;
  generateText(req: GenerationRequest): Promise<GenerationResult>;
  generateImage(req: GenerationRequest): Promise<GenerationResult>;
  generateVideo(req: GenerationRequest): Promise<GenerationResult>;
  generateAudio(req: GenerationRequest): Promise<GenerationResult>;
}

export function generateByModality(p: GenerationProvider, modality: Modality, req: GenerationRequest): Promise<GenerationResult> {
  switch (modality) {
    case 'text':
      return p.generateText(req);
    case 'image':
      return p.generateImage(req);
    case 'video':
      return p.generateVideo(req);
    case 'audio':
      return p.generateAudio(req);
  }
}

export interface OmniRouteOptions {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /**
   * Request-body mappers. Defaults follow OpenAI-style conventions; field names for
   * video parameters differ between providers/versions and MUST be verified against the
   * deployed OmniRoute version (see README "Assumptions").
   */
  mapVideoBody?: (req: GenerationRequest) => Record<string, unknown>;
  mapImageBody?: (req: GenerationRequest) => Record<string, unknown>;
  mapAudioBody?: (req: GenerationRequest) => Record<string, unknown>;
  mapTextBody?: (req: GenerationRequest) => Record<string, unknown>;
}

type Json = Record<string, any>;

export class OmniRouteAdapter implements GenerationProvider {
  private o: OmniRouteOptions;
  private f: typeof fetch;

  constructor(options: OmniRouteOptions) {
    this.o = options;
    this.f = options.fetch ?? fetch;
  }

  private async call(method: 'GET' | 'POST', path: string, body: Json | undefined, req?: GenerationRequest): Promise<Json> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.o.apiKey) headers.authorization = `Bearer ${this.o.apiKey}`;
    if (req) {
      headers['idempotency-key'] = req.idempotencyKey;
      headers['x-request-id'] = req.requestId;
    }
    let res: Response;
    try {
      res = await this.f(this.o.baseUrl.replace(/\/$/, '') + path, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 600_000),
      });
    } catch (e) {
      const timeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new GatewayError(timeout ? 'timeout' : 'unavailable', `gateway ${timeout ? 'timeout' : 'unreachable'}: ${String(e)}`);
    }
    if (res.status === 429) throw new GatewayError('rate_limited', 'rate limited', 429);
    if (res.status >= 500) throw new GatewayError('unavailable', `gateway ${res.status}`, res.status);
    if (!res.ok) throw new GatewayError('rejected', `gateway rejected request: ${res.status} ${(await res.text()).slice(0, 300)}`, res.status);
    return (await res.json()) as Json;
  }

  async listModels(): Promise<LiveModel[]> {
    const j = await this.call('GET', '/v1/models', undefined);
    const arr: Json[] = Array.isArray(j.data) ? j.data : [];
    return arr
      .filter((m) => typeof m.id === 'string')
      .map((m) => {
        const hint = m.modality ?? m.type;
        return { id: m.id as string, modality: ['text', 'image', 'video', 'audio'].includes(hint) ? (hint as Modality) : undefined };
      });
  }

  private parse(j: Json, started: number): GenerationResult {
    const items: Json[] = Array.isArray(j.data) ? j.data : [];
    const assets = items.map((d) => ({ url: d.url, b64: d.b64_json, mimeType: d.mime_type }));
    const cost = j.usage?.cost ?? j.cost;
    return {
      assets,
      reportedCost: typeof cost === 'number' ? cost : undefined,
      costCurrency: j.usage?.currency ?? j.currency,
      latencyMs: Date.now() - started,
      raw: j,
    };
  }

  async generateText(req: GenerationRequest): Promise<GenerationResult> {
    const t = Date.now();
    const content = req.inputAssets?.length
      ? [{ type: 'text', text: req.prompt }, ...req.inputAssets.map((u) => ({ type: 'image_url', image_url: { url: u } }))]
      : req.prompt;
    const body = this.o.mapTextBody?.(req) ?? { model: req.model, messages: [{ role: 'user', content }], ...req.params };
    const j = await this.call('POST', '/v1/chat/completions', body, req);
    const text = j.choices?.[0]?.message?.content;
    const r = this.parse(j, t);
    if (typeof text === 'string') r.assets = [{ mimeType: 'text/plain', b64: Buffer.from(text).toString('base64') }];
    return r;
  }

  async generateImage(req: GenerationRequest): Promise<GenerationResult> {
    const t = Date.now();
    const body = this.o.mapImageBody?.(req) ?? { model: req.model, prompt: req.prompt, ...req.params };
    return this.parse(await this.call('POST', '/v1/images/generations', body, req), t);
  }

  async generateVideo(req: GenerationRequest): Promise<GenerationResult> {
    const t = Date.now();
    const body =
      this.o.mapVideoBody?.(req) ??
      { model: req.model, prompt: req.prompt, duration: req.durationSec, ...req.params, ...(req.inputAssets?.length ? { image: req.inputAssets[0] } : {}) };
    return this.parse(await this.call('POST', '/v1/videos/generations', body, req), t);
  }

  async generateAudio(req: GenerationRequest): Promise<GenerationResult> {
    const t = Date.now();
    const body = this.o.mapAudioBody?.(req) ?? { model: req.model, input: req.prompt, ...req.params };
    return this.parse(await this.call('POST', '/v1/audio/speech', body, req), t);
  }
}

export interface DirectRoute {
  provider: GenerationProvider;
  handles: (modelId: string) => boolean;
}

/**
 * Gateway-first with direct-provider fallback: if the gateway is unreachable/overloaded,
 * the request goes to a direct adapter that handles the model. Non-transient rejections
 * (4xx) are NOT retried elsewhere.
 */
export class FallbackProvider implements GenerationProvider {
  private primary: GenerationProvider;
  private direct: DirectRoute[];

  constructor(primary: GenerationProvider, direct: DirectRoute[]) {
    this.primary = primary;
    this.direct = direct;
  }

  private async run(modelId: string | undefined, fn: (p: GenerationProvider) => Promise<GenerationResult>): Promise<GenerationResult> {
    try {
      return await fn(this.primary);
    } catch (e) {
      if (!(e instanceof GatewayError) || !e.retryable || !modelId) throw e;
      const alt = this.direct.find((d) => d.handles(modelId));
      if (!alt) throw e;
      return fn(alt.provider);
    }
  }

  async listModels(): Promise<LiveModel[]> {
    try {
      return await this.primary.listModels();
    } catch (e) {
      const all = await Promise.allSettled(this.direct.map((d) => d.provider.listModels()));
      const ok = all.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      if (ok.length === 0) throw e;
      return ok;
    }
  }
  generateText(r: GenerationRequest) { return this.run(r.model, (p) => p.generateText(r)); }
  generateImage(r: GenerationRequest) { return this.run(r.model, (p) => p.generateImage(r)); }
  generateVideo(r: GenerationRequest) { return this.run(r.model, (p) => p.generateVideo(r)); }
  generateAudio(r: GenerationRequest) { return this.run(r.model, (p) => p.generateAudio(r)); }
}
