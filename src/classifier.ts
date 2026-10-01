import type { RouterConfig } from './config.ts';
import type { Complexity, Importance } from './types.ts';

export function deriveImportance(c: Partial<Complexity>): Importance {
  const s = Math.max(c.narrative ?? 0, c.visual ?? 0);
  return s >= 9 ? 'hero' : s >= 7 ? 'important' : s >= 4 ? 'normal' : 'background';
}

/** Required quality = importance baseline nudged by overall complexity, never below the user's minimum. */
export function requiredQualityFor(
  c: Partial<Complexity>,
  importance: Importance,
  cfg: RouterConfig,
  userMinQuality = 0,
): number {
  const dims = [c.character, c.motion, c.camera, c.environment, c.lighting].filter((x): x is number => typeof x === 'number');
  const complexity = dims.length ? dims.reduce((a, b) => a + b, 0) / dims.length : 5;
  const q = cfg.baseRequiredQuality[importance] + (complexity - 5) * 0.1;
  return Math.min(10, Math.max(userMinQuality, q));
}
