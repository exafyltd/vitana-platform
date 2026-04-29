/**
 * VTID-02026 — Phase 6a — Memory Broker (Layer 1 semantic API).
 *
 * The unified read API for memory. Every consumer (orb-live, conversation,
 * autopilot, brain prompt assembly, …) eventually calls
 * `getMemoryContext(input)` and gets back a typed `MemoryPack`. No consumer
 * touches the underlying tables directly.
 *
 * Phase 6a scope (this file): IDENTITY, EPISODIC, SEMANTIC blocks routed
 * by 3 intents (recall_recent, recall_history, identity). Six additional
 * blocks (DIARY, BIOMETRICS, LOCATION, DEVICE, NETWORK + extra intents)
 * land in 6b. Wiring into context-pack-builder + retrieval-router lands
 * in 6c.
 *
 * Plan reference:
 *   /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
 *   Part 6 — Layer 1 Semantic API
 */

import { getSupabase } from '../lib/supabase';
import { getSystemControl } from './system-controls-service';

const VTID = 'VTID-02026';
const POLICY_VERSION = 'mem-2026.04';

// =============================================================================
// Public types — match Part 6 of the plan
// =============================================================================

export type MemoryIntent =
  | 'recall_recent'        // "what did I just ask?" — Tier 0 + last 24h episodic
  | 'recall_history'       // "you said last week..." — episodic + bi-temporal facts
  | 'identity'             // who is this user — semantic + governance
  | 'plan_next_action'     // for autopilot ranker — full multi-stream
  | 'open_session'         // ORB cold-start — agent profile + recent + Index + goal
  | 'health_query'         // pillar-specific — trajectory + pillar agent outputs + KB
  | 'index_status'         // "what's my Index?" — trajectory current view
  | 'goal_check'           // "am I on track?" — Life Compass + projection
  | 'social_query'         // "who do I know who…" — relationship graph
  | 'community_intent'     // RSVP, group join — community + dismissals
  | 'system_introspect';   // dev/admin "why did Vitana do X?" — OASIS + audit

export type MemoryBlockKind =
  | 'WORKING'
  | 'EPISODIC'
  | 'SEMANTIC'
  | 'PROCEDURAL'
  | 'TRAJECTORY'
  | 'GOVERNANCE'
  | 'PROGRESSION'
  | 'SOCIAL'
  | 'SYSTEM'
  | 'DIARY'
  | 'BIOMETRICS'
  | 'LOCATION'
  | 'DEVICE'
  | 'NETWORK'
  | 'IDENTITY';

export type ChannelKind =
  | 'orb-live'
  | 'conversation'
  | 'autopilot'
  | 'guide'
  | 'calendar'
  | 'compass'
  | 'brief'
  | 'admin';

export type RoleKind = 'community' | 'developer' | 'admin';

export interface ContextLens {
  tenant_id: string;
  user_id: string;
  workspace_scope?: 'product' | 'dev';
  active_role?: string;
  visibility_scope?: 'private' | 'shared' | 'public';
  max_age_hours?: number;
}

export interface MemoryReadInput {
  tenant_id: string;
  user_id: string;
  intent: MemoryIntent;
  channel?: ChannelKind;
  role?: RoleKind;
  latency_budget_ms?: number;
  required_blocks?: MemoryBlockKind[];
  // Lens overrides — most callers leave this empty
  lens?: Partial<ContextLens>;
  ui_context?: { surface?: string; weakest_pillar?: string; active_goal_category?: string };
  // Phase 6b: when present, EPISODIC switches from recency-order to
  // semantic-rank using mem_episodes_semantic_search (cosine + recency
  // boost combined_score). Empty/short query falls back to recency.
  query?: string;
}

export interface IdentityBlock {
  kind: 'IDENTITY';
  user_id: string;
  tenant_id: string;
  // canonical fields read from app_users (NEVER from memory_facts — Identity
  // Lock invariant per VTID-01952)
  first_name: string | null;
  last_name: string | null;
  full_name: string | null;
  preferred_name: string | null;
  email: string | null;
  date_of_birth: string | null;
  gender: string | null;
  pronouns: string | null;
  locale: string | null;
  vitana_id: string | null;
  source: 'app_users';
  asserted_at: string;
}

export interface EpisodicHit {
  id: string;
  kind: string;
  content: string;
  category_key: string | null;
  source: string | null;
  importance: number;
  occurred_at: string;
  actor_id: string;
  conversation_id: string | null;
}

export interface EpisodicBlock {
  kind: 'EPISODIC';
  hits: EpisodicHit[];
  source: 'mem_episodes';
  fetched_at: string;
}

export interface SemanticFact {
  id: string;
  fact_key: string;
  fact_value: string;
  fact_value_type: string;
  entity: string;
  confidence: number;
  actor_id: string;
  asserted_at: string;
}

export interface SemanticBlock {
  kind: 'SEMANTIC';
  facts: SemanticFact[];
  source: 'mem_facts';
  fetched_at: string;
}

// Phase 6b — Five additional first-class blocks. Each is a thin read view
// over a Phase 5a/5c-populated table. All gracefully empty out when the
// underlying table has no rows for this user.

export interface TrajectoryDay {
  date: string;
  score_total: number | null;
  score_sleep: number | null;
  score_nutrition: number | null;
  score_exercise: number | null;
  score_hydration: number | null;
  score_mental: number | null;
}

export interface TrajectoryBlock {
  kind: 'TRAJECTORY';
  days: TrajectoryDay[];          // most recent 30, oldest first
  latest_total: number | null;
  source: 'vitana_index_scores';
  fetched_at: string;
}

export interface NetworkPerson {
  node_id: string;
  display_name: string | null;
  node_type: string;
  edge_type: string | null;
  strength: number | null;
  last_interaction_at: string | null;
}

export interface NetworkBlock {
  kind: 'NETWORK';
  people: NetworkPerson[];
  source: 'mem_graph_edges';
  fetched_at: string;
}

export interface LocationCurrent {
  location_type: string;
  locality: string | null;
  country: string | null;
  timezone: string;
  source: string;
  valid_from: string;
}

export interface LocationBlock {
  kind: 'LOCATION';
  current: LocationCurrent | null;
  named_places: Array<{ name: string; locality: string | null; country: string | null; timezone: string | null; user_confirmed: boolean }>;
  source: 'user_location_history+user_location_settings';
  fetched_at: string;
}

export interface BiometricsTrend {
  feature_key: string;
  pillar: string;
  trend_class: string;
  latest: number | null;
  mean_30d: number | null;
  anomaly_flag: boolean;
}

export interface BiometricsEvent {
  event_type: string;
  feature_key: string;
  pillar: string;
  observed_at: string;
  detail: Record<string, unknown>;
}

export interface BiometricsBlock {
  kind: 'BIOMETRICS';
  trends: BiometricsTrend[];
  events: BiometricsEvent[];
  source: 'biometric_trends+biometric_events';
  fetched_at: string;
}

export interface DiaryEntry {
  id: string;
  occurred_at: string;
  category_key: string | null;
  content: string;
}

export interface DiaryBlock {
  kind: 'DIARY';
  entries: DiaryEntry[];
  source: 'memory_diary_entries';
  fetched_at: string;
}

// Phase 7a — GOVERNANCE block. Tells the brain what NOT to pitch.
// Sources:
//   - autopilot_recommendations rows the user already rejected, archived,
//     or snoozed (don't re-pitch within the cooldown window).
//   - user_proactive_pause rows (user said "stop suggesting X").

export interface GovernanceDismissal {
  recommendation_id: string;
  title: string;
  domain: string | null;
  status: string;          // rejected | auto_archived | etc.
  // Window in which the recommendation should NOT be re-pitched
  cooldown_until: string | null;
  reason: 'rejected' | 'auto_archived' | 'snoozed' | 'expired';
  source_signal: string | null;
}

export interface GovernancePause {
  scope: string;            // 'orb_proactive' | 'autopilot' | … (free-form)
  reason: string | null;
  pause_until: string | null;
  created_at: string;
}

export interface GovernanceBlock {
  kind: 'GOVERNANCE';
  dismissals: GovernanceDismissal[];
  pauses: GovernancePause[];
  source: 'autopilot_recommendations+user_proactive_pause';
  fetched_at: string;
}

export type MemoryBlock =
  | IdentityBlock
  | EpisodicBlock
  | SemanticBlock
  | TrajectoryBlock
  | NetworkBlock
  | LocationBlock
  | BiometricsBlock
  | DiaryBlock
  | GovernanceBlock;

export interface MemoryPack {
  ok: boolean;
  intent: MemoryIntent;
  blocks: Partial<Record<MemoryBlockKind, MemoryBlock>>;
  meta: {
    streams_hit: string[];
    latency_ms_per_stream: Record<string, number>;
    total_latency_ms: number;
    degraded: boolean;
    pack_size_bytes: number;
    block_count: number;
  };
  error?: string;
}

// =============================================================================
// Default block selection per intent (Phase 6a covers a subset; rest in 6b)
// =============================================================================

// Phase 6b + 7a: full per-intent default block selection from the plan
// (Part 6, Layer 1 Semantic API). IDENTITY is implicitly added to every
// intent except system_introspect — modeled here as an explicit entry.
// GOVERNANCE is added to intents where the brain might pitch something
// (open_session, plan_next_action, community_intent), so it has the
// "don't re-pitch this" list inline.
const DEFAULT_BLOCKS_BY_INTENT: Record<MemoryIntent, MemoryBlockKind[]> = {
  recall_recent:     ['IDENTITY', 'EPISODIC', 'DIARY', 'GOVERNANCE'],
  recall_history:    ['IDENTITY', 'EPISODIC', 'DIARY', 'NETWORK', 'SEMANTIC', 'TRAJECTORY', 'GOVERNANCE'],
  identity:          ['IDENTITY', 'SEMANTIC'],
  plan_next_action:  ['IDENTITY', 'TRAJECTORY', 'BIOMETRICS', 'DIARY', 'LOCATION', 'SEMANTIC', 'NETWORK', 'GOVERNANCE'],
  open_session:      ['IDENTITY', 'EPISODIC', 'TRAJECTORY', 'BIOMETRICS', 'LOCATION', 'NETWORK', 'GOVERNANCE'],
  health_query:      ['IDENTITY', 'TRAJECTORY', 'BIOMETRICS', 'DIARY', 'SEMANTIC'],
  index_status:      ['IDENTITY', 'TRAJECTORY', 'BIOMETRICS'],
  goal_check:        ['IDENTITY', 'SEMANTIC', 'TRAJECTORY', 'DIARY'],
  social_query:      ['IDENTITY', 'NETWORK', 'EPISODIC', 'DIARY'],
  community_intent:  ['IDENTITY', 'NETWORK', 'LOCATION', 'GOVERNANCE'],
  system_introspect: ['IDENTITY', 'EPISODIC'],
};

// =============================================================================
// Flag check
// =============================================================================

let cachedFlag: boolean | null = null;
let cachedFlagAt = 0;
const FLAG_TTL_MS = 30_000;

async function isBrokerEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedFlag !== null && now - cachedFlagAt < FLAG_TTL_MS) return cachedFlag;
  try {
    const c = await getSystemControl('memory_broker_enabled');
    cachedFlag = !!(c && c.enabled);
  } catch {
    cachedFlag = false;
  }
  cachedFlagAt = now;
  return cachedFlag;
}

export function invalidateBrokerFlagCache(): void {
  cachedFlag = null;
  cachedFlagAt = 0;
}

// =============================================================================
// Per-block fetchers
// =============================================================================

async function fetchIdentityBlock(input: MemoryReadInput): Promise<{
  block: IdentityBlock | null;
  latency_ms: number;
}> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  // Canonical identity comes from app_users — NEVER memory_facts (Identity
  // Lock invariant, VTID-01952).
  //
  // The actual app_users schema stores name/dob/etc inside the `profile`
  // JSONB blob plus a few flat columns (display_name, email, locale,
  // vitana_id). We unpack profile into the IdentityBlock shape so callers
  // get a stable contract regardless of the backing layout.
  const { data, error } = await supabase
    .from('app_users')
    .select('user_id, display_name, email, locale, vitana_id, profile')
    .eq('user_id', input.user_id)
    .eq('tenant_id', input.tenant_id)
    .maybeSingle();

  if (error || !data) {
    return { block: null, latency_ms: Date.now() - t0 };
  }

  const profile = ((data as any).profile ?? {}) as Record<string, any>;
  const fullName: string | null = (data as any).display_name
    ?? profile.full_name ?? profile.display_name ?? null;

  const block: IdentityBlock = {
    kind: 'IDENTITY',
    user_id: data.user_id,
    tenant_id: input.tenant_id,
    first_name: profile.first_name ?? null,
    last_name: profile.last_name ?? null,
    full_name: fullName,
    preferred_name: profile.preferred_name ?? profile.preferred_first_name ?? null,
    email: (data as any).email ?? profile.email ?? null,
    date_of_birth: profile.date_of_birth ?? profile.dob ?? null,
    gender: profile.gender ?? null,
    pronouns: profile.pronouns ?? null,
    locale: (data as any).locale ?? profile.locale ?? null,
    vitana_id: (data as any).vitana_id ?? null,
    source: 'app_users',
    asserted_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

async function fetchEpisodicBlock(
  input: MemoryReadInput,
  limit: number,
  maxAgeHours: number | null
): Promise<{ block: EpisodicBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  // Phase 6b: when caller passes a query string, switch to semantic-rank
  // via mem_episodes_semantic_search RPC (cosine + recency-boosted
  // combined_score). Otherwise fall back to recency-order.
  const trimmedQuery = (input.query ?? '').trim();
  if (trimmedQuery.length > 5) {
    const semantic = await fetchEpisodicSemantic(
      input, trimmedQuery, limit, maxAgeHours
    );
    if (semantic.ok) {
      return { block: semantic.block, latency_ms: Date.now() - t0 };
    }
    // Embedding generation or RPC failed — fall through to recency-order.
  }

  let query = supabase
    .from('mem_episodes')
    .select('id, kind, content, category_key, source, importance, occurred_at, actor_id, conversation_id')
    .eq('tenant_id', input.tenant_id)
    .eq('user_id', input.user_id)
    .is('valid_to', null) // active rows only
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (maxAgeHours && maxAgeHours > 0) {
    const cutoff = new Date(Date.now() - maxAgeHours * 3600 * 1000).toISOString();
    query = query.gte('occurred_at', cutoff);
  }

  const { data, error } = await query;
  if (error) {
    console.warn(`[${VTID}] mem_episodes query failed: ${error.message}`);
    return { block: null, latency_ms: Date.now() - t0 };
  }

  const block: EpisodicBlock = {
    kind: 'EPISODIC',
    hits: (data ?? []).map(r => ({
      id: r.id,
      kind: r.kind,
      content: (r.content ?? '').slice(0, 400),
      category_key: r.category_key,
      source: r.source,
      importance: r.importance ?? 30,
      occurred_at: r.occurred_at,
      actor_id: r.actor_id,
      conversation_id: r.conversation_id,
    })),
    source: 'mem_episodes',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

async function fetchSemanticBlock(
  input: MemoryReadInput,
  limit: number
): Promise<{ block: SemanticBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  // Active facts only (the canonical "current truth" view from mem_facts).
  const { data, error } = await supabase
    .from('mem_facts')
    .select('id, fact_key, fact_value, fact_value_type, entity, confidence, actor_id, asserted_at')
    .eq('tenant_id', input.tenant_id)
    .eq('user_id', input.user_id)
    .is('valid_to', null)
    .order('asserted_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn(`[${VTID}] mem_facts query failed: ${error.message}`);
    return { block: null, latency_ms: Date.now() - t0 };
  }

  const block: SemanticBlock = {
    kind: 'SEMANTIC',
    facts: (data ?? []).map(r => ({
      id: r.id,
      fact_key: r.fact_key,
      fact_value: r.fact_value,
      fact_value_type: r.fact_value_type,
      entity: r.entity,
      confidence: r.confidence ?? 1.0,
      actor_id: r.actor_id,
      asserted_at: r.asserted_at,
    })),
    source: 'mem_facts',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// -----------------------------------------------------------------------------
// EPISODIC semantic mode — calls mem_episodes_semantic_search RPC
// -----------------------------------------------------------------------------

async function fetchEpisodicSemantic(
  input: MemoryReadInput,
  query: string,
  limit: number,
  maxAgeHours: number | null
): Promise<{ ok: boolean; block: EpisodicBlock | null }> {
  // Lazy-import to avoid a hard dep when EPISODIC isn't requested.
  const { generateEmbedding } = await import('./embedding-service');
  const supabase = getSupabase();
  if (!supabase) return { ok: false, block: null };

  const emb = await generateEmbedding(query);
  if (!emb.ok || !emb.embedding) return { ok: false, block: null };

  const { data, error } = await supabase.rpc('mem_episodes_semantic_search', {
    p_query_embedding: '[' + emb.embedding.join(',') + ']',
    p_top_k: limit,
    p_tenant_id: input.tenant_id,
    p_user_id: input.user_id,
    p_workspace_scope: null,
    p_active_role: null,
    p_categories: null,
    p_visibility_scope: 'private',
    p_max_age_hours: maxAgeHours ?? null,
    p_recency_boost: true,
  });

  if (error) {
    console.warn(`[${VTID}] mem_episodes_semantic_search RPC failed: ${error.message}`);
    return { ok: false, block: null };
  }

  const block: EpisodicBlock = {
    kind: 'EPISODIC',
    hits: (data ?? []).map((r: any) => ({
      id: r.id,
      kind: 'utterance',
      content: (r.content ?? '').slice(0, 400),
      category_key: r.category_key,
      source: r.source,
      importance: r.importance ?? 30,
      occurred_at: r.occurred_at,
      actor_id: r.actor_id,
      conversation_id: r.conversation_id,
    })),
    source: 'mem_episodes',
    fetched_at: new Date().toISOString(),
  };
  return { ok: true, block };
}

// -----------------------------------------------------------------------------
// TRAJECTORY — vitana_index_scores last 30 days
// -----------------------------------------------------------------------------

async function fetchTrajectoryBlock(
  input: MemoryReadInput
): Promise<{ block: TrajectoryBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('vitana_index_scores')
    .select('date, score_total, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
    .eq('tenant_id', input.tenant_id)
    .eq('user_id', input.user_id)
    .gte('date', cutoff)
    .order('date', { ascending: true })
    .limit(40);

  if (error) {
    console.warn(`[${VTID}] vitana_index_scores query failed: ${error.message}`);
    return { block: null, latency_ms: Date.now() - t0 };
  }

  const days = (data ?? []).map(r => ({
    date: r.date,
    score_total: r.score_total,
    score_sleep: r.score_sleep,
    score_nutrition: r.score_nutrition,
    score_exercise: r.score_exercise,
    score_hydration: r.score_hydration,
    score_mental: r.score_mental,
  }));
  const latest = days.length ? days[days.length - 1].score_total : null;

  const block: TrajectoryBlock = {
    kind: 'TRAJECTORY',
    days,
    latest_total: latest,
    source: 'vitana_index_scores',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// -----------------------------------------------------------------------------
// NETWORK — mem_graph_edges + relationship_nodes (closest people)
// -----------------------------------------------------------------------------

async function fetchNetworkBlock(
  input: MemoryReadInput,
  limit: number
): Promise<{ block: NetworkBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  // Active edges where the user is one endpoint, ordered by strength then
  // recent interaction. Resolve target node via relationship_nodes.
  const { data: edges, error } = await supabase
    .from('mem_graph_edges')
    .select('source_type, source_id, target_type, target_id, edge_type, strength, last_interaction_at')
    .eq('tenant_id', input.tenant_id)
    .eq('user_id', input.user_id)
    .is('valid_to', null)
    .order('strength', { ascending: false })
    .order('last_interaction_at', { ascending: false, nullsFirst: false })
    .limit(limit);

  if (error) {
    console.warn(`[${VTID}] mem_graph_edges query failed: ${error.message}`);
    return { block: null, latency_ms: Date.now() - t0 };
  }

  // Resolve "the other side" of each edge into relationship_nodes for display name.
  const nodeIds = Array.from(new Set(
    (edges ?? []).map(e => e.target_type === 'user' || e.target_type === 'person' ? e.target_id : e.source_id)
  ));

  let nodesById: Record<string, { display_name: string | null; node_type: string }> = {};
  if (nodeIds.length > 0) {
    const { data: nodes } = await supabase
      .from('relationship_nodes')
      .select('id, display_name, node_type')
      .in('id', nodeIds);
    nodesById = Object.fromEntries(
      (nodes ?? []).map(n => [n.id, { display_name: n.display_name, node_type: n.node_type }])
    );
  }

  const people: NetworkPerson[] = (edges ?? []).map(e => {
    const isOutbound = e.source_type === 'user' || e.source_type === 'person';
    const otherNodeId = isOutbound ? e.target_id : e.source_id;
    const otherNodeType = isOutbound ? e.target_type : e.source_type;
    const node = nodesById[otherNodeId];
    return {
      node_id: otherNodeId,
      display_name: node?.display_name ?? null,
      node_type: node?.node_type ?? otherNodeType,
      edge_type: e.edge_type,
      strength: e.strength,
      last_interaction_at: e.last_interaction_at,
    };
  });

  const block: NetworkBlock = {
    kind: 'NETWORK',
    people,
    source: 'mem_graph_edges',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// -----------------------------------------------------------------------------
// LOCATION — current location + named places
// -----------------------------------------------------------------------------

async function fetchLocationBlock(
  input: MemoryReadInput
): Promise<{ block: LocationBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  const [historyRes, settingsRes] = await Promise.all([
    supabase
      .from('user_location_history')
      .select('location_type, locality, country, timezone, source, valid_from')
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .is('valid_to', null)
      .order('valid_from', { ascending: false })
      .limit(1),
    supabase
      .from('user_location_settings')
      .select('name, locality, country, timezone, user_confirmed')
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .order('is_primary_home', { ascending: false })
      .limit(20),
  ]);

  const current = (historyRes.data?.[0] ?? null) as LocationCurrent | null;
  const named = (settingsRes.data ?? []).map(p => ({
    name: p.name,
    locality: p.locality,
    country: p.country,
    timezone: p.timezone,
    user_confirmed: p.user_confirmed,
  }));

  const block: LocationBlock = {
    kind: 'LOCATION',
    current,
    named_places: named,
    source: 'user_location_history+user_location_settings',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// -----------------------------------------------------------------------------
// BIOMETRICS — current trends + active anomaly events
// -----------------------------------------------------------------------------

async function fetchBiometricsBlock(
  input: MemoryReadInput
): Promise<{ block: BiometricsBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  const [trendsRes, eventsRes] = await Promise.all([
    supabase
      .from('biometric_trends')
      .select('feature_key, pillar, trend_class, latest, mean_30d, anomaly_flag')
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .order('computed_at', { ascending: false })
      .limit(20),
    supabase
      .from('biometric_events')
      .select('event_type, feature_key, pillar, observed_at, detail')
      .eq('tenant_id', input.tenant_id)
      .eq('user_id', input.user_id)
      .is('acknowledged_at', null)
      .order('observed_at', { ascending: false })
      .limit(10),
  ]);

  const block: BiometricsBlock = {
    kind: 'BIOMETRICS',
    trends: (trendsRes.data ?? []).map(t => ({
      feature_key: t.feature_key,
      pillar: t.pillar,
      trend_class: t.trend_class,
      latest: t.latest,
      mean_30d: t.mean_30d,
      anomaly_flag: t.anomaly_flag,
    })),
    events: (eventsRes.data ?? []).map(e => ({
      event_type: e.event_type,
      feature_key: e.feature_key,
      pillar: e.pillar,
      observed_at: e.observed_at,
      detail: e.detail ?? {},
    })),
    source: 'biometric_trends+biometric_events',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// -----------------------------------------------------------------------------
// DIARY — memory_diary_entries (legacy; Phase 8 will migrate to mem_episodes)
// -----------------------------------------------------------------------------

async function fetchDiaryBlock(
  input: MemoryReadInput,
  daysBack: number,
  limit: number
): Promise<{ block: DiaryBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  const cutoff = new Date(Date.now() - daysBack * 24 * 3600 * 1000).toISOString();
  const { data, error } = await supabase
    .from('memory_diary_entries')
    .select('id, occurred_at, category_key, content')
    .eq('tenant_id', input.tenant_id)
    .eq('user_id', input.user_id)
    .gte('occurred_at', cutoff)
    .order('occurred_at', { ascending: false })
    .limit(limit);

  if (error) {
    // Table may not exist on all environments — graceful empty.
    return { block: null, latency_ms: Date.now() - t0 };
  }

  const block: DiaryBlock = {
    kind: 'DIARY',
    entries: (data ?? []).map(e => ({
      id: e.id,
      occurred_at: e.occurred_at,
      category_key: e.category_key,
      content: (e.content ?? '').slice(0, 400),
    })),
    source: 'memory_diary_entries',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// -----------------------------------------------------------------------------
// GOVERNANCE — autopilot dismissals + user_proactive_pause
// -----------------------------------------------------------------------------

async function fetchGovernanceBlock(
  input: MemoryReadInput
): Promise<{ block: GovernanceBlock | null; latency_ms: number }> {
  const t0 = Date.now();
  const supabase = getSupabase();
  if (!supabase) return { block: null, latency_ms: Date.now() - t0 };

  // Cooldown window: the brain should NOT re-pitch a recommendation that
  // was rejected/archived/snoozed within the last 14 days.
  const cooldownStart = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString();

  const [recsRes, pausesRes] = await Promise.all([
    supabase
      .from('autopilot_recommendations')
      .select('id, title, domain, status, snoozed_until, expires_at, signal_fingerprint, updated_at')
      .eq('user_id', input.user_id)
      .in('status', ['rejected', 'auto_archived'])
      .gte('updated_at', cooldownStart)
      .order('updated_at', { ascending: false })
      .limit(50),
    supabase
      .from('user_proactive_pause')
      .select('*')
      .eq('user_id', input.user_id)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  const dismissals: GovernanceDismissal[] = (recsRes.data ?? []).map(r => ({
    recommendation_id: r.id,
    title: r.title,
    domain: r.domain,
    status: r.status,
    cooldown_until: r.snoozed_until ?? r.expires_at ?? null,
    reason: (r.status === 'rejected'
      ? 'rejected'
      : r.status === 'auto_archived'
        ? 'auto_archived'
        : (r.snoozed_until ? 'snoozed' : 'expired')) as GovernanceDismissal['reason'],
    source_signal: r.signal_fingerprint,
  }));

  // user_proactive_pause schema is unknown at compile time (the table is
  // empty and the plan doesn't fully spec it). Read everything and pick
  // out plausible field names.
  const pauses: GovernancePause[] = (pausesRes.data ?? []).map((p: any) => ({
    scope: p.scope ?? p.kind ?? p.area ?? 'unknown',
    reason: p.reason ?? p.note ?? null,
    pause_until: p.pause_until ?? p.until ?? p.expires_at ?? null,
    created_at: p.created_at ?? new Date().toISOString(),
  }));

  const block: GovernanceBlock = {
    kind: 'GOVERNANCE',
    dismissals,
    pauses,
    source: 'autopilot_recommendations+user_proactive_pause',
    fetched_at: new Date().toISOString(),
  };
  return { block, latency_ms: Date.now() - t0 };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Unified read entry point. Returns a MemoryPack with the blocks selected
 * by the intent (or by `required_blocks` override). Always returns within
 * `latency_budget_ms` (default 1500ms) — slow blocks are dropped, the pack
 * is marked `degraded=true`, and the consumer sees what was ready.
 */
export async function getMemoryContext(input: MemoryReadInput): Promise<MemoryPack> {
  const t0 = Date.now();
  const intent = input.intent;
  const blocksWanted = input.required_blocks ?? DEFAULT_BLOCKS_BY_INTENT[intent] ?? ['IDENTITY'];
  const budgetMs = input.latency_budget_ms ?? 1500;

  // Hard contract: caller must supply tenant_id and user_id. Anonymous
  // memory reads are not a thing in this system.
  if (!input.tenant_id || !input.user_id) {
    return {
      ok: false,
      intent,
      blocks: {},
      meta: {
        streams_hit: [],
        latency_ms_per_stream: {},
        total_latency_ms: Date.now() - t0,
        degraded: true,
        pack_size_bytes: 0,
        block_count: 0,
      },
      error: 'tenant_id and user_id are required',
    };
  }

  // If broker is disabled by flag, return an empty pack. Callers with a
  // legacy fallback path will use it; the broker becoming a hard dep
  // happens in Phase 6c after the canary period.
  if (!(await isBrokerEnabled())) {
    return {
      ok: false,
      intent,
      blocks: {},
      meta: {
        streams_hit: [],
        latency_ms_per_stream: {},
        total_latency_ms: Date.now() - t0,
        degraded: true,
        pack_size_bytes: 0,
        block_count: 0,
      },
      error: 'memory_broker_disabled',
    };
  }

  const blocks: Partial<Record<MemoryBlockKind, MemoryBlock>> = {};
  const streamsHit: string[] = [];
  const latencyPerStream: Record<string, number> = {};
  let degraded = false;

  // Per-block fetch with budget guard. Each block is fetched in parallel;
  // any block that exceeds the budget is dropped and the pack is marked
  // degraded.
  const fetchers: Array<Promise<void>> = [];

  if (blocksWanted.includes('IDENTITY')) {
    fetchers.push(
      withBudget(fetchIdentityBlock(input), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['app_users'] = budgetMs;
        } else if (r.value?.block) {
          blocks['IDENTITY'] = r.value.block;
          streamsHit.push('app_users');
          latencyPerStream['app_users'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('EPISODIC')) {
    const limit = intent === 'recall_recent' ? 20 : 50;
    const maxAge = intent === 'recall_recent' ? 24 : null;
    fetchers.push(
      withBudget(fetchEpisodicBlock(input, limit, maxAge), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['mem_episodes'] = budgetMs;
        } else if (r.value?.block) {
          blocks['EPISODIC'] = r.value.block;
          streamsHit.push('mem_episodes');
          latencyPerStream['mem_episodes'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('SEMANTIC')) {
    fetchers.push(
      withBudget(fetchSemanticBlock(input, 50), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['mem_facts'] = budgetMs;
        } else if (r.value?.block) {
          blocks['SEMANTIC'] = r.value.block;
          streamsHit.push('mem_facts');
          latencyPerStream['mem_facts'] = r.value.latency_ms;
        }
      })
    );
  }

  // Phase 6b — five new blocks. Each follows the same withBudget pattern;
  // any block whose source table is empty just returns a block with empty
  // arrays (fetched_at populated), which is fine — consumers see "no data
  // yet" rather than a missing block.

  if (blocksWanted.includes('TRAJECTORY')) {
    fetchers.push(
      withBudget(fetchTrajectoryBlock(input), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['vitana_index_scores'] = budgetMs;
        } else if (r.value?.block) {
          blocks['TRAJECTORY'] = r.value.block;
          streamsHit.push('vitana_index_scores');
          latencyPerStream['vitana_index_scores'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('NETWORK')) {
    fetchers.push(
      withBudget(fetchNetworkBlock(input, 20), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['mem_graph_edges'] = budgetMs;
        } else if (r.value?.block) {
          blocks['NETWORK'] = r.value.block;
          streamsHit.push('mem_graph_edges');
          latencyPerStream['mem_graph_edges'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('LOCATION')) {
    fetchers.push(
      withBudget(fetchLocationBlock(input), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['user_location_history'] = budgetMs;
        } else if (r.value?.block) {
          blocks['LOCATION'] = r.value.block;
          streamsHit.push('user_location_history');
          latencyPerStream['user_location_history'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('BIOMETRICS')) {
    fetchers.push(
      withBudget(fetchBiometricsBlock(input), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['biometric_trends'] = budgetMs;
        } else if (r.value?.block) {
          blocks['BIOMETRICS'] = r.value.block;
          streamsHit.push('biometric_trends');
          latencyPerStream['biometric_trends'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('DIARY')) {
    // Last 14 days of diary highlights (per Part 6 plan default).
    fetchers.push(
      withBudget(fetchDiaryBlock(input, 14, 30), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['memory_diary_entries'] = budgetMs;
        } else if (r.value?.block) {
          blocks['DIARY'] = r.value.block;
          streamsHit.push('memory_diary_entries');
          latencyPerStream['memory_diary_entries'] = r.value.latency_ms;
        }
      })
    );
  }

  if (blocksWanted.includes('GOVERNANCE')) {
    fetchers.push(
      withBudget(fetchGovernanceBlock(input), budgetMs).then(r => {
        if (r.timedOut) {
          degraded = true;
          latencyPerStream['autopilot_recommendations'] = budgetMs;
        } else if (r.value?.block) {
          blocks['GOVERNANCE'] = r.value.block;
          streamsHit.push('autopilot_recommendations');
          latencyPerStream['autopilot_recommendations'] = r.value.latency_ms;
        }
      })
    );
  }

  await Promise.all(fetchers);

  const packSizeBytes = JSON.stringify(blocks).length;

  return {
    ok: true,
    intent,
    blocks,
    meta: {
      streams_hit: streamsHit,
      latency_ms_per_stream: latencyPerStream,
      total_latency_ms: Date.now() - t0,
      degraded,
      pack_size_bytes: packSizeBytes,
      block_count: Object.keys(blocks).length,
    },
  };
}

/**
 * Race a per-block fetch against the latency budget. If the budget elapses
 * first, return `{ timedOut: true }` and let the broker mark the pack
 * degraded. The fetch itself is not cancelled — Postgres has its own
 * timeout — but the caller has already moved on.
 */
async function withBudget<T>(
  fetchPromise: Promise<T>,
  budgetMs: number
): Promise<{ timedOut: boolean; value?: T }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>(resolve => {
    timer = setTimeout(() => resolve({ timedOut: true }), budgetMs);
  });
  const result = await Promise.race([
    fetchPromise.then(value => ({ timedOut: false as const, value })),
    timeout,
  ]);
  if (timer) clearTimeout(timer);
  return result as { timedOut: boolean; value?: T };
}

/**
 * Phase 6a does not implement writes through the broker yet — existing
 * writers still call writeMemoryItemWithIdentity / writeFact directly,
 * with the Phase 5b dual-writer fanning out to mem_*. Phase 6c will
 * gate writes behind a `writeMemoryUnified` API that enforces provenance
 * and Identity Lock at a single chokepoint.
 */
