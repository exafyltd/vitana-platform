/**
 * VTID-04776 — Voice session facts writer.
 *
 * One `voice_session_facts` row per ORB voice session (SSE, WS, LiveKit),
 * the per-session fact the Voice Supervisor reads (routes/voice-supervisor.ts).
 * Before this table a session existed only as a scatter of OASIS events with
 * no tenant column, and the start/stop events carried no role, surface,
 * language or provider.
 *
 * Contract:
 *   - Every write is fire-and-forget. Nothing here ever throws into, awaits
 *     on, or slows the voice path. Callers do not await.
 *   - Every failure is logged loudly (console.error with the session id and
 *     the PostgREST status/body) — never swallowed silently.
 *   - All writes are PostgREST upserts on `session_id` that send only the
 *     columns they know, so a later write never blanks an earlier one.
 *   - Writes for one session are serialized in-process (a per-session promise
 *     chain), so an update fired a few ms after the start can never land
 *     first and fail on the NOT NULL `started_at`.
 *   - Kill switch: VOICE_SESSION_FACTS_ENABLED=false disables every write
 *     (default ON).
 *
 * Outcome classification (`classifyVoiceSessionOutcome`) is pure and reuses
 * the existing voice-failure taxonomy (`classifyQualityFromSessionStop`,
 * `detectAudioOneWay`) for `failure_class` instead of inventing a parallel
 * one.
 */

import {
  classifyQualityFromSessionStop,
  detectAudioOneWay,
} from './voice-failure-taxonomy';

const LOG = '[VTID-04776 voice-session-facts]';

export type FactsProvider = 'nova_sonic' | 'cascade' | 'vertex_serbian_bridge' | 'livekit' | 'unknown';
export type FactsTransport = 'sse' | 'ws' | 'livekit';
export type FactsOutcome = 'ok' | 'silent' | 'one_way' | 'dropped' | 'error' | 'abandoned' | 'active';

export interface VoiceSessionFactsRow {
  session_id: string;
  tenant_id?: string | null;
  user_id?: string | null;
  is_anonymous?: boolean;
  surface?: string | null;
  role?: string | null;
  persona_key?: string | null;
  profile_resolution?: string | null;
  lang?: string | null;
  provider?: FactsProvider | null;
  selection_reason?: string | null;
  transport?: FactsTransport | null;
  is_mobile?: boolean | null;
  app_version?: string | null;
  entry?: string | null;
  started_at?: string;
  ended_at?: string | null;
  last_activity_at?: string | null;
  duration_ms?: number | null;
  turn_count?: number | null;
  user_turns?: number | null;
  model_turns?: number | null;
  audio_in_chunks?: number | null;
  audio_out_chunks?: number | null;
  ttfa_ms?: number | null;
  p50_turn_ms?: number | null;
  close_reason?: string | null;
  close_code?: number | null;
  failure_class?: string | null;
  outcome?: FactsOutcome | null;
  stall_count?: number | null;
}

export type VoiceSessionFactsPatch = Omit<VoiceSessionFactsRow, 'session_id'>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** uuid columns refuse 'anonymous', 'anon-…', 'dev-…' — keep only real uuids. */
export function uuidOrNull(v: unknown): string | null {
  return typeof v === 'string' && UUID_RE.test(v) ? v : null;
}

/** Map the gateway's VoiceProviderName (and LiveKit) onto the facts vocabulary. */
export function toFactsProvider(name: unknown): FactsProvider {
  switch (typeof name === 'string' ? name.trim().toLowerCase() : '') {
    case 'nova_sonic': return 'nova_sonic';
    case 'cascaded':
    case 'cascade': return 'cascade';
    // VTID-04000: the only reachable Vertex path is the Serbian bridge
    // (upstream-provider-selector.ts gate). Any other Vertex use is an
    // incident, and it would still be visible here under this label.
    case 'vertex':
    case 'vertex_serbian_bridge': return 'vertex_serbian_bridge';
    case 'livekit': return 'livekit';
    default: return 'unknown';
  }
}

export function toFactsTransport(v: unknown): FactsTransport | null {
  switch (typeof v === 'string' ? v.toLowerCase() : '') {
    case 'sse': return 'sse';
    case 'ws':
    case 'websocket': return 'ws';
    case 'livekit': return 'livekit';
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Outcome classification (pure)
// ---------------------------------------------------------------------------

/** A session that never produced audio but lasted this long was owed a greeting. */
export const GREETING_EXPECTED_AFTER_MS = 5_000;
/** Mic never reached us although the model spoke for this long → one-way. */
export const ONE_WAY_NO_INPUT_AFTER_MS = 30_000;
/** An abnormal upstream close this close to the end is what ended the session. */
export const DROP_CLOSE_WINDOW_MS = 60_000;
/** Close codes that are normal ends, not drops (normal, going away, no status). */
const NORMAL_CLOSE_CODES = new Set([1000, 1001, 1005]);

export interface OutcomeInput {
  audio_in_chunks?: number | null;
  /** VTID-VOICE-FWD: forwarded-only mic count; preferred by the taxonomy. */
  audio_in_forwarded?: number | null;
  audio_out_chunks?: number | null;
  duration_ms?: number | null;
  turn_count?: number | null;
  user_turns?: number | null;
  model_turns?: number | null;
  stall_count?: number | null;
  close_reason?: string | null;
  close_code?: number | null;
  /** ms between the last upstream close and the session end (null = unknown). */
  close_age_ms?: number | null;
}

export interface OutcomeResult {
  outcome: Exclude<FactsOutcome, 'active'>;
  failure_class: string | null;
}

const ERROR_REASON_RE = /(error|failed|failure|exception|crash)/i;
const ABANDON_REASONS = new Set(['idle_no_engagement']);

/**
 * Classify a finished session. Order matters — the first match wins:
 *   1. error      the close reason names an error (client_error, ws error…)
 *   2. abandoned  reaped for never engaging, or closed within the greeting
 *                 grace with no audio either way (page closed immediately)
 *   3. one_way    the user was heard but the model never spoke (the
 *                 taxonomy's detectAudioOneWay), or the model spoke for
 *                 > 30 s but no mic audio ever reached us
 *   4. silent     no audio out at all after the greeting was owed
 *   5. dropped    an abnormal upstream close (not 1000/1001/1005) within
 *                 60 s of the end — the upstream ended it, not the user
 *   6. ok
 * `failure_class` is the voice-failure taxonomy's class: quality classes from
 * classifyQualityFromSessionStop, `voice.audio_one_way`, `voice.model_stall`
 * when the watchdog fired, `voice.upstream_disconnect` for a drop.
 */
export function classifyVoiceSessionOutcome(input: OutcomeInput): OutcomeResult {
  const ai = Math.max(0, Number(input.audio_in_chunks) || 0);
  const ao = Math.max(0, Number(input.audio_out_chunks) || 0);
  const dur = Math.max(0, Number(input.duration_ms) || 0);
  const turns = Math.max(0, Number(input.turn_count) || 0);
  const stalls = Math.max(0, Number(input.stall_count) || 0);
  const reason = (input.close_reason || '').toString();

  const quality = classifyQualityFromSessionStop({
    audio_in_chunks: ai,
    audio_in_forwarded: input.audio_in_forwarded ?? undefined,
    audio_out_chunks: ao,
    duration_ms: dur,
    turn_count: turns,
    user_turns: input.user_turns ?? undefined,
    model_turns: input.model_turns ?? undefined,
  });
  const oneWay = detectAudioOneWay({ audio_in_chunks: ai, audio_out_chunks: ao, stall_type: null });
  const abnormalClose =
    typeof input.close_code === 'number' &&
    !NORMAL_CLOSE_CODES.has(input.close_code) &&
    (input.close_age_ms == null || input.close_age_ms <= DROP_CLOSE_WINDOW_MS);

  let failure: string | null = quality?.class ?? null;
  if (!failure && oneWay) failure = oneWay.class;
  if (!failure && stalls > 0) failure = 'voice.model_stall';
  if (!failure && abnormalClose) failure = 'voice.upstream_disconnect';

  if (ERROR_REASON_RE.test(reason)) return { outcome: 'error', failure_class: failure };
  if (ABANDON_REASONS.has(reason)) return { outcome: 'abandoned', failure_class: failure };
  if (ao === 0 && ai === 0 && dur < GREETING_EXPECTED_AFTER_MS) {
    return { outcome: 'abandoned', failure_class: failure };
  }
  if (ao === 0 && ai > 0) return { outcome: 'one_way', failure_class: failure ?? 'voice.audio_one_way' };
  if (ao > 0 && ai === 0 && turns === 0 && dur >= ONE_WAY_NO_INPUT_AFTER_MS) {
    return { outcome: 'one_way', failure_class: failure ?? 'voice.audio_one_way' };
  }
  if (ao === 0) return { outcome: 'silent', failure_class: failure ?? 'voice.model_stall' };
  if (abnormalClose) return { outcome: 'dropped', failure_class: failure ?? 'voice.upstream_disconnect' };
  return { outcome: 'ok', failure_class: failure };
}

// ---------------------------------------------------------------------------
// Snapshot from a live gateway session (structural — no import of orb-live)
// ---------------------------------------------------------------------------

/** The fields of GeminiLiveSession this module reads. Kept structural so the
 *  writer does not import routes/orb-live.ts (which imports this file). */
export interface LiveSessionLike {
  sessionId?: string;
  assistantProfile?: {
    surface?: string | null;
    role?: string | null;
    isWorkSurface?: boolean;
    personaKey?: string | null;
    resolution?: string | null;
  } | null;
  active_role?: string | null;
  lang?: string;
  upstreamProvider?: string | null;
  identity?: { user_id?: string | null; tenant_id?: string | null; role?: string | null } | null;
  isAnonymous?: boolean;
  is_mobile?: boolean;
  app_version?: string | null;
  clientWs?: unknown;
  createdAt?: Date;
  lastActivity?: Date;
  audioInChunks?: number;
  audioInForwarded?: number;
  audioOutChunks?: number;
  turn_count?: number;
  transcriptTurns?: Array<{ role: string }>;
  lastUpstreamCloseCode?: number | null;
  lastUpstreamCloseAt?: number | null;
  stallCount?: number;
}

/**
 * The role this session served: the work-surface role, else the stored member
 * role clamped onto the member plane (`session.active_role`, set by the
 * context build), else what the screen declared.
 */
export function servedRole(s: LiveSessionLike): string | null {
  const p = s.assistantProfile;
  if (p?.isWorkSurface && p.role) return p.role;
  return s.active_role || p?.role || null;
}

/** Stop-event enrichment: the fields every vtid.live.session.stop now carries. */
export function stopEventContext(s: LiveSessionLike, reason: string): Record<string, unknown> {
  return {
    surface: s.assistantProfile?.surface ?? null,
    role: servedRole(s),
    lang: s.lang ?? null,
    provider: s.upstreamProvider ?? null,
    reason,
    close_code: typeof s.lastUpstreamCloseCode === 'number' ? s.lastUpstreamCloseCode : null,
  };
}

/** End-of-session fields from a live gateway session object. */
export function endFieldsFromLiveSession(
  s: LiveSessionLike,
  reason: string,
  nowMs: number = Date.now(),
): VoiceSessionFactsPatch & { _outcome_input: OutcomeInput } {
  const startedMs = s.createdAt instanceof Date ? s.createdAt.getTime() : null;
  const turns = Array.isArray(s.transcriptTurns) ? s.transcriptTurns : [];
  const closeAt = typeof s.lastUpstreamCloseAt === 'number' ? s.lastUpstreamCloseAt : null;
  const fields: VoiceSessionFactsPatch = {
    tenant_id: uuidOrNull(s.identity?.tenant_id),
    user_id: uuidOrNull(s.identity?.user_id),
    surface: s.assistantProfile?.surface ?? null,
    role: servedRole(s),
    lang: s.lang ?? null,
    ...(s.upstreamProvider ? { provider: toFactsProvider(s.upstreamProvider) } : {}),
    ...(startedMs !== null ? { started_at: new Date(startedMs).toISOString() } : {}),
    duration_ms: startedMs === null ? null : Math.max(0, nowMs - startedMs),
    last_activity_at: s.lastActivity instanceof Date ? s.lastActivity.toISOString() : null,
    turn_count: s.turn_count ?? 0,
    user_turns: turns.filter((t) => t.role === 'user').length,
    model_turns: turns.filter((t) => t.role === 'assistant').length,
    audio_in_chunks: s.audioInChunks ?? 0,
    audio_out_chunks: s.audioOutChunks ?? 0,
    close_reason: reason,
    close_code: typeof s.lastUpstreamCloseCode === 'number' ? s.lastUpstreamCloseCode : null,
    stall_count: s.stallCount ?? 0,
  };
  return {
    ...fields,
    _outcome_input: {
      audio_in_chunks: fields.audio_in_chunks,
      audio_in_forwarded: s.audioInForwarded ?? null,
      audio_out_chunks: fields.audio_out_chunks,
      duration_ms: fields.duration_ms,
      turn_count: fields.turn_count,
      user_turns: fields.user_turns,
      model_turns: fields.model_turns,
      stall_count: fields.stall_count,
      close_reason: reason,
      close_code: fields.close_code,
      close_age_ms: closeAt === null ? null : Math.max(0, nowMs - closeAt),
    },
  };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export function isVoiceSessionFactsEnabled(): boolean {
  return (process.env.VOICE_SESSION_FACTS_ENABLED || '').trim().toLowerCase() !== 'false';
}

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

let warnedUnconfigured = false;
const chains = new Map<string, Promise<void>>();
/**
 * Sessions whose row this process created (start enqueued). Insertion-ordered
 * so the oldest entry is evicted past MAX_TRACKED. Kept after the end too, so
 * a late update (first audio after a fast stop) still PATCHes the row.
 */
const known = new Map<string, true>();
/**
 * An update for a session this process has not started yet (e.g. the member
 * role resolved by the async context build before session/start finished)
 * is held and merged into the start row, so it can neither be lost nor be
 * overwritten by the start's older values. If no start comes within
 * PENDING_FLUSH_MS (a session started elsewhere), it is upserted on its own.
 */
const pending = new Map<string, { patch: Record<string, unknown>; firstAt: string; timer: ReturnType<typeof setTimeout> }>();
const PENDING_FLUSH_MS = 30_000;
const MAX_TRACKED = 20_000;

type WriteMode = 'upsert' | 'patch';

function clean(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v !== undefined && !k.startsWith('_')) out[k] = v;
  }
  return out;
}

/**
 * `upsert` creates or merges (PostgREST INSERT … ON CONFLICT DO UPDATE of the
 * sent columns only) and therefore must carry the NOT NULL `started_at`;
 * `patch` updates an existing row and never creates one.
 */
async function write(mode: WriteMode, sessionId: string, row: Record<string, unknown>): Promise<void> {
  const cfg = supabaseConfig();
  if (!cfg) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      console.error(`${LOG} SUPABASE_URL / SUPABASE_SERVICE_ROLE missing — voice session facts are NOT being recorded`);
    }
    return;
  }
  const headers = {
    apikey: cfg.key,
    Authorization: `Bearer ${cfg.key}`,
    'Content-Type': 'application/json',
    Prefer: mode === 'upsert' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal',
  };
  const url = mode === 'upsert'
    ? `${cfg.url}/rest/v1/voice_session_facts?on_conflict=session_id`
    : `${cfg.url}/rest/v1/voice_session_facts?session_id=eq.${encodeURIComponent(sessionId)}`;
  const body = mode === 'upsert' ? { ...row, session_id: sessionId } : row;
  const res = await fetch(url, {
    method: mode === 'upsert' ? 'POST' : 'PATCH',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res || !res.ok) {
    const text = res ? await res.text().catch(() => '') : 'no response';
    throw new Error(`${mode} ${res?.status ?? 'n/a'}: ${String(text).slice(0, 300)}`);
  }
}

/** Queue a write for one session behind any write already in flight for it. */
function enqueue(mode: WriteMode, sessionId: string, row: Record<string, unknown>, what: string): void {
  if (mode === 'upsert' && !row.started_at) {
    console.error(`${LOG} ${what}: refused an upsert with no started_at for ${sessionId}`);
    return;
  }
  const payload = clean(row);
  delete payload.session_id;
  const prev = chains.get(sessionId) ?? Promise.resolve();
  const next = prev
    .then(() => write(mode, sessionId, payload))
    .catch((err: unknown) => {
      console.error(`${LOG} ${what} failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    });
  chains.set(sessionId, next);
  void next.finally(() => {
    if (chains.get(sessionId) === next) chains.delete(sessionId);
  });
}

function takePending(sessionId: string): Record<string, unknown> | null {
  const p = pending.get(sessionId);
  if (!p) return null;
  clearTimeout(p.timer);
  pending.delete(sessionId);
  return p.patch;
}

function markKnown(sessionId: string): void {
  known.delete(sessionId);
  known.set(sessionId, true);
  if (known.size > MAX_TRACKED) {
    const oldest = known.keys().next().value;
    if (oldest !== undefined) known.delete(oldest);
  }
}

/** Start of a session: insert (or merge into) the row. Never throws. */
export function recordVoiceSessionStart(fields: VoiceSessionFactsRow): void {
  try {
    if (!isVoiceSessionFactsEnabled()) return;
    if (!fields?.session_id) {
      console.error(`${LOG} start: refused a write with no session_id`);
      return;
    }
    const startedAt = fields.started_at ?? new Date().toISOString();
    // A held update is newer than the start's own values → it wins.
    const held = takePending(fields.session_id) ?? {};
    markKnown(fields.session_id);
    enqueue('upsert', fields.session_id, {
      ...fields,
      started_at: startedAt,
      last_activity_at: fields.last_activity_at ?? startedAt,
      outcome: fields.outcome ?? 'active',
      ...held,
    }, 'start');
  } catch (err) {
    console.error(`${LOG} start threw for ${fields?.session_id}: ${(err as Error)?.message}`);
  }
}

/**
 * Merge a partial update (provider selected, first audio, member role
 * resolved, activity heartbeat, LiveKit agent start). Never throws.
 *
 *   - session started by this process → PATCH;
 *   - patch carries `started_at`       → upsert (may create the row);
 *   - otherwise                        → held, merged into the start row.
 */
export function updateVoiceSessionFacts(sessionId: string, patch: VoiceSessionFactsPatch): void {
  try {
    if (!isVoiceSessionFactsEnabled()) return;
    if (!sessionId) {
      console.error(`${LOG} update: refused a write with no session_id`);
      return;
    }
    if (patch.started_at) {
      markKnown(sessionId);
      enqueue('upsert', sessionId, { ...patch }, 'update');
      return;
    }
    if (known.has(sessionId)) {
      enqueue('patch', sessionId, { ...patch }, 'update');
      return;
    }
    const existing = pending.get(sessionId);
    if (existing) {
      existing.patch = { ...existing.patch, ...patch };
      return;
    }
    if (pending.size >= MAX_TRACKED) {
      console.error(`${LOG} pending-update buffer full (${MAX_TRACKED}); dropping update for ${sessionId}`);
      return;
    }
    const firstAt = new Date().toISOString();
    const timer = setTimeout(() => {
      const held = takePending(sessionId);
      if (held) {
        markKnown(sessionId);
        enqueue('upsert', sessionId, { started_at: firstAt, ...held }, 'update (no start seen)');
      }
    }, PENDING_FLUSH_MS);
    if (typeof (timer as { unref?: () => void }).unref === 'function') (timer as { unref: () => void }).unref();
    pending.set(sessionId, { patch: { ...patch }, firstAt, timer });
  } catch (err) {
    console.error(`${LOG} update threw for ${sessionId}: ${(err as Error)?.message}`);
  }
}

/**
 * End of a session: computes `outcome` + `failure_class` (unless given) and
 * writes the final metrics. Upserts when `started_at` is known or derivable
 * from `duration_ms` (so a session whose start write was lost still gets a
 * row), else PATCHes. Never throws.
 */
export function recordVoiceSessionEnd(
  sessionId: string,
  fields: VoiceSessionFactsPatch & { _outcome_input?: OutcomeInput },
): void {
  try {
    if (!isVoiceSessionFactsEnabled()) return;
    if (!sessionId) {
      console.error(`${LOG} end: refused a write with no session_id`);
      return;
    }
    const endedAt = fields.ended_at ?? new Date().toISOString();
    const input: OutcomeInput = fields._outcome_input ?? {
      audio_in_chunks: fields.audio_in_chunks,
      audio_out_chunks: fields.audio_out_chunks,
      duration_ms: fields.duration_ms,
      turn_count: fields.turn_count,
      user_turns: fields.user_turns,
      model_turns: fields.model_turns,
      stall_count: fields.stall_count,
      close_reason: fields.close_reason,
      close_code: fields.close_code,
    };
    const classified = classifyVoiceSessionOutcome(input);
    const startedAt =
      fields.started_at ??
      (typeof fields.duration_ms === 'number'
        ? new Date(Date.parse(endedAt) - fields.duration_ms).toISOString()
        : undefined);
    const held = takePending(sessionId) ?? {};
    const row: Record<string, unknown> = {
      ...held,
      ...fields,
      ...(startedAt ? { started_at: startedAt } : {}),
      ended_at: endedAt,
      last_activity_at: fields.last_activity_at ?? endedAt,
      outcome: fields.outcome ?? classified.outcome,
      failure_class: fields.failure_class !== undefined ? fields.failure_class : classified.failure_class,
    };
    markKnown(sessionId);
    enqueue(startedAt ? 'upsert' : 'patch', sessionId, row, 'end');
  } catch (err) {
    console.error(`${LOG} end threw for ${sessionId}: ${(err as Error)?.message}`);
  }
}

/** End a live gateway session from its in-memory object. Never throws. */
export function recordLiveSessionEnd(session: LiveSessionLike, sessionId: string, reason: string): void {
  try {
    recordVoiceSessionEnd(sessionId, endFieldsFromLiveSession(session, reason));
  } catch (err) {
    console.error(`${LOG} live end threw for ${sessionId}: ${(err as Error)?.message}`);
  }
}

/**
 * First model audio of a session → ttfa_ms. Idempotent per session object
 * (one write per session, however many chunks follow).
 */
export function noteFirstAudioOut(session: LiveSessionLike & { _factsTtfaRecorded?: boolean }): void {
  try {
    if (session._factsTtfaRecorded) return;
    session._factsTtfaRecorded = true;
    const startedMs = session.createdAt instanceof Date ? session.createdAt.getTime() : null;
    if (startedMs === null || !session.sessionId) return;
    updateVoiceSessionFacts(session.sessionId, { ttfa_ms: Math.max(0, Date.now() - startedMs) });
  } catch (err) {
    console.error(`${LOG} ttfa threw: ${(err as Error)?.message}`);
  }
}

/**
 * VTID-04835: wait for every facts write queued so far (each chain already
 * swallows its own error, so this never rejects). Used by the SIGTERM drain,
 * which bounds it with its own timeout — a hung PostgREST call must not hold
 * the task past ECS's stopTimeout.
 */
export async function flushVoiceSessionFactsWrites(): Promise<void> {
  await Promise.all([...chains.values()]);
}

/** Test-only: wait for every queued write. */
export async function __flushVoiceSessionFactsForTests(): Promise<void> {
  await flushVoiceSessionFactsWrites();
}

/** Test-only: forget in-process bookkeeping between tests. */
export function __resetVoiceSessionFactsForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer);
  pending.clear();
  known.clear();
  chains.clear();
  warnedUnconfigured = false;
}
