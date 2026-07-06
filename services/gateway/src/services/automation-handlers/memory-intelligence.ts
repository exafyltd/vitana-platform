/**
 * Memory & Intelligence Handlers — AP-0900 series
 *
 * VTID: VTID-01250
 * Automations built on the live memory_facts/relationship_nodes/relationship_edges
 * stack (VTID-01192/VTID-01087, documented in CLAUDE.md section 14).
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';
import { tt } from '../../i18n/catalog';
import { getUserLocale, bulkGetUserLocales } from '../../i18n/server-locale';
import {
  detectNewFacts,
  markLearningSurfaced,
  readLearningSurfacedAt,
} from '../conversation/new-facts-detector';
import { SIGNAL_GREETING_FACTS, parseFacts } from '../conversation/greeting-facts-ledger';

// ── AP-0901: Memory-Informed Matching ───────────────────────
// On a positive match reaction, look up the user's most recent self-facts
// (memory_facts, entity='self') to personalize the "why this match" nudge.
async function runMemoryInformedMatching(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id: userId, match_id: matchId } = payload || {};
  if (!userId || !matchId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: match } = await supabase
    .from('daily_matches')
    .select('id')
    .eq('id', matchId)
    .maybeSingle();
  if (!match) return { usersAffected: 0, actionsTaken: 0 };

  const { data: facts } = await supabase
    .from('memory_facts')
    .select('fact_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .eq('entity', 'self')
    .is('superseded_at', null)
    .order('extracted_at', { ascending: false })
    .limit(3);

  if (!facts?.length) return { usersAffected: 0, actionsTaken: 0 };

  // BOOTSTRAP-MEMORY-DAILY-LEARNING (3d): the copy leads with "I remembered
  // you mentioned X" — the stored fact is announced as learning, not used as
  // silent background justification. Localized via the gateway catalog
  // (CLAUDE.md 13b) instead of the previous hardcoded English.
  const trait = facts[0].fact_value;
  const lc = await getUserLocale(supabase, userId);
  ctx.notify(userId, 'orb_suggestion', {
    title: tt('notif.memory_match.title', lc),
    body: tt('notif.memory_match.body', lc, { trait }),
    data: { url: '/matches', match_id: matchId },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0902: Fact Extraction from Conversations ─────────────
// The real extraction pipeline (cognee-extractor-client.ts extractAsync +
// persistExtractionResults) already runs async per-session outside the
// automations registry. This handler is a lightweight audit: confirm a
// session that ended actually produced memory_facts, and flag silent
// extraction failures for ops.
async function runFactExtractionAudit(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id: userId, session_id: sessionId } = payload || {};
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { count: factCount } = await supabase
    .from('memory_facts')
    .select('id', { count: 'exact', head: true })
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .gte('extracted_at', tenMinutesAgo);

  if ((factCount || 0) > 0) return { usersAffected: 0, actionsTaken: 0 };

  ctx.log(`No memory_facts extracted for user ${userId.slice(0, 8)}… in the last 10min after session ${sessionId || 'unknown'} ended`);
  await ctx.emitEvent('autopilot.memory.extraction_silent', { user_id: userId, session_id: sessionId });

  return { usersAffected: 0, actionsTaken: 1 };
}

// ── AP-0903: RETIRED (BOOTSTRAP-MEMORY-DAILY-LEARNING) ──────
// Its edge decay double-decayed the same relationship_edges rows the
// nightly consolidator's Loop 13 already maintains, on a conflicting
// formula (flat −10 @ 90d vs. Loop 13's 5%-toward-mid @ 30d). Loop 13
// is the single decay mechanism now; AP-0909 below owns graph CREATION.

// ── AP-0904: Semantic Memory Search for Autopilot Context ───
// Fired before another automation executes (same 'automation.pre_execute'
// topic AP-0613 uses); stashes the user's top self-facts onto
// ctx.run.metadata for the calling automation to read, so downstream
// notification copy can be memory-aware without its own memory_facts query.
const CONTEXT_FACTS_LIMIT = 5;

async function runSemanticMemoryContextForAutopilot(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  const { data: facts } = await supabase
    .from('memory_facts')
    .select('fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .is('superseded_at', null)
    .order('extracted_at', { ascending: false })
    .limit(CONTEXT_FACTS_LIMIT);

  ctx.run.metadata = {
    ...ctx.run.metadata,
    memory_context_facts: (facts || []).map((f: any) => ({ key: f.fact_key, value: f.fact_value })),
  };

  return { usersAffected: 1, actionsTaken: 0 };
}

// ── AP-0905: Knowledge Base Context for Suggestions ─────────
// knowledge_docs (tags array) is the live knowledge hub table. Given a set
// of topic tags, surfaces the most relevant doc and stashes it on
// ctx.run.metadata the same way AP-0904 stashes memory facts.
async function runKnowledgeBaseContextForSuggestions(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { topic_tags: topicTags } = payload || {};
  if (!Array.isArray(topicTags) || topicTags.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase } = ctx;

  const { data: docs } = await supabase
    .from('knowledge_docs')
    .select('id, title, path')
    .overlaps('tags', topicTags)
    .limit(1);

  if (!docs?.length) return { usersAffected: 0, actionsTaken: 0 };

  ctx.run.metadata = {
    ...ctx.run.metadata,
    knowledge_context_doc: docs[0],
  };

  return { usersAffected: 0, actionsTaken: 1 };
}

// ── AP-0906: Routine Pattern Extraction ─────────────────────
// Wires the previously caller-less guide/pattern-extractor (VTID-01936):
// for every user with calendar activity in the extractor's 30-day window,
// derive time-of-day / day-of-week / category-affinity routines into
// user_routines. The UserContextProfiler and guide awareness-context
// already read that table, so extracted routines flow straight into the
// ORB voice profile and the brain's routine-weaving.
const ROUTINE_EXTRACT_LOOKBACK_DAYS = 30;
const ROUTINE_EXTRACT_MAX_USERS_PER_RUN = 200;
const ROUTINE_EXTRACT_EVENT_SCAN_LIMIT = 5000;

async function runRoutinePatternExtraction(ctx: AutomationContext) {
  const { supabase } = ctx;
  const sinceIso = new Date(Date.now() - ROUTINE_EXTRACT_LOOKBACK_DAYS * 86_400_000).toISOString();

  const { data: rows, error } = await supabase
    .from('calendar_events')
    .select('user_id')
    .gte('start_time', sinceIso)
    .not('user_id', 'is', null)
    .limit(ROUTINE_EXTRACT_EVENT_SCAN_LIMIT);

  if (error) {
    ctx.log(`calendar_events scan failed: ${error.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const userIds = [...new Set((rows || []).map((r: any) => r.user_id).filter(Boolean))].slice(
    0,
    ROUTINE_EXTRACT_MAX_USERS_PER_RUN,
  );

  const { extractPatternsForUser } = await import('../guide/pattern-extractor');

  let usersAffected = 0;
  let actionsTaken = 0;
  for (const userId of userIds) {
    try {
      const result = await extractPatternsForUser(userId as string);
      if (result.routines_written > 0) {
        usersAffected++;
        actionsTaken += result.routines_written;
      }
    } catch (err: any) {
      ctx.log(`pattern extraction failed for ${String(userId).slice(0, 8)}…: ${err?.message}`);
    }
  }

  await ctx.emitEvent('autopilot.memory.routines_extracted', {
    users_scanned: userIds.length,
    users_with_routines: usersAffected,
    routines_written: actionsTaken,
  });

  return { usersAffected, actionsTaken };
}

// ── AP-0907: Daily Learning Digest ──────────────────────────
// The standalone half of the shared felt-learning detector (3a): for users
// who gained memory_facts in the last 24h but did NOT get the moment in a
// session today (greeting-ledger `facts_learned` spoken today, or already
// notified today), send one "I learned something new about you" push with
// a deep link into the Memory Garden. Silent when nothing new — no filler.
const LEARNING_DIGEST_WINDOW_MS = 24 * 3600 * 1000;
const LEARNING_DIGEST_MAX_USERS_PER_RUN = 500;

async function runDailyLearningDigest(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const today = nowIso.slice(0, 10);
  const sinceIso = new Date(nowMs - LEARNING_DIGEST_WINDOW_MS).toISOString();

  // One query shrinks the fan-out to users who actually learned something.
  const { data: factRows, error } = await supabase
    .from('memory_facts')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .gt('extracted_at', sinceIso)
    .limit(5000);
  if (error) {
    ctx.log(`memory_facts scan failed: ${error.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
  const userIds = [...new Set((factRows || []).map((r: any) => r.user_id).filter(Boolean))].slice(
    0,
    LEARNING_DIGEST_MAX_USERS_PER_RUN,
  ) as string[];
  if (userIds.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  const locales = await bulkGetUserLocales(supabase, userIds);

  let usersAffected = 0;
  for (const userId of userIds) {
    try {
      // Guard 1: greeting already surfaced learning in a session today (3e wins).
      const { data: ledgerRow } = await supabase
        .from('user_assistant_state')
        .select('value')
        .eq('tenant_id', tenantId)
        .eq('user_id', userId)
        .eq('signal_name', SIGNAL_GREETING_FACTS)
        .maybeSingle();
      const spokenAt = ledgerRow
        ? parseFacts((ledgerRow as { value: unknown }).value).facts_learned?.spoken_at
        : undefined;
      if (spokenAt && spokenAt.slice(0, 10) === today) continue;

      // Guard 2: this digest already fired today.
      const surfacedAt = await readLearningSurfacedAt(supabase, tenantId, userId);
      if (surfacedAt && surfacedAt.slice(0, 10) === today) continue;

      const result = await detectNewFacts({ supabase, userId, tenantId, sinceIso, nowMs });
      if (result.count === 0) continue;

      const lc = locales.get(userId);
      ctx.notify(userId, 'orb_suggestion', {
        title: tt('notif.daily_learning.title', lc),
        body: tt('notif.daily_learning.body', lc, { count: result.count }),
        data: { url: '/memory' },
      });
      await markLearningSurfaced(supabase, tenantId, userId, result.count, nowIso);
      usersAffected++;
    } catch (err: any) {
      ctx.log(`learning digest failed for ${userId.slice(0, 8)}…: ${err?.message}`);
    }
  }

  await ctx.emitEvent('autopilot.memory.learning_digest_sent', {
    users_scanned: userIds.length,
    users_notified: usersAffected,
  });
  return { usersAffected, actionsTaken: usersAffected };
}

// ── AP-0908: Behavior-Derived Preference Inference ──────────
// Phase 2 of the felt-learning plan: turn observed behavior (the routines
// AP-0906 extracts into user_routines) into user_preference_* memory_facts
// via the write_fact RPC — provenance 'behavior_inferred', confidence 0.55
// (below the 0.80 of explicit statements, above the 0.55 retrieval floor so
// the fixed fetchPreferences() picks them up). The Memory Garden visibly
// grows from behavior, not just conversation. Idempotent: identical values
// are skipped so re-runs cause no supersession churn.
const BEHAVIOR_PREF_MIN_ROUTINE_CONFIDENCE = 0.6;
const BEHAVIOR_PREF_CONFIDENCE = 0.55;
const BEHAVIOR_PREF_MAX_USERS_PER_RUN = 500;

const ROUTINE_KIND_TO_PREF: Record<string, { factKey: string; metaField: string }> = {
  time_of_day_preference: { factKey: 'user_preference_active_time', metaField: 'time_of_day' },
  day_of_week_rhythm: { factKey: 'user_preference_active_day', metaField: 'day_of_week' },
  category_affinity: { factKey: 'user_preference_activity_focus', metaField: 'tag' },
};

async function runBehaviorPreferenceInference(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;

  const { data: routines, error } = await supabase
    .from('user_routines')
    .select('user_id, routine_kind, confidence, metadata')
    .gte('confidence', BEHAVIOR_PREF_MIN_ROUTINE_CONFIDENCE)
    .order('confidence', { ascending: false })
    .limit(3000);
  if (error) {
    ctx.log(`user_routines scan failed: ${error.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  // Highest-confidence routine per (user, kind) wins — rows are ordered desc.
  const derived = new Map<string, Map<string, string>>(); // userId → factKey → value
  for (const r of (routines || []) as Array<{ user_id: string; routine_kind: string; metadata: any }>) {
    const mapping = ROUTINE_KIND_TO_PREF[r.routine_kind];
    if (!mapping || !r.user_id) continue;
    const value = String(r.metadata?.[mapping.metaField] ?? '').trim();
    if (!value) continue;
    if (!derived.has(r.user_id)) derived.set(r.user_id, new Map());
    const userFacts = derived.get(r.user_id)!;
    if (!userFacts.has(mapping.factKey)) userFacts.set(mapping.factKey, value);
  }
  const userIds = [...derived.keys()].slice(0, BEHAVIOR_PREF_MAX_USERS_PER_RUN);
  if (userIds.length === 0) return { usersAffected: 0, actionsTaken: 0 };

  // Skip identical current facts — no daily supersession churn.
  const { data: existingRows } = await supabase
    .from('memory_facts')
    .select('user_id, fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .in('user_id', userIds)
    .like('fact_key', 'user_preference_%')
    .is('superseded_at', null);
  const existing = new Map<string, string>();
  for (const row of (existingRows || []) as Array<{ user_id: string; fact_key: string; fact_value: string }>) {
    existing.set(`${row.user_id}:${row.fact_key}`, row.fact_value);
  }

  let usersAffected = 0;
  let actionsTaken = 0;
  for (const userId of userIds) {
    let wroteAny = false;
    for (const [factKey, value] of derived.get(userId)!) {
      if (existing.get(`${userId}:${factKey}`) === value) continue;
      const { error: rpcErr } = await supabase.rpc('write_fact', {
        p_tenant_id: tenantId,
        p_user_id: userId,
        p_fact_key: factKey,
        p_fact_value: value,
        p_entity: 'self',
        p_fact_value_type: 'text',
        p_provenance_source: 'behavior_inferred',
        p_provenance_confidence: BEHAVIOR_PREF_CONFIDENCE,
      });
      if (rpcErr) {
        ctx.log(`write_fact ${factKey} failed for ${userId.slice(0, 8)}…: ${rpcErr.message}`);
        continue;
      }
      wroteAny = true;
      actionsTaken++;
    }
    if (wroteAny) usersAffected++;
  }

  await ctx.emitEvent('autopilot.memory.behavior_preferences_written', {
    users_scanned: userIds.length,
    users_with_new_preferences: usersAffected,
    facts_written: actionsTaken,
  });
  return { usersAffected, actionsTaken };
}

// ── AP-0909: Relationship Graph Projection ──────────────────
// The graph is a DERIVED INDEX over memory_facts + app social events —
// never a second extraction write-path (that dual-write drift is why
// Cognee was retired in Phase 8). Nightly, idempotent, fully rebuildable:
//
//   1. Person-facts (spouse_name, friend_name_*, child_name, …) →
//      relationship_nodes (node_type 'person', owner-scoped in metadata)
//      + a person→node edge carrying the relation as edge_type.
//   2. Mutual follows → person↔person 'connected' edges — exactly the
//      shape AP-0801's social-comfort gate already counts.
//
// Loop 13 (nightly consolidator) stays the ONLY strength-decay mechanism.
// Column names follow the LIVE relationship_edges schema (source_type/
// source_id/target_type/target_id/edge_type/last_interaction_at), which
// diverged from the VTID-01087 migration file — verified 2026-07-06.
const GRAPH_PROJECT_MAX_FACTS_PER_RUN = 1000;
const GRAPH_PROJECT_MAX_FOLLOWS = 5000;
const GRAPH_PROJECT_MAX_NAME_LEN = 60;

const PERSON_FACT_RELATIONS: Array<{ pattern: RegExp; relation: string }> = [
  { pattern: /^(spouse|husband|wife)_name/, relation: 'spouse' },
  { pattern: /^(fiancee|fiance)_name/, relation: 'fiancee' },
  { pattern: /^partner_name/, relation: 'partner' },
  { pattern: /^(mother|father|parent)_name/, relation: 'parent' },
  { pattern: /^(child|son|daughter)_name/, relation: 'child' },
  { pattern: /^grandchild_name/, relation: 'grandchild' },
  { pattern: /^(sister|brother|sibling)_name/, relation: 'sibling' },
  { pattern: /^(user_)?friend_name/, relation: 'friend' },
  { pattern: /^colleague_name/, relation: 'colleague' },
];

function relationForFactKey(factKey: string): string | null {
  for (const { pattern, relation } of PERSON_FACT_RELATIONS) {
    if (pattern.test(factKey)) return relation;
  }
  return null;
}

async function runRelationshipGraphProjection(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  const nowIso = new Date().toISOString();
  let nodesCreated = 0;
  let edgesCreated = 0;
  const usersTouched = new Set<string>();

  // ---- 1. Disclosed persons from memory_facts ----
  const { data: facts, error: factsErr } = await supabase
    .from('memory_facts')
    .select('user_id, fact_key, fact_value, extracted_at')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .like('fact_key', '%name%')
    .limit(GRAPH_PROJECT_MAX_FACTS_PER_RUN);
  if (factsErr) {
    ctx.log(`person-fact scan failed: ${factsErr.message}`);
  }

  for (const fact of (facts || []) as Array<{ user_id: string; fact_key: string; fact_value: string; extracted_at: string }>) {
    try {
      const relation = relationForFactKey(fact.fact_key || '');
      const name = String(fact.fact_value || '').trim();
      if (!relation || !fact.user_id || !name || name.length > GRAPH_PROJECT_MAX_NAME_LEN) continue;

      // Node: one 'person' node per (owner, name) — owner-scoped so two
      // users' "Maria" never merge.
      const { data: existingNode } = await supabase
        .from('relationship_nodes')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('node_type', 'person')
        .eq('title', name)
        .eq('metadata->>owner_user_id', fact.user_id)
        .maybeSingle();
      let nodeId = (existingNode as { id?: string } | null)?.id ?? null;
      if (!nodeId) {
        const { data: inserted, error: insErr } = await supabase
          .from('relationship_nodes')
          .insert({
            tenant_id: tenantId,
            node_type: 'person',
            title: name,
            domain: 'community',
            metadata: {
              owner_user_id: fact.user_id,
              relation,
              fact_key: fact.fact_key,
              origin: 'memory_facts_projection',
            },
          })
          .select('id')
          .single();
        if (insErr || !inserted) {
          ctx.log(`node insert failed for ${fact.fact_key}: ${insErr?.message}`);
          continue;
        }
        nodeId = (inserted as { id: string }).id;
        nodesCreated++;
      }

      // Edge: user →(suggested)→ person node. Live CHECK constraints limit
      // edge_type to community values and target_type to entity kinds —
      // verified on staging 2026-07-06, where relation-typed edges were
      // rejected. 'suggested' (NOT 'connected') is deliberate: consumers of
      // person/connected edges treat target_id as an APP USER id (AP-1403
      // notifies it; AP-0801 counts it as social comfort) — a disclosed
      // person's target_id is a relationship_nodes UUID, so it must never
      // enter the connected set. The REAL relation (spouse/friend/…)
      // travels in metadata.relation; last_interaction_at tracks the fact's
      // recency so Loop 13's decay stays honest.
      const { data: existingEdge } = await supabase
        .from('relationship_edges')
        .select('id')
        .eq('tenant_id', tenantId)
        .eq('source_type', 'person')
        .eq('source_id', fact.user_id)
        .eq('target_type', 'person')
        .eq('target_id', nodeId)
        .eq('edge_type', 'suggested')
        .maybeSingle();
      if (existingEdge) {
        await supabase
          .from('relationship_edges')
          .update({ last_interaction_at: fact.extracted_at || nowIso, updated_at: nowIso })
          .eq('id', (existingEdge as { id: string }).id);
      } else {
        const { error: edgeErr } = await supabase.from('relationship_edges').insert({
          tenant_id: tenantId,
          source_type: 'person',
          source_id: fact.user_id,
          target_type: 'person',
          target_id: nodeId,
          edge_type: 'suggested',
          strength: 10,
          last_interaction_at: fact.extracted_at || nowIso,
          metadata: { origin: 'memory_facts_projection', relation, fact_key: fact.fact_key },
        });
        if (edgeErr) {
          ctx.log(`edge insert failed for ${fact.fact_key}: ${edgeErr.message}`);
          continue;
        }
        edgesCreated++;
      }
      usersTouched.add(fact.user_id);
    } catch (err: any) {
      ctx.log(`projection failed for fact ${fact.fact_key}: ${err?.message}`);
    }
  }

  // ---- 2. Mutual follows → person↔person 'connected' edges ----
  const { data: follows, error: followErr } = await supabase
    .from('user_follows')
    .select('follower_id, following_id')
    .limit(GRAPH_PROJECT_MAX_FOLLOWS);
  if (followErr) {
    ctx.log(`user_follows scan failed: ${followErr.message}`);
  } else {
    const pairs = new Set(
      ((follows || []) as Array<{ follower_id: string; following_id: string }>).map(
        (f) => `${f.follower_id}>${f.following_id}`,
      ),
    );
    for (const pair of pairs) {
      const [a, b] = pair.split('>');
      if (!a || !b || a === b || !pairs.has(`${b}>${a}`)) continue;
      if (a > b) continue; // handle each mutual pair once; write both directions below
      for (const [src, tgt] of [[a, b], [b, a]] as Array<[string, string]>) {
        try {
          const { data: existing } = await supabase
            .from('relationship_edges')
            .select('id')
            .eq('tenant_id', tenantId)
            .eq('source_type', 'person')
            .eq('source_id', src)
            .eq('target_type', 'person')
            .eq('target_id', tgt)
            .eq('edge_type', 'connected')
            .maybeSingle();
          if (existing) continue;
          const { error: edgeErr } = await supabase.from('relationship_edges').insert({
            tenant_id: tenantId,
            source_type: 'person',
            source_id: src,
            target_type: 'person',
            target_id: tgt,
            edge_type: 'connected',
            strength: 10,
            last_interaction_at: nowIso,
            metadata: { origin: 'mutual_follow_projection' },
          });
          if (edgeErr) {
            ctx.log(`connected-edge insert failed: ${edgeErr.message}`);
            continue;
          }
          edgesCreated++;
          usersTouched.add(src);
        } catch (err: any) {
          ctx.log(`follow projection failed: ${err?.message}`);
        }
      }
    }
  }

  await ctx.emitEvent('autopilot.memory.graph_projected', {
    nodes_created: nodesCreated,
    edges_created: edgesCreated,
    users_touched: usersTouched.size,
  });
  return { usersAffected: usersTouched.size, actionsTaken: nodesCreated + edgesCreated };
}

// ── AP-0910: Memory Embedding Backfill ──────────────────────
// Only ~4% of live memory_facts carried embeddings (the inline extractor's
// REST write path never embedded), leaving tier-2 semantic fact retrieval
// blind. New writes now embed inline (inline-fact-extractor); this backfill
// drains the historical backlog and catches any write-path misses. Hourly,
// bounded, no-ops cheaply once the backlog is empty.
const EMBED_BACKFILL_BATCH = 100;

async function runMemoryEmbeddingBackfill(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;

  const { data: rows, error } = await supabase
    .from('memory_facts')
    .select('id, fact_key, fact_value')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .is('embedding', null)
    .limit(EMBED_BACKFILL_BATCH);
  if (error) {
    ctx.log(`backlog scan failed: ${error.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
  if (!rows?.length) return { usersAffected: 0, actionsTaken: 0 };

  const { generateBatchEmbeddings } = await import('../embedding-service');
  const texts = (rows as Array<{ fact_key: string; fact_value: string }>).map(
    (r) => `${r.fact_key}: ${r.fact_value}`,
  );
  const batch = await generateBatchEmbeddings(texts);
  if (!batch.ok || !batch.embeddings) {
    ctx.log(`batch embedding failed: ${batch.error}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  let embedded = 0;
  const nowIso = new Date().toISOString();
  for (let i = 0; i < rows.length; i++) {
    const vec = batch.embeddings[i];
    if (!Array.isArray(vec)) continue;
    const { error: upErr } = await supabase
      .from('memory_facts')
      .update({
        embedding: JSON.stringify(vec),
        embedding_model: batch.model || 'text-embedding-3-small',
        embedding_updated_at: nowIso,
      })
      .eq('id', (rows[i] as { id: string }).id);
    if (upErr) {
      ctx.log(`embedding store failed for ${(rows[i] as { id: string }).id}: ${upErr.message}`);
      continue;
    }
    embedded++;
  }

  await ctx.emitEvent('autopilot.memory.embeddings_backfilled', {
    scanned: rows.length,
    embedded,
  });
  return { usersAffected: 0, actionsTaken: embedded };
}

// ── AP-0911: User Model Synthesis ───────────────────────────
// Nightly narrative profile per active user (see user-model-synthesis.ts):
// one LLM pass connects facts + routines + goal + Vitana Index into a
// compact "who is this person" paragraph the ORB bootstrap injects at zero
// latency cost. Skips users with <3 facts and unchanged inputs.
const SYNTHESIS_MAX_USERS_PER_RUN = 100;

async function runUserModelSynthesis(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;

  const { data: factRows, error } = await supabase
    .from('memory_facts')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .is('superseded_at', null)
    .limit(10000);
  if (error) {
    ctx.log(`fact scan failed: ${error.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }
  const counts = new Map<string, number>();
  for (const r of (factRows || []) as Array<{ user_id: string }>) {
    if (r.user_id) counts.set(r.user_id, (counts.get(r.user_id) || 0) + 1);
  }
  const userIds = [...counts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SYNTHESIS_MAX_USERS_PER_RUN)
    .map(([id]) => id);

  const { synthesizeUserModel } = await import('../user-model-synthesis');
  let written = 0;
  for (const userId of userIds) {
    try {
      const result = await synthesizeUserModel(supabase, tenantId, userId);
      if (result.written) written++;
    } catch (err: any) {
      ctx.log(`synthesis failed for ${userId.slice(0, 8)}…: ${err?.message}`);
    }
  }

  await ctx.emitEvent('autopilot.memory.profiles_synthesized', {
    users_scanned: userIds.length,
    narratives_written: written,
  });
  return { usersAffected: written, actionsTaken: written };
}

// ── AP-0912: Health Correlation Insights ────────────────────
// The "sees contextual influence" differentiator, made concrete with
// DETERMINISTIC rules (no LLM → no hallucinated health claims). Each rule
// writes a health_insight_* memory fact (provenance system_observed) via
// write_fact — auto-superseded when the picture changes, and surfaced to
// the user through the same felt-learning detector as every other fact.
//   R1: a pillar moved ≥ INSIGHT_PILLAR_DELTA over ~7 days → trend insight.
//   R2: diary went silent after a consistent streak → lapse insight.
const INSIGHT_PILLAR_DELTA = 10;
const INSIGHT_MAX_USERS_PER_RUN = 200;
const PILLAR_COLUMNS = ['score_sleep', 'score_nutrition', 'score_exercise', 'score_hydration', 'score_mental'] as const;

async function runHealthCorrelationInsights(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  const now = Date.now();
  const since14d = new Date(now - 14 * 86_400_000).toISOString().slice(0, 10);

  const { data: scoreRows, error } = await supabase
    .from('vitana_index_scores')
    .select('user_id, date, score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
    .eq('tenant_id', tenantId)
    .gte('date', since14d)
    .order('date', { ascending: true })
    .limit(10000);
  if (error) {
    ctx.log(`index scan failed: ${error.message}`);
    return { usersAffected: 0, actionsTaken: 0 };
  }

  const byUser = new Map<string, Array<Record<string, any>>>();
  for (const row of (scoreRows || []) as Array<Record<string, any>>) {
    if (!row.user_id) continue;
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id)!.push(row);
  }

  const writeInsight = async (userId: string, key: string, value: string) => {
    const { error: rpcErr } = await supabase.rpc('write_fact', {
      p_tenant_id: tenantId,
      p_user_id: userId,
      p_fact_key: key,
      p_fact_value: value,
      p_entity: 'self',
      p_fact_value_type: 'text',
      p_provenance_source: 'system_observed',
      p_provenance_confidence: 0.9,
    });
    if (rpcErr) {
      ctx.log(`insight write ${key} failed for ${userId.slice(0, 8)}…: ${rpcErr.message}`);
      return false;
    }
    return true;
  };

  let usersAffected = 0;
  let actionsTaken = 0;
  const userIds = [...byUser.keys()].slice(0, INSIGHT_MAX_USERS_PER_RUN);

  for (const userId of userIds) {
    const rows = byUser.get(userId)!;
    if (rows.length < 4) continue; // too little signal for a defensible trend
    let wroteAny = false;

    // R1 — pillar trend: first vs last reading in the window.
    const first = rows[0];
    const last = rows[rows.length - 1];
    for (const col of PILLAR_COLUMNS) {
      const a = Number(first[col]);
      const b = Number(last[col]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const delta = b - a;
      if (Math.abs(delta) < INSIGHT_PILLAR_DELTA) continue;
      const pillar = col.replace('score_', '');
      const direction = delta > 0 ? 'improved' : 'declined';
      const ok = await writeInsight(
        userId,
        `health_insight_${pillar}_trend`,
        `${pillar} pillar ${direction} by ${Math.abs(Math.round(delta))} points over the last two weeks`,
      );
      if (ok) {
        wroteAny = true;
        actionsTaken++;
      }
    }

    if (wroteAny) usersAffected++;
  }

  // R2 — diary lapse: entries in the previous week but none in the last one.
  const since7dIso = new Date(now - 7 * 86_400_000).toISOString();
  const since14dIso = new Date(now - 14 * 86_400_000).toISOString();
  const { data: diaryRows } = await supabase
    .from('diary_entries')
    .select('user_id, created_at')
    .gte('created_at', since14dIso)
    .limit(5000);
  const diaryByUser = new Map<string, { recent: number; prior: number }>();
  for (const row of (diaryRows || []) as Array<{ user_id: string; created_at: string }>) {
    if (!row.user_id) continue;
    const bucket = diaryByUser.get(row.user_id) || { recent: 0, prior: 0 };
    if (row.created_at >= since7dIso) bucket.recent++;
    else bucket.prior++;
    diaryByUser.set(row.user_id, bucket);
  }
  for (const [userId, bucket] of diaryByUser) {
    if (bucket.prior >= 3 && bucket.recent === 0) {
      const ok = await writeInsight(
        userId,
        'health_insight_diary_lapse',
        `stopped diary entries this week after ${bucket.prior} entries the week before`,
      );
      if (ok) {
        actionsTaken++;
        usersAffected++;
      }
    }
  }

  await ctx.emitEvent('autopilot.memory.health_insights_written', {
    users_with_insights: usersAffected,
    insights_written: actionsTaken,
  });
  return { usersAffected, actionsTaken };
}

export function registerMemoryIntelligenceHandlers(): void {
  registerHandler('runMemoryInformedMatching', runMemoryInformedMatching);
  registerHandler('runFactExtractionAudit', runFactExtractionAudit);
  registerHandler('runRelationshipGraphProjection', runRelationshipGraphProjection);
  registerHandler('runSemanticMemoryContextForAutopilot', runSemanticMemoryContextForAutopilot);
  registerHandler('runKnowledgeBaseContextForSuggestions', runKnowledgeBaseContextForSuggestions);
  registerHandler('runRoutinePatternExtraction', runRoutinePatternExtraction);
  registerHandler('runDailyLearningDigest', runDailyLearningDigest);
  registerHandler('runBehaviorPreferenceInference', runBehaviorPreferenceInference);
  registerHandler('runMemoryEmbeddingBackfill', runMemoryEmbeddingBackfill);
  registerHandler('runUserModelSynthesis', runUserModelSynthesis);
  registerHandler('runHealthCorrelationInsights', runHealthCorrelationInsights);
}
