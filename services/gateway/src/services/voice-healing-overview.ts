/**
 * Voice Self-Healing overview (VTID-04626)
 *
 * One read for the Command Hub → Voice → Self-Healing screen. The screen used
 * to stitch five endpoints together, three of them fetched without a login
 * token (so they 401'd and the page stuck at "MODE: ..."), and it showed 41
 * "open reports" of which 17 were empty placeholders left by a report writer
 * that had been failing for weeks — with nothing on the page saying so.
 *
 * This module answers the questions an operator actually has, in order:
 *   1. Is each stage of the loop working? (detector → investigator →
 *      sentinel → execution), with the real last error when it is not.
 *   2. What needs a decision? (open reports, failed investigations)
 *   3. What did the detector see recently, and what is quarantined?
 *
 * Read-only and side-effect-free. Every fetch fails soft to an empty set and
 * the failure is carried in `fetch_errors` so the screen can say which part
 * of the picture is missing instead of rendering a confident empty state.
 */

import { getVoiceSelfHealingMode } from './voice-self-healing-adapter';
import { buildLiveMonitor, buildHealingSummary } from './voice-healing-summary';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

function headers(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE as string,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
  };
}

function isoMinusHours(h: number, now = Date.now()): string {
  return new Date(now - h * 3600_000).toISOString();
}

// =============================================================================
// Types
// =============================================================================

export type StageStatus = 'ok' | 'failing' | 'idle' | 'no_traffic' | 'unknown';

export interface CompactReport {
  id: string;
  class: string;
  normalized_signature: string | null;
  trigger_reason: string;
  generated_at: string;
  status: string;
  failed: boolean;
  /** VTID-04626: recommendation written about the retired Vertex/Gemini Live pipeline. */
  stale_pipeline: boolean;
  failure_reason: string | null;
  failure_detail: string | null;
  track: string | null;
  confidence: number | null;
  summary: string | null;
  step_count: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  decision_notes: string | null;
  execution: Record<string, unknown> | null;
  llm: Record<string, unknown> | null;
}

export interface ReportRowRaw {
  id: string;
  class: string;
  normalized_signature: string | null;
  trigger_reason: string;
  generated_at: string;
  status: string;
  schema_version: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  decision_notes: string | null;
  investigator_status?: string | null;
  failure_reason?: string | null;
  failure_detail?: string | null;
  track?: string | null;
  confidence?: number | string | null;
  summary?: string | null;
  steps?: unknown;
  execution?: Record<string, unknown> | null;
  llm?: Record<string, unknown> | null;
}

export interface InvestigatorHealth {
  status: StageStatus;
  stage: 'triage';
  attempts_30d: number;
  successes_30d: number;
  failures_30d: number;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_failure_at: string | null;
  last_failure_detail: string | null;
  consecutive_failures: number;
}

export interface Detection {
  at: string;
  class: string;
  session_id: string | null;
  trigger: string | null;
  audio_in_chunks: number | null;
  audio_out_chunks: number | null;
  turn_count: number | null;
  duration_ms: number | null;
}

export interface Alert {
  level: 'error' | 'warning' | 'info';
  title: string;
  detail: string;
}

export interface HealingOverview {
  generated_at: string;
  mode: 'off' | 'shadow' | 'live';
  mode_updated_at: string | null;
  pipeline: {
    detector: {
      status: StageStatus;
      session_stops_24h: number;
      last_session_stop_at: string | null;
      detections_7d: number;
      last_detection_at: string | null;
    };
    investigator: InvestigatorHealth;
    sentinel: { status: StageStatus; quarantined: number; probation: number };
    execution: { status: StageStatus; accepted_30d: number; executions_linked: number };
  };
  alerts: Alert[];
  reports: { open: CompactReport[]; failed: CompactReport[]; decided: CompactReport[] };
  quarantine: Array<{
    class: string;
    normalized_signature: string;
    status: string;
    reason: string | null;
    quarantined_at: string | null;
    probation_until: string | null;
  }>;
  detections: Detection[];
  per_class: unknown[];
  live: unknown | null;
  fetch_errors: string[];
}

// =============================================================================
// Pure helpers (unit-tested)
// =============================================================================

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * VTID-04626: until this change the investigator prompt told the model the
 * pipeline was "Vertex AI Gemini Live + Cloud TTS". GCP was switched off on
 * 2026-08-16, so any report reasoning about Vertex / Gemini Live targets code
 * that no longer runs voice (Serbian bridge aside). Accepting one would send
 * an agent after the wrong system.
 */
export function isStalePipelineReport(summary: string | null | undefined, steps: unknown[]): boolean {
  const text = [summary || '', ...steps.map((x) => String(x))].join(' ');
  return /\bvertex\b|gemini[\s-]*live|cloud tts/i.test(text);
}

export function compactReport(r: ReportRowRaw): CompactReport {
  const failed = r.schema_version === 'v1-stub' || r.investigator_status === 'failed';
  const steps = Array.isArray(r.steps) ? r.steps : [];
  return {
    id: r.id,
    class: r.class,
    normalized_signature: r.normalized_signature ?? null,
    trigger_reason: r.trigger_reason,
    generated_at: r.generated_at,
    status: r.status,
    failed,
    stale_pipeline: !failed && isStalePipelineReport(r.summary, steps),
    failure_reason: failed ? r.failure_reason ?? 'unknown' : null,
    failure_detail: failed ? (r.failure_detail ?? '').slice(0, 600) || null : null,
    track: failed ? null : r.track ?? null,
    confidence: failed ? null : num(r.confidence),
    summary: failed ? null : (r.summary ?? '').slice(0, 600) || null,
    step_count: failed ? 0 : steps.length,
    acknowledged_by: r.acknowledged_by ?? null,
    acknowledged_at: r.acknowledged_at ?? null,
    decision_notes: r.decision_notes ?? null,
    execution: r.execution ?? null,
    llm: r.llm ?? null,
  };
}

/** Rows newest first. */
export function deriveInvestigatorHealth(
  rows: Array<{ generated_at: string; schema_version: string | null; failure_detail?: string | null }>,
): InvestigatorHealth {
  const isFail = (r: { schema_version: string | null }) => r.schema_version === 'v1-stub';
  const failures = rows.filter(isFail);
  const successes = rows.filter((r) => !isFail(r));
  let consecutive = 0;
  for (const r of rows) {
    if (!isFail(r)) break;
    consecutive++;
  }
  const last = rows[0];
  const status: StageStatus = !last ? 'idle' : isFail(last) ? 'failing' : 'ok';
  return {
    status,
    stage: 'triage',
    attempts_30d: rows.length,
    successes_30d: successes.length,
    failures_30d: failures.length,
    last_attempt_at: last?.generated_at ?? null,
    last_success_at: successes[0]?.generated_at ?? null,
    last_failure_at: failures[0]?.generated_at ?? null,
    last_failure_detail: failures[0]?.failure_detail ? String(failures[0].failure_detail).slice(0, 600) : null,
    consecutive_failures: consecutive,
  };
}

export function deriveAlerts(o: Pick<HealingOverview, 'mode' | 'pipeline' | 'reports' | 'fetch_errors'>): Alert[] {
  const alerts: Alert[] = [];
  const inv = o.pipeline.investigator;
  if (inv.status === 'failing') {
    alerts.push({
      level: 'error',
      title: `Report writer failing (${inv.consecutive_failures} in a row)`,
      detail:
        `The investigator could not produce a report since ${inv.last_success_at ? inv.last_success_at.slice(0, 10) : 'the start of the 30-day window'}. ` +
        `Last error: ${inv.last_failure_detail || 'unknown'}`,
    });
  }
  if (o.reports.failed.length > 0) {
    alerts.push({
      level: 'warning',
      title: `${o.reports.failed.length} failed investigation${o.reports.failed.length === 1 ? '' : 's'} waiting`,
      detail: 'These are placeholders, not reports. Retry them now that the report writer is fixed, or dismiss them.',
    });
  }
  const stale = o.reports.open.filter((r) => r.stale_pipeline).length;
  if (stale > 0) {
    alerts.push({
      level: 'warning',
      title: `${stale} open report${stale === 1 ? '' : 's'} written for the retired Vertex pipeline`,
      detail: 'Voice runs on Amazon Nova Sonic since August 2026. These recommendations target code that no longer runs voice — dismiss them rather than executing them.',
    });
  }
  if (o.pipeline.detector.status === 'no_traffic') {
    alerts.push({
      level: 'info',
      title: 'No voice sessions in the last 24 hours',
      detail: 'The detector has nothing to look at, so an empty detection list says nothing about health.',
    });
  }
  if (o.pipeline.sentinel.quarantined > 0) {
    alerts.push({
      level: 'info',
      title: `${o.pipeline.sentinel.quarantined} failure pattern${o.pipeline.sentinel.quarantined === 1 ? '' : 's'} quarantined`,
      detail: 'New occurrences are recorded but no new investigation starts until you release the pattern.',
    });
  }
  if (o.mode === 'off') {
    alerts.push({
      level: 'info',
      title: 'Error dispatch is off',
      detail: 'Quality failures are still investigated; error sessions are not classified or dispatched.',
    });
  }
  for (const e of o.fetch_errors) {
    alerts.push({ level: 'warning', title: 'Part of this screen could not be loaded', detail: e });
  }
  return alerts;
}

export function detectionFromEvent(e: { created_at: string; metadata?: Record<string, unknown> | null }): Detection | null {
  const m = e.metadata || {};
  const klass = typeof m.class === 'string' ? m.class : null;
  // Mode flips were emitted on this topic before VTID-04626 — skip them.
  if (!klass) return null;
  return {
    at: e.created_at,
    class: klass,
    session_id: typeof m.session_id === 'string' ? m.session_id : null,
    trigger: typeof m.trigger === 'string' ? m.trigger : null,
    audio_in_chunks: num(m.audio_in_chunks),
    audio_out_chunks: num(m.audio_out_chunks),
    turn_count: num(m.turn_count),
    duration_ms: num(m.duration_ms),
  };
}

// =============================================================================
// Fetchers
// =============================================================================

const REPORT_SELECT = [
  'id', 'class', 'normalized_signature', 'trigger_reason', 'generated_at', 'status', 'schema_version',
  'acknowledged_by', 'acknowledged_at', 'decision_notes',
  'investigator_status:report->>investigator_status',
  'failure_reason:report->>failure_reason',
  'failure_detail:report->>failure_detail',
  'track:report->recommendation->>track',
  'confidence:report->recommendation->confidence',
  'summary:report->recommendation->>summary',
  'steps:report->recommendation->proposed_next_steps',
  'execution:report->_execution',
  'llm:report->_llm',
].join(',');

async function getJson<T>(path: string, label: string, errors: string[]): Promise<T | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    errors.push(`${label}: Supabase not configured`);
    return null;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      errors.push(`${label}: HTTP ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err: any) {
    errors.push(`${label}: ${err?.message ?? 'fetch failed'}`);
    return null;
  }
}

async function countOf(path: string, label: string, errors: string[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return 0;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { ...headers(), Prefer: 'count=exact', Range: '0-0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok && res.status !== 206) {
      errors.push(`${label}: HTTP ${res.status}`);
      return 0;
    }
    const m = /\/(\d+)$/.exec(res.headers.get('content-range') || '');
    return m ? parseInt(m[1], 10) : 0;
  } catch (err: any) {
    errors.push(`${label}: ${err?.message ?? 'fetch failed'}`);
    return 0;
  }
}

export async function fetchReportById(id: string): Promise<Record<string, any> | null> {
  const errors: string[] = [];
  const rows = await getJson<any[]>(
    `voice_architecture_reports?id=eq.${encodeURIComponent(id)}&limit=1`,
    'report',
    errors,
  );
  return rows && rows[0] ? rows[0] : null;
}

export async function buildHealingOverview(): Promise<HealingOverview> {
  const errors: string[] = [];
  const now = Date.now();
  const since24h = encodeURIComponent(isoMinusHours(24, now));
  const since7d = encodeURIComponent(isoMinusHours(24 * 7, now));
  const since30d = encodeURIComponent(isoMinusHours(24 * 30, now));

  const [
    mode,
    modeRow,
    openRows,
    decidedRows,
    attemptRows,
    quarantineRows,
    detectionEvents,
    stops24h,
    lastStop,
    live,
    summary,
  ] = await Promise.all([
    getVoiceSelfHealingMode(true),
    getJson<Array<{ updated_at: string }>>(
      'system_config?key=eq.voice_self_healing_mode&select=updated_at&limit=1',
      'mode',
      errors,
    ),
    getJson<ReportRowRaw[]>(
      `voice_architecture_reports?status=eq.open&select=${REPORT_SELECT}&order=generated_at.desc&limit=100`,
      'open reports',
      errors,
    ),
    getJson<ReportRowRaw[]>(
      `voice_architecture_reports?status=neq.open&select=${REPORT_SELECT}&order=generated_at.desc&limit=20`,
      'decided reports',
      errors,
    ),
    getJson<Array<{ generated_at: string; schema_version: string | null; failure_detail: string | null }>>(
      `voice_architecture_reports?generated_at=gte.${since30d}&select=generated_at,schema_version,failure_detail:report->>failure_detail&order=generated_at.desc&limit=500`,
      'investigator history',
      errors,
    ),
    getJson<HealingOverview['quarantine']>(
      'voice_healing_quarantine?status=in.(quarantined,probation)&select=class,normalized_signature,status,reason,quarantined_at,probation_until&order=quarantined_at.desc&limit=100',
      'quarantine',
      errors,
    ),
    getJson<Array<{ created_at: string; metadata: Record<string, unknown> | null }>>(
      `oasis_events?topic=eq.voice.healing.dispatched&created_at=gte.${since7d}&select=created_at,metadata&order=created_at.desc&limit=100`,
      'detections',
      errors,
    ),
    countOf(`oasis_events?topic=eq.vtid.live.session.stop&created_at=gte.${since24h}&select=id`, 'session stops', errors),
    getJson<Array<{ created_at: string }>>(
      'oasis_events?topic=eq.vtid.live.session.stop&select=created_at&order=created_at.desc&limit=1',
      'last session stop',
      errors,
    ),
    buildLiveMonitor().catch((e: any) => {
      errors.push(`live monitor: ${e?.message ?? 'failed'}`);
      return null;
    }),
    buildHealingSummary().catch((e: any) => {
      errors.push(`per-class summary: ${e?.message ?? 'failed'}`);
      return null;
    }),
  ]);

  const openAll = (openRows || []).map(compactReport);
  const decided = (decidedRows || []).map(compactReport);
  const detections = (detectionEvents || [])
    .map(detectionFromEvent)
    .filter((d): d is Detection => d !== null);
  const quarantine = quarantineRows || [];
  const investigator = deriveInvestigatorHealth(attemptRows || []);
  const accepted30d = decided.filter((r) => r.status === 'accepted' && r.acknowledged_at && r.acknowledged_at >= decodeURIComponent(since30d));

  const pipeline: HealingOverview['pipeline'] = {
    detector: {
      status: stops24h > 0 ? 'ok' : 'no_traffic',
      session_stops_24h: stops24h,
      last_session_stop_at: lastStop && lastStop[0] ? lastStop[0].created_at : null,
      detections_7d: detections.length,
      last_detection_at: detections[0]?.at ?? null,
    },
    investigator,
    sentinel: {
      status: 'ok', // quarantining is the sentinel working, not failing
      quarantined: quarantine.filter((q) => q.status === 'quarantined').length,
      probation: quarantine.filter((q) => q.status === 'probation').length,
    },
    execution: {
      status: accepted30d.length > 0 ? 'ok' : 'idle',
      accepted_30d: accepted30d.length,
      executions_linked: decided.filter((r) => r.execution).length,
    },
  };

  const reports = {
    open: openAll.filter((r) => !r.failed),
    failed: openAll.filter((r) => r.failed),
    decided,
  };

  const overview: HealingOverview = {
    generated_at: new Date(now).toISOString(),
    mode,
    mode_updated_at: modeRow && modeRow[0] ? modeRow[0].updated_at : null,
    pipeline,
    alerts: [],
    reports,
    quarantine,
    detections: detections.slice(0, 25),
    per_class: (summary as any)?.per_class ?? [],
    live: live ?? null,
    fetch_errors: errors,
  };
  overview.alerts = deriveAlerts(overview);
  return overview;
}
