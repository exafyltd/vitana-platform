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

// ── AP-0903: Relationship Graph Maintenance ─────────────────
// Decays relationship_edges.strength for edges with no interaction in 90+
// days (real last_interaction_at column), keeping match/social-proof
// automations from over-weighting stale connections.
const GRAPH_DECAY_STALE_DAYS = 90;
const GRAPH_DECAY_AMOUNT = 10;
const GRAPH_DECAY_MAX_EDGES_PER_RUN = 500;

async function runRelationshipGraphMaintenance(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let actionsTaken = 0;

  const staleCutoff = new Date(Date.now() - GRAPH_DECAY_STALE_DAYS * 86_400_000).toISOString();

  const { data: staleEdges } = await supabase
    .from('relationship_edges')
    .select('id, strength')
    .eq('tenant_id', tenantId)
    .lt('last_interaction_at', staleCutoff)
    .gt('strength', 0)
    .limit(GRAPH_DECAY_MAX_EDGES_PER_RUN);

  for (const edge of staleEdges || []) {
    const newStrength = Math.max(0, (edge.strength || 0) - GRAPH_DECAY_AMOUNT);
    await supabase.from('relationship_edges').update({ strength: newStrength }).eq('id', edge.id);
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.memory.graph_edges_decayed', { edges_decayed: actionsTaken });
  return { usersAffected: 0, actionsTaken };
}

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

export function registerMemoryIntelligenceHandlers(): void {
  registerHandler('runMemoryInformedMatching', runMemoryInformedMatching);
  registerHandler('runFactExtractionAudit', runFactExtractionAudit);
  registerHandler('runRelationshipGraphMaintenance', runRelationshipGraphMaintenance);
  registerHandler('runSemanticMemoryContextForAutopilot', runSemanticMemoryContextForAutopilot);
  registerHandler('runKnowledgeBaseContextForSuggestions', runKnowledgeBaseContextForSuggestions);
  registerHandler('runRoutinePatternExtraction', runRoutinePatternExtraction);
  registerHandler('runDailyLearningDigest', runDailyLearningDigest);
  registerHandler('runBehaviorPreferenceInference', runBehaviorPreferenceInference);
}
