/**
 * Memory & Intelligence Handlers — AP-0900 series
 *
 * VTID: VTID-01250
 * Automations built on the live memory_facts/relationship_nodes/relationship_edges
 * stack (VTID-01192/VTID-01087, documented in CLAUDE.md section 14).
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

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

  const trait = facts[0].fact_value;
  ctx.notify(userId, 'orb_suggestion', {
    title: 'A Match Worth a Second Look',
    body: `Based on what you've shared with your ORB about ${trait}, this match might be a great fit.`,
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

export function registerMemoryIntelligenceHandlers(): void {
  registerHandler('runMemoryInformedMatching', runMemoryInformedMatching);
  registerHandler('runFactExtractionAudit', runFactExtractionAudit);
  registerHandler('runRelationshipGraphMaintenance', runRelationshipGraphMaintenance);
  registerHandler('runSemanticMemoryContextForAutopilot', runSemanticMemoryContextForAutopilot);
  registerHandler('runKnowledgeBaseContextForSuggestions', runKnowledgeBaseContextForSuggestions);
}
