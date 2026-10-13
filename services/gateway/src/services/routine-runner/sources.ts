/**
 * VTID-05103 — Routine registry for the in-gateway runner.
 *
 * Each entry pairs a routine with its daily UTC time (from its spec's
 * "Schedule" line), the data it reads and the check in checks.ts. The data
 * comes from the SAME functions the HTTP audit routes use — no loader calls
 * HTTP and no new queries are written:
 *   - 8 routines: the exported audit* functions in routes/routine-audits.ts
 *   - agents-heartbeat: readAgentsRegistry() in routes/agents-registry.ts
 *
 * VTID-05141 (Phase 3b) adds voice-lab-triage (reads voice_session_facts —
 * /voice-lab/live/sessions has no time window, so VTID-05103 left it out),
 * llm-spend-budget (the shadow budgets in orchestrator/budgets.ts, alert only)
 * and llm-fallback-watch (isGoogleLlmCall over llm.call.completed).
 *
 * VTID-05148 (Phase 4) adds learn-outcomes (loop L3 Learn, learn-outcomes.ts):
 * tests_added per fix PR, write_test findings for escaped bugs, the L3
 * metrics, and graduation proposals on Mondays (UTC).
 *
 * VTID-05153 (Phase 5) adds supplier-catalog-check (loop L9 Supplier catalog,
 * services/catalog-check/run.ts): deterministic checks of at most 20 supplier
 * rows of one category per run, one result per row, the L9 metrics.
 */

async function googleCallsLast24h() {
  const { createAttentionReads } = require('../ops-attention-reads');
  const rows = await createAttentionReads().llmGoogleCalls(new Date(Date.now() - LLM_GOOGLE_WINDOW_MS).toISOString());
  return rows.filter(isGoogleLlmCall);
}

async function spendToday() {
  const { getSupabase } = require('../../lib/supabase');
  const sb = getSupabase();
  if (!sb) throw new Error('Supabase client not configured');
  const { rows, since, truncated, error } = await loadSpendToday(sb);
  if (error) throw new Error(`oasis_events (llm.call.completed): ${error}`);
  return { rows: rows.length, since, truncated, lines: budgetLines(aggregateSpend(rows)) };
}

import {
  auditAutopilotRecs,
  auditDykTourProgress,
  auditIoPressure,
  auditKnowledgeDocsStaleness,
  auditMobileScreenLatency,
  auditOasisSummary,
  auditSpecMemoryQuarantine,
  auditVitanaIndex,
  auditVoiceSessionOutcomes,
} from '../../routes/routine-audits';
import { aggregateSpend, budgetLines, loadSpendToday } from '../orchestrator/budgets';
import { isGoogleLlmCall, LLM_GOOGLE_WINDOW_MS } from '../ops-attention-adapters';
import { readAgentsRegistry } from '../../routes/agents-registry';
import { runLearnOutcomes } from './learn-outcomes';
import { runSupplierCatalogCheck } from '../catalog-check/run';
import {
  RoutineVerdict,
  checkAgentsHeartbeat,
  checkAutopilotRecQuality,
  checkDykTourProgress,
  checkKnowledgeDocsFreshness,
  checkMobileScreenLatency,
  checkOasisEventAnomaly,
  checkSpecMemoryQuarantine,
  checkSupabaseIoAudit,
  checkVitanaIndexHealth,
  checkVoiceLabTriage,
  checkLlmSpendBudget,
  checkLlmFallbackWatch,
} from './checks';

export interface RunnerRoutine {
  name: string;
  /** Daily run time, UTC — the routine's documented cron schedule. */
  hour: number;
  minute: number;
  run: () => Promise<RoutineVerdict>;
}

export const RUNNER_ROUTINES: readonly RunnerRoutine[] = [
  {
    name: 'voice-lab-triage',
    hour: 4,
    minute: 30,
    run: async () => {
      const yesterday = await auditVoiceSessionOutcomes({ sinceHours: 24 });
      const baseline = await auditVoiceSessionOutcomes({ sinceHours: 192, untilHours: 24 });
      return checkVoiceLabTriage(yesterday, baseline);
    },
  },
  {
    name: 'agents-heartbeat',
    hour: 5,
    minute: 30,
    run: async () => {
      const r = await readAgentsRegistry();
      if (!r.ok) return { status: 'failure', summary: `❌ Could not read the agents registry: ${r.error}`, findings: {} };
      return checkAgentsHeartbeat(r);
    },
  },
  { name: 'supabase-io-audit', hour: 6, minute: 0, run: async () => checkSupabaseIoAudit(await auditIoPressure()) },
  {
    name: 'mobile-screen-latency-rollup',
    hour: 6,
    minute: 15,
    run: async () => {
      const allUp = await auditMobileScreenLatency({ windowHours: 24 });
      const ios = await auditMobileScreenLatency({ windowHours: 24, platform: 'ios' });
      const android = await auditMobileScreenLatency({ windowHours: 24, platform: 'android' });
      return checkMobileScreenLatency(allUp, { ios, android });
    },
  },
  { name: 'autopilot-rec-quality', hour: 6, minute: 30, run: async () => checkAutopilotRecQuality(await auditAutopilotRecs()) },
  {
    name: 'oasis-event-anomaly',
    hour: 7,
    minute: 0,
    run: async () => {
      const today = await auditOasisSummary({ windowHours: 24 });
      const baseline = await auditOasisSummary({ windowHours: 192, untilHours: 24 });
      return checkOasisEventAnomaly(today, baseline);
    },
  },
  { name: 'llm-fallback-watch', hour: 7, minute: 15, run: async () => checkLlmFallbackWatch(await googleCallsLast24h()) },
  { name: 'vitana-index-health', hour: 7, minute: 30, run: async () => checkVitanaIndexHealth(await auditVitanaIndex()) },
  {
    name: 'knowledge-docs-freshness',
    hour: 9,
    minute: 0,
    run: async () => checkKnowledgeDocsFreshness(await auditKnowledgeDocsStaleness({ staleAfterDays: 180 })),
  },
  { name: 'dyk-tour-progress', hour: 10, minute: 30, run: async () => checkDykTourProgress(await auditDykTourProgress()) },
  { name: 'spec-memory-quarantine', hour: 11, minute: 0, run: async () => checkSpecMemoryQuarantine(await auditSpecMemoryQuarantine()) },
  // L3 Learn; the graduation step inside it runs on Mondays (UTC) only.
  { name: 'learn-outcomes', hour: 12, minute: 0, run: async () => runLearnOutcomes() },
  // L9 Supplier catalog, wave 1: at most 20 supplement rows per run, results only, never publishes.
  { name: 'supplier-catalog-check', hour: 13, minute: 0, run: async () => runSupplierCatalogCheck() },
  // Budgets are per UTC day (budgets.ts), so the day's spend is read just before midnight.
  { name: 'llm-spend-budget', hour: 23, minute: 50, run: async () => checkLlmSpendBudget(await spendToday()) },
];
