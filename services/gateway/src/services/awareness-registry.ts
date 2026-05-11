/**
 * Awareness Registry — BOOTSTRAP-AWARENESS-REGISTRY
 *
 * Single source of truth for every context signal the voice ORB / brain can
 * inject into a Gemini Live system_instruction. Each entry declares its
 * tier, subcategory, default state, and (optional) tunable parameters.
 *
 * The manifest below is the spec. Live overrides come from the
 * `awareness_config` table (admin-controlled, exafy-admin only). The
 * `getAwarenessConfig()` helper merges defaults with overrides and caches
 * the merged view for 60s.
 *
 * Consumers (orb-live.ts, user-context-profiler.ts) ask:
 *
 *     const cfg = await getAwarenessConfig();
 *     if (!cfg.isEnabled('content.music.enabled')) return '';
 *     const maxItems = cfg.getParam('content.section.max_items', 8);
 *
 * v1 is GLOBAL — one config applies to every tenant. Per-tenant + per-user
 * overrides are deferred to v2.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Types
// =============================================================================

export type Tier =
  | 'identity'
  | 'memory'
  | 'activity'
  | 'content'
  | 'social'
  | 'preferences'
  | 'routines'
  | 'health'
  | 'context'
  | 'knowledge'
  | 'brain'
  | 'overrides';

export interface ParamSpec {
  key: string;
  label: string;
  type: 'int' | 'float' | 'bool' | 'string' | 'enum';
  default: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  description?: string;
}

export interface AwarenessSignal {
  key: string;                 // dot-notation, globally unique
  tier: Tier;
  subcategory: string;         // group within the tier
  label: string;               // shown in admin UI
  description: string;         // one-sentence what this signal does
  default_on: boolean;
  locked?: boolean;            // cannot be turned off (mandatory)
  params?: ParamSpec[];        // optional tunable parameters
  enforcement_status?: 'live' | 'pending'; // pending = manifest-only, no code gate yet
  // VTID-02858: Operator-visible status of whether the signal actually
  // fires on production sessions (vs. enforcement_status above, which is
  // about whether the gate exists in code). Surfaced as a column in the
  // Voice / Awareness / Registry sub-tab so operators can scan "what's
  // still missing" at a glance. Backfilled incrementally; undefined =
  // unknown.
  wired?: 'live' | 'partial' | 'not_wired' | 'not_relevant';
}

export interface ResolvedSignal {
  enabled: boolean;
  params: Record<string, unknown>;
  source: 'override' | 'default';
}

export interface AwarenessConfigSnapshot {
  /** Resolved (manifest defaults + DB overrides) keyed by signal.key */
  resolved: Record<string, ResolvedSignal>;
  /** Raw overrides from the table (only the keys with rows) */
  overrides: Record<string, { enabled: boolean; params: Record<string, unknown> }>;
  /** ISO timestamp when this snapshot was built */
  built_at: string;
  /** Helper: is this signal enabled? */
  isEnabled(key: string): boolean;
  /** Helper: get a param value with fallback */
  getParam<T = unknown>(signalKey: string, paramKey: string, fallback: T): T;
}

// =============================================================================
// MANIFEST — every awareness signal in the system, organized by tier
// =============================================================================

const M: AwarenessSignal[] = [
  // ─── 1. IDENTITY (locked) ─────────────────────────────────────────────────
  { key: 'identity.user_id',    tier: 'identity', subcategory: 'Authenticated user', label: 'User ID',     description: 'JWT sub claim resolved into the active user_id.',         default_on: true, locked: true, wired: 'live' },
  { key: 'identity.tenant_id',  tier: 'identity', subcategory: 'Authenticated user', label: 'Tenant ID',   description: 'JWT app_metadata.active_tenant_id.',                       default_on: true, locked: true, wired: 'live' },
  // VTID-02858 wired-mapping: user's #1 (Authoritative role header) — live.
  { key: 'identity.active_role',tier: 'identity', subcategory: 'Authenticated user', label: 'Active role', description: 'community / professional / staff / admin / dev.',          default_on: true, locked: true, wired: 'live' },
  { key: 'identity.email',      tier: 'identity', subcategory: 'Authenticated user', label: 'Email',       description: 'Caller email from JWT (used for personalization).',        default_on: true, wired: 'live' },
  // VTID-02858 wired-mapping: user's #21 (Surface scoping) — live in tools layer.
  { key: 'identity.surface',    tier: 'identity', subcategory: 'Session surface',    label: 'Surface',     description: 'orb / operator / command-hub / cicd / api.',               default_on: true, locked: true, wired: 'live' },
  { key: 'identity.is_anonymous', tier: 'identity', subcategory: 'Session surface',  label: 'Anonymous flag', description: 'Emitted when no JWT — gates personal context entirely.', default_on: true, locked: true, wired: 'live' },

  // ─── 2. MEMORY ───────────────────────────────────────────────────────────
  { key: 'memory.items.enabled', tier: 'memory', subcategory: 'Memory Garden', label: 'Memory items', description: 'Inject ranked memory_items rows from the user\'s Memory Garden.', default_on: true, params: [
      { key: 'max_age_hours', label: 'Max age (hours)', type: 'int', default: 168, min: 1, max: 8760, step: 1 },
      { key: 'max_count',     label: 'Max items',       type: 'int', default: 50,  min: 1, max: 200,  step: 1 },
  ]},
  { key: 'memory.items.categories.personal_identity',     tier: 'memory', subcategory: 'Memory Garden categories', label: 'Personal identity',       description: 'Name, birthday, location facts.',                            default_on: true, locked: true },
  { key: 'memory.items.categories.health_wellness',       tier: 'memory', subcategory: 'Memory Garden categories', label: 'Health & wellness',       description: 'Sleep, stress, biomarker mentions.',                         default_on: true },
  { key: 'memory.items.categories.lifestyle_routines',    tier: 'memory', subcategory: 'Memory Garden categories', label: 'Lifestyle & routines',    description: 'Daily rhythms, schedule preferences.',                       default_on: true },
  { key: 'memory.items.categories.network_relationships', tier: 'memory', subcategory: 'Memory Garden categories', label: 'Network & relationships', description: 'Family, friends, colleagues.',                                default_on: true },
  { key: 'memory.items.categories.learning_knowledge',    tier: 'memory', subcategory: 'Memory Garden categories', label: 'Learning & knowledge',    description: 'Skills, education, reading.',                                default_on: true },
  { key: 'memory.items.categories.business_projects',     tier: 'memory', subcategory: 'Memory Garden categories', label: 'Business & projects',     description: 'Active work / tasks.',                                       default_on: true },
  { key: 'memory.items.categories.finance_assets',        tier: 'memory', subcategory: 'Memory Garden categories', label: 'Finance & assets',        description: 'Investments, products, services.',                            default_on: true },
  { key: 'memory.items.categories.location_environment',  tier: 'memory', subcategory: 'Memory Garden categories', label: 'Location & environment',  description: 'Home city, travel patterns.',                                default_on: true },
  { key: 'memory.items.categories.digital_footprint',     tier: 'memory', subcategory: 'Memory Garden categories', label: 'Digital footprint',       description: 'Online accounts, services used.',                            default_on: true },
  { key: 'memory.items.categories.values_aspirations',    tier: 'memory', subcategory: 'Memory Garden categories', label: 'Values & aspirations',    description: 'Goals, motivations.',                                        default_on: true },
  { key: 'memory.items.categories.autopilot_context',     tier: 'memory', subcategory: 'Memory Garden categories', label: 'Autopilot context',       description: 'Recommendations + auto actions context.',                    default_on: true },
  { key: 'memory.items.categories.future_plans',          tier: 'memory', subcategory: 'Memory Garden categories', label: 'Future plans',            description: 'Upcoming milestones.',                                       default_on: true },
  { key: 'memory.items.categories.uncategorized',         tier: 'memory', subcategory: 'Memory Garden categories', label: 'Uncategorized',           description: 'Conversation notes that did not match a category.',          default_on: true },

  // VTID-02858 wired-mapping: user's #11 (Memory facts) — live, also #23 (Vitana ID context lives here).
  { key: 'memory.facts.enabled',       tier: 'memory', subcategory: 'Memory Facts (VTID-01192)', label: 'Memory facts',                description: 'Inject high-confidence memory_facts (name, birthday, etc.).',  default_on: true, locked: true, wired: 'live', params: [
      { key: 'min_confidence', label: 'Minimum confidence', type: 'float', default: 0.7, min: 0, max: 1, step: 0.05 },
      { key: 'max_count',      label: 'Max facts in profile', type: 'int', default: 6, min: 1, max: 30, step: 1 },
  ]},
  { key: 'memory.facts.entity.self',     tier: 'memory', subcategory: 'Memory Facts (VTID-01192)', label: 'Self facts',     description: 'Facts about the user themselves.', default_on: true },
  { key: 'memory.facts.entity.disclosed',tier: 'memory', subcategory: 'Memory Facts (VTID-01192)', label: 'Disclosed facts',description: 'Facts the user disclosed about others (family, partner, friends).', default_on: true },

  // VTID-02858 wired-mapping: user's #10 (Last-10-turns conversation history) — partial; recent_turns inject is live but the 10-turn reconnect block is not.
  { key: 'memory.recent_turns.enabled', tier: 'memory', subcategory: 'Recent ORB turns', label: 'Recent ORB turns', description: 'Last N raw user utterances — answers "what did I just say?".', default_on: true, wired: 'partial', params: [
      { key: 'count', label: 'Turn count', type: 'int', default: 3, min: 1, max: 10, step: 1 },
  ]},

  { key: 'memory.relationships.nodes',   tier: 'memory', subcategory: 'Cognee relationship graph (VTID-01087)', label: 'Relationship nodes',   description: 'PERSON / LOCATION / ORG entities extracted from conversations.', default_on: true, enforcement_status: 'pending' },
  { key: 'memory.relationships.edges',   tier: 'memory', subcategory: 'Cognee relationship graph (VTID-01087)', label: 'Relationship edges',   description: 'knows / works_for / attends / following relations.',              default_on: true, enforcement_status: 'pending' },
  { key: 'memory.relationships.signals', tier: 'memory', subcategory: 'Cognee relationship graph (VTID-01087)', label: 'Relationship signals', description: 'Computed interaction signals from the graph.',                    default_on: true, enforcement_status: 'pending' },

  // ─── 3. ACTIVITY ─────────────────────────────────────────────────────────
  { key: 'activity.summary.enabled', tier: 'activity', subcategory: 'Counted summary', label: '[ACTIVITY_14D] block', description: 'One-line counted summary across the activity window.', default_on: true, params: [
      { key: 'window_days', label: 'Window (days)', type: 'enum', default: 14, options: ['14','30','90'] },
  ]},
  { key: 'activity.recent.enabled', tier: 'activity', subcategory: 'Recent actions', label: '[RECENT] block', description: 'Listed recent high-signal actions with relative times.', default_on: true, params: [
      { key: 'max_items',   label: 'Max items',     type: 'int', default: 8,  min: 1, max: 30,  step: 1 },
      { key: 'window_days', label: 'Window (days)', type: 'int', default: 14, min: 1, max: 180, step: 1 },
  ]},

  { key: 'activity.include.diary',             tier: 'activity', subcategory: 'High-signal categories', label: 'Diary',                  description: 'Include diary.* events in [RECENT].',          default_on: true },
  { key: 'activity.include.autopilot',         tier: 'activity', subcategory: 'High-signal categories', label: 'Autopilot',              description: 'Include autopilot.* events.',                  default_on: true },
  { key: 'activity.include.recommendation',    tier: 'activity', subcategory: 'High-signal categories', label: 'Recommendation',         description: 'Include recommendation.* events.',             default_on: true },
  { key: 'activity.include.task',              tier: 'activity', subcategory: 'High-signal categories', label: 'Task',                   description: 'Include task.* events.',                       default_on: true },
  { key: 'activity.include.calendar',          tier: 'activity', subcategory: 'High-signal categories', label: 'Calendar',               description: 'Include calendar.* events.',                   default_on: true },
  { key: 'activity.include.community',         tier: 'activity', subcategory: 'High-signal categories', label: 'Community',              description: 'Include community.* events (groups, events, live rooms).', default_on: true },
  { key: 'activity.include.wallet',            tier: 'activity', subcategory: 'High-signal categories', label: 'Wallet',                 description: 'Include wallet.* events.',                     default_on: true },
  { key: 'activity.include.memory',            tier: 'activity', subcategory: 'High-signal categories', label: 'Memory',                 description: 'Include memory.* events (create/update/promote).', default_on: true },
  { key: 'activity.include.profile',           tier: 'activity', subcategory: 'High-signal categories', label: 'Profile',                description: 'Include profile.update events.',               default_on: true },
  { key: 'activity.include.discover_bookmark', tier: 'activity', subcategory: 'High-signal categories', label: 'Discover: bookmarks',    description: 'Include discover.service.bookmark events.',    default_on: true },
  { key: 'activity.include.discover_offer',    tier: 'activity', subcategory: 'High-signal categories', label: 'Discover: offer views',  description: 'Include discover.offer.view events.',          default_on: true },
  { key: 'activity.include.media',             tier: 'activity', subcategory: 'High-signal categories', label: 'Media plays',            description: 'Include media.* (music, podcasts, shorts) events.', default_on: true },

  { key: 'activity.nav.include_page_view',   tier: 'activity', subcategory: 'Navigation handling', label: 'Include page views in [RECENT]', description: 'Off by default — too noisy.',                          default_on: false },
  { key: 'activity.nav.include_auth',        tier: 'activity', subcategory: 'Navigation handling', label: 'Include auth events in [RECENT]', description: 'Off by default — login/logout is rarely interesting.', default_on: false },
  { key: 'activity.nav.collapsed_summary',   tier: 'activity', subcategory: 'Navigation handling', label: 'Collapsed nav summary',           description: 'Emit "76 navigation events, areas: X, Y, Z" in [RECENT].', default_on: true },

  // ─── 4. CONTENT CONSUMPTION ──────────────────────────────────────────────
  { key: 'content.music.enabled',         tier: 'content', subcategory: 'Music',           label: '[CONTENT_PLAYED] music',  description: 'Render songs the user played in [CONTENT_PLAYED].', default_on: true },
  { key: 'content.music.include_query',   tier: 'content', subcategory: 'Music',           label: 'Include query',           description: 'What the user asked for ("play XYZ").', default_on: true },
  { key: 'content.music.include_title',   tier: 'content', subcategory: 'Music',           label: 'Include title',           description: 'Resolved track title.',                  default_on: true },
  { key: 'content.music.include_channel', tier: 'content', subcategory: 'Music',           label: 'Include artist/channel',  description: 'Artist or YouTube channel.',             default_on: true },
  { key: 'content.music.include_source',  tier: 'content', subcategory: 'Music',           label: 'Include source',          description: 'YouTube Music / Spotify / Apple Music / Vitana Hub.', default_on: true },
  { key: 'content.podcast.enabled',       tier: 'content', subcategory: 'Podcasts',        label: '[CONTENT_PLAYED] podcasts', description: 'Pending — ORB podcast tool not yet shipped.', default_on: true, enforcement_status: 'pending' },
  { key: 'content.podcast.include_title', tier: 'content', subcategory: 'Podcasts',        label: 'Include podcast title',   description: 'Pending.', default_on: true, enforcement_status: 'pending' },
  { key: 'content.shorts.enabled',        tier: 'content', subcategory: 'Shorts / video',  label: '[CONTENT_PLAYED] shorts', description: 'Pending — frontend instrumentation.', default_on: true, enforcement_status: 'pending' },
  { key: 'content.video.enabled',         tier: 'content', subcategory: 'Shorts / video',  label: '[CONTENT_PLAYED] videos', description: 'Pending — frontend instrumentation.', default_on: true, enforcement_status: 'pending' },
  { key: 'content.community.posts_read',     tier: 'content', subcategory: 'Community content', label: 'Posts read',     description: 'Pending — needs scroll/dwell tracking.', default_on: false, enforcement_status: 'pending' },
  { key: 'content.community.articles_read',  tier: 'content', subcategory: 'Community content', label: 'Articles read',  description: 'Pending — needs read detection.',       default_on: false, enforcement_status: 'pending' },
  { key: 'content.section.max_items',     tier: 'content', subcategory: 'Section render',  label: 'Max items',               description: 'Cap on [CONTENT_PLAYED] line count.', default_on: true, params: [
      { key: 'value', label: 'Max items', type: 'int', default: 8, min: 1, max: 30, step: 1 },
  ]},
  { key: 'content.section.window_days',   tier: 'content', subcategory: 'Section render',  label: 'Window (days)',           description: 'How far back to look for content plays.', default_on: true, params: [
      { key: 'value', label: 'Days', type: 'int', default: 14, min: 1, max: 90, step: 1 },
  ]},

  // ─── 5. SOCIAL GRAPH ─────────────────────────────────────────────────────
  { key: 'social.section.enabled', tier: 'social', subcategory: 'Section render', label: '[NETWORK] block', description: 'Master toggle for the entire [NETWORK] section.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'max_chars',           label: 'Max chars in [NETWORK]', type: 'int',  default: 600, min: 100, max: 2000, step: 50 },
      { key: 'anonymize_names',     label: 'Anonymize names (initials)',   type: 'bool', default: false },
      { key: 'include_counts_only', label: 'Counts only (no names)',       type: 'bool', default: false },
  ]},
  { key: 'social.follows.enabled',          tier: 'social', subcategory: 'Follow graph', label: 'Follow stats',         description: 'Following / followers / mutuals counts + top N.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'outgoing_top_n',  label: 'Top N following', type: 'int', default: 5, min: 0, max: 20, step: 1 },
      { key: 'followers_top_n', label: 'Top N followers', type: 'int', default: 5, min: 0, max: 20, step: 1 },
      { key: 'mutuals_top_n',   label: 'Top N mutuals',   type: 'int', default: 5, min: 0, max: 20, step: 1 },
  ]},
  { key: 'social.follows.recently_added',   tier: 'social', subcategory: 'Follow graph', label: 'Recently added follows',   description: 'Last N follows (trend signal).',     default_on: true, enforcement_status: 'pending' },
  { key: 'social.follows.recently_removed', tier: 'social', subcategory: 'Follow graph', label: 'Recently removed follows', description: 'Last N unfollows (dampening signal).',default_on: true, enforcement_status: 'pending' },

  { key: 'social.dm.enabled', tier: 'social', subcategory: 'Direct messaging', label: 'DM partners', description: 'Top chat partners by message volume.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'top_partners_n',     label: 'Top N partners',  type: 'int', default: 5,  min: 1, max: 20, step: 1 },
      { key: 'volume_window_days', label: 'Window (days)',  type: 'int', default: 30, min: 1, max: 180, step: 1 },
  ]},
  { key: 'social.dm.last_contacted',  tier: 'social', subcategory: 'Direct messaging', label: 'Last contacted',   description: 'Most recent DM recipient + relative time.', default_on: true, enforcement_status: 'pending' },
  { key: 'social.dm.cadence_summary', tier: 'social', subcategory: 'Direct messaging', label: 'Cadence summary',  description: '"chats daily with X, weekly with Y".',      default_on: true, enforcement_status: 'pending' },

  { key: 'social.groups.enabled',         tier: 'social', subcategory: 'Groups & spaces', label: 'Groups joined',      description: 'Top N groups the user is a member of.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'top_n', label: 'Top N groups', type: 'int', default: 5, min: 1, max: 20, step: 1 },
  ]},
  { key: 'social.groups.created_by_user', tier: 'social', subcategory: 'Groups & spaces', label: 'Groups created/hosted', description: 'Groups where the user is host.',        default_on: true, enforcement_status: 'pending' },

  { key: 'social.live_rooms.enabled',       tier: 'social', subcategory: 'Live rooms & events', label: 'Live rooms attended', description: 'Recent live_room_attendance rows.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'recent_n', label: 'Recent N', type: 'int', default: 5, min: 1, max: 20, step: 1 },
  ]},
  { key: 'social.live_rooms.cohost_history',tier: 'social', subcategory: 'Live rooms & events', label: 'Co-host history',     description: 'Co-host invites accepted/declined.', default_on: true, enforcement_status: 'pending' },
  { key: 'social.events.enabled',           tier: 'social', subcategory: 'Live rooms & events', label: 'Events RSVPd',        description: 'Events the user has RSVPd to.',      default_on: true, enforcement_status: 'pending', params: [
      { key: 'top_n', label: 'Top N events', type: 'int', default: 5, min: 1, max: 20, step: 1 },
  ]},

  { key: 'social.profile_views.enabled',     tier: 'social', subcategory: 'Profile views', label: 'Profiles viewed', description: 'Recent community.profile.view events.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'recent_n', label: 'Recent N', type: 'int', default: 8, min: 1, max: 30, step: 1 },
  ]},
  { key: 'social.profile_views.role_pattern',tier: 'social', subcategory: 'Profile views', label: 'Role pattern',     description: '"mostly viewed: coaches / professionals / community".', default_on: true, enforcement_status: 'pending' },

  { key: 'social.search.enabled',                tier: 'social', subcategory: 'Search intent (who is the user looking for)', label: 'Search intent',           description: 'Recent member-search queries.',      default_on: true, enforcement_status: 'pending', params: [
      { key: 'recent_queries_n', label: 'Recent queries', type: 'int', default: 5, min: 1, max: 20, step: 1 },
  ]},
  { key: 'social.search.top_terms',              tier: 'social', subcategory: 'Search intent (who is the user looking for)', label: 'Top search terms',         description: '"coach", "nutritionist", "personal trainer".', default_on: true, enforcement_status: 'pending' },
  { key: 'social.search.inferred_looking_for',   tier: 'social', subcategory: 'Search intent (who is the user looking for)', label: 'Inferred "looking for"',   description: '"Looking for: movement coaches, nutritionists".', default_on: true, enforcement_status: 'pending' },

  { key: 'social.matches.enabled',             tier: 'social', subcategory: 'Matchmaking (people-matches)', label: 'People matches',           description: 'Recent matches_daily rows + accept/dismiss counts.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'recent_matches_n', label: 'Recent N', type: 'int', default: 5, min: 1, max: 20, step: 1 },
  ]},
  { key: 'social.matches.include_blocklist_signal', tier: 'social', subcategory: 'Matchmaking (people-matches)', label: 'Include blocklist signal', description: 'SENSITIVE — exposes who user blocked.',                default_on: false, locked: true, enforcement_status: 'pending' },
  { key: 'social.matches.include_dampened',         tier: 'social', subcategory: 'Matchmaking (people-matches)', label: 'Include dampened',         description: 'user_dampening — 7-day "don\'t show again" entries.',  default_on: false, enforcement_status: 'pending' },

  { key: 'social.topics.enabled', tier: 'social', subcategory: 'Topic affinity', label: 'Topic profile', description: 'user_topic_profile — top topics by score.', default_on: true, enforcement_status: 'pending', params: [
      { key: 'top_n',     label: 'Top N',           type: 'int', default: 8,  min: 1, max: 30,  step: 1 },
      { key: 'min_score', label: 'Minimum score',   type: 'int', default: 30, min: 0, max: 100, step: 5 },
  ]},
  { key: 'social.topics.source.system',   tier: 'social', subcategory: 'Topic affinity sources', label: 'System-derived topics',   description: 'Topics derived by the system.',                default_on: true, enforcement_status: 'pending' },
  { key: 'social.topics.source.explicit', tier: 'social', subcategory: 'Topic affinity sources', label: 'Explicit topics',         description: 'User-stated topic preferences.',               default_on: true, enforcement_status: 'pending' },
  { key: 'social.topics.source.feedback', tier: 'social', subcategory: 'Topic affinity sources', label: 'Feedback-derived topics', description: 'From match like/dismiss feedback.',           default_on: true, enforcement_status: 'pending' },
  { key: 'social.topics.source.inferred', tier: 'social', subcategory: 'Topic affinity sources', label: 'Inferred topics',         description: 'Inferred from behavior.',                      default_on: true, enforcement_status: 'pending' },

  { key: 'social.signals.enabled', tier: 'social', subcategory: 'Inferred social signals', label: 'Inferred signals', description: 'relationship_signals (close_to_X, leader_in_Y).', default_on: true, enforcement_status: 'pending', params: [
      { key: 'min_confidence', label: 'Minimum confidence', type: 'float', default: 0.6, min: 0, max: 1, step: 0.05 },
      { key: 'max_n',          label: 'Max signals',         type: 'int',   default: 6, min: 1, max: 20, step: 1 },
  ]},

  // ─── 6. PREFERENCES ──────────────────────────────────────────────────────
  { key: 'preferences.explicit.enabled', tier: 'preferences', subcategory: 'Explicit preferences (user_preferences)', label: 'Explicit preferences', description: 'Inject [PREFERENCES] from user_preferences table.', default_on: true },
  { key: 'preferences.inferred.enabled', tier: 'preferences', subcategory: 'Inferred preferences (user_inferred_preferences)', label: 'Inferred preferences', description: 'Inject from user_inferred_preferences table.', default_on: true, params: [
      { key: 'min_confidence', label: 'Minimum confidence', type: 'float', default: 0.55, min: 0, max: 1, step: 0.05 },
  ]},
  { key: 'preferences.capability.music',    tier: 'preferences', subcategory: 'Capability defaults (VTID-01942)', label: 'Music default connector',    description: 'Whether to expose user\'s default music provider.',    default_on: true, enforcement_status: 'pending' },
  { key: 'preferences.capability.email',    tier: 'preferences', subcategory: 'Capability defaults (VTID-01942)', label: 'Email default connector',    description: 'Whether to expose user\'s default email provider.',    default_on: true, enforcement_status: 'pending' },
  { key: 'preferences.capability.calendar', tier: 'preferences', subcategory: 'Capability defaults (VTID-01942)', label: 'Calendar default connector', description: 'Whether to expose user\'s default calendar provider.', default_on: true, enforcement_status: 'pending' },
  { key: 'preferences.dedupe_by_key',       tier: 'preferences', subcategory: 'Render', label: 'Dedupe by key', description: 'Collapse duplicate explicit + inferred entries.', default_on: true },

  // ─── 7. ROUTINES ─────────────────────────────────────────────────────────
  { key: 'routines.enabled', tier: 'routines', subcategory: 'Section render', label: '[ROUTINES] block', description: 'Inject pattern-extracted routines from user_routines (VTID-01936).', default_on: true, params: [
      { key: 'min_confidence', label: 'Minimum confidence', type: 'float', default: 0.5, min: 0, max: 1, step: 0.05 },
      { key: 'max_items',      label: 'Max items',           type: 'int',   default: 5, min: 1, max: 20, step: 1 },
  ]},
  { key: 'routines.kind.time_of_day_preference', tier: 'routines', subcategory: 'Routine kinds', label: 'Time-of-day preference', description: 'morning / afternoon / evening rhythms.',   default_on: true },
  { key: 'routines.kind.day_of_week_rhythm',     tier: 'routines', subcategory: 'Routine kinds', label: 'Day-of-week rhythm',     description: '"diary on Sundays" type patterns.',         default_on: true },
  { key: 'routines.kind.category_affinity',      tier: 'routines', subcategory: 'Routine kinds', label: 'Category affinity',      description: 'Higher engagement with specific categories.', default_on: true },
  { key: 'routines.kind.wave_velocity',          tier: 'routines', subcategory: 'Routine kinds', label: 'Wave velocity',          description: '90-day wave progression speed.',             default_on: true },
  { key: 'routines.kind.completion_streak',      tier: 'routines', subcategory: 'Routine kinds', label: 'Completion streak',      description: 'N-day streak in a category.',                 default_on: true },
  { key: 'routines.fallback_time_of_day',        tier: 'routines', subcategory: 'Fallback', label: 'Compute time-of-day from activity', description: 'If no routines exist, derive from activity log.', default_on: true },

  // ─── 8. HEALTH ───────────────────────────────────────────────────────────
  { key: 'health.enabled', tier: 'health', subcategory: 'Section render', label: '[HEALTH] block', description: 'Inject health summary section.', default_on: true, params: [
      { key: 'window_days', label: 'Window (days)', type: 'int', default: 14, min: 1, max: 90, step: 1 },
  ]},
  { key: 'health.vitana_index.score',       tier: 'health', subcategory: 'Vitana Index (VTID-01103)', label: 'Index score + tier',       description: 'Latest Vitana Index total (0-999) + tier band (Starting / Early / Building / Strong / Really good / Elite).', default_on: true },
  { key: 'health.vitana_index.sub_scores',  tier: 'health', subcategory: 'Vitana Index (VTID-01103)', label: '5 pillars breakdown',      description: 'Nutrition / Hydration / Exercise / Sleep / Mental — each 0-200 — plus weakest and strongest pillar annotations, sub-score breakdown (baseline / completions / connected data / streak), and balance_factor (0.7-1.0).', default_on: true },
  { key: 'health.vitana_index.deltas',      tier: 'health', subcategory: 'Vitana Index (VTID-01103)', label: 'Trend + last movement',    description: '7-day trend and most recent index.recomputed event (which pillar moved, by how much, what triggered it).', default_on: true },
  { key: 'health.vitana_index.goal_gap',    tier: 'health', subcategory: 'Vitana Index (VTID-01103)', label: 'Aspirational tier distance', description: 'Aspirational distance to the next tier (Strong/Really good/Elite). Framed as "on pace to land in [tier] by Day 90", never as a pass/fail gate.', default_on: true },
  { key: 'health.biomarker.upload_count',  tier: 'health', subcategory: 'Biomarkers',                 label: 'Upload count',    description: 'Recent biomarker uploads (count).',  default_on: true },
  { key: 'health.biomarker.recent_tests',  tier: 'health', subcategory: 'Biomarkers',                 label: 'Recent tests',    description: 'Names of recent tests.',             default_on: true, enforcement_status: 'pending' },
  { key: 'health.supplement.add_count',    tier: 'health', subcategory: 'Supplements',                label: 'Adds count',      description: 'Recent supplement additions.',       default_on: true },
  { key: 'health.supplement.current_list', tier: 'health', subcategory: 'Supplements',                label: 'Current list',    description: 'Active supplements.',                default_on: true, enforcement_status: 'pending' },
  { key: 'health.lab_report.upload_count', tier: 'health', subcategory: 'Lab reports',                label: 'Upload count',    description: 'Recent lab report uploads.',          default_on: true, enforcement_status: 'pending' },
  { key: 'health.omics.upload_count',      tier: 'health', subcategory: 'Omics',                      label: 'Upload count',    description: 'Recent omics uploads.',              default_on: true, enforcement_status: 'pending' },

  // ─── 9. SESSION CONTEXT ──────────────────────────────────────────────────
  // VTID-02858 wired-mapping: user's #7 (Temporal/journey context) — live for current_route + recent_routes ring.
  { key: 'context.current_route',  tier: 'context', subcategory: 'Navigation', label: 'currentRoute', description: 'URL path the user is on right now.', default_on: true, wired: 'live' },
  { key: 'context.selected_id',    tier: 'context', subcategory: 'Navigation', label: 'selectedId',   description: 'Specific entity the user has open.',   default_on: true, wired: 'live' },
  { key: 'context.recent_routes',  tier: 'context', subcategory: 'Navigation', label: 'recentRoutes', description: 'Last N pages visited this session.', default_on: true, wired: 'live', params: [
      { key: 'count', label: 'Routes count', type: 'int', default: 5, min: 1, max: 20, step: 1 },
  ]},
  // VTID-02858 wired-mapping: user's #24 (ENVIRONMENT CONTEXT geo + time) — just shipped.
  { key: 'context.client.city',           tier: 'context', subcategory: 'Client context (IP + device)', label: 'City',          description: 'IP geo city.',          default_on: true, wired: 'live' },
  { key: 'context.client.country',        tier: 'context', subcategory: 'Client context (IP + device)', label: 'Country',       description: 'IP geo country.',       default_on: true, wired: 'live' },
  { key: 'context.client.timezone',       tier: 'context', subcategory: 'Client context (IP + device)', label: 'Timezone',      description: 'User timezone.',         default_on: true, wired: 'live' },
  { key: 'context.client.time_of_day',    tier: 'context', subcategory: 'Client context (IP + device)', label: 'Time of day',   description: 'morning / midday / afternoon / evening / night.', default_on: true, wired: 'live' },
  { key: 'context.client.device',         tier: 'context', subcategory: 'Client context (IP + device)', label: 'Device',        description: 'iOS / Android / Desktop / Appilix WebView.', default_on: true, wired: 'live' },
  { key: 'context.client.browser',        tier: 'context', subcategory: 'Client context (IP + device)', label: 'Browser',       description: 'Browser identifier.',   default_on: true, wired: 'live' },
  { key: 'context.client.accept_language',tier: 'context', subcategory: 'Client context (IP + device)', label: 'Accept-Language',description: 'Browser-preferred language.', default_on: true, wired: 'live' },
  { key: 'context.last_session_info',     tier: 'context', subcategory: 'Session continuity',           label: 'Last session info', description: 'When the user was last in voice + whether it failed.', default_on: true, wired: 'partial' },
  // VTID-02858 wired-mapping: user's #8 (Conversation Summary) — not_wired (returns null).
  // VTID-02899: deferred-by-design — marked enforcement_status: 'pending'
  // so the Voice Improve briefing doesn't surface this as an urgent action
  // item. Wired badge in the Registry still shows ✗ (status reflects reality).
  { key: 'context.conversation_summary',  tier: 'context', subcategory: 'Session continuity',           label: 'Conversation summary', description: 'Returning-user bridge summary text.', default_on: true, wired: 'not_wired', enforcement_status: 'pending' },
  // VTID-02858 wired-mapping: user's #10 (Last-10-turns conversation history) — not_wired.
  // VTID-02899: deferred-by-design (see above).
  { key: 'context.conversation_history',  tier: 'context', subcategory: 'Session continuity',           label: 'Conversation history (reconnect)', description: 'Last N turns when reconnecting.', default_on: true, wired: 'not_wired', enforcement_status: 'pending', params: [
      { key: 'max_turns', label: 'Max turns', type: 'int', default: 10, min: 1, max: 50, step: 1 },
  ]},
  { key: 'context.journey_stage',         tier: 'context', subcategory: 'Session continuity',           label: 'Journey stage', description: '90-day wave / wave_name / day_number.', default_on: true, wired: 'live' },

  // ─── 10. KNOWLEDGE & SYSTEM ──────────────────────────────────────────────
  // VTID-02858 wired-mapping: user's #9 (Bootstrap context block) — partial: facts + pillars + memory items shipped, Knowledge Hub items still missing.
  { key: 'knowledge.hub.enabled', tier: 'knowledge', subcategory: 'Knowledge Hub (retrieval router)', label: 'Knowledge Hub', description: 'Master toggle for knowledge retrieval.', default_on: true, wired: 'partial', params: [
      { key: 'max_items', label: 'Max items', type: 'int', default: 8, min: 1, max: 30, step: 1 },
  ]},
  { key: 'knowledge.ns.vitana_system',     tier: 'knowledge', subcategory: 'Namespaces (retrieval-router)', label: 'vitana_system (priority 100)',     description: 'Platform docs & how-to.', default_on: true, locked: true },
  { key: 'knowledge.ns.personal_history',  tier: 'knowledge', subcategory: 'Namespaces (retrieval-router)', label: 'personal_history (priority 90)',   description: '"remember", "my name", "told you" routing.', default_on: true },
  { key: 'knowledge.ns.health_personal',   tier: 'knowledge', subcategory: 'Namespaces (retrieval-router)', label: 'health_personal (priority 85)',     description: 'Personal health questions.', default_on: true },
  { key: 'knowledge.ns.external_current',  tier: 'knowledge', subcategory: 'Namespaces (retrieval-router)', label: 'external_current (priority 80)',   description: 'News / weather / stock.', default_on: true },
  { key: 'knowledge.ns.general_knowledge', tier: 'knowledge', subcategory: 'Namespaces (retrieval-router)', label: 'general_knowledge (priority 50)',   description: '"what is" / "how to".', default_on: true },
  { key: 'knowledge.web_search.enabled',   tier: 'knowledge', subcategory: 'Web search', label: 'Google Search grounding', description: 'Route to google_search tool for current events.', default_on: true, params: [
      { key: 'max_items', label: 'Max items', type: 'int', default: 6, min: 1, max: 20, step: 1 },
  ]},
  { key: 'knowledge.calendar.today_events',    tier: 'knowledge', subcategory: 'Calendar', label: "Today's events",      description: 'Inject today\'s calendar events.',        default_on: true },
  { key: 'knowledge.calendar.upcoming_events', tier: 'knowledge', subcategory: 'Calendar', label: 'Upcoming events',     description: 'Inject upcoming events list.',            default_on: true },
  { key: 'knowledge.calendar.free_slots',      tier: 'knowledge', subcategory: 'Calendar', label: 'Free time slots',     description: 'Inject free slots between meetings.',     default_on: true },

  // ─── 11. BRAIN / PROACTIVE ───────────────────────────────────────────────
  { key: 'brain.awareness.tenure',            tier: 'brain', subcategory: 'User Awareness block', label: 'Tenure stage',         description: 'day0 / early / returning.',          default_on: true, enforcement_status: 'pending' },
  { key: 'brain.awareness.last_interaction',  tier: 'brain', subcategory: 'User Awareness block', label: 'Last interaction',     description: 'When user was last in any surface.',default_on: true, enforcement_status: 'pending' },
  { key: 'brain.awareness.journey',           tier: 'brain', subcategory: 'User Awareness block', label: 'Journey wave',         description: 'Current 90-day wave.',              default_on: true, enforcement_status: 'pending' },
  { key: 'brain.awareness.goal',              tier: 'brain', subcategory: 'User Awareness block', label: 'Active goal',          description: 'Active Life Compass goal.',         default_on: true, enforcement_status: 'pending' },
  { key: 'brain.awareness.motivation_signal', tier: 'brain', subcategory: 'User Awareness block', label: 'Motivation signal',    description: 'absent / low / present.',           default_on: true, enforcement_status: 'pending' },
  // VTID-02858 wired-mapping: user's #16 (Proactive Opener Override matrix) — not_wired.
  { key: 'brain.opener.enabled',              tier: 'brain', subcategory: 'Proactive opener',    label: 'Proactive opener',     description: 'Suggest opener from shape matrix.',  default_on: true, enforcement_status: 'pending', wired: 'not_wired' },
  { key: 'brain.opener.forbidden_phrases',    tier: 'brain', subcategory: 'Proactive opener',    label: 'Forbidden openings',   description: '"What can I do for you?" override.',default_on: true, enforcement_status: 'pending', wired: 'not_wired' },
  { key: 'brain.retrieval_router.enabled',    tier: 'brain', subcategory: 'Retrieval router',    label: 'Retrieval router',     description: 'Router-based retrieval rules.',     default_on: true, enforcement_status: 'pending' },

  // ─── 12. OVERRIDES (high-priority, append-last blocks) ───────────────────
  // VTID-02858 wired-mapping: user's #16 (Proactive Opener Override matrix) — not_wired.
  // VTID-02899: deferred-by-design — enforcement_status: 'pending' excludes
  // from Voice Improve briefing as actionable; Registry still shows ✗.
  { key: 'overrides.proactive_opener',    tier: 'overrides', subcategory: 'High-priority overrides', label: 'PROACTIVE OPENER OVERRIDE', description: 'VTID-01927 — appended after temporal journey to override greeting reflexes.', default_on: true, wired: 'not_wired', enforcement_status: 'pending' },
  // VTID-02858 wired-mapping: user's #17 (Activity awareness override) — not_wired.
  // VTID-02899: deferred-by-design (see above).
  { key: 'overrides.activity_awareness',  tier: 'overrides', subcategory: 'High-priority overrides', label: 'ACTIVITY AWARENESS OVERRIDE', description: 'BOOTSTRAP-HISTORY-AWARE-TIMELINE — re-asserts USER CONTEXT PROFILE at end of prompt with hard rules.', default_on: true, wired: 'not_wired', enforcement_status: 'pending' },
  // VTID-02858 wired-mapping: user's #6 (Navigator policy section) — partial (gates wired, prose section missing).
  { key: 'overrides.navigator_policy',    tier: 'overrides', subcategory: 'High-priority overrides', label: 'Navigator policy',           description: 'Navigator tool routing rules section.', default_on: true, enforcement_status: 'pending', wired: 'partial' },
  // VTID-02858 wired-mapping: user's #7 (Temporal/journey context) — live.
  { key: 'overrides.temporal_journey',    tier: 'overrides', subcategory: 'High-priority overrides', label: 'Temporal + journey context', description: 'Time-of-day greeting + 90-day journey stage.', default_on: true, enforcement_status: 'pending', wired: 'live' },
];

// =============================================================================
// Public — manifest accessors
// =============================================================================

export function getManifest(): readonly AwarenessSignal[] {
  return M;
}

export function getSignal(key: string): AwarenessSignal | undefined {
  return M.find(s => s.key === key);
}

// =============================================================================
// Config snapshot — merges manifest + DB overrides, cached
// =============================================================================

const CACHE_TTL_MS = 60_000;
let cached: { snap: AwarenessConfigSnapshot; expiresAt: number } | null = null;
let inflight: Promise<AwarenessConfigSnapshot> | null = null;

function serviceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

function buildSnapshot(overrides: Record<string, { enabled: boolean; params: Record<string, unknown> }>): AwarenessConfigSnapshot {
  const resolved: Record<string, ResolvedSignal> = {};

  for (const sig of M) {
    const override = overrides[sig.key];
    const defaultParams: Record<string, unknown> = {};
    for (const p of sig.params || []) {
      defaultParams[p.key] = p.default;
    }
    if (override) {
      // Locked signals cannot be turned off — force enabled regardless of override.
      const enabled = sig.locked ? sig.default_on : override.enabled;
      resolved[sig.key] = {
        enabled,
        params: { ...defaultParams, ...(override.params || {}) },
        source: 'override',
      };
    } else {
      resolved[sig.key] = {
        enabled: sig.default_on,
        params: defaultParams,
        source: 'default',
      };
    }
  }

  return {
    resolved,
    overrides,
    built_at: new Date().toISOString(),
    isEnabled(key: string): boolean {
      const r = resolved[key];
      if (r) return r.enabled;
      // Unknown key → treat as enabled (don't break callers when manifest is ahead/behind).
      console.warn(`[AwarenessRegistry] isEnabled called with unknown key: ${key}`);
      return true;
    },
    getParam<T>(signalKey: string, paramKey: string, fallback: T): T {
      const r = resolved[signalKey];
      if (!r) return fallback;
      const v = r.params[paramKey];
      return (v === undefined || v === null) ? fallback : (v as T);
    },
  };
}

async function fetchOverrides(): Promise<Record<string, { enabled: boolean; params: Record<string, unknown> }>> {
  const client = serviceClient();
  if (!client) return {};
  const { data, error } = await client
    .from('awareness_config')
    .select('key, enabled, params');
  if (error) {
    // table missing pre-migration is normal — log once and continue.
    if (!/relation .*awareness_config.* does not exist/i.test(error.message)) {
      console.warn(`[AwarenessRegistry] fetchOverrides failed: ${error.message}`);
    }
    return {};
  }
  const out: Record<string, { enabled: boolean; params: Record<string, unknown> }> = {};
  for (const row of (data || []) as any[]) {
    out[row.key] = { enabled: !!row.enabled, params: (row.params as Record<string, unknown>) || {} };
  }
  return out;
}

/**
 * Returns the current effective awareness configuration. Cached for 60s.
 */
export async function getAwarenessConfig(): Promise<AwarenessConfigSnapshot> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.snap;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const overrides = await fetchOverrides();
      const snap = buildSnapshot(overrides);
      cached = { snap, expiresAt: Date.now() + CACHE_TTL_MS };
      return snap;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Drop the cache. Called by the admin write endpoint after a save so the next
 * read sees fresh values immediately.
 */
export function invalidateAwarenessConfigCache(): void {
  cached = null;
}

/**
 * Synchronous helper for code paths where awaiting isn't possible. Returns
 * a snapshot built from manifest defaults only when no cache is warm.
 */
export function getAwarenessConfigSync(): AwarenessConfigSnapshot {
  if (cached && cached.expiresAt > Date.now()) return cached.snap;
  return buildSnapshot({});
}
