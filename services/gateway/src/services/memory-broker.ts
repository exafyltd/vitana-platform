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

export type MemoryBlock = IdentityBlock | EpisodicBlock | SemanticBlock;

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

const DEFAULT_BLOCKS_BY_INTENT: Record<MemoryIntent, MemoryBlockKind[]> = {
  recall_recent:     ['IDENTITY', 'EPISODIC'],
  recall_history:    ['IDENTITY', 'EPISODIC', 'SEMANTIC'],
  identity:          ['IDENTITY', 'SEMANTIC'],
  // Phase 6b will fully populate these:
  plan_next_action:  ['IDENTITY', 'EPISODIC', 'SEMANTIC'],
  open_session:      ['IDENTITY', 'EPISODIC', 'SEMANTIC'],
  health_query:      ['IDENTITY', 'SEMANTIC'],
  index_status:      ['IDENTITY'],
  goal_check:        ['IDENTITY', 'SEMANTIC'],
  social_query:      ['IDENTITY', 'SEMANTIC'],
  community_intent:  ['IDENTITY', 'SEMANTIC'],
  system_introspect: ['IDENTITY'],
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
