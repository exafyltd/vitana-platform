/**
 * BOOTSTRAP-MEMORY-ORCHESTRATOR-MANDATORY — admin status endpoint.
 *
 * Computes the "Memory Alive / Memory Dead" verdict for the Command Hub
 * card from the per-turn proof events the orchestrator emits:
 *
 *   memory.orchestrator.turn             — one per completed assistant turn
 *   memory.orchestrator.context_built    — one per orchestrator invocation
 *   memory.orchestrator.bypass_detected  — an assistant path skipped memory
 *
 * Verdict:
 *   alive    — turns exist, ≥95% had the memory block injected, and memory
 *              was actually retrieved (hits > 0) on at least one turn
 *   degraded — memory injected but retrieval is empty/failing, or soft
 *              bypasses were detected
 *   dead     — turns are shipping without the memory block, or enforced
 *              bypasses fired
 *   no_data  — no orchestrator activity in the window
 *
 * GET /api/v1/admin/memory-orchestrator/status?window_hours=24
 */

import { Router, Response } from 'express';
import {
  requireAuth,
  requireExafyAdmin,
  AuthenticatedRequest,
} from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { MEMORY_ORCHESTRATOR_EVENT_TYPES } from '../services/memory-orchestrator';

const router = Router();
// Path-scoped auth (mounted at /api/v1 — see VTID-02032 note in
// admin-memory-broker.ts for why router.use(requireAuth) is wrong here).
router.use('/admin/memory-orchestrator', requireAuth);
router.use('/admin/memory-orchestrator', requireExafyAdmin);

interface TurnPayload {
  memory_injected_to_prompt?: boolean;
  assistant_used_memory?: boolean;
  memory_hits?: number;
  facts_loaded?: number;
  goals_loaded?: number;
  preferences_loaded?: number;
  dismissed_loaded?: number;
  degraded_sources?: string[];
  channel?: string;
}

router.get('/admin/memory-orchestrator/status', async (req: AuthenticatedRequest, res: Response) => {
  const windowHours = Math.min(Math.max(Number(req.query.window_hours) || 24, 1), 168);
  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ ok: false, error: 'Database not configured' });
  }

  try {
    const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
    // oasis_events stores the event type in `topic` and the payload in
    // `metadata` (see oasis-event-service emit mapping) — verified against
    // production data 2026-07-03; `type`/`payload` columns do not exist.
    const { data, error } = await supabase
      .from('oasis_events')
      .select('topic, status, metadata, created_at')
      .in('topic', [
        MEMORY_ORCHESTRATOR_EVENT_TYPES.TURN,
        MEMORY_ORCHESTRATOR_EVENT_TYPES.CONTEXT_BUILT,
        MEMORY_ORCHESTRATOR_EVENT_TYPES.BYPASS_DETECTED,
      ])
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000);

    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }

    const events = data || [];
    const turns = events.filter((e) => e.topic === MEMORY_ORCHESTRATOR_EVENT_TYPES.TURN);
    const built = events.filter((e) => e.topic === MEMORY_ORCHESTRATOR_EVENT_TYPES.CONTEXT_BUILT);
    const bypasses = events.filter((e) => e.topic === MEMORY_ORCHESTRATOR_EVENT_TYPES.BYPASS_DETECTED);

    let injected = 0;
    let retrieved = 0;
    let used = 0;
    let hitsSum = 0;
    let factsSum = 0;
    let goalsSum = 0;
    let prefsSum = 0;
    const perChannel: Record<string, { turns: number; injected: number }> = {};
    for (const e of turns) {
      const p = (e.metadata || {}) as TurnPayload;
      if (p.memory_injected_to_prompt) injected++;
      if ((p.memory_hits ?? 0) > 0) retrieved++;
      if (p.assistant_used_memory) used++;
      hitsSum += p.memory_hits ?? 0;
      factsSum += p.facts_loaded ?? 0;
      goalsSum += p.goals_loaded ?? 0;
      prefsSum += p.preferences_loaded ?? 0;
      const ch = p.channel || 'unknown';
      perChannel[ch] = perChannel[ch] || { turns: 0, injected: 0 };
      perChannel[ch].turns++;
      if (p.memory_injected_to_prompt) perChannel[ch].injected++;
    }

    const degradedBuilds = built.filter(
      (e) => Array.isArray((e.metadata as any)?.degraded_sources) && (e.metadata as any).degraded_sources.length > 0,
    ).length;
    const enforcedBypasses = bypasses.filter((e) => (e.metadata as any)?.enforced === true).length;
    const softBypasses = bypasses.length - enforcedBypasses;
    const bypassCallers = Array.from(
      new Set(bypasses.map((e) => String((e.metadata as any)?.caller || 'unknown'))),
    ).slice(0, 10);

    const injectedRate = turns.length > 0 ? injected / turns.length : 0;
    const retrievalRate = turns.length > 0 ? retrieved / turns.length : 0;
    const usedRate = turns.length > 0 ? used / turns.length : 0;

    // Verdict — green ONLY when memory was retrieved AND injected.
    let status: 'alive' | 'degraded' | 'dead' | 'no_data';
    if (turns.length === 0 && built.length === 0) {
      status = 'no_data';
    } else if (enforcedBypasses > 0 || (turns.length > 0 && injectedRate < 0.9)) {
      status = 'dead';
    } else if (turns.length === 0 || retrieved === 0 || softBypasses > 0 || degradedBuilds > built.length / 2) {
      status = 'degraded';
    } else {
      status = 'alive';
    }

    return res.json({
      ok: true,
      status,
      memory_alive: status === 'alive',
      window_hours: windowHours,
      last_turn_at: turns[0]?.created_at ?? null,
      totals: {
        turns: turns.length,
        turns_injected: injected,
        turns_retrieved: retrieved,
        turns_used_memory: used,
        context_built: built.length,
        degraded_builds: degradedBuilds,
        bypasses_soft: softBypasses,
        bypasses_enforced: enforcedBypasses,
      },
      rates: {
        injected_rate: Number(injectedRate.toFixed(3)),
        retrieval_rate: Number(retrievalRate.toFixed(3)),
        used_rate: Number(usedRate.toFixed(3)),
      },
      averages_per_turn: {
        memory_hits: turns.length ? Number((hitsSum / turns.length).toFixed(1)) : 0,
        facts_loaded: turns.length ? Number((factsSum / turns.length).toFixed(1)) : 0,
        goals_loaded: turns.length ? Number((goalsSum / turns.length).toFixed(1)) : 0,
        preferences_loaded: turns.length ? Number((prefsSum / turns.length).toFixed(1)) : 0,
      },
      per_channel: perChannel,
      recent_bypass_callers: bypassCallers,
    });
  } catch (err: any) {
    console.error('[admin-memory-orchestrator] status failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;
