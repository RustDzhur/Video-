export const TIERS = ['free', 'free_tier', 'cheap', 'standard', 'premium'] as const;
export type Tier = (typeof TIERS)[number];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

export type Modality = 'text' | 'image' | 'video' | 'audio';
export type Importance = 'background' | 'normal' | 'important' | 'hero';
export type RoutingMode = 'max_quality' | 'balanced' | 'lowest_cost' | 'user_budget';
export type ApprovalMode = 'auto' | 'semi_auto' | 'manual';

export interface Capabilities {
  textToVideo?: boolean;
  imageToVideo?: boolean;
  characterReference?: boolean;
  cameraControl?: boolean;
  audio?: boolean;
  seed?: boolean;
  negativePrompt?: boolean;
  maxDurationSec?: number;
  /** Max output height in px (1080 => 1080p). */
  maxHeight?: number;
  aspectRatios?: string[];
}

export interface QualityProfile {
  cinematic?: number;
  motion?: number;
  characters?: number;
  consistency?: number;
  overall?: number;
}

export interface Economics {
  /** Truly free (no cost, no quota semantics beyond rate limits). */
  free?: boolean;
  /** Free trial / free quota: costs 0 while quota lasts. */
  freeQuota?: boolean;
  costPerSecond?: number;
  costPerImage?: number;
  costPerRequest?: number;
  currency: string;
  /** Explicit operator override of the derived tier. */
  tierOverride?: Tier;
}

export type ModelStatus = 'available' | 'unavailable' | 'stale';

export interface ModelEntryInput {
  provider: string;
  model: string;
  modality: Modality;
  family?: string;
  capabilities: Capabilities;
  quality: QualityProfile;
  economics: Economics;
  latencySec?: number;
  status?: ModelStatus;
}

export interface ModelEntry extends ModelEntryInput {
  /** `provider/model` */
  id: string;
  tier: Tier;
  status: ModelStatus;
  lastSeenAt: number;
}

export interface Complexity {
  character: number;
  motion: number;
  camera: number;
  environment: number;
  lighting: number;
  continuity: number;
  narrative: number;
  visual: number;
}

export interface ShotBudget {
  preferred: number;
  max: number;
  hardLimit: number;
}

export interface ShotGenerationPolicy {
  maxCost?: number;
  preferredTier?: Tier;
  /** User override: use exactly this tier (still bound by hard budget). */
  forceTier?: Tier;
  allowedTiers?: Tier[];
  allowPremium?: boolean;
  allowFree?: boolean;
  allowFallback?: boolean;
}

export interface ShotNeeds {
  imageToVideo?: boolean;
  characterReference?: boolean;
  cameraControl?: boolean;
  audio?: boolean;
  height?: number;
  aspectRatio?: string;
  seed?: boolean;
  negativePrompt?: boolean;
}

export interface ShotSpec {
  tenantId: string;
  projectId: string;
  filmId?: string;
  sceneId: string;
  shotId: string;
  modality: Modality;
  prompt: string;
  durationSec?: number;
  count?: number;
  importance: Importance;
  /** 0..10 */
  requiredQuality: number;
  complexity?: Partial<Complexity>;
  needs?: ShotNeeds;
  budget: ShotBudget;
  continuity?: { groupId: string; strict?: boolean };
  modelLock?: { modelId: string };
  inputAssets?: string[];
  params?: Record<string, unknown>;
}

export interface QualityScore {
  visual_quality?: number;
  motion_quality?: number;
  character_consistency?: number;
  face_quality?: number;
  scene_consistency?: number;
  prompt_adherence?: number;
  camera_quality?: number;
  temporal_stability?: number;
  artifact_score?: number;
  overall: number;
}

export type QaDecision = 'PASS' | 'REGENERATE' | 'ESCALATE';

export interface ChainEntry {
  modelId: string;
  provider: string;
  model: string;
  tier: Tier;
  estimatedCost: number;
  expectedQuality: number;
  /** Entry may only be used when the preferred (locked) model is unavailable, not on QA failure. */
  availabilityFallbackOnly?: boolean;
}

export interface Strategy {
  provider: string;
  model: string;
  tier: Tier;
  estimatedCost: number;
  expectedQuality: number;
  fallbackChain: ChainEntry[];
  /** Cheapest premium-tier cost for this shot, for savings accounting. */
  premiumBaselineCost?: number;
  reason: string;
}

export interface DecisionEntry {
  modelId: string;
  tier?: Tier;
  verdict: 'accepted' | 'rejected';
  reason: string;
  expectedQuality?: number;
  estimatedCost?: number;
}
