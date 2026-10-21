/**
 * VTID-01270A: Event Relevance Scoring Engine
 *
 * Multi-dimension scoring replaces hard AND filters in search_events.
 * Each event receives a 0-100 score based on how well it matches the
 * user's search criteria. No event is excluded by scoring — results
 * are ranked and tiered into "Best matches" vs "You might also like".
 *
 * Scoring Dimensions (base weights when all active):
 * 1. Query match (activity/keyword)  - base 35 points
 * 2. Location match                  - base 30 points
 * 3. Organizer match                 - base 20 points
 * 4. Price match                     - base 15 points
 * 5. Proximity (user home city)      - 10 bonus points (always additive)
 *
 * When fewer filters are provided, active dimensions redistribute
 * the 100-point budget proportionally.
 */

// =============================================================================
// Types
// =============================================================================

export interface EventRecord {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  location: string;
  virtual_link: string | null;
  slug: string | null;
  metadata: {
    category?: string;
    host?: string;
    guest?: string;
    price?: number;
    is_paid?: boolean;
    venue_type?: string;
  } | null;
}

export interface EventSearchFilters {
  query: string;
  location: string;
  organizer: string;
  maxPrice: number | undefined;
  userHomeCity?: string; // from location_preferences, for proximity boost
}

interface ScoreBreakdown {
  query: number;
  location: number;
  organizer: number;
  price: number;
  proximity: number;
}

export interface ScoredEvent {
  event: EventRecord;
  score: number;
  breakdown: ScoreBreakdown;
  tier: 'best' | 'alternative';
}

export interface ScoredEventResults {
  best: ScoredEvent[];
  alternatives: ScoredEvent[];
  totalScored: number;
  activeFilters: string[];
}

// =============================================================================
// Country → City Mapping (shared, replaces duplicates in orb-live + gemini-operator)
// =============================================================================

export const COUNTRY_CITY_MAP: Record<string, string[]> = {
  'france': ['paris', 'lyon', 'nice', 'marseille', 'montmartre', 'bordeaux', 'toulouse', 'strasbourg', 'rivoli'],
  'germany': ['berlin', 'munich', 'münchen', 'hamburg', 'frankfurt', 'cologne', 'köln', 'bremen', 'düsseldorf', 'garmisch', 'neukölln', 'prenzlauer'],
  'spain': ['mallorca', 'palma', 'barcelona', 'madrid', 'portixol', 'cala major', 'santa catalina', 'puerto portals'],
  'usa': ['new york', 'los angeles', 'chicago', 'san francisco', 'miami', 'brooklyn', 'manhattan'],
  'united states': ['new york', 'los angeles', 'chicago', 'san francisco', 'miami', 'brooklyn', 'manhattan'],
  'uae': ['dubai', 'abu dhabi'],
  'united arab emirates': ['dubai', 'abu dhabi'],
  'austria': ['vienna', 'wien', 'salzburg', 'graz', 'innsbruck'],
  'serbia': ['belgrade', 'beograd', 'novi sad', 'petrovaradin'],
  'luxembourg': ['luxembourg'],
  'mallorca': ['palma', 'portixol', 'cala major', 'santa catalina', 'puerto portals', 'mallorca', 'box palma'],
};

// =============================================================================
// Per-Dimension Scoring Functions
// =============================================================================

const BASE_WEIGHTS = {
  query: 35,
  location: 30,
  organizer: 20,
  price: 15,
};

const PROXIMITY_BONUS_MAX = 10;
const BEST_THRESHOLD = 50;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Score query/keyword match. Returns 0-100.
 */
function scoreQuery(event: EventRecord, query: string): number {
  if (!query) return 0;
  const q = query.toLowerCase();
  const title = (event.title || '').toLowerCase();
  const desc = (event.description || '').toLowerCase();
  const category = (event.metadata?.category || '').toLowerCase();

  // Exact word boundary match in title
  try {
    const wordRegex = new RegExp(`\\b${escapeRegex(q)}\\b`, 'i');
    if (wordRegex.test(event.title || '')) return 100;
  } catch { /* regex failed, skip */ }

  if (title.includes(q)) return 80;
  if (category.includes(q)) return 70;
  if (desc.includes(q)) return 50;

  // Partial prefix match (min 4 chars)
  if (q.length >= 4 && title.includes(q.substring(0, 4))) return 20;

  return 0;
}

/**
 * Score location match. Returns 0-100.
 * Uses COUNTRY_CITY_MAP for country → city expansion.
 */
function scoreLocation(event: EventRecord, locationFilter: string): number {
  if (!locationFilter) return 0;
  const locFilter = locationFilter.toLowerCase();
  const loc = (event.location || '').toLowerCase();
  const title = (event.title || '').toLowerCase();

  // Direct match on location field
  if (loc.includes(locFilter)) return 100;
  // Direct match in title
  if (title.includes(locFilter)) return 90;

  // Country/region expansion
  const expandedTerms = COUNTRY_CITY_MAP[locFilter] || [];
  if (expandedTerms.length > 0) {
    if (expandedTerms.some(city => loc.includes(city))) return 70;
    if (expandedTerms.some(city => title.includes(city))) return 60;
  }

  return 0;
}

/**
 * Score organizer match. Returns 0-100.
 */
function scoreOrganizer(event: EventRecord, organizerFilter: string): number {
  if (!organizerFilter) return 0;
  const org = organizerFilter.toLowerCase();
  const host = (event.metadata?.host || '').toLowerCase();
  const guest = (event.metadata?.guest || '').toLowerCase();

  if (host && host === org) return 100;
  if (host && host.includes(org)) return 80;
  if (guest && guest === org) return 70;
  if (guest && guest.includes(org)) return 50;

  return 0;
}

/**
 * Score price match. Returns 0-100.
 */
function scorePrice(event: EventRecord, maxPrice: number | undefined): number {
  if (maxPrice === undefined) return 0;
  const isPaid = event.metadata?.is_paid;
  const price = event.metadata?.price ?? 0;

  if (maxPrice === 0) {
    // Free-only request
    if (!isPaid) return 100;
    if (price <= 20) return 30; // cheap events as alternatives
    return 0;
  }

  // Budget-constrained
  if (!isPaid || price <= maxPrice) return 100;
  if (price <= maxPrice * 1.5) return 60;
  if (price <= maxPrice * 2) return 30;
  return 0;
}

/**
 * Score proximity to user's home city. Returns 0-100.
 * This is a bonus dimension (max 10 points), not a main filter.
 */
function scoreProximity(event: EventRecord, userHomeCity: string | undefined): number {
  if (!userHomeCity) return 0;
  const home = userHomeCity.toLowerCase();
  const loc = (event.location || '').toLowerCase();
  const title = (event.title || '').toLowerCase();

  // Direct match
  if (loc.includes(home) || title.includes(home)) return 100;

  // Country/region expansion (user's home city might be a country name)
  const expandedTerms = COUNTRY_CITY_MAP[home] || [];
  if (expandedTerms.length > 0) {
    if (expandedTerms.some(city => loc.includes(city) || title.includes(city))) return 70;
  }

  return 0;
}

// =============================================================================
// Score Aggregation
// =============================================================================

function scoreEvent(event: EventRecord, filters: EventSearchFilters): ScoredEvent {
  const breakdown: ScoreBreakdown = {
    query: scoreQuery(event, filters.query),
    location: scoreLocation(event, filters.location),
    organizer: scoreOrganizer(event, filters.organizer),
    price: scorePrice(event, filters.maxPrice),
    proximity: scoreProximity(event, filters.userHomeCity),
  };

  // Determine active filter dimensions (user provided a value)
  const activeDimensions: { key: keyof typeof BASE_WEIGHTS; weight: number }[] = [];
  if (filters.query) activeDimensions.push({ key: 'query', weight: BASE_WEIGHTS.query });
  if (filters.location) activeDimensions.push({ key: 'location', weight: BASE_WEIGHTS.location });
  if (filters.organizer) activeDimensions.push({ key: 'organizer', weight: BASE_WEIGHTS.organizer });
  if (filters.maxPrice !== undefined) activeDimensions.push({ key: 'price', weight: BASE_WEIGHTS.price });

  let finalScore = 0;

  if (activeDimensions.length > 0) {
    // Redistribute weights among active dimensions to sum to 100
    const totalBaseWeight = activeDimensions.reduce((sum, d) => sum + d.weight, 0);
    for (const dim of activeDimensions) {
      const normalizedWeight = (dim.weight / totalBaseWeight) * 100;
      finalScore += (breakdown[dim.key] / 100) * normalizedWeight;
    }
  }
  // else: no filters → finalScore stays 0, chronological order preserved

  // Add proximity bonus (up to 10 points, always additive)
  finalScore += (breakdown.proximity / 100) * PROXIMITY_BONUS_MAX;

  finalScore = Math.round(finalScore * 100) / 100;

  return {
    event,
    score: finalScore,
    breakdown,
    tier: 'best', // assigned during grouping
  };
}

// =============================================================================
// Main Exported Function: Score, Rank, and Tier
// =============================================================================

export function scoreAndRankEvents(
  events: EventRecord[],
  filters: EventSearchFilters,
  maxResults: number
): ScoredEventResults {
  const activeFilters: string[] = [];
  if (filters.query) activeFilters.push(`query="${filters.query}"`);
  if (filters.location) activeFilters.push(`location="${filters.location}"`);
  if (filters.organizer) activeFilters.push(`organizer="${filters.organizer}"`);
  if (filters.maxPrice !== undefined) activeFilters.push(`maxPrice=${filters.maxPrice}`);
  if (filters.userHomeCity) activeFilters.push(`homeCity="${filters.userHomeCity}"`);

  // Score all events
  const scored = events.map(e => scoreEvent(e, filters));

  // Sort by score descending, chronological tiebreaker
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(a.event.start_time).getTime() - new Date(b.event.start_time).getTime();
  });

  // Cap to maxResults
  const capped = scored.slice(0, maxResults);

  const best: ScoredEvent[] = [];
  const alternatives: ScoredEvent[] = [];

  if (activeFilters.length === 0 || (activeFilters.length === 1 && filters.userHomeCity && !filters.query && !filters.location && !filters.organizer && filters.maxPrice === undefined)) {
    // No explicit filters (only proximity at most): all are "best", chronological
    for (const s of capped) {
      s.tier = 'best';
      best.push(s);
    }
  } else {
    for (const s of capped) {
      if (s.score >= BEST_THRESHOLD) {
        s.tier = 'best';
        best.push(s);
      } else {
        s.tier = 'alternative';
        alternatives.push(s);
      }
    }

    // Always promote at least one to "best"
    if (best.length === 0 && alternatives.length > 0) {
      const promoted = alternatives.shift()!;
      promoted.tier = 'best';
      best.push(promoted);
    }
  }

  return {
    best,
    alternatives,
    totalScored: events.length,
    activeFilters,
  };
}

// =============================================================================
// Formatters
// =============================================================================

function buildEventLink(e: EventRecord): string {
  return `https://vitanaland.com/e/${e.slug || e.id}`;
}

function formatEventLineVoice(s: ScoredEvent): string {
  const e = s.event;
  const date = new Date(e.start_time).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const category = e.metadata?.category ? ` | Category: ${e.metadata.category}` : '';
  const host = e.metadata?.host ? ` | Organizer: ${e.metadata.host}` : '';
  const guest = e.metadata?.guest ? ` | Guest: ${e.metadata.guest}` : '';
  const price = e.metadata?.is_paid ? ` | €${e.metadata.price || '?'}` : ' | Free';
  const venue = e.metadata?.venue_type ? ` | ${e.metadata.venue_type}` : '';
  const link = ` | Link: ${buildEventLink(e)}`;
  const desc = e.description ? ` | About: ${e.description.substring(0, 120)}` : '';
  return `${e.title} | ${date} | ${e.location || 'TBD'}${category}${host}${guest}${price}${venue}${link}${desc}`;
}

function formatEventLineText(s: ScoredEvent): string {
  const e = s.event;
  const date = new Date(e.start_time).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
  const category = e.metadata?.category ? ` | Category: ${e.metadata.category}` : '';
  const host = e.metadata?.host ? ` | Organizer: ${e.metadata.host}` : '';
  const guest = e.metadata?.guest ? ` | Guest: ${e.metadata.guest}` : '';
  const price = e.metadata?.is_paid ? ` | €${e.metadata.price || '?'}` : ' | Free';
  const venue = e.metadata?.venue_type ? ` | ${e.metadata.venue_type}` : '';
  const desc = (e.description || '').substring(0, 200);
  const link = buildEventLink(e);
  return `**${e.title}** | ${date} | ${e.location || 'TBD'}${category}${host}${guest}${price}${venue}\n  ${desc}\n  Link: ${link}`;
}

/**
 * Format scored results for voice path. Compact, max 3000 chars.
 */
export function formatForVoice(results: ScoredEventResults): string {
  const MAX_CHARS = 3000;
  const lines: string[] = [];
  const total = results.best.length + results.alternatives.length;

  if (results.best.length > 0) {
    if (results.alternatives.length > 0) {
      lines.push(`Best matches (${results.best.length}):`);
    }
    for (const s of results.best) {
      lines.push(formatEventLineVoice(s));
    }
  }

  if (results.alternatives.length > 0) {
    lines.push('');
    lines.push(`You might also like (${results.alternatives.length}):`);
    for (const s of results.alternatives) {
      lines.push(formatEventLineVoice(s));
    }
  }

  let output = `Found ${total} upcoming events:\n` + lines.join('\n');
  if (output.length > MAX_CHARS) {
    output = output.substring(0, MAX_CHARS) + '\n... (truncated)';
  }
  return output;
}

/**
 * Format scored results for text path. Markdown-friendly.
 */
export function formatForText(results: ScoredEventResults): string {
  const lines: string[] = [];
  const total = results.best.length + results.alternatives.length;

  if (results.best.length > 0) {
    if (results.alternatives.length > 0) {
      lines.push(`**Best matches** (${results.best.length}):`);
    }
    for (const s of results.best) {
      lines.push(formatEventLineText(s));
    }
  }

  if (results.alternatives.length > 0) {
    lines.push('');
    lines.push(`**You might also like** (${results.alternatives.length}):`);
    for (const s of results.alternatives) {
      lines.push(formatEventLineText(s));
    }
  }

  return `Found ${total} upcoming events:\n` + lines.join('\n');
}
