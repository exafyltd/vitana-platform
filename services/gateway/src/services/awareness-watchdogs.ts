/**
 * VTID-02859: Awareness Watchdogs manifest.
 *
 * The 10 watchdogs that verify each awareness signal is firing on
 * production sessions. Each watchdog watches one or more signal keys
 * (from services/awareness-registry.ts) and joins telemetry from
 * `oasis_events` to produce an "is the signal alive in the last N
 * sessions?" verdict.
 *
 * The /api/v1/voice/awareness/watchdogs endpoint returns this manifest
 * with optional last-run / last-result fields populated from telemetry.
 * Today the timestamps come from oasis_events scans; future iterations
 * can promote the watchdog to a scheduled probe.
 *
 * Adding a watchdog is a typed-array entry, no schema change.
 */

import { getSupabase } from '../lib/supabase';

export type WatchdogVerdict = 'pass' | 'fail' | 'partial' | 'unknown';

export interface AwarenessWatchdog {
  /** Stable id: dot-notation, snake_case. */
  id: string;
  /** Operator-readable name. */
  name: string;
  /** What this watchdog verifies in one sentence. */
  description: string;
  /** Awareness signal keys (from awareness-registry) this watchdog covers. */
  watches: string[];
  /** Source-of-truth file:line so an operator can jump to the gate. */
  source_hint?: string;
  /**
   * Telemetry probe: oasis_events `topic` filter to scan. The endpoint
   * picks the most recent matching row's timestamp + actor/payload as
   * "last_run". A row within the last 24h means pass.
   */
  oasis_topic?: string;
}

const WATCHDOGS: AwarenessWatchdog[] = [
  {
    id: 'identity_lock_active',
    name: 'Identity Lock active',
    description: 'Authoritative role + tenant headers are flowing into orb-live for every session.',
    watches: ['identity.user_id', 'identity.tenant_id', 'identity.active_role'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
    oasis_topic: 'vtid.live.session.start',
  },
  {
    id: 'environment_context_geo',
    name: 'Environment context (geo + time)',
    description: 'IP geo + timezone + time-of-day sections are present in the bootstrap context.',
    watches: ['context.client.city', 'context.client.country', 'context.client.timezone', 'context.client.time_of_day'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
    oasis_topic: 'vtid.live.session.start',
  },
  {
    id: 'memory_facts_injected',
    name: 'Memory facts injected',
    description: 'High-confidence memory_facts rows are being injected into ORB sessions.',
    watches: ['memory.facts.enabled'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
    // VTID-02903: orb.memory.context_injected isn't a real topic. Memory
    // facts are injected at session start, so we lean on vtid.live.session.start
    // as the proxy. A more granular topic could be added later if/when memory
    // injection becomes a separate emit.
    oasis_topic: 'vtid.live.session.start',
  },
  {
    id: 'temporal_journey_block',
    name: 'Temporal + journey context block',
    description: 'currentRoute + recentRoutes ring + journey_stage are present in the prompt.',
    watches: ['context.current_route', 'context.recent_routes', 'context.journey_stage', 'overrides.temporal_journey'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
    oasis_topic: 'vtid.live.session.start',
  },
  {
    id: 'navigator_policy_section',
    name: 'Navigator policy section',
    description: 'Navigator routing rules section is appended to the prompt (gates wired; prose missing).',
    watches: ['overrides.navigator_policy'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
    oasis_topic: 'orb.navigator.consulted',
  },
  {
    id: 'conversation_summary',
    name: 'Conversation summary',
    description: 'Returning-user bridge summary text — currently NOT_WIRED (returns null).',
    watches: ['context.conversation_summary'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
  },
  {
    id: 'conversation_history_reconnect',
    name: 'Conversation history (reconnect)',
    description: 'Last 10 turns are fed back when a session reconnects — currently NOT_WIRED.',
    watches: ['context.conversation_history'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
  },
  {
    id: 'proactive_opener_override',
    name: 'Proactive opener override',
    description: 'PROACTIVE OPENER OVERRIDE block appended after temporal — currently NOT_WIRED.',
    watches: ['overrides.proactive_opener', 'brain.opener.enabled'],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
  },
  {
    id: 'health_pillar_data',
    name: 'Health Pillar Data (Vitana Index)',
    description: 'Health pillars + Vitana Index score sections are present in the prompt.',
    watches: [],
    source_hint: 'services/gateway/src/routes/orb-live.ts',
    oasis_topic: 'vtid.live.session.start',
  },
  {
    id: 'surface_scoping',
    name: 'Surface scoping (mobile community coercion)',
    description: 'Surface header + mobile-community role coercion gate every tool call.',
    watches: ['identity.surface'],
    source_hint: 'services/gateway/src/middleware/auth-supabase-jwt.ts',
    // VTID-02903: real topic is orb.live.tool.executed (not orb.tool.invoked).
    oasis_topic: 'orb.live.tool.executed',
  },
];

/**
 * In-memory annotation merged from oasis_events. Built fresh on each
 * /api/v1/voice/awareness/watchdogs request. We deliberately don't
 * pre-compute / cache this — the volume is tiny (10 watchdogs × 1
 * Supabase query each, batched) and operators expect fresh-on-load.
 */
export interface WatchdogStatus {
  watchdog: AwarenessWatchdog;
  verdict: WatchdogVerdict;
  last_run_at: string | null;
  last_result_summary: string | null;
}

/** Pass = topic emitted at least once in the last 24h. */
const PASS_WINDOW_HOURS = 24;

export async function getWatchdogStatuses(): Promise<WatchdogStatus[]> {
  const sb = getSupabase();
  const out: WatchdogStatus[] = [];

  // Build the union of unique topics so we hit Supabase once for telemetry.
  const topics = Array.from(
    new Set(WATCHDOGS.map((w) => w.oasis_topic).filter((t): t is string => !!t)),
  );

  let mostRecentByTopic: Record<string, string> = {};
  if (sb && topics.length > 0) {
    const since = new Date(Date.now() - PASS_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const { data } = await sb
      .from('oasis_events')
      .select('topic, created_at')
      .in('topic', topics)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(500);
    for (const row of (data || []) as Array<{ topic: string; created_at: string }>) {
      if (!mostRecentByTopic[row.topic]) {
        mostRecentByTopic[row.topic] = row.created_at;
      }
    }
  }

  for (const w of WATCHDOGS) {
    const lastRun = w.oasis_topic ? mostRecentByTopic[w.oasis_topic] || null : null;
    let verdict: WatchdogVerdict = 'unknown';
    let summary: string | null = null;
    if (!w.oasis_topic) {
      verdict = 'unknown';
      summary = 'No telemetry topic configured — manual probe required.';
    } else if (lastRun) {
      verdict = 'pass';
      summary = `Topic '${w.oasis_topic}' fired at ${lastRun}.`;
    } else {
      verdict = 'fail';
      summary = `Topic '${w.oasis_topic}' has no rows in the last ${PASS_WINDOW_HOURS}h.`;
    }
    out.push({ watchdog: w, verdict, last_run_at: lastRun, last_result_summary: summary });
  }
  return out;
}

export function getWatchdogManifest(): readonly AwarenessWatchdog[] {
  return WATCHDOGS;
}
