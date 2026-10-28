/**
 * VTID-01128: Environmental, Location & Mobility Context Engine Types (D34)
 *
 * Type definitions for the Environmental, Location & Mobility Context Engine.
 * Grounds intelligence in physical reality so recommendations are:
 * - Location-appropriate
 * - Mobility-aware
 * - Environment-sensitive
 *
 * Answers: "Given where this person is, what can they actually do?"
 *
 * Hard Constraints (from spec):
 *   - Never assume precise location without consent
 *   - Default to local + low effort
 *   - Avoid unsafe timing/location combinations
 *   - Defer suggestions when environment fit is low
 */

import { z } from 'zod';

// =============================================================================
// VTID-01128: Location Context Types
// =============================================================================

/**
 * Travel states - inferred from patterns or explicitly stated
 */
export const TravelState = z.enum([
  'home',           // At home location
  'work',           // At work location
  'traveling',      // Currently traveling
  'visiting',       // Visiting somewhere temporarily
  'unknown'         // Cannot determine
]);
export type TravelState = z.infer<typeof TravelState>;

/**
 * Location precision levels - privacy-first approach
 */
export const LocationPrecision = z.enum([
  'country',        // Only country known
  'region',         // Region/state known
  'city',           // City known
  'area',           // Neighborhood/area known
  'precise'         // Exact coordinates (only if consented)
]);
export type LocationPrecision = z.infer<typeof LocationPrecision>;

/**
 * Urban density classification
 */
export const UrbanDensity = z.enum([
  'urban',          // Dense city
  'suburban',       // Suburbs
  'rural',          // Rural area
  'unknown'         // Cannot determine
]);
export type UrbanDensity = z.infer<typeof UrbanDensity>;

/**
 * Location context resolved from user data
 * Per spec section 2.1
 */
export const LocationContextSchema = z.object({
  city: z.string().nullable().optional(),
  region: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  travel_state: TravelState.default('unknown'),
  urban_density: UrbanDensity.default('unknown'),
  precision: LocationPrecision.default('city'),
  confidence: z.number().min(0).max(100).default(50),
  resolved_at: z.string().datetime(),
  source: z.enum(['explicit', 'inferred', 'preferences', 'visit_history', 'default']).default('default')
});
export type LocationContext = z.infer<typeof LocationContextSchema>;

// =============================================================================
// VTID-01128: Mobility & Access Types
// =============================================================================

/**
 * Mode preference - how the user prefers to travel
 */
export const ModePreference = z.enum([
  'walking',        // Prefers walking
  'public_transit', // Uses public transport
  'driving',        // Has access to car
  'cycling',        // Prefers cycling
  'mixed',          // Uses multiple modes
  'limited',        // Limited mobility options
  'unknown'         // Not determined
]);
export type ModePreference = z.infer<typeof ModePreference>;

/**
 * Distance tolerance level
 */
export const DistanceTolerance = z.enum([
  'very_local',     // < 1km / 10 min walk
  'local',          // < 5km / walkable with effort
  'moderate',       // < 20km / short drive/transit
  'regional',       // < 100km / willing to travel
  'any',            // No distance constraints
  'unknown'         // Not determined
]);
export type DistanceTolerance = z.infer<typeof DistanceTolerance>;

/**
 * Mobility access level
 */
export const AccessLevel = z.enum([
  'full',           // No mobility constraints
  'moderate',       // Some constraints (e.g., no stairs)
  'limited',        // Significant constraints
  'assisted',       // Requires assistance
  'unknown'         // Not specified
]);
export type AccessLevel = z.infer<typeof AccessLevel>;

/**
 * Mobility profile per spec section 2.2
 */
export const MobilityProfileSchema = z.object({
  mode_preference: ModePreference.default('unknown'),
  distance_tolerance: DistanceTolerance.default('local'),
  access_level: AccessLevel.default('unknown'),
  has_vehicle: z.boolean().nullable().optional(),
  public_transit_available: z.boolean().nullable().optional(),
  walkability_preference: z.number().min(0).max(100).nullable().optional(),
  confidence: z.number().min(0).max(100).default(50),
  inferred_from: z.array(z.string()).default([]),
  last_updated: z.string().datetime().optional()
});
export type MobilityProfile = z.infer<typeof MobilityProfileSchema>;

// =============================================================================
// VTID-01128: Environmental Constraint Types
// =============================================================================

/**
 * Environment flags per spec section 2.3
 */
export const EnvironmentFlag = z.enum([
  'outdoor_ok',           // Outdoor activities suitable
  'outdoor_preferred',    // User prefers outdoors
  'indoor_preferred',     // User prefers indoors
  'avoid_late_night',     // Avoid late night activities
  'weather_sensitive',    // Consider weather in recommendations
  'seasonal_aware',       // Consider seasonal factors
  'daylight_preferred',   // Prefers daylight activities
  'noise_sensitive',      // Sensitive to noise levels
  'crowd_avoidant',       // Prefers less crowded places
  'accessibility_required' // Requires accessible venues
]);
export type EnvironmentFlag = z.infer<typeof EnvironmentFlag>;

/**
 * Time of day safety classification
 */
export const TimeOfDaySafety = z.enum([
  'safe',           // Generally safe
  'caution',        // Exercise caution
  'avoid',          // Best avoided
  'unknown'         // Cannot determine
]);
export type TimeOfDaySafety = z.infer<typeof TimeOfDaySafety>;

/**
 * Weather suitability
 */
export const WeatherSuitability = z.enum([
  'ideal',          // Perfect conditions
  'acceptable',     // Manageable conditions
  'challenging',    // Difficult conditions
  'unsuitable',     // Not suitable
  'unknown'         // Weather data unavailable
]);
export type WeatherSuitability = z.infer<typeof WeatherSuitability>;

/**
 * Environmental constraints bundle
 */
export const EnvironmentalConstraintsSchema = z.object({
  flags: z.array(EnvironmentFlag).default([]),
  time_of_day_safety: TimeOfDaySafety.default('unknown'),
  weather_suitability: WeatherSuitability.default('unknown'),
  indoor_outdoor_preference: z.enum(['indoor', 'outdoor', 'either']).default('either'),
  current_local_time: z.string().datetime().optional(),
  is_late_night: z.boolean().default(false),
  is_early_morning: z.boolean().default(false),
  cultural_considerations: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(100).default(50)
});
export type EnvironmentalConstraints = z.infer<typeof EnvironmentalConstraintsSchema>;

// =============================================================================
// VTID-01128: Environment Tags (Output)
// =============================================================================

/**
 * Environment tags per spec section 5.2
 */
export const EnvironmentTag = z.enum([
  'local_only',         // Restrict to local options
  'walkable',           // Must be walkable
  'travel_required',    // Requires travel
  'indoor_preferred',   // Indoor options preferred
  'outdoor_preferred',  // Outdoor options preferred
  'time_sensitive',     // Consider time constraints
  'weather_dependent',  // Depends on weather
  'accessibility_needed' // Requires accessible options
]);
export type EnvironmentTag = z.infer<typeof EnvironmentTag>;

// =============================================================================
// VTID-01128: Contextual Action Types (Output)
// =============================================================================

/**
 * Mobility fit assessment
 */
export const MobilityFit = z.enum([
  'excellent',      // Perfect fit for user's mobility
  'good',           // Good fit
  'acceptable',     // Acceptable but not ideal
  'challenging',    // May be challenging
  'unsuitable'      // Not suitable for user's mobility
]);
export type MobilityFit = z.infer<typeof MobilityFit>;

/**
 * Contextual action output per spec section 5.1
 */
export const ContextualActionSchema = z.object({
  action: z.string(),
  action_type: z.enum(['meetup', 'commerce', 'wellness', 'social', 'event', 'service', 'other']).default('other'),
  distance_estimate: z.enum(['here', 'nearby', 'local', 'moderate', 'far', 'remote', 'unknown']).default('unknown'),
  distance_km: z.number().nullable().optional(),
  mobility_fit: MobilityFit.default('acceptable'),
  confidence: z.number().min(0).max(100).default(50),
  environment_tags: z.array(EnvironmentTag).default([]),
  is_reachable: z.boolean().default(true),
  is_suitable: z.boolean().default(true),
  effort_level: z.enum(['minimal', 'low', 'moderate', 'high', 'extreme']).default('moderate'),
  rejection_reason: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional()
});
export type ContextualAction = z.infer<typeof ContextualActionSchema>;

// =============================================================================
// VTID-01128: Contextual Filter Input/Output
// =============================================================================

/**
 * Action to be filtered
 */
export const ActionToFilterSchema = z.object({
  id: z.string().optional(),
  action: z.string(),
  action_type: z.enum(['meetup', 'commerce', 'wellness', 'social', 'event', 'service', 'other']).optional(),
  location: z.object({
    city: z.string().optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    is_indoor: z.boolean().optional()
  }).optional(),
  distance_km: z.number().optional(),
  time: z.string().datetime().optional(),
  effort_required: z.enum(['minimal', 'low', 'moderate', 'high', 'extreme']).optional(),
  metadata: z.record(z.unknown()).optional()
});
export type ActionToFilter = z.infer<typeof ActionToFilterSchema>;

/**
 * Filter result for an action
 */
export const FilterResultSchema = z.object({
  action_id: z.string().optional(),
  action: z.string(),
  passed: z.boolean(),
  contextual_action: ContextualActionSchema.optional(),
  rejection_reasons: z.array(z.object({
    rule: z.string(),
    reason: z.string(),
    severity: z.enum(['hard', 'soft'])
  })).default([]),
  adjustments: z.array(z.object({
    field: z.string(),
    original: z.unknown(),
    adjusted: z.unknown(),
    reason: z.string()
  })).default([])
});
export type FilterResult = z.infer<typeof FilterResultSchema>;

// =============================================================================
// VTID-01128: D34 Context Bundle (Main Output)
// =============================================================================

/**
 * Complete D34 context bundle
 * This is the main output of the D34 engine
 */
export const D34ContextBundleSchema = z.object({
  bundle_id: z.string().uuid(),
  bundle_hash: z.string(),
  computed_at: z.string().datetime(),

  // Core contexts
  location_context: LocationContextSchema,
  mobility_profile: MobilityProfileSchema,
  environmental_constraints: EnvironmentalConstraintsSchema,

  // Output tags
  environment_tags: z.array(EnvironmentTag).default([]),

  // Confidence & metadata
  overall_confidence: z.number().min(0).max(100).default(50),
  data_freshness: z.enum(['fresh', 'recent', 'stale', 'unknown']).default('unknown'),

  // Traceability
  sources_used: z.array(z.string()).default([]),
  fallback_applied: z.boolean().default(false),
  fallback_reason: z.string().nullable().optional(),

  // Disclaimer (always present per spec)
  disclaimer: z.string().default('Location and mobility context is probabilistic and should not be used for safety-critical decisions.')
});
export type D34ContextBundle = z.infer<typeof D34ContextBundleSchema>;

// =============================================================================
// VTID-01128: API Request/Response Schemas
// =============================================================================

/**
 * Compute context request
 */
export const ComputeContextRequestSchema = z.object({
  user_id: z.string().uuid().optional(),
  session_id: z.string().optional(),

  // Optional explicit inputs (override inference)
  explicit_location: z.object({
    city: z.string().optional(),
    region: z.string().optional(),
    country: z.string().optional(),
    timezone: z.string().optional()
  }).optional(),

  explicit_mobility: z.object({
    mode_preference: ModePreference.optional(),
    distance_tolerance: DistanceTolerance.optional(),
    access_level: AccessLevel.optional()
  }).optional(),

  // Situation context (from D32 when available)
  situation_context: z.record(z.unknown()).optional(),

  // Availability context (from D33 when available)
  availability_context: z.record(z.unknown()).optional(),

  // Time context
  reference_time: z.string().datetime().optional(),

  // Force refresh
  force_refresh: z.boolean().default(false)
});
export type ComputeContextRequest = z.infer<typeof ComputeContextRequestSchema>;

/**
 * Compute context response
 */
export interface ComputeContextResponse {
  ok: boolean;
  bundle?: D34ContextBundle;
  error?: string;
  message?: string;
}

/**
 * Filter actions request
 */
export const FilterActionsRequestSchema = z.object({
  actions: z.array(ActionToFilterSchema),
  context_bundle_id: z.string().uuid().optional(),
  strictness: z.enum(['relaxed', 'normal', 'strict']).default('normal')
});
export type FilterActionsRequest = z.infer<typeof FilterActionsRequestSchema>;

/**
 * Filter actions response
 */
export interface FilterActionsResponse {
  ok: boolean;
  results?: FilterResult[];
  passed_count?: number;
  rejected_count?: number;
  context_bundle_id?: string;
  error?: string;
}

/**
 * Get current context response
 */
export interface GetCurrentContextResponse {
  ok: boolean;
  bundle?: D34ContextBundle;
  cached?: boolean;
  cache_age_seconds?: number;
  error?: string;
}

/**
 * Override context request
 */
export const OverrideContextRequestSchema = z.object({
  override_type: z.enum(['location', 'mobility', 'environment']),
  overrides: z.record(z.unknown()),
  reason: z.string().optional(),
  duration_minutes: z.number().int().min(1).max(1440).optional() // Max 24 hours
});
export type OverrideContextRequest = z.infer<typeof OverrideContextRequestSchema>;

/**
 * Override context response
 */
export interface OverrideContextResponse {
  ok: boolean;
  override_id?: string;
  expires_at?: string;
  error?: string;
}

// =============================================================================
// VTID-01128: ORB Integration Types
// =============================================================================

/**
 * Simplified context for ORB system prompt injection
 */
export interface OrbMobilityContext {
  // Location summary
  location_summary: string;
  is_traveling: boolean;
  is_home: boolean;

  // Mobility summary
  mobility_summary: string;
  distance_preference: DistanceTolerance;

  // Environment summary
  environment_summary: string;
  prefer_indoor: boolean;
  prefer_outdoor: boolean;

  // Key flags for recommendation filtering
  is_local_only: boolean;
  is_walkable_only: boolean;
  avoid_late_night: boolean;

  // Disclaimer (always present)
  disclaimer: string;
}

/**
 * Convert D34ContextBundle to OrbMobilityContext for prompt injection
 */
export function toOrbMobilityContext(bundle: D34ContextBundle): OrbMobilityContext {
  const { location_context, mobility_profile, environmental_constraints, environment_tags } = bundle;

  // Build location summary
  const locationParts: string[] = [];
  if (location_context.city) locationParts.push(location_context.city);
  if (location_context.region) locationParts.push(location_context.region);
  if (location_context.country) locationParts.push(location_context.country);
  const locationSummary = locationParts.length > 0
    ? locationParts.join(', ')
    : 'Location unknown';

  // Build mobility summary
  let mobilitySummary = 'Standard mobility';
  if (mobility_profile.mode_preference === 'walking') {
    mobilitySummary = 'Prefers walking';
  } else if (mobility_profile.mode_preference === 'public_transit') {
    mobilitySummary = 'Uses public transit';
  } else if (mobility_profile.mode_preference === 'driving') {
    mobilitySummary = 'Has vehicle access';
  } else if (mobility_profile.access_level === 'limited' || mobility_profile.access_level === 'assisted') {
    mobilitySummary = 'Limited mobility';
  }

  // Build environment summary
  const envParts: string[] = [];
  if (environmental_constraints.is_late_night) envParts.push('late night');
  if (environmental_constraints.is_early_morning) envParts.push('early morning');
  if (environmental_constraints.indoor_outdoor_preference !== 'either') {
    envParts.push(`prefers ${environmental_constraints.indoor_outdoor_preference}`);
  }
  const environmentSummary = envParts.length > 0
    ? envParts.join(', ')
    : 'No specific environmental preferences';

  return {
    location_summary: locationSummary,
    is_traveling: location_context.travel_state === 'traveling' || location_context.travel_state === 'visiting',
    is_home: location_context.travel_state === 'home',

    mobility_summary: mobilitySummary,
    distance_preference: mobility_profile.distance_tolerance,

    environment_summary: environmentSummary,
    prefer_indoor: environmental_constraints.indoor_outdoor_preference === 'indoor' ||
                   environment_tags.includes('indoor_preferred'),
    prefer_outdoor: environmental_constraints.indoor_outdoor_preference === 'outdoor' ||
                    environment_tags.includes('outdoor_preferred'),

    is_local_only: environment_tags.includes('local_only') ||
                   mobility_profile.distance_tolerance === 'very_local' ||
                   mobility_profile.distance_tolerance === 'local',
    is_walkable_only: environment_tags.includes('walkable') ||
                      mobility_profile.mode_preference === 'walking',
    avoid_late_night: environmental_constraints.flags.includes('avoid_late_night') ||
                      environmental_constraints.is_late_night,

    disclaimer: bundle.disclaimer
  };
}

/**
 * Format OrbMobilityContext for system prompt injection
 */
export function formatMobilityContextForPrompt(ctx: OrbMobilityContext): string {
  const lines: string[] = [
    '## Location & Mobility Context (D34)',
    `[${ctx.disclaimer}]`,
    ''
  ];

  lines.push(`- Location: ${ctx.location_summary}`);

  if (ctx.is_traveling) {
    lines.push('- Status: Currently traveling');
  } else if (ctx.is_home) {
    lines.push('- Status: At home');
  }

  lines.push(`- Mobility: ${ctx.mobility_summary}`);
  lines.push(`- Distance preference: ${ctx.distance_preference.replace('_', ' ')}`);

  if (ctx.environment_summary !== 'No specific environmental preferences') {
    lines.push(`- Environment: ${ctx.environment_summary}`);
  }

  lines.push('');
  lines.push('### Recommendation Filters');

  if (ctx.is_local_only) {
    lines.push('- FILTER: Local options only');
  }
  if (ctx.is_walkable_only) {
    lines.push('- FILTER: Walkable distance only');
  }
  if (ctx.prefer_indoor) {
    lines.push('- PREFERENCE: Indoor activities');
  }
  if (ctx.prefer_outdoor) {
    lines.push('- PREFERENCE: Outdoor activities');
  }
  if (ctx.avoid_late_night) {
    lines.push('- FILTER: Avoid late night suggestions');
  }

  return lines.join('\n');
}

// =============================================================================
// VTID-01128: OASIS Event Types
// =============================================================================

/**
 * OASIS event types for D34
 */
export const D34_EVENT_TYPES = [
  'd34.context.computed',
  'd34.context.cached',
  'd34.context.override',
  'd34.context.fallback',
  'd34.filter.applied',
  'd34.filter.rejected',
  'd34.error'
] as const;

export type D34EventType = typeof D34_EVENT_TYPES[number];

/**
 * OASIS event payload for D34
 */
export interface D34EventPayload {
  vtid: string;
  bundle_id?: string;
  location_confidence?: number;
  mobility_confidence?: number;
  environment_confidence?: number;
  fallback_applied?: boolean;
  actions_filtered?: number;
  actions_passed?: number;
  actions_rejected?: number;
  override_type?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

// =============================================================================
// VTID-01128: Dependency Placeholders (D32, D33)
// =============================================================================

/**
 * Placeholder for D32 Situation Vector (to be implemented)
 * D34 can work without this, but will use it when available
 */
export interface D32SituationVector {
  primary_activity?: string;
  energy_level?: 'low' | 'medium' | 'high';
  social_context?: 'alone' | 'with_others' | 'professional';
  time_pressure?: 'none' | 'moderate' | 'high';
  location_hint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Placeholder for D33 Availability Context (to be implemented)
 * D34 can work without this, but will use it when available
 */
export interface D33AvailabilityContext {
  available_now?: boolean;
  available_duration_minutes?: number;
  next_commitment_at?: string;
  energy_budget?: 'depleted' | 'low' | 'moderate' | 'high';
  effort_capacity?: 'minimal' | 'low' | 'moderate' | 'high';
  metadata?: Record<string, unknown>;
}
