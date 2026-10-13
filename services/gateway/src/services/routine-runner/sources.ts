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
 * voice-lab-triage is deliberately absent (VTID-05103 amendment A1): its
 * spec reads time windows and error codes that /voice-lab/live/sessions does
 * not provide, so a port would be green forever. See routines/voice-lab-triage.md.
 */

import {
  auditAutopilotRecs,
  auditDykTourProgress,
  auditIoPressure,
  auditKnowledgeDocsStaleness,
  auditMobileScreenLatency,
  auditOasisSummary,
  auditSpecMemoryQuarantine,
  auditVitanaIndex,
} from '../../routes/routine-audits';
import { readAgentsRegistry } from '../../routes/agents-registry';
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
  { name: 'vitana-index-health', hour: 7, minute: 30, run: async () => checkVitanaIndexHealth(await auditVitanaIndex()) },
  {
    name: 'knowledge-docs-freshness',
    hour: 9,
    minute: 0,
    run: async () => checkKnowledgeDocsFreshness(await auditKnowledgeDocsStaleness({ staleAfterDays: 180 })),
  },
  { name: 'dyk-tour-progress', hour: 10, minute: 30, run: async () => checkDykTourProgress(await auditDykTourProgress()) },
  { name: 'spec-memory-quarantine', hour: 11, minute: 0, run: async () => checkSpecMemoryQuarantine(await auditSpecMemoryQuarantine()) },
];
