/**
 * VTID-01128: D34 Environmental, Location & Mobility Context Engine
 *
 * Deterministic engine that grounds intelligence in physical reality.
 * Understands where the user is and what is realistically possible there.
 *
 * Core Capabilities:
 *   1. Location Context Resolution (privacy-first)
 *   2. Mobility & Access Modeling
 *   3. Environmental Constraints
 *   4. Contextual Filtering Rules
 *
 * Hard Constraints (from spec):
 *   - Never assume precise location without consent
 *   - Default to local + low effort
 *   - Avoid unsafe timing/location combinations
 *   - Defer suggestions when environment fit is low
 *
 * Determinism Rules:
 *   - Same inputs -> same context output
 *   - No generative inference
 *   - Rule-based processing only
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash, randomUUID } from 'crypto';
import { emitOasisEvent } from './oasis-event-service';
import {
  LocationContext,
  LocationContextSchema,
  LocationPrecision,
  TravelState,
  UrbanDensity,
  MobilityProfile,
  MobilityProfileSchema,
  ModePreference,
  DistanceTolerance,
  AccessLevel,
  EnvironmentalConstraints,
  EnvironmentalConstraintsSchema,
  EnvironmentFlag,
  TimeOfDaySafety,
  WeatherSuitability,
  EnvironmentTag,
  ContextualAction,
  ContextualActionSchema,
  MobilityFit,
  ActionToFilter,
  FilterResult,
  D34ContextBundle,
  D34ContextBundleSchema,
  ComputeContextRequest,
  ComputeContextResponse,
  FilterActionsRequest,
  FilterActionsResponse,
  GetCurrentContextResponse,
  OverrideContextRequest,
  OverrideContextResponse,
  OrbMobilityContext,
  toOrbMobilityContext,
  formatMobilityContextForPrompt,
  D32SituationVector,
  D33AvailabilityContext
} from '../types/environmental-mobility-context';

// =============================================================================
// Constants
// =============================================================================

export const VTID = 'VTID-01128';
const LOG_PREFIX = '[D34-Engine]';

/**
 * Fixed dev identity for sandbox testing
 */
const DEV_IDENTITY = {
  USER_ID: '00000000-0000-0000-0000-000000000099',
  TENANT_ID: '00000000-0000-0000-0000-000000000001'
};

/**
 * Default location context when no data available
 */
const DEFAULT_LOCATION_CONTEXT: LocationContext = {
  city: null,
  region: null,
  country: null,
  timezone: null,
  travel_state: 'unknown',
  urban_density: 'unknown',
  precision: 'country',
  confidence: 0,
  resolved_at: new Date().toISOString(),
  source: 'default'
};

/**
 * Default mobility profile when no data available
 */
const DEFAULT_MOBILITY_PROFILE: MobilityProfile = {
  mode_preference: 'unknown',
  distance_tolerance: 'local',
  access_level: 'unknown',
  has_vehicle: null,
  public_transit_available: null,
  walkability_preference: null,
  confidence: 0,
  inferred_from: [],
  last_updated: undefined
};

/**
 * Default environmental constraints
 */
const DEFAULT_ENVIRONMENTAL_CONSTRAINTS: EnvironmentalConstraints = {
  flags: [],
  time_of_day_safety: 'unknown',
  weather_suitability: 'unknown',
  indoor_outdoor_preference: 'either',
  current_local_time: undefined,
  is_late_night: false,
  is_early_morning: false,
  cultural_considerations: [],
  confidence: 0
};

/**
 * Distance estimates in km
 */
const DISTANCE_ESTIMATES: Record<string, { min: number; max: number }> = {
  here: { min: 0, max: 0.1 },
  nearby: { min: 0.1, max: 1 },
  local: { min: 1, max: 5 },
  moderate: { min: 5, max: 20 },
  far: { min: 20, max: 100 },
  remote: { min: 100, max: Infinity }
};

/**
 * Distance tolerance mappings
 */
const DISTANCE_TOLERANCE_KM: Record<DistanceTolerance, number> = {
  very_local: 1,
  local: 5,
  moderate: 20,
  regional: 100,
  any: Infinity,
  unknown: 10 // Default to moderate local
};

/**
 * Cache TTL in milliseconds
 */
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
// Environment Detection
// =============================================================================

function isDevSandbox(): boolean {
  const env = (process.env.ENVIRONMENT || process.env.VITANA_ENV || '').toLowerCase();
  return env === 'dev-sandbox' ||
         env === 'dev' ||
         env === 'development' ||
         env === 'sandbox' ||
         env.includes('dev') ||
         env.includes('sandbox');
}

// =============================================================================
// Supabase Client
// =============================================================================

function createServiceClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  if (!supabaseUrl || !supabaseServiceKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

function createUserClient(token: string): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    console.warn(`${LOG_PREFIX} Missing SUPABASE_URL or SUPABASE_ANON_KEY`);
    return null;
  }

  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: {
        Authorization: `Bearer ${token}`
      }
    },
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  });
}

// =============================================================================
// Location Context Resolver (Spec Section 2.1)
// =============================================================================

/**
 * Resolve location context from available data sources
 * Privacy-first: Uses city/region level by default
 */
export async function resolveLocationContext(
  supabase: SupabaseClient | null,
  explicitLocation?: ComputeContextRequest['explicit_location'],
  situationVector?: D32SituationVector
): Promise<LocationContext> {
  const now = new Date().toISOString();

  // 1. If explicit location provided, use it directly
  if (explicitLocation && (explicitLocation.city || explicitLocation.country)) {
    return {
      city: explicitLocation.city || null,
      region: explicitLocation.region || null,
      country: explicitLocation.country || null,
      timezone: explicitLocation.timezone || inferTimezone(explicitLocation.country || null),
      travel_state: 'unknown',
      urban_density: inferUrbanDensity(explicitLocation.city || null),
      precision: explicitLocation.city ? 'city' : 'country',
      confidence: 90,
      resolved_at: now,
      source: 'explicit'
    };
  }

  // 2. Try to get from location preferences if Supabase available
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('location_preferences_get');
      if (!error && data?.ok && data.preferences) {
        const prefs = data.preferences;
        if (prefs.home_city || prefs.home_area) {
          return {
            city: prefs.home_city || null,
            region: prefs.home_area || null,
            country: null,
            timezone: inferTimezone(null),
            travel_state: 'home',
            urban_density: inferUrbanDensity(prefs.home_city || null),
            precision: prefs.home_city ? 'city' : 'area',
            confidence: 70,
            resolved_at: now,
            source: 'preferences'
          };
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to get location preferences:`, err);
    }
  }

  // 3. Try to infer from recent visit history
  if (supabase) {
    try {
      const { data, error } = await supabase.rpc('location_get_visits', {
        p_from: null,
        p_to: null,
        p_limit: 10
      });
      if (!error && data?.ok && data.visits?.length > 0) {
        // Use most recent visit location
        const recentVisit = data.visits[0];
        if (recentVisit.location?.city) {
          return {
            city: recentVisit.location.city || null,
            region: recentVisit.location.area || null,
            country: recentVisit.location.country || null,
            timezone: inferTimezone(recentVisit.location.country || null),
            travel_state: inferTravelState(data.visits),
            urban_density: inferUrbanDensity(recentVisit.location.city || null),
            precision: 'city',
            confidence: 60,
            resolved_at: now,
            source: 'visit_history'
          };
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to get visit history:`, err);
    }
  }

  // 4. Check D32 situation vector for location hints
  if (situationVector?.location_hint) {
    return {
      city: situationVector.location_hint,
      region: null,
      country: null,
      timezone: inferTimezone(null),
      travel_state: 'unknown',
      urban_density: 'unknown',
      precision: 'city',
      confidence: 40,
      resolved_at: now,
      source: 'inferred'
    };
  }

  // 5. Return default (unknown location)
  return {
    ...DEFAULT_LOCATION_CONTEXT,
    resolved_at: now
  };
}

/**
 * Infer timezone from country (simplified)
 */
function inferTimezone(country: string | null): string | null {
  if (!country) return null;
  const countryLower = country.toLowerCase();

  // Common timezone mappings (simplified)
  const timezones: Record<string, string> = {
    'usa': 'America/New_York',
    'united states': 'America/New_York',
    'uk': 'Europe/London',
    'united kingdom': 'Europe/London',
    'germany': 'Europe/Berlin',
    'france': 'Europe/Paris',
    'japan': 'Asia/Tokyo',
    'australia': 'Australia/Sydney',
    'india': 'Asia/Kolkata'
  };

  return timezones[countryLower] || null;
}

/**
 * Infer urban density from city name (heuristic)
 */
function inferUrbanDensity(city: string | null): UrbanDensity {
  if (!city) return 'unknown';

  // Major cities are typically urban
  const majorCities = [
    'new york', 'london', 'paris', 'tokyo', 'berlin', 'sydney',
    'los angeles', 'chicago', 'munich', 'amsterdam', 'madrid'
  ];

  if (majorCities.some(c => city.toLowerCase().includes(c))) {
    return 'urban';
  }

  return 'unknown';
}

/**
 * Infer travel state from visit history
 */
function inferTravelState(visits: Array<{ location?: { city?: string } }>): TravelState {
  if (visits.length < 2) return 'unknown';

  // Check if recent visits are in different cities
  const cities = visits
    .slice(0, 5)
    .map(v => v.location?.city?.toLowerCase())
    .filter(Boolean);

  const uniqueCities = new Set(cities);
  if (uniqueCities.size > 2) {
    return 'traveling';
  }

  return 'home';
}

// =============================================================================
// Mobility Profiler (Spec Section 2.2)
// =============================================================================

/**
 * Build mobility profile from available data
 */
export async function buildMobilityProfile(
  supabase: SupabaseClient | null,
  explicitMobility?: ComputeContextRequest['explicit_mobility'],
  situationVector?: D32SituationVector,
  availabilityContext?: D33AvailabilityContext
): Promise<MobilityProfile> {
  const now = new Date().toISOString();
  const inferredFrom: string[] = [];

  // Start with defaults
  let profile: MobilityProfile = {
    ...DEFAULT_MOBILITY_PROFILE,
    last_updated: now
  };

  // 1. Apply explicit overrides
  if (explicitMobility) {
    if (explicitMobility.mode_preference) {
      profile.mode_preference = explicitMobility.mode_preference;
      inferredFrom.push('explicit_mode');
    }
    if (explicitMobility.distance_tolerance) {
      profile.distance_tolerance = explicitMobility.distance_tolerance;
      inferredFrom.push('explicit_distance');
    }
    if (explicitMobility.access_level) {
      profile.access_level = explicitMobility.access_level;
      inferredFrom.push('explicit_access');
    }
    profile.confidence = 90;
  }

  // 2. Infer from user preferences (D27)
  if (supabase && profile.confidence < 70) {
    try {
      const { data, error } = await supabase.rpc('user_preferences_get_bundle');
      if (!error && data?.ok && data.preferences) {
        const prefs = data.preferences;

        // Check for mobility-related preferences
        for (const pref of prefs) {
          if (pref.category === 'health' && pref.key === 'activity_intensity') {
            // High activity -> walking preference
            if (pref.value === 'high') {
              profile.mode_preference = profile.mode_preference === 'unknown' ? 'walking' : profile.mode_preference;
              profile.distance_tolerance = profile.distance_tolerance === 'unknown' ? 'moderate' : profile.distance_tolerance;
              inferredFrom.push('health_activity');
            } else if (pref.value === 'low') {
              profile.distance_tolerance = 'very_local';
              inferredFrom.push('health_activity');
            }
          }
        }

        if (inferredFrom.includes('health_activity')) {
          profile.confidence = Math.max(profile.confidence, 60);
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to get user preferences:`, err);
    }
  }

  // 3. Infer from visit history patterns
  if (supabase && profile.confidence < 50) {
    try {
      const { data, error } = await supabase.rpc('location_get_visits', {
        p_from: null,
        p_to: null,
        p_limit: 20
      });

      if (!error && data?.ok && data.visits?.length > 0) {
        const distances = analyzeVisitDistances(data.visits);
        if (distances.avgDistance !== null) {
          if (distances.avgDistance < 2) {
            profile.distance_tolerance = 'very_local';
            profile.mode_preference = 'walking';
          } else if (distances.avgDistance < 10) {
            profile.distance_tolerance = 'local';
          } else {
            profile.distance_tolerance = 'moderate';
          }
          inferredFrom.push('visit_patterns');
          profile.confidence = Math.max(profile.confidence, 50);
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} Failed to analyze visit patterns:`, err);
    }
  }

  // 4. Adjust based on availability context (D33)
  if (availabilityContext) {
    if (availabilityContext.effort_capacity === 'minimal' || availabilityContext.energy_budget === 'depleted') {
      // User has low energy -> prefer minimal distance
      profile.distance_tolerance = 'very_local';
      inferredFrom.push('availability_effort');
      profile.confidence = Math.max(profile.confidence, 70);
    }
  }

  profile.inferred_from = inferredFrom;
  return profile;
}

/**
 * Analyze visit distances (placeholder - would need geo calculations)
 */
function analyzeVisitDistances(_visits: unknown[]): { avgDistance: number | null } {
  // In a real implementation, this would calculate distances between visits
  // For now, return null to indicate no distance data
  return { avgDistance: null };
}

// =============================================================================
// Environmental Constraints Engine (Spec Section 2.3)
// =============================================================================

/**
 * Compute environmental constraints
 */
export async function computeEnvironmentalConstraints(
  referenceTime?: string,
  locationContext?: LocationContext,
  situationVector?: D32SituationVector
): Promise<EnvironmentalConstraints> {
  const now = referenceTime ? new Date(referenceTime) : new Date();
  const flags: EnvironmentFlag[] = [];
  let indoorOutdoorPreference: 'indoor' | 'outdoor' | 'either' = 'either';

  // 1. Determine time-based constraints
  const hour = now.getHours();
  const isLateNight = hour >= 22 || hour < 5;
  const isEarlyMorning = hour >= 5 && hour < 7;

  if (isLateNight) {
    flags.push('avoid_late_night');
  }

  if (isEarlyMorning || isLateNight) {
    flags.push('daylight_preferred');
  }

  // 2. Determine time-of-day safety
  let timeOfDaySafety: TimeOfDaySafety = 'safe';
  if (isLateNight) {
    timeOfDaySafety = 'caution';
    // Urban areas at late night need more caution
    if (locationContext?.urban_density === 'urban') {
      timeOfDaySafety = 'caution';
    }
  }

  // 3. Weather considerations (placeholder - would need weather API)
  // For now, default to unknown
  const weatherSuitability: WeatherSuitability = 'unknown';

  // 4. Infer indoor/outdoor from situation
  if (situationVector) {
    if (situationVector.energy_level === 'low') {
      indoorOutdoorPreference = 'indoor';
      flags.push('indoor_preferred');
    } else if (situationVector.primary_activity?.includes('exercise') ||
               situationVector.primary_activity?.includes('walk')) {
      indoorOutdoorPreference = 'outdoor';
      flags.push('outdoor_ok');
    }
  }

  // 5. Default outdoor_ok if daytime and no restrictions
  if (!isLateNight && weatherSuitability !== 'unsuitable' && !flags.includes('indoor_preferred')) {
    flags.push('outdoor_ok');
  }

  // Calculate confidence based on available data
  let confidence = 50;
  if (referenceTime) confidence += 20;
  if (locationContext && locationContext.confidence > 50) confidence += 15;
  if (situationVector) confidence += 15;
  confidence = Math.min(confidence, 100);

  return {
    flags,
    time_of_day_safety: timeOfDaySafety,
    weather_suitability: weatherSuitability,
    indoor_outdoor_preference: indoorOutdoorPreference,
    current_local_time: now.toISOString(),
    is_late_night: isLateNight,
    is_early_morning: isEarlyMorning,
    cultural_considerations: [],
    confidence
  };
}

// =============================================================================
// Contextual Filter Engine (Spec Section 3)
// =============================================================================

/**
 * Filter actions based on context
 * Per spec: Filter by reachability, suitability, and effort level
 */
export function filterActions(
  actions: ActionToFilter[],
  contextBundle: D34ContextBundle,
  strictness: 'relaxed' | 'normal' | 'strict' = 'normal'
): FilterResult[] {
  const results: FilterResult[] = [];

  for (const action of actions) {
    const result = filterSingleAction(action, contextBundle, strictness);
    results.push(result);
  }

  return results;
}

/**
 * Filter a single action against context
 */
function filterSingleAction(
  action: ActionToFilter,
  context: D34ContextBundle,
  strictness: 'relaxed' | 'normal' | 'strict'
): FilterResult {
  const rejectionReasons: FilterResult['rejection_reasons'] = [];
  const adjustments: FilterResult['adjustments'] = [];
  let passed = true;

  const { location_context, mobility_profile, environmental_constraints } = context;

  // 1. Check reachability (distance)
  if (action.distance_km !== undefined) {
    const maxDistance = DISTANCE_TOLERANCE_KM[mobility_profile.distance_tolerance];

    if (action.distance_km > maxDistance) {
      const severity = strictness === 'strict' ? 'hard' : 'soft';
      rejectionReasons.push({
        rule: 'distance_check',
        reason: `Distance ${action.distance_km}km exceeds tolerance of ${maxDistance}km`,
        severity
      });

      if (severity === 'hard') {
        passed = false;
      }
    }
  }

  // 2. Check location match
  if (action.location?.city && location_context.city) {
    if (action.location.city.toLowerCase() !== location_context.city.toLowerCase()) {
      // Different city - check if user is willing to travel
      if (mobility_profile.distance_tolerance === 'very_local' ||
          mobility_profile.distance_tolerance === 'local') {
        rejectionReasons.push({
          rule: 'location_match',
          reason: `Action in ${action.location.city} but user prefers local (${location_context.city})`,
          severity: strictness === 'relaxed' ? 'soft' : 'hard'
        });

        if (strictness !== 'relaxed') {
          passed = false;
        }
      }
    }
  }

  // 3. Check time suitability
  if (action.time) {
    const actionTime = new Date(action.time);
    const actionHour = actionTime.getHours();
    const isLateNight = actionHour >= 22 || actionHour < 5;

    if (isLateNight && environmental_constraints.flags.includes('avoid_late_night')) {
      rejectionReasons.push({
        rule: 'time_safety',
        reason: 'Action scheduled during late night hours',
        severity: 'soft'
      });

      if (strictness === 'strict') {
        passed = false;
      }
    }
  }

  // 4. Check indoor/outdoor suitability
  if (action.location?.is_indoor !== undefined) {
    if (action.location.is_indoor && environmental_constraints.indoor_outdoor_preference === 'outdoor') {
      rejectionReasons.push({
        rule: 'indoor_outdoor_preference',
        reason: 'Indoor activity but user prefers outdoor',
        severity: 'soft'
      });
    } else if (!action.location.is_indoor && environmental_constraints.indoor_outdoor_preference === 'indoor') {
      rejectionReasons.push({
        rule: 'indoor_outdoor_preference',
        reason: 'Outdoor activity but user prefers indoor',
        severity: 'soft'
      });
    }
  }

  // 5. Check effort level alignment
  if (action.effort_required) {
    const effortLevels = ['minimal', 'low', 'moderate', 'high', 'extreme'];
    const actionEffortIndex = effortLevels.indexOf(action.effort_required);
    const toleranceIndex = getEffortToleranceIndex(mobility_profile);

    if (actionEffortIndex > toleranceIndex) {
      rejectionReasons.push({
        rule: 'effort_check',
        reason: `Effort level ${action.effort_required} exceeds user's capacity`,
        severity: strictness === 'strict' ? 'hard' : 'soft'
      });

      if (strictness === 'strict' && actionEffortIndex > toleranceIndex + 1) {
        passed = false;
      }
    }
  }

  // Build contextual action if passed
  let contextualAction: ContextualAction | undefined;
  if (passed || strictness === 'relaxed') {
    contextualAction = {
      action: action.action,
      action_type: action.action_type || 'other',
      distance_estimate: estimateDistance(action.distance_km),
      distance_km: action.distance_km ?? null,
      mobility_fit: assessMobilityFit(action, mobility_profile),
      confidence: calculateActionConfidence(action, context),
      environment_tags: deriveEnvironmentTags(action, context),
      is_reachable: !rejectionReasons.some(r => r.rule === 'distance_check' && r.severity === 'hard'),
      is_suitable: !rejectionReasons.some(r => r.severity === 'hard'),
      effort_level: action.effort_required || 'moderate',
      rejection_reason: passed ? null : rejectionReasons.find(r => r.severity === 'hard')?.reason || null,
      metadata: action.metadata
    };
  }

  return {
    action_id: action.id,
    action: action.action,
    passed,
    contextual_action: contextualAction,
    rejection_reasons: rejectionReasons,
    adjustments
  };
}

/**
 * Get effort tolerance index based on mobility profile
 */
function getEffortToleranceIndex(mobility: MobilityProfile): number {
  const effortLevels = ['minimal', 'low', 'moderate', 'high', 'extreme'];

  // Access level impacts effort tolerance
  switch (mobility.access_level) {
    case 'limited':
    case 'assisted':
      return effortLevels.indexOf('low');
    case 'moderate':
      return effortLevels.indexOf('moderate');
    case 'full':
    default:
      return effortLevels.indexOf('high');
  }
}

/**
 * Estimate distance category from km
 */
function estimateDistance(km: number | undefined): ContextualAction['distance_estimate'] {
  if (km === undefined) return 'unknown';

  for (const [category, range] of Object.entries(DISTANCE_ESTIMATES)) {
    if (km >= range.min && km < range.max) {
      return category as ContextualAction['distance_estimate'];
    }
  }

  return 'remote';
}

/**
 * Assess mobility fit for an action
 */
function assessMobilityFit(action: ActionToFilter, mobility: MobilityProfile): MobilityFit {
  let score = 100;

  // Distance penalty
  if (action.distance_km !== undefined) {
    const maxDistance = DISTANCE_TOLERANCE_KM[mobility.distance_tolerance];
    if (action.distance_km > maxDistance) {
      score -= 40;
    } else if (action.distance_km > maxDistance * 0.7) {
      score -= 20;
    }
  }

  // Effort penalty
  if (action.effort_required) {
    const toleranceIndex = getEffortToleranceIndex(mobility);
    const effortLevels = ['minimal', 'low', 'moderate', 'high', 'extreme'];
    const actionEffortIndex = effortLevels.indexOf(action.effort_required);

    if (actionEffortIndex > toleranceIndex) {
      score -= (actionEffortIndex - toleranceIndex) * 15;
    }
  }

  // Convert score to fit level
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'acceptable';
  if (score >= 30) return 'challenging';
  return 'unsuitable';
}

/**
 * Calculate confidence for an action
 */
function calculateActionConfidence(action: ActionToFilter, context: D34ContextBundle): number {
  let confidence = context.overall_confidence;

  // Reduce confidence if distance is estimated
  if (action.distance_km === undefined) {
    confidence -= 20;
  }

  // Reduce confidence if location doesn't match
  if (action.location?.city && context.location_context.city &&
      action.location.city.toLowerCase() !== context.location_context.city.toLowerCase()) {
    confidence -= 15;
  }

  return Math.max(0, Math.min(100, confidence));
}

/**
 * Derive environment tags for an action
 */
function deriveEnvironmentTags(action: ActionToFilter, context: D34ContextBundle): EnvironmentTag[] {
  const tags: EnvironmentTag[] = [];

  // Local only tag
  if (context.mobility_profile.distance_tolerance === 'very_local' ||
      context.mobility_profile.distance_tolerance === 'local') {
    tags.push('local_only');
  }

  // Walkable tag
  if (context.mobility_profile.mode_preference === 'walking') {
    tags.push('walkable');
  }

  // Travel required tag
  if (action.distance_km && action.distance_km > DISTANCE_TOLERANCE_KM.local) {
    tags.push('travel_required');
  }

  // Indoor/outdoor preference
  if (context.environmental_constraints.indoor_outdoor_preference === 'indoor') {
    tags.push('indoor_preferred');
  } else if (context.environmental_constraints.indoor_outdoor_preference === 'outdoor') {
    tags.push('outdoor_preferred');
  }

  // Time sensitivity
  if (action.time) {
    tags.push('time_sensitive');
  }

  // Accessibility
  if (context.mobility_profile.access_level === 'limited' ||
      context.mobility_profile.access_level === 'assisted') {
    tags.push('accessibility_needed');
  }

  return tags;
}

// =============================================================================
// Bundle Generation
// =============================================================================

/**
 * Generate bundle hash for determinism verification
 */
function generateBundleHash(bundle: Omit<D34ContextBundle, 'bundle_hash'>): string {
  const content = JSON.stringify({
    location: bundle.location_context,
    mobility: bundle.mobility_profile,
    environment: bundle.environmental_constraints
  });

  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Derive environment tags from context
 */
function deriveContextEnvironmentTags(
  location: LocationContext,
  mobility: MobilityProfile,
  environment: EnvironmentalConstraints
): EnvironmentTag[] {
  const tags: EnvironmentTag[] = [];

  // Distance-based tags
  if (mobility.distance_tolerance === 'very_local' || mobility.distance_tolerance === 'local') {
    tags.push('local_only');
  }

  if (mobility.mode_preference === 'walking') {
    tags.push('walkable');
  }

  // Indoor/outdoor
  if (environment.indoor_outdoor_preference === 'indoor') {
    tags.push('indoor_preferred');
  } else if (environment.indoor_outdoor_preference === 'outdoor') {
    tags.push('outdoor_preferred');
  }

  // Weather-dependent
  if (environment.weather_suitability !== 'unknown' && environment.weather_suitability !== 'ideal') {
    tags.push('weather_dependent');
  }

  // Accessibility
  if (mobility.access_level === 'limited' || mobility.access_level === 'assisted') {
    tags.push('accessibility_needed');
  }

  return tags;
}

// =============================================================================
// Context Bundle Cache
// =============================================================================

interface CacheEntry {
  bundle: D34ContextBundle;
  timestamp: number;
}

const contextCache = new Map<string, CacheEntry>();

function getCacheKey(userId?: string, sessionId?: string): string {
  return `${userId || 'anonymous'}-${sessionId || 'default'}`;
}

function getCachedBundle(userId?: string, sessionId?: string): D34ContextBundle | null {
  const key = getCacheKey(userId, sessionId);
  const entry = contextCache.get(key);

  if (!entry) return null;

  const age = Date.now() - entry.timestamp;
  if (age > CACHE_TTL_MS) {
    contextCache.delete(key);
    return null;
  }

  return entry.bundle;
}

function setCachedBundle(bundle: D34ContextBundle, userId?: string, sessionId?: string): void {
  const key = getCacheKey(userId, sessionId);
  contextCache.set(key, {
    bundle,
    timestamp: Date.now()
  });
}

// =============================================================================
// Main Engine Functions
// =============================================================================

/**
 * Compute complete D34 context bundle
 */
export async function computeContext(
  request: ComputeContextRequest,
  authToken?: string
): Promise<ComputeContextResponse> {
  const startTime = Date.now();

  try {
    // Check cache first (unless force refresh)
    if (!request.force_refresh) {
      const cached = getCachedBundle(request.user_id, request.session_id);
      if (cached) {
        console.log(`${LOG_PREFIX} Returning cached context bundle`);

        await emitOasisEvent({
          vtid: VTID,
          type: 'd34.context.cached',
          source: 'gateway-d34',
          status: 'success',
          message: 'Context bundle served from cache',
          payload: {
            bundle_id: cached.bundle_id,
            cache_age_ms: Date.now() - new Date(cached.computed_at).getTime()
          }
        });

        return { ok: true, bundle: cached };
      }
    }

    // Create Supabase client
    let supabase: SupabaseClient | null = null;
    let useDevIdentity = false;

    if (authToken) {
      supabase = createUserClient(authToken);
    } else if (isDevSandbox()) {
      supabase = createServiceClient();
      useDevIdentity = true;
    }

    // Bootstrap dev context if needed
    if (supabase && useDevIdentity) {
      await supabase.rpc('dev_bootstrap_request_context', {
        p_tenant_id: DEV_IDENTITY.TENANT_ID,
        p_active_role: 'developer'
      }).catch(() => { /* Ignore bootstrap errors */ });
    }

    // Parse D32/D33 inputs if provided
    const situationVector = request.situation_context as D32SituationVector | undefined;
    const availabilityContext = request.availability_context as D33AvailabilityContext | undefined;

    // 1. Resolve location context
    const locationContext = await resolveLocationContext(
      supabase,
      request.explicit_location,
      situationVector
    );

    // 2. Build mobility profile
    const mobilityProfile = await buildMobilityProfile(
      supabase,
      request.explicit_mobility,
      situationVector,
      availabilityContext
    );

    // 3. Compute environmental constraints
    const environmentalConstraints = await computeEnvironmentalConstraints(
      request.reference_time,
      locationContext,
      situationVector
    );

    // 4. Derive environment tags
    const environmentTags = deriveContextEnvironmentTags(
      locationContext,
      mobilityProfile,
      environmentalConstraints
    );

    // 5. Calculate overall confidence
    const overallConfidence = Math.round(
      (locationContext.confidence + mobilityProfile.confidence + environmentalConstraints.confidence) / 3
    );

    // 6. Determine data freshness
    const now = Date.now();
    const locationAge = now - new Date(locationContext.resolved_at).getTime();
    const dataFreshness: D34ContextBundle['data_freshness'] =
      locationAge < 60000 ? 'fresh' :
      locationAge < 300000 ? 'recent' :
      locationAge < 3600000 ? 'stale' : 'unknown';

    // 7. Build sources used list
    const sourcesUsed: string[] = [];
    if (request.explicit_location) sourcesUsed.push('explicit_location');
    if (request.explicit_mobility) sourcesUsed.push('explicit_mobility');
    if (locationContext.source !== 'default') sourcesUsed.push(`location_${locationContext.source}`);
    if (mobilityProfile.inferred_from.length > 0) {
      sourcesUsed.push(...mobilityProfile.inferred_from.map(s => `mobility_${s}`));
    }

    // 8. Determine if fallback was applied
    const fallbackApplied = locationContext.source === 'default' &&
                           mobilityProfile.confidence < 30;

    // 9. Build the bundle
    const bundleId = randomUUID();
    const computedAt = new Date().toISOString();

    const bundleWithoutHash = {
      bundle_id: bundleId,
      bundle_hash: '',
      computed_at: computedAt,
      location_context: locationContext,
      mobility_profile: mobilityProfile,
      environmental_constraints: environmentalConstraints,
      environment_tags: environmentTags,
      overall_confidence: overallConfidence,
      data_freshness: dataFreshness,
      sources_used: sourcesUsed,
      fallback_applied: fallbackApplied,
      fallback_reason: fallbackApplied ? 'No location or mobility data available' : null,
      disclaimer: 'Location and mobility context is probabilistic and should not be used for safety-critical decisions.'
    };

    const bundle: D34ContextBundle = {
      ...bundleWithoutHash,
      bundle_hash: generateBundleHash(bundleWithoutHash)
    };

    // Cache the bundle
    setCachedBundle(bundle, request.user_id, request.session_id);

    const duration = Date.now() - startTime;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd34.context.computed',
      source: 'gateway-d34',
      status: 'success',
      message: `D34 context computed in ${duration}ms`,
      payload: {
        bundle_id: bundle.bundle_id,
        location_confidence: locationContext.confidence,
        mobility_confidence: mobilityProfile.confidence,
        environment_confidence: environmentalConstraints.confidence,
        overall_confidence: overallConfidence,
        fallback_applied: fallbackApplied,
        sources_used: sourcesUsed,
        duration_ms: duration
      }
    });

    console.log(`${LOG_PREFIX} Context computed in ${duration}ms, confidence=${overallConfidence}%`);

    return { ok: true, bundle };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error computing context:`, errorMessage);

    await emitOasisEvent({
      vtid: VTID,
      type: 'd34.error',
      source: 'gateway-d34',
      status: 'error',
      message: `Context computation error: ${errorMessage}`,
      payload: { error: errorMessage }
    });

    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      message: errorMessage
    };
  }
}

/**
 * Get current context (from cache or compute fresh)
 */
export async function getCurrentContext(
  userId?: string,
  sessionId?: string,
  authToken?: string
): Promise<GetCurrentContextResponse> {
  // Check cache first
  const cached = getCachedBundle(userId, sessionId);
  if (cached) {
    const cacheAge = Math.round((Date.now() - new Date(cached.computed_at).getTime()) / 1000);
    return {
      ok: true,
      bundle: cached,
      cached: true,
      cache_age_seconds: cacheAge
    };
  }

  // Compute fresh
  const result = await computeContext({
    user_id: userId,
    session_id: sessionId
  }, authToken);

  if (!result.ok) {
    return {
      ok: false,
      error: result.error
    };
  }

  return {
    ok: true,
    bundle: result.bundle,
    cached: false,
    cache_age_seconds: 0
  };
}

/**
 * Filter a batch of actions
 */
export async function filterActionsBatch(
  request: FilterActionsRequest,
  authToken?: string
): Promise<FilterActionsResponse> {
  try {
    // Get or compute context
    let bundle: D34ContextBundle | undefined;

    if (request.context_bundle_id) {
      // Try to find in cache (simplified - in real impl would use bundle_id lookup)
      const cached = getCachedBundle();
      if (cached?.bundle_id === request.context_bundle_id) {
        bundle = cached;
      }
    }

    if (!bundle) {
      const contextResult = await computeContext({}, authToken);
      if (!contextResult.ok || !contextResult.bundle) {
        return {
          ok: false,
          error: 'Failed to compute context for filtering'
        };
      }
      bundle = contextResult.bundle;
    }

    // Filter actions
    const results = filterActions(request.actions, bundle, request.strictness);

    const passedCount = results.filter(r => r.passed).length;
    const rejectedCount = results.filter(r => !r.passed).length;

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd34.filter.applied',
      source: 'gateway-d34',
      status: 'success',
      message: `Filtered ${request.actions.length} actions: ${passedCount} passed, ${rejectedCount} rejected`,
      payload: {
        bundle_id: bundle.bundle_id,
        actions_filtered: request.actions.length,
        actions_passed: passedCount,
        actions_rejected: rejectedCount,
        strictness: request.strictness
      }
    });

    return {
      ok: true,
      results,
      passed_count: passedCount,
      rejected_count: rejectedCount,
      context_bundle_id: bundle.bundle_id
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error filtering actions:`, errorMessage);

    return {
      ok: false,
      error: errorMessage
    };
  }
}

/**
 * Apply context override (user correction)
 */
export async function applyContextOverride(
  request: OverrideContextRequest,
  userId?: string,
  sessionId?: string,
  authToken?: string
): Promise<OverrideContextResponse> {
  try {
    // Get current context
    const currentResult = await getCurrentContext(userId, sessionId, authToken);
    if (!currentResult.ok || !currentResult.bundle) {
      return {
        ok: false,
        error: 'No context available to override'
      };
    }

    const bundle = currentResult.bundle;
    const overrideId = randomUUID();
    const expiresAt = request.duration_minutes
      ? new Date(Date.now() + request.duration_minutes * 60 * 1000).toISOString()
      : undefined;

    // Apply overrides based on type
    switch (request.override_type) {
      case 'location':
        const locationOverrides = request.overrides as Partial<LocationContext>;
        Object.assign(bundle.location_context, locationOverrides);
        bundle.location_context.source = 'explicit';
        bundle.location_context.confidence = 100;
        break;

      case 'mobility':
        const mobilityOverrides = request.overrides as Partial<MobilityProfile>;
        Object.assign(bundle.mobility_profile, mobilityOverrides);
        bundle.mobility_profile.confidence = 100;
        bundle.mobility_profile.inferred_from = ['user_override'];
        break;

      case 'environment':
        const envOverrides = request.overrides as Partial<EnvironmentalConstraints>;
        Object.assign(bundle.environmental_constraints, envOverrides);
        bundle.environmental_constraints.confidence = 100;
        break;
    }

    // Recompute hash and update
    bundle.bundle_hash = generateBundleHash(bundle);
    bundle.computed_at = new Date().toISOString();
    bundle.sources_used.push(`override_${request.override_type}`);

    // Update cache
    setCachedBundle(bundle, userId, sessionId);

    // Emit OASIS event
    await emitOasisEvent({
      vtid: VTID,
      type: 'd34.context.override',
      source: 'gateway-d34',
      status: 'info',
      message: `Context override applied: ${request.override_type}`,
      payload: {
        bundle_id: bundle.bundle_id,
        override_id: overrideId,
        override_type: request.override_type,
        expires_at: expiresAt,
        reason: request.reason
      }
    });

    console.log(`${LOG_PREFIX} Override applied: ${request.override_type}`);

    return {
      ok: true,
      override_id: overrideId,
      expires_at: expiresAt
    };

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error(`${LOG_PREFIX} Error applying override:`, errorMessage);

    return {
      ok: false,
      error: errorMessage
    };
  }
}

// =============================================================================
// ORB Integration Functions
// =============================================================================

/**
 * Get mobility context for ORB system prompt injection
 */
export async function getOrbMobilityContext(
  userId?: string,
  sessionId?: string,
  authToken?: string
): Promise<{ context: string; orbContext: OrbMobilityContext } | null> {
  try {
    const result = await getCurrentContext(userId, sessionId, authToken);

    if (!result.ok || !result.bundle) {
      return null;
    }

    const orbContext = toOrbMobilityContext(result.bundle);
    const context = formatMobilityContextForPrompt(orbContext);

    return { context, orbContext };

  } catch (error) {
    console.error(`${LOG_PREFIX} Error getting ORB mobility context:`, error);
    return null;
  }
}

/**
 * Verify bundle integrity (determinism check)
 */
export function verifyBundleIntegrity(bundle: D34ContextBundle): boolean {
  const expectedHash = generateBundleHash(bundle);
  return bundle.bundle_hash === expectedHash;
}

/**
 * Verify determinism between two bundles
 */
export function verifyDeterminism(
  bundle1: D34ContextBundle,
  bundle2: D34ContextBundle
): { match: boolean; differences: string[] } {
  const differences: string[] = [];

  // Compare location context (excluding timestamps)
  if (bundle1.location_context.city !== bundle2.location_context.city) {
    differences.push('location_context.city');
  }
  if (bundle1.location_context.country !== bundle2.location_context.country) {
    differences.push('location_context.country');
  }

  // Compare mobility profile
  if (bundle1.mobility_profile.mode_preference !== bundle2.mobility_profile.mode_preference) {
    differences.push('mobility_profile.mode_preference');
  }
  if (bundle1.mobility_profile.distance_tolerance !== bundle2.mobility_profile.distance_tolerance) {
    differences.push('mobility_profile.distance_tolerance');
  }

  // Compare environmental constraints (excluding time-dependent fields)
  if (bundle1.environmental_constraints.indoor_outdoor_preference !==
      bundle2.environmental_constraints.indoor_outdoor_preference) {
    differences.push('environmental_constraints.indoor_outdoor_preference');
  }

  return {
    match: differences.length === 0,
    differences
  };
}

// =============================================================================
// Exports
// =============================================================================

export {
  toOrbMobilityContext,
  formatMobilityContextForPrompt
};

export type {
  LocationContext,
  MobilityProfile,
  EnvironmentalConstraints,
  EnvironmentTag,
  ContextualAction,
  D34ContextBundle,
  ComputeContextRequest,
  ComputeContextResponse,
  FilterActionsRequest,
  FilterActionsResponse,
  GetCurrentContextResponse,
  OverrideContextRequest,
  OverrideContextResponse,
  OrbMobilityContext
};
