export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  shouldRetry?: (e: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** Exponential backoff with full jitter. */
export async function retryWithBackoff<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = o.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (attempt >= o.retries || (o.shouldRetry && !o.shouldRetry(e))) throw e;
      const cap = Math.min(o.maxMs, o.baseMs * 2 ** attempt);
      await sleep(Math.floor(random() * cap));
    }
  }
}
