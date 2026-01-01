/**
 * VTID-01091: Locations Memory Gateway Routes
 *
 * Endpoints:
 * - POST   /api/v1/locations                  - Create a new location
 * - POST   /api/v1/locations/:id/checkin      - Check in to a location
 * - GET    /api/v1/locations/visits           - Get visit history
 * - GET    /api/v1/discover/nearby            - Discover nearby locations
 * - GET    /api/v1/location/prefs             - Get location preferences
 * - POST   /api/v1/location/prefs             - Update location preferences
 * - GET    /api/v1/locations/health           - Health check
 *
 * Internal helpers:
 * - extractLocationFromDiary()                - Extract location mentions from diary text
 *
 * Dependencies:
 * - VTID-01087 (relationship graph via relationship_edges table)
 * - VTID-01102 (context bridge)
 * - VTID-01104 (memory core)
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { createUserSupabaseClient } from '../lib/supabase-user';
import { emitOasisEvent } from '../services/oasis-event-service';

const router = Router();

// =============================================================================
// VTID-01091: Constants & Types
// =============================================================================

const LOCATION_TYPES = ['park', 'gym', 'clinic', 'cafe', 'store', 'home', 'work', 'other'] as const;
type LocationType = typeof LOCATION_TYPES[number];

const PRIVACY_LEVELS = ['private', 'shared', 'public'] as const;
type PrivacyLevel = typeof PRIVACY_LEVELS[number];

const VISIT_TYPES = ['checkin', 'meetup', 'service', 'diary_mention'] as const;
type VisitType = typeof VISIT_TYPES[number];

// =============================================================================
// VTID-01091: Request Schemas
// =============================================================================

const LocationCreateSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  location_type: z.enum(LOCATION_TYPES).default('other'),
  country: z.string().optional(),
  city: z.string().optional(),
  area: z.string().optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  privacy_level: z.enum(PRIVACY_LEVELS).default('private'),
  topic_keys: z.array(z.string()).default([])
});

const LocationCheckinSchema = z.object({
  visit_time: z.string().datetime().optional(),
  visit_type: z.enum(VISIT_TYPES).default('checkin'),
  notes: z.string().optional(),
  metadata: z.record(z.unknown()).optional()
});

const VisitsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50)
});

const NearbyDiscoverySchema = z.object({
  lat: z.coerce.number().optional(),
  lng: z.coerce.number().optional(),
  radius_km: z.coerce.number().int().min(1).max(100).default(10),
  topics: z.string().optional()  // comma-separated topic keys
});

const LocationPreferencesSchema = z.object({
  preferred_radius_km: z.number().int().min(1).max(100).default(10),
  allow_location_personalization: z.boolean().default(true),
  allow_sharing_in_meetups: z.boolean().default(false),
  home_city: z.string().optional(),
  home_area: z.string().optional()
});

// =============================================================================
// VTID-01091: Helper Functions
// =============================================================================

/**
 * Extract Bearer token from Authorization header.
 */
function getBearerToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  return authHeader.slice(7);
}

/**
 * Emit a location-related OASIS event
 */
async function emitLocationEvent(
  type: string,
  status: 'info' | 'success' | 'warning' | 'error',
  message: string,
  payload: Record<string, unknown>
): Promise<void> {
  await emitOasisEvent({
    vtid: 'VTID-01091',
    type: type as any,
    source: 'locations-gateway',
    status,
    message,
    payload
  }).catch(err => console.warn(`[VTID-01091] Failed to emit ${type}:`, err.message));
}

// =============================================================================
// VTID-01091: Location Mention Extraction (Diary Integration)
// =============================================================================

/**
 * Location patterns for diary extraction.
 * Deterministic v1 - no LLM, just regex patterns.
 */
const LOCATION_PATTERNS = [
  // "at the gym", "at my gym"
  /\bat\s+(?:the\s+|my\s+)?(\w+(?:\s+\w+)?)\s*(?:gym|park|clinic|cafe|coffee\s*shop|store|office|home|work)/gi,
  // "went to [place]"
  /went\s+to\s+(?:the\s+|my\s+)?([^,.]+?)(?:\s+for\s+|\s+to\s+|[,.]|$)/gi,
  // "walked in [place]"
  /walked\s+(?:in|at|through)\s+(?:the\s+)?([^,.]+?)(?:[,.]|$)/gi,
  // "visited [place]"
  /visited\s+(?:the\s+|my\s+)?([^,.]+?)(?:[,.]|$)/gi,
  // "at [place name]" (capitalized, likely proper noun)
  /\bat\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)/g
];

/**
 * Location type keywords for classification.
 */
const LOCATION_TYPE_KEYWORDS: Record<LocationType, string[]> = {
  park: ['park', 'garden', 'trail', 'beach', 'forest', 'nature'],
  gym: ['gym', 'fitness', 'crossfit', 'yoga studio', 'pilates'],
  clinic: ['clinic', 'hospital', 'doctor', 'medical', 'dentist', 'therapist'],
  cafe: ['cafe', 'coffee', 'starbucks', 'bakery', 'restaurant'],
  store: ['store', 'shop', 'market', 'mall', 'grocery'],
  home: ['home', 'house', 'apartment'],
  work: ['office', 'work', 'workplace', 'company'],
  other: []
};

/**
 * Classify a location name to a location_type based on keywords.
 */
function classifyLocationType(name: string): LocationType {
  const lowerName = name.toLowerCase();
  for (const [type, keywords] of Object.entries(LOCATION_TYPE_KEYWORDS)) {
    if (keywords.some(kw => lowerName.includes(kw))) {
      return type as LocationType;
    }
  }
  return 'other';
}

/**
 * Extract topic keys from location name.
 */
function extractTopicKeys(name: string, locationType: LocationType): string[] {
  const topics: string[] = [];
  const lowerName = name.toLowerCase();

  // Health/wellness related
  if (['gym', 'park'].includes(locationType) || lowerName.includes('fitness') || lowerName.includes('wellness')) {
    topics.push('movement');
  }
  if (locationType === 'park' || lowerName.includes('walk') || lowerName.includes('trail')) {
    topics.push('walking');
  }
  if (lowerName.includes('yoga') || lowerName.includes('meditation')) {
    topics.push('mindfulness');
  }
  if (locationType === 'gym' || lowerName.includes('strength') || lowerName.includes('weight')) {
    topics.push('strength');
  }
  if (locationType === 'clinic' || lowerName.includes('therapy') || lowerName.includes('recovery')) {
    topics.push('recovery');
  }
  if (locationType === 'cafe' || lowerName.includes('coffee') || lowerName.includes('tea')) {
    topics.push('social');
  }

  return topics;
}

/**
 * Extract location mentions from diary text.
 * Returns structured location data for creation/linking.
 *
 * @param text - Diary entry text
 * @returns Array of extracted location mentions
 */
export function extractLocationFromDiary(text: string): Array<{
  name: string;
  location_type: LocationType;
  topic_keys: string[];
  raw_match: string;
}> {
  const locations: Array<{
    name: string;
    location_type: LocationType;
    topic_keys: string[];
    raw_match: string;
  }> = [];

  const seenNames = new Set<string>();

  for (const pattern of LOCATION_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    let match;
    while ((match = pattern.exec(text)) !== null) {
      const rawMatch = match[0];
      const extractedName = match[1]?.trim();

      if (!extractedName || extractedName.length < 2 || extractedName.length > 100) {
        continue;
      }

      // Normalize and dedupe
      const normalizedName = extractedName.toLowerCase();
      if (seenNames.has(normalizedName)) {
        continue;
      }
      seenNames.add(normalizedName);

      // Classify and extract topics
      const locationType = classifyLocationType(extractedName);
      const topicKeys = extractTopicKeys(extractedName, locationType);

      locations.push({
        name: extractedName,
        location_type: locationType,
        topic_keys: topicKeys,
        raw_match: rawMatch
      });
    }
  }

  return locations;
}

/**
 * Process diary text to create location records and visits.
 * Used internally when diary entries are created.
 *
 * @param token - User's Bearer token
 * @param diaryText - The diary entry text
 * @param diaryTimestamp - When the diary entry occurred
 * @returns Result with created locations and visits
 */
export async function processLocationMentionsFromDiary(
  token: string,
  diaryText: string,
  diaryTimestamp?: string
): Promise<{
  ok: boolean;
  locations_created: number;
  visits_created: number;
  errors: string[];
}> {
  const errors: string[] = [];
  let locationsCreated = 0;
  let visitsCreated = 0;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return { ok: false, locations_created: 0, visits_created: 0, errors: ['Gateway misconfigured'] };
  }

  const mentions = extractLocationFromDiary(diaryText);
  if (mentions.length === 0) {
    return { ok: true, locations_created: 0, visits_created: 0, errors: [] };
  }

  const supabase = createUserSupabaseClient(token);
  const visitTime = diaryTimestamp || new Date().toISOString();

  for (const mention of mentions) {
    try {
      // Create or find the location
      const { data: locationData, error: locationError } = await supabase.rpc('location_add', {
        p_payload: {
          name: mention.name,
          location_type: mention.location_type,
          privacy_level: 'private',
          topic_keys: mention.topic_keys
        }
      });

      if (locationError) {
        errors.push(`Failed to create location "${mention.name}": ${locationError.message}`);
        continue;
      }

      if (locationData?.ok && locationData.id) {
        if (!locationData.reused) {
          locationsCreated++;
        }

        // Create a visit record
        const { data: visitData, error: visitError } = await supabase.rpc('location_checkin', {
          p_payload: {
            location_id: locationData.id,
            visit_time: visitTime,
            visit_type: 'diary_mention',
            notes: `Mentioned in diary: "${mention.raw_match}"`
          }
        });

        if (visitError) {
          errors.push(`Failed to create visit for "${mention.name}": ${visitError.message}`);
        } else if (visitData?.ok) {
          visitsCreated++;

          // Emit OASIS event for diary mention
          await emitLocationEvent(
            'location.visit.diary_mention',
            'success',
            `Location mention extracted from diary: ${mention.name}`,
            {
              location_id: locationData.id,
              location_name: mention.name,
              location_type: mention.location_type,
              visit_id: visitData.visit_id,
              raw_match: mention.raw_match
            }
          );
        }
      }
    } catch (err: any) {
      errors.push(`Error processing "${mention.name}": ${err.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    locations_created: locationsCreated,
    visits_created: visitsCreated,
    errors
  };
}

// =============================================================================
// VTID-01091: Routes
// =============================================================================

/**
 * POST / -> POST /api/v1/locations
 *
 * Create a new location.
 */
router.post('/', async (req: Request, res: Response) => {
  console.log('[VTID-01091] POST /locations');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = LocationCreateSchema.safeParse(req.body);
  if (!validation.success) {
    console.warn('[VTID-01091] Validation failed:', validation.error.errors);
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('location_add', {
      p_payload: validation.data
    });

    if (error) {
      console.error('[VTID-01091] location_add RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({ ok: false, error: data?.error || 'Location creation failed' });
    }

    // Emit OASIS event
    await emitLocationEvent(
      'location.created',
      'success',
      `Location created: ${validation.data.name}`,
      {
        location_id: data.id,
        location_name: data.name,
        location_type: data.location_type,
        privacy_level: data.privacy_level,
        reused: data.reused
      }
    );

    console.log(`[VTID-01091] Location created: ${data.id} (${data.name})`);

    return res.status(201).json({
      ok: true,
      id: data.id,
      name: data.name,
      location_type: data.location_type,
      privacy_level: data.privacy_level,
      reused: data.reused
    });
  } catch (err: any) {
    console.error('[VTID-01091] location create error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /:id/checkin -> POST /api/v1/locations/:id/checkin
 *
 * Check in to a location.
 */
router.post('/:id/checkin', async (req: Request, res: Response) => {
  const locationId = req.params.id;
  console.log(`[VTID-01091] POST /locations/${locationId}/checkin`);

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate UUID
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(locationId)) {
    return res.status(400).json({ ok: false, error: 'Invalid location_id format' });
  }

  // Validate request body
  const validation = LocationCheckinSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('location_checkin', {
      p_payload: {
        location_id: locationId,
        ...validation.data
      }
    });

    if (error) {
      console.error('[VTID-01091] location_checkin RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      const statusCode = data?.error === 'LOCATION_NOT_FOUND' ? 404 : 400;
      return res.status(statusCode).json({ ok: false, error: data?.error || 'Check-in failed', message: data?.message });
    }

    // Emit OASIS events
    await emitLocationEvent(
      'location.checkin.created',
      'success',
      `Check-in created at location ${locationId}`,
      {
        location_id: data.location_id,
        visit_id: data.visit_id,
        visit_type: data.visit_type,
        visit_time: data.visit_time
      }
    );

    // Emit relationship edge strengthened event
    if (data.edge_strengthened) {
      await emitLocationEvent(
        'relationship.edge.strengthened',
        'success',
        `Relationship edge strengthened: person -> location`,
        {
          edge_id: data.edge_id,
          edge_type: 'visited',
          source_type: 'person',
          target_type: 'location',
          target_id: data.location_id,
          strength: data.edge_strength
        }
      );
    }

    console.log(`[VTID-01091] Check-in created: ${data.visit_id} at ${locationId}`);

    return res.status(201).json({
      ok: true,
      visit_id: data.visit_id,
      location_id: data.location_id,
      visit_time: data.visit_time,
      visit_type: data.visit_type,
      edge_strengthened: data.edge_strengthened,
      edge_strength: data.edge_strength
    });
  } catch (err: any) {
    console.error('[VTID-01091] checkin error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * GET /visits -> GET /api/v1/locations/visits
 *
 * Get visit history.
 */
router.get('/visits', async (req: Request, res: Response) => {
  console.log('[VTID-01091] GET /locations/visits');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate query parameters
  const queryValidation = VisitsQuerySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { from, to, limit } = queryValidation.data;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('location_get_visits', {
      p_from: from || null,
      p_to: to || null,
      p_limit: limit
    });

    if (error) {
      console.error('[VTID-01091] location_get_visits RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({ ok: false, error: data?.error || 'Failed to fetch visits' });
    }

    console.log(`[VTID-01091] Visits fetched: ${data.visits?.length || 0}`);

    return res.status(200).json({
      ok: true,
      visits: data.visits || [],
      query: data.query
    });
  } catch (err: any) {
    console.error('[VTID-01091] visits error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * GET /health -> GET /api/v1/locations/health
 *
 * Health check for locations service.
 */
router.get('/health', (_req: Request, res: Response) => {
  const hasSupabaseUrl = !!process.env.SUPABASE_URL;
  const hasSupabaseKey = !!process.env.SUPABASE_ANON_KEY;

  const status = hasSupabaseUrl && hasSupabaseKey ? 'ok' : 'degraded';

  return res.status(200).json({
    ok: true,
    status,
    service: 'locations-gateway',
    version: '1.0.0',
    vtid: 'VTID-01091',
    timestamp: new Date().toISOString(),
    capabilities: {
      create_location: hasSupabaseUrl && hasSupabaseKey,
      checkin: hasSupabaseUrl && hasSupabaseKey,
      discovery: hasSupabaseUrl && hasSupabaseKey,
      diary_extraction: true
    },
    dependencies: {
      'VTID-01087': 'relationship_edges',
      'VTID-01102': 'context_bridge',
      'VTID-01104': 'memory_core'
    }
  });
});

export default router;

// =============================================================================
// VTID-01091: Discovery Router (mounted separately at /api/v1/discover)
// =============================================================================

export const discoveryRouter = Router();

/**
 * GET /nearby -> GET /api/v1/discover/nearby
 *
 * Discover nearby locations, meetups, and services.
 */
discoveryRouter.get('/nearby', async (req: Request, res: Response) => {
  console.log('[VTID-01091] GET /discover/nearby');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate query parameters
  const queryValidation = NearbyDiscoverySchema.safeParse(req.query);
  if (!queryValidation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Invalid query parameters',
      details: queryValidation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const { lat, lng, radius_km, topics } = queryValidation.data;

  // Parse topic_keys from comma-separated string
  const topicKeys = topics ? topics.split(',').map(t => t.trim()).filter(t => t.length > 0) : null;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('location_nearby_discovery', {
      p_lat: lat || null,
      p_lng: lng || null,
      p_radius_km: radius_km,
      p_topic_keys: topicKeys
    });

    if (error) {
      console.error('[VTID-01091] location_nearby_discovery RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({ ok: false, error: data?.error || 'Discovery failed' });
    }

    // Emit OASIS event
    await emitLocationEvent(
      'discover.nearby.read',
      'success',
      `Nearby discovery query`,
      {
        lat,
        lng,
        radius_km,
        topic_keys: topicKeys,
        locations_found: data.discovery?.locations?.length || 0,
        frequent_places_found: data.discovery?.frequent_places?.length || 0
      }
    );

    console.log(`[VTID-01091] Discovery: ${data.discovery?.locations?.length || 0} locations, ${data.discovery?.frequent_places?.length || 0} frequent places`);

    return res.status(200).json({
      ok: true,
      discovery: data.discovery,
      query: data.query
    });
  } catch (err: any) {
    console.error('[VTID-01091] discovery error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

// =============================================================================
// VTID-01091: Preferences Router (mounted separately at /api/v1/location)
// =============================================================================

export const locationPrefsRouter = Router();

/**
 * GET /prefs -> GET /api/v1/location/prefs
 *
 * Get location preferences.
 */
locationPrefsRouter.get('/prefs', async (req: Request, res: Response) => {
  console.log('[VTID-01091] GET /location/prefs');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('location_preferences_get');

    if (error) {
      console.error('[VTID-01091] location_preferences_get RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({ ok: false, error: data?.error || 'Failed to fetch preferences' });
    }

    return res.status(200).json({
      ok: true,
      preferences: data.preferences,
      is_default: data.is_default
    });
  } catch (err: any) {
    console.error('[VTID-01091] prefs get error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});

/**
 * POST /prefs -> POST /api/v1/location/prefs
 *
 * Update location preferences.
 */
locationPrefsRouter.post('/prefs', async (req: Request, res: Response) => {
  console.log('[VTID-01091] POST /location/prefs');

  const token = getBearerToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  }

  // Validate request body
  const validation = LocationPreferencesSchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({
      ok: false,
      error: 'Validation failed',
      details: validation.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ')
    });
  }

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!supabaseUrl || !supabaseAnonKey) {
    return res.status(503).json({ ok: false, error: 'Gateway misconfigured' });
  }

  try {
    const supabase = createUserSupabaseClient(token);

    const { data, error } = await supabase.rpc('location_preferences_set', {
      p_payload: validation.data
    });

    if (error) {
      console.error('[VTID-01091] location_preferences_set RPC error:', error.message);
      return res.status(502).json({ ok: false, error: error.message });
    }

    if (!data?.ok) {
      return res.status(400).json({ ok: false, error: data?.error || 'Failed to update preferences' });
    }

    console.log('[VTID-01091] Preferences updated');

    return res.status(200).json({
      ok: true,
      message: 'Preferences updated'
    });
  } catch (err: any) {
    console.error('[VTID-01091] prefs set error:', err.message);
    return res.status(502).json({ ok: false, error: err.message });
  }
});
