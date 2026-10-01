/**
 * VTID-04419 (Plan v1 WS-1.7) — the brain inspector's read model.
 *
 * For one voice session: what context was built (builder, size, what the
 * bootstrap packer kept, shortened or dropped, whether the stored snapshot
 * filled in, whether a reconnect rebuilt it), what the opening decision was
 * and why, what the tool catalog was trimmed to, and how the session ended.
 *
 * Everything is read from telemetry the gateway already emits to
 * `oasis_events` for that session, so the inspector adds no write path. The
 * reads are bounded by topic AND a time window, which the
 * (topic, created_at DESC) index serves as a range scan — never a scan of the
 * whole table (the shape behind the VTID-03980 I/O incident).
 *
 * The summarizer is pure. It never returns the user's email or user agent,
 * which the session-start event carries.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export const INSPECTOR_TOPICS = [
  'vtid.live.session.start',
  'vtid.live.session.stop',
  'orb.live.diag',
  'orb.live.context.bootstrap',
  'orb.live.context.bootstrap.skipped',
  'voice.latency.measured',
  'conversation.session.finalized',
] as const;

/** Read window after the session start. Sessions run minutes, not hours. */
export const INSPECTOR_WINDOW_MS = 2 * 60 * 60 * 1000;
export const INSPECTOR_MAX_EVENTS = 800;
export const INSPECTOR_LOOKBACK_DAYS = 14;
export const TIMELINE_MAX = 150;

export interface InspectorEventRow {
  topic: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

export interface SessionListItem {
  session_id: string;
  started_at: string;
  user_id: string | null;
  lang: string | null;
  transport: string | null;
  origin: string | null;
}

export interface SessionBrainSummary {
  session_id: string;
  found: boolean;
  started_at: string | null;
  user: { user_id: string | null; lang: string | null; transport: string | null; origin: string | null };
  context: {
    builder: string | null;
    brain_error: string | null;
    bootstrap_chars: number | null;
    bootstrap_latency_ms: number | null;
    skipped_reason: string | null;
    packing: {
      chars_before: number | null;
      chars_after: number | null;
      packed: boolean;
      kept: string[];
      shortened: string[];
      dropped: string[];
    } | null;
    gate: { timed_out: boolean | null; context_source: string | null; waited_ms: number | null } | null;
    setup_context_chars: number | null;
    setup_context_source: string | null;
    snapshot_used: { chars: number | null; fresh_timed_out: boolean | null } | null;
    rebuilt_on_reconnect: Array<{ at: string; builder: string | null; started_builder: string | null; chars: number | null; brain_error: string | null }>;
    /**
     * VTID-04525 (hub B2): the system-instruction byte budget per upstream
     * setup — the latest one wins; `setups` counts them (reconnects included).
     */
    instruction_budget?: {
      budget_bytes: number | null;
      total_bytes_before: number | null;
      total_bytes_after: number | null;
      trimmed_sections: string[];
      still_over_budget: boolean | null;
      section_bytes: Record<string, number>;
      setups: number;
    } | null;
  };
  decision: Array<{
    at: string;
    wake_opener: string | null;
    register: string | null;
    bucket: string | null;
    nba: string | null;
    nba_domain: string | null;
    current_route: string | null;
    lang: string | null;
    /** VTID-04420: the provider whose candidate won the ranker, and whether it was spoken. */
    candidate_provider: string | null;
    candidate_kind: string | null;
    candidate_spoken: boolean | null;
    candidate_outranked_by: string | null;
  }>;
  /**
   * VTID-04420 (WS-2.1): every continuation provider's result for this
   * session's opening, read from `orb_wake_timelines` (one row per session,
   * keyed by session id). Null when no timeline was recorded.
   */
  candidates: {
    selected_kind: string | null;
    none_with_reason: string | null;
    duration_ms: number | null;
    providers: Array<{ key: string; status: string; latency_ms: number | null; reason: string | null }>;
    /** VTID-04422: the shadow relevance ranking recorded beside the live one. */
    shadow: {
      weights_version: number | null;
      live_winner: string | null;
      shadow_winner: string | null;
      agree: boolean | null;
      scores: Array<{ provider: string; score: number | null; priority: number | null }>;
      /** VTID-04435: this user's weight adjustment, and the winner under the shared weights. */
      personal?: { evidence: number | null; outcome_mult: number | null; freshness_mult: number | null; shared_weights_winner: string | null } | null;
      /** VTID-04454: which ranking chose the opening, and the provider served. */
      ranking_mode?: string | null;
      served_winner?: string | null;
    } | null;
  } | null;
  tools: {
    bytes_before: number | null;
    bytes_after: number | null;
    dropped_count: number | null;
    provider: string | null;
    /** VTID-04426: context-aware selection, when it ran. */
    route_groups?: string[];
    contextual_kept?: number | null;
    deferred_reachable?: number | null;
    /** VTID-04426: find_tool calls and the tools use_tool ran. */
    searches?: number;
    deferred_used?: string[];
  } | null;
  /**
   * VTID-04427 (WS-3.2): the live advisor, when it ran. Counts and cost only —
   * the note text itself is never written to OASIS.
   */
  advisor?: {
    notes: number;
    skipped: Record<string, number>;
    reads: number;
    fresh_reads: number;
    cost_usd: number;
    latency_ms_max: number | null;
    suggested_tools: string[];
  } | null;
  errors: Array<{ at: string; stage: string; failure_kind: string | null; code: string | null }>;
  outcome: {
    stopped: boolean;
    stop_reason: string | null;
    turns: number | null;
    duration_ms: number | null;
    audio_out_chunks: number | null;
    first_audio_ms: number | null;
    /** First model audio after the user's turn, per turn (turn >= 1). */
    turn_first_audio_ms: Array<{ turn: number; ms: number }>;
    finalized: { reason: string | null; memory_committed: boolean | null; summary_written: boolean | null; threads_written: number | null } | null;
  };
  timeline: Array<{ t_ms: number; topic: string; stage: string | null }>;
  events_read: number;
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}
function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}
function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 60) : [];
}

const ERROR_STAGES = new Set(['upstream_error', 'upstream_ws_error', 'nova_stream_error', 'stall_detected', 'watchdog_fired']);

export function summarizeSessionEvents(sessionId: string, rows: InspectorEventRow[], opts: { truncated?: boolean } = {}): SessionBrainSummary {
  const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const start = sorted.find((r) => r.topic === 'vtid.live.session.start') ?? null;
  const startMs = start ? Date.parse(start.created_at) : sorted.length ? Date.parse(sorted[0].created_at) : 0;
  const sm = (start?.metadata ?? {}) as Record<string, unknown>;

  const summary: SessionBrainSummary = {
    session_id: sessionId,
    found: sorted.length > 0,
    started_at: start?.created_at ?? null,
    user: { user_id: str(sm.user_id), lang: str(sm.lang), transport: str(sm.transport), origin: str(sm.origin) },
    context: {
      builder: null,
      brain_error: null,
      bootstrap_chars: null,
      bootstrap_latency_ms: null,
      skipped_reason: null,
      packing: null,
      gate: null,
      setup_context_chars: null,
      setup_context_source: null,
      snapshot_used: null,
      rebuilt_on_reconnect: [],
    },
    decision: [],
    candidates: null,
    tools: null,
    errors: [],
    outcome: { stopped: false, stop_reason: null, turns: null, duration_ms: null, audio_out_chunks: null, first_audio_ms: null, turn_first_audio_ms: [], finalized: null },
    timeline: [],
    events_read: rows.length,
    truncated: !!opts.truncated,
  };

  for (const r of sorted) {
    const m = (r.metadata ?? {}) as Record<string, unknown>;
    const stage = str(m.stage);
    if (summary.timeline.length < TIMELINE_MAX) {
      summary.timeline.push({ t_ms: Math.max(0, Date.parse(r.created_at) - startMs), topic: r.topic, stage });
    }

    if (r.topic === 'orb.live.context.bootstrap' || r.topic === 'orb.live.context.bootstrap.skipped') {
      summary.context.builder = str(m.builder) ?? summary.context.builder;
      summary.context.brain_error = str(m.brain_error);
      summary.context.bootstrap_chars = num(m.chars);
      summary.context.bootstrap_latency_ms = num(m.latency_ms);
      summary.context.skipped_reason = str(m.reason);
      continue;
    }
    if (r.topic === 'voice.latency.measured' && (num(m.turn) ?? 0) > 0) {
      const phases = Array.isArray(m.phases) ? (m.phases as Array<Record<string, unknown>>) : [];
      const first = phases.find((p) => p.phase === 'audio_out_first_chunk');
      const ms = first ? num(first.offset_ms) : null;
      if (ms !== null) summary.outcome.turn_first_audio_ms.push({ turn: num(m.turn) as number, ms });
      continue;
    }
    if (r.topic === 'voice.latency.measured' && num(m.turn) === 0) {
      const phases = Array.isArray(m.phases) ? (m.phases as Array<Record<string, unknown>>) : [];
      for (const p of phases) {
        const d = (p.detail ?? {}) as Record<string, unknown>;
        if (p.phase === 'context_awaited' && !summary.context.gate) {
          summary.context.gate = { timed_out: bool(d.timed_out), context_source: str(d.context_source), waited_ms: num(d.awaited_ms) };
        }
        if (p.phase === 'setup_sent') {
          summary.context.setup_context_chars = num(d.context_chars);
          summary.context.setup_context_source = str(d.context_source);
        }
        if (p.phase === 'audio_out_first_chunk' && summary.outcome.first_audio_ms === null) {
          summary.outcome.first_audio_ms = num(p.offset_ms);
        }
      }
      continue;
    }
    if (r.topic === 'vtid.live.session.stop') {
      summary.outcome.stopped = true;
      summary.outcome.stop_reason = str(m.reason);
      summary.outcome.turns = num(m.turn_count);
      summary.outcome.duration_ms = num(m.duration_ms);
      summary.outcome.audio_out_chunks = num(m.audio_out_chunks);
      continue;
    }
    if (r.topic === 'conversation.session.finalized') {
      summary.outcome.finalized = {
        reason: str(m.reason),
        memory_committed: bool(m.memory_committed),
        summary_written: bool(m.summary_written),
        threads_written: num(m.threads_written),
      };
      continue;
    }
    if (r.topic !== 'orb.live.diag' || !stage) continue;

    switch (stage) {
      case 'brain_context_built':
        summary.context.packing = {
          chars_before: num(m.chars_before),
          chars_after: num(m.chars_after),
          packed: m.packed === true,
          kept: strList(m.kept),
          shortened: strList(m.shortened),
          dropped: strList(m.dropped),
        };
        break;
      case 'core_snapshot_used':
        summary.context.snapshot_used = { chars: num(m.chars), fresh_timed_out: bool(m.fresh_timed_out) };
        break;
      case 'context_rebuilt_on_reconnect':
        summary.context.rebuilt_on_reconnect.push({
          at: r.created_at,
          builder: str(m.builder),
          started_builder: str(m.started_builder),
          chars: num(m.chars),
          brain_error: str(m.brain_error),
        });
        break;
      case 'greeting_sent':
        summary.decision.push({
          at: r.created_at,
          wake_opener: str(m.wake_opener),
          register: str(m.register),
          bucket: str(m.bucket),
          nba: str(m.nba),
          nba_domain: str(m.nba_domain),
          current_route: str(m.current_route),
          lang: str(m.lang),
          candidate_provider: str(m.candidate_provider),
          candidate_kind: str(m.candidate_kind),
          candidate_spoken: bool(m.candidate_spoken),
          candidate_outranked_by: str(m.candidate_outranked_by),
        });
        break;
      case 'instruction_budget': {
        const sb: Record<string, number> = {};
        if (m.section_bytes && typeof m.section_bytes === 'object') {
          for (const [k, v] of Object.entries(m.section_bytes as Record<string, unknown>)) {
            const n = num(v);
            if (n != null) sb[k] = n;
          }
        }
        summary.context.instruction_budget = {
          budget_bytes: num(m.budget_bytes),
          total_bytes_before: num(m.total_bytes_before),
          total_bytes_after: num(m.total_bytes_after),
          trimmed_sections: Array.isArray(m.trimmed_sections) ? (m.trimmed_sections as unknown[]).map(String) : [],
          still_over_budget: bool(m.still_over_budget),
          section_bytes: sb,
          setups: (summary.context.instruction_budget?.setups ?? 0) + 1,
        };
        break;
      }
      case 'tool_catalog_trimmed':
      case 'vertex_tool_catalog_trimmed':
        summary.tools = {
          ...(summary.tools ?? {}),
          bytes_before: num(m.bytes_before),
          bytes_after: num(m.bytes_after),
          dropped_count: num(m.dropped_count),
          provider: str(m.provider) ?? summary.tools?.provider ?? null,
          ...(m.selection === 'context'
            ? {
              route_groups: Array.isArray(m.route_groups) ? (m.route_groups as unknown[]).map(String) : [],
              contextual_kept: num(m.contextual_kept),
              deferred_reachable: num(m.deferred_reachable),
            }
            : {}),
        };
        break;
      case 'deferred_tool_search':
      case 'deferred_tool_used': {
        const t = summary.tools ?? (summary.tools = { bytes_before: null, bytes_after: null, dropped_count: null, provider: null });
        if (stage === 'deferred_tool_search') t.searches = (t.searches ?? 0) + 1;
        else if (str(m.tool)) t.deferred_used = [...(t.deferred_used ?? []), str(m.tool) as string];
        break;
      }
      case 'advisor_note':
      case 'advisor_skipped':
      case 'guidance_read': {
        const a = summary.advisor ?? (summary.advisor = { notes: 0, skipped: {}, reads: 0, fresh_reads: 0, cost_usd: 0, latency_ms_max: null, suggested_tools: [] });
        if (stage === 'advisor_note') {
          a.notes += 1;
          a.cost_usd = Math.round((a.cost_usd + (num(m.cost_usd) ?? 0)) * 1e6) / 1e6;
          for (const t of strList(m.suggested_tools)) if (!a.suggested_tools.includes(t) && a.suggested_tools.length < 20) a.suggested_tools.push(t);
        } else if (stage === 'advisor_skipped') {
          const reason = str(m.reason) ?? 'unknown';
          a.skipped[reason] = (a.skipped[reason] ?? 0) + 1;
        } else {
          a.reads += 1;
          if (m.fresh === true) a.fresh_reads += 1;
        }
        const lat = num(m.latency_ms);
        if (lat !== null && stage !== 'guidance_read') a.latency_ms_max = Math.max(a.latency_ms_max ?? 0, lat);
        break;
      }
      default:
        if (ERROR_STAGES.has(stage)) {
          summary.errors.push({ at: r.created_at, stage, failure_kind: str(m.failure_kind), code: str(m.code) ?? str(m.reason) });
        }
    }
  }
  return summary;
}

/**
 * VTID-04420: the provider results for one session's opening, from the wake
 * timeline's `continuation_decision_finished` / `wake_brief_selected` events.
 */
export function summarizeWakeTimeline(events: unknown): SessionBrainSummary['candidates'] {
  if (!Array.isArray(events)) return null;
  let out: NonNullable<SessionBrainSummary['candidates']> | null = null;
  const ensure = () => (out ??= { selected_kind: null, none_with_reason: null, duration_ms: null, providers: [], shadow: null });
  for (const e of events as Array<Record<string, unknown>>) {
    const name = str(e?.name);
    const m = (e?.metadata ?? {}) as Record<string, unknown>;
    if (name === 'wake_brief_selected') {
      const o = ensure();
      o.selected_kind = str(m.selected_continuation_kind);
      o.none_with_reason = str(m.none_with_reason);
    } else if (name === 'continuation_shadow_ranked') {
      const o = ensure();
      const cands = Array.isArray(m.candidates) ? (m.candidates as Array<Record<string, unknown>>) : [];
      o.shadow = {
        weights_version: num(m.weights_version),
        live_winner: str(m.live_winner),
        shadow_winner: str(m.shadow_winner),
        agree: bool(m.agree),
        scores: cands.slice(0, 15).map((c) => ({ provider: str(c.provider) ?? '?', score: num(c.score), priority: num(c.priority) })),
      };
      if (str(m.ranking_mode)) {
        o.shadow.ranking_mode = str(m.ranking_mode);
        o.shadow.served_winner = str(m.served_winner);
      }
      const pa = (m.personal ?? null) as Record<string, unknown> | null;
      if (pa && pa.applied === true) {
        o.shadow.personal = {
          evidence: num(pa.evidence),
          outcome_mult: num(pa.outcome_mult),
          freshness_mult: num(pa.freshness_mult),
          shared_weights_winner: str(m.shadow_winner_shared_weights),
        };
      }
    } else if (name === 'continuation_decision_finished') {
      const o = ensure();
      o.duration_ms = num(m.durationMs);
      const pr = Array.isArray(m.providerResults) ? (m.providerResults as Array<Record<string, unknown>>) : [];
      o.providers = pr.slice(0, 40).map((p) => ({
        key: str(p.key) ?? '?',
        status: str(p.status) ?? '?',
        latency_ms: num(p.latencyMs),
        reason: str(p.reason),
      }));
    }
  }
  return out;
}

export function toSessionListItem(row: InspectorEventRow): SessionListItem | null {
  const m = (row.metadata ?? {}) as Record<string, unknown>;
  const sid = str(m.session_id);
  if (!sid) return null;
  return { session_id: sid, started_at: row.created_at, user_id: str(m.user_id), lang: str(m.lang), transport: str(m.transport), origin: str(m.origin) };
}

// ---------------------------------------------------------------------------
// Bounded reads
// ---------------------------------------------------------------------------

const SESSION_ID_RE = /^[A-Za-z0-9_-]{4,120}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionId(v: unknown): v is string {
  return typeof v === 'string' && SESSION_ID_RE.test(v);
}
export function isValidUserId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export async function listRecentSessions(
  sb: SupabaseClient,
  opts: { hours: number; userId?: string | null; limit: number; nowMs?: number },
): Promise<{ sessions: SessionListItem[]; error: string | null }> {
  const since = new Date((opts.nowMs ?? Date.now()) - opts.hours * 3600 * 1000).toISOString();
  let q = sb
    .from('oasis_events')
    .select('topic, created_at, metadata')
    .eq('topic', 'vtid.live.session.start')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(opts.limit);
  if (opts.userId) q = q.eq('metadata->>user_id', opts.userId);
  const { data, error } = await q;
  if (error) return { sessions: [], error: error.message };
  const sessions = ((data || []) as InspectorEventRow[]).map(toSessionListItem).filter((s): s is SessionListItem => !!s);
  return { sessions, error: null };
}

export async function inspectSession(
  sb: SupabaseClient,
  sessionId: string,
  opts: { nowMs?: number } = {},
): Promise<{ summary: SessionBrainSummary; error: string | null }> {
  const nowMs = opts.nowMs ?? Date.now();
  const lookbackIso = new Date(nowMs - INSPECTOR_LOOKBACK_DAYS * 86_400_000).toISOString();
  const startRes = await sb
    .from('oasis_events')
    .select('topic, created_at, metadata')
    .eq('topic', 'vtid.live.session.start')
    .eq('metadata->>session_id', sessionId)
    .gte('created_at', lookbackIso)
    .order('created_at', { ascending: true })
    .limit(1);
  if (startRes.error) return { summary: summarizeSessionEvents(sessionId, []), error: startRes.error.message };
  const start = ((startRes.data || []) as InspectorEventRow[])[0];
  if (!start) return { summary: summarizeSessionEvents(sessionId, []), error: null };

  const fromMs = Date.parse(start.created_at) - 60_000;
  const toMs = Math.min(nowMs, Date.parse(start.created_at) + INSPECTOR_WINDOW_MS);
  const evRes = await sb
    .from('oasis_events')
    .select('topic, created_at, metadata')
    .in('topic', INSPECTOR_TOPICS as unknown as string[])
    .eq('metadata->>session_id', sessionId)
    .gte('created_at', new Date(fromMs).toISOString())
    .lte('created_at', new Date(toMs).toISOString())
    .order('created_at', { ascending: true })
    .limit(INSPECTOR_MAX_EVENTS);
  if (evRes.error) return { summary: summarizeSessionEvents(sessionId, [start]), error: evRes.error.message };
  const rows = (evRes.data || []) as InspectorEventRow[];
  const withStart = rows.some((r) => r.topic === 'vtid.live.session.start') ? rows : [start, ...rows];
  const summary = summarizeSessionEvents(sessionId, withStart, { truncated: rows.length >= INSPECTOR_MAX_EVENTS });
  // VTID-04420: provider results live in the session's wake timeline (primary
  // key lookup, one row). Best-effort — a failure leaves `candidates` null.
  try {
    const wt = await sb.from('orb_wake_timelines').select('events').eq('session_id', sessionId).maybeSingle();
    if (!wt.error && wt.data) summary.candidates = summarizeWakeTimeline((wt.data as { events?: unknown }).events);
  } catch {
    /* candidates stay null */
  }
  return { summary, error: null };
}
