/**
 * Voice Recurrence Sentinel (VTID-01962, PR #5)
 *
 * Class-level anti-loop control. The Spec Memory Gate (PR #3) blocks
 * spec-level repeats; the Sentinel blocks CLASS-level patterns even when
 * each individual fix appears to succeed. Three thresholds keyed on
 * (class, normalized_signature):
 *
 *   - Burst:        ≥ 5 verdict=ok in 24h. "We keep fixing it but it
 *                   keeps coming back the same day."
 *   - Persistence:  ≥ 3 dispatches in 7d where recurrence_after_fix_ms
 *                   < 6h. "Fix never holds for long."
 *   - Failed-fix:   ≥ 4 rollbacks in 7d. "We don't know how to fix this."
 *
 * State machine per (class, signature):
 *   active        — default; adapter dispatches normally.
 *   quarantined   — auto-set by Sentinel when a threshold trips. Adapter
 *                   short-circuits with voice.healing.dispatch.suppressed.
 *                   Held until ops calls /quarantine/release.
 *   probation     — set by ops via release endpoint. 72h timer.
 *                   Adapter allows max 1 dispatch per day per (class, sig);
 *                   thresholds are halved during probation so a fast
 *                   relapse re-quarantines.
 *   released      — probation completed without re-quarantine.
 *                   Adapter dispatches normally again.
 *
 * v2 (post-canary): adaptive thresholds derived from the trailing 30-day
 * distribution of recurrence_after_fix_ms and dispatch volume.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import { emitOasisEvent } from './oasis-event-service';
import { spawnInvestigator } from './voice-architecture-investigator';
import { notifyGChat } from './self-healing-snapshot-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;

// =============================================================================
// Thresholds (v1 fixed; v2 adaptive)
// =============================================================================

const BURST_LIMIT = 5;
const BURST_WINDOW_HOURS = 24;
const PERSISTENCE_LIMIT = 3;
const PERSISTENCE_WINDOW_HOURS = 24 * 7;
const PERSISTENCE_RECURRENCE_MS_THRESHOLD = 6 * 3600_000;
const FAILED_FIX_LIMIT = 4;
const FAILED_FIX_WINDOW_HOURS = 24 * 7;

// Probation: halved thresholds → re-quarantine fast on relapse.
const PROBATION_BURST_LIMIT = Math.ceil(BURST_LIMIT / 2);
const PROBATION_FAILED_FIX_LIMIT = Math.ceil(FAILED_FIX_LIMIT / 2);
const PROBATION_DURATION_HOURS = 72;
const PROBATION_MAX_DISPATCHES_PER_DAY = 1;

// =============================================================================
// Types
// =============================================================================

export type SentinelVerdict = 'ok' | 'rollback' | 'partial' | 'suppressed';
export type QuarantineStatus = 'active' | 'quarantined' | 'probation' | 'released';
export type QuarantineReason =
  | 'burst_threshold'
  | 'persistence_threshold'
  | 'failed_fix_threshold'
  | 'probation_burst'
  | 'probation_failed_fix'
  | 'manual';

export interface AppendVerdictInput {
  class: string;
  normalized_signature: string;
  verdict: SentinelVerdict;
  recurrence_after_fix_ms?: number | null;
  gateway_revision?: string | null;
  tenant_scope?: string | null;
  vtid?: string | null;
  fixed_at?: string | null;
}

export interface QuarantineRow {
  class: string;
  normalized_signature: string;
  status: QuarantineStatus;
  quarantined_at: string | null;
  reason: string | null;
  probation_until: string | null;
  investigation_id: string | null;
  updated_at: string;
}

export interface DispatchAllowedDecision {
  allowed: boolean;
  reason: 'active' | 'released' | 'probation_allowed' | 'quarantined' | 'probation_capped';
  status?: QuarantineStatus;
  probation_until?: string | null;
}

// =============================================================================
// Helpers
// =============================================================================

function supabaseHeaders(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_ROLE!,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
    'Content-Type': 'application/json',
  };
}

function isoMinusHours(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

// =============================================================================
// VTID-04776: recurrence after fix
// =============================================================================

/**
 * Pure: ms between the most recent fix of this (class, signature) and `nowMs`.
 * Null when there is no prior fix or the timestamp is unusable (never
 * negative). This is what the Persistence threshold ("fix never holds for
 * long", recurrence < 6 h) reads — and what every appendVerdict caller left
 * null until VTID-04776, so that threshold could never trip.
 */
export function recurrenceAfterFixMs(priorFixedAt: string | null | undefined, nowMs: number = Date.now()): number | null {
  if (!priorFixedAt) return null;
  const t = Date.parse(priorFixedAt);
  if (!Number.isFinite(t) || t > nowMs) return null;
  return nowMs - t;
}

/**
 * The most recent `fixed_at` recorded for (class, signature), or null.
 * Never throws; a failed lookup is logged and reads as "no prior fix".
 */
export async function fetchLastFixedAt(klass: string, signature: string): Promise<string | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/voice_healing_history?` +
      `class=eq.${encodeURIComponent(klass)}&` +
      `normalized_signature=eq.${encodeURIComponent(signature)}&` +
      `fixed_at=not.is.null&select=fixed_at&order=fixed_at.desc&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res || !res.ok) {
      console.warn(`[VTID-04776] last fixed_at lookup failed for ${klass}/${signature}: ${res?.status ?? 'no response'}`);
      return null;
    }
    const rows = (await res.json()) as Array<{ fixed_at: string | null }>;
    return rows?.[0]?.fixed_at ?? null;
  } catch (err) {
    console.warn(`[VTID-04776] last fixed_at lookup threw for ${klass}/${signature}: ${(err as Error)?.message}`);
    return null;
  }
}

/** Convenience for appendVerdict callers: recurrence vs the prior fix. */
export async function resolveRecurrenceAfterFixMs(klass: string, signature: string): Promise<number | null> {
  return recurrenceAfterFixMs(await fetchLastFixedAt(klass, signature));
}

// =============================================================================
// History append
// =============================================================================

export async function appendVerdict(input: AppendVerdictInput): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/voice_healing_history`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), Prefer: 'return=minimal' },
      body: JSON.stringify({
        class: input.class,
        normalized_signature: input.normalized_signature,
        verdict: input.verdict,
        recurrence_after_fix_ms: input.recurrence_after_fix_ms ?? null,
        gateway_revision: input.gateway_revision ?? null,
        tenant_scope: input.tenant_scope ?? null,
        vtid: input.vtid ?? null,
        fixed_at: input.fixed_at ?? null,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// =============================================================================
// Quarantine state read/write
// =============================================================================

export async function getQuarantineState(
  klass: string,
  signature: string,
): Promise<QuarantineRow | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;
  try {
    const url =
      `${SUPABASE_URL}/rest/v1/voice_healing_quarantine?` +
      `class=eq.${encodeURIComponent(klass)}&` +
      `normalized_signature=eq.${encodeURIComponent(signature)}&limit=1`;
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) return null;
    const rows = (await res.json()) as QuarantineRow[];
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function upsertQuarantine(
  klass: string,
  signature: string,
  patch: Partial<QuarantineRow>,
): Promise<boolean> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return false;
  const row = {
    class: klass,
    normalized_signature: signature,
    updated_at: new Date().toISOString(),
    ...patch,
  };
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/voice_healing_quarantine?on_conflict=class,normalized_signature`,
      {
        method: 'POST',
        headers: {
          ...supabaseHeaders(),
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
        body: JSON.stringify(row),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

// =============================================================================
// Threshold evaluation
// =============================================================================

interface ThresholdCounts {
  burst_24h: number;
  persistence_7d: number;
  failed_fix_7d: number;
  probation_dispatches_today: number;
}

async function countHistory(
  klass: string,
  signature: string,
): Promise<ThresholdCounts | null> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) return null;

  const since24h = isoMinusHours(BURST_WINDOW_HOURS);
  const since7d = isoMinusHours(FAILED_FIX_WINDOW_HOURS);
  const since24hToday = isoMinusHours(24);

  try {
    const baseUrl =
      `${SUPABASE_URL}/rest/v1/voice_healing_history?` +
      `class=eq.${encodeURIComponent(klass)}&` +
      `normalized_signature=eq.${encodeURIComponent(signature)}&`;

    const [burstRes, persistRes, rollbackRes, dispatchTodayRes] = await Promise.all([
      fetch(
        `${baseUrl}verdict=eq.ok&dispatched_at=gte.${encodeURIComponent(since24h)}&select=id`,
        { headers: { ...supabaseHeaders(), Prefer: 'count=exact' } },
      ),
      fetch(
        `${baseUrl}dispatched_at=gte.${encodeURIComponent(since7d)}&recurrence_after_fix_ms=lt.${PERSISTENCE_RECURRENCE_MS_THRESHOLD}&select=id`,
        { headers: { ...supabaseHeaders(), Prefer: 'count=exact' } },
      ),
      fetch(
        `${baseUrl}verdict=eq.rollback&dispatched_at=gte.${encodeURIComponent(since7d)}&select=id`,
        { headers: { ...supabaseHeaders(), Prefer: 'count=exact' } },
      ),
      fetch(
        `${baseUrl}dispatched_at=gte.${encodeURIComponent(since24hToday)}&select=id`,
        { headers: { ...supabaseHeaders(), Prefer: 'count=exact' } },
      ),
    ]);

    const parseCount = (r: Response): number => {
      const cr = r.headers.get('content-range') || '';
      const m = /\/(\d+)$/.exec(cr);
      return m ? parseInt(m[1], 10) : 0;
    };

    return {
      burst_24h: burstRes.ok ? parseCount(burstRes) : 0,
      persistence_7d: persistRes.ok ? parseCount(persistRes) : 0,
      failed_fix_7d: rollbackRes.ok ? parseCount(rollbackRes) : 0,
      probation_dispatches_today: dispatchTodayRes.ok ? parseCount(dispatchTodayRes) : 0,
    };
  } catch {
    return null;
  }
}

/**
 * After every verdict written via appendVerdict, evaluate thresholds and
 * quarantine the (class, signature) pair if any threshold is exceeded.
 * Threshold values depend on whether we're already in probation (halved).
 * Returns the reason if quarantined, null otherwise.
 */
export async function evaluateAndQuarantine(
  klass: string,
  signature: string,
): Promise<QuarantineReason | null> {
  const counts = await countHistory(klass, signature);
  if (!counts) return null;

  const current = await getQuarantineState(klass, signature);
  const inProbation =
    current?.status === 'probation' &&
    current.probation_until &&
    new Date(current.probation_until).getTime() > Date.now();

  const burstLimit = inProbation ? PROBATION_BURST_LIMIT : BURST_LIMIT;
  const failedFixLimit = inProbation ? PROBATION_FAILED_FIX_LIMIT : FAILED_FIX_LIMIT;

  let reason: QuarantineReason | null = null;
  if (counts.burst_24h >= burstLimit) {
    reason = inProbation ? 'probation_burst' : 'burst_threshold';
  } else if (!inProbation && counts.persistence_7d >= PERSISTENCE_LIMIT) {
    reason = 'persistence_threshold';
  } else if (counts.failed_fix_7d >= failedFixLimit) {
    reason = inProbation ? 'probation_failed_fix' : 'failed_fix_threshold';
  }

  if (!reason) return null;

  await upsertQuarantine(klass, signature, {
    status: 'quarantined',
    quarantined_at: new Date().toISOString(),
    probation_until: null,
    reason,
  });

  try {
    await emitOasisEvent({
      vtid: 'VTID-VOICE-HEALING',
      type: 'voice.healing.dispatch.suppressed',
      source: 'voice-recurrence-sentinel',
      status: 'warning',
      message: `Sentinel quarantined ${klass} (${signature}) — reason=${reason}`,
      payload: {
        class: klass,
        normalized_signature: signature,
        reason,
        burst_24h: counts.burst_24h,
        persistence_7d: counts.persistence_7d,
        failed_fix_7d: counts.failed_fix_7d,
        was_in_probation: inProbation || false,
      },
    });
  } catch {
    /* best-effort */
  }

  // VTID-02030: ping ops via Gchat — quarantine means the auto-loop has
  // stopped and the supervisor should look. Reuses the same notifyGChat()
  // helper that powers existing self-healing pings (54-health-check stream).
  console.log(
    `[voice-recurrence-sentinel] gchat-ping prep: class=${klass} reason=${reason} ` +
    `webhook_set=${Boolean(process.env.GCHAT_COMMANDHUB_WEBHOOK)}`,
  );
  try {
    await notifyGChat(
      `🛑 *Voice class quarantined*\n` +
      `Class: \`${klass}\`\n` +
      `Signature: \`${signature}\`\n` +
      `Reason: *${reason}* ` +
      `(burst_24h=${counts.burst_24h}, persistence_7d=${counts.persistence_7d}, failed_fix_7d=${counts.failed_fix_7d}` +
      `${inProbation ? ', from_probation=true' : ''})\n` +
      `Investigator spawned. No further auto-dispatch on this class until released.`,
    );
    console.log(
      `[voice-recurrence-sentinel] gchat-ping sent for class=${klass}`,
    );
  } catch (err: any) {
    console.error(
      `[voice-recurrence-sentinel] gchat-ping FAILED: ${err?.message ?? err}`,
    );
  }

  // VTID-01963 (PR #6): spawn the Architecture Investigator. Fire-and-forget
  // so we don't block the reconciler tick on the Vertex call. The
  // investigator persists a report row and emits voice.healing.investigation.completed.
  spawnInvestigator({
    class: klass,
    normalized_signature: signature,
    trigger_reason: 'sentinel_quarantine',
    notes: `Quarantine reason: ${reason}. Burst=${counts.burst_24h}, persistence=${counts.persistence_7d}, failed_fix=${counts.failed_fix_7d}.`,
  }).catch((err) =>
    console.warn(
      `[voice-recurrence-sentinel] investigator spawn failed: ${err?.message ?? err}`,
    ),
  );

  return reason;
}

// =============================================================================
// Quarantine release (ops endpoint backs this)
// =============================================================================

export async function releaseQuarantine(
  klass: string,
  signature: string,
  reason?: string,
): Promise<{ ok: boolean; new_status: QuarantineStatus; probation_until: string | null; error?: string }> {
  const current = await getQuarantineState(klass, signature);
  if (!current) {
    return { ok: false, new_status: 'active', probation_until: null, error: 'no_quarantine_row' };
  }
  if (current.status !== 'quarantined') {
    return {
      ok: false,
      new_status: current.status,
      probation_until: current.probation_until,
      error: `cannot_release_from_${current.status}`,
    };
  }

  const probationUntil = new Date(
    Date.now() + PROBATION_DURATION_HOURS * 3600_000,
  ).toISOString();

  const ok = await upsertQuarantine(klass, signature, {
    status: 'probation',
    probation_until: probationUntil,
    reason: `released_to_probation${reason ? `:${reason}` : ''}`,
  });

  if (!ok) {
    return {
      ok: false,
      new_status: current.status,
      probation_until: current.probation_until,
      error: 'upsert_failed',
    };
  }

  return { ok: true, new_status: 'probation', probation_until: probationUntil };
}

// =============================================================================
// Adapter gate
// =============================================================================

/**
 * Adapter calls this between classifier and Spec Memory Gate. Returns
 * allowed=false when the (class, signature) pair is in 'quarantined'
 * status, or in 'probation' with daily dispatch quota exhausted.
 */
export async function isDispatchAllowed(
  klass: string,
  signature: string,
): Promise<DispatchAllowedDecision> {
  const current = await getQuarantineState(klass, signature);
  if (!current || current.status === 'active' || current.status === 'released') {
    return { allowed: true, reason: current?.status === 'released' ? 'released' : 'active' };
  }

  if (current.status === 'quarantined') {
    return {
      allowed: false,
      reason: 'quarantined',
      status: 'quarantined',
    };
  }

  // Status is 'probation' — check expiry first.
  if (current.status === 'probation') {
    const expiresAt = current.probation_until
      ? new Date(current.probation_until).getTime()
      : 0;
    if (expiresAt && expiresAt < Date.now()) {
      // Probation expired naturally with no relapse → released.
      await upsertQuarantine(klass, signature, {
        status: 'released',
        probation_until: null,
        reason: `probation_expired_no_relapse`,
      });
      return { allowed: true, reason: 'released', status: 'released' };
    }

    // Check today's dispatch count via count of history rows.
    const counts = await countHistory(klass, signature);
    const todayCount = counts?.probation_dispatches_today ?? 0;
    if (todayCount >= PROBATION_MAX_DISPATCHES_PER_DAY) {
      return {
        allowed: false,
        reason: 'probation_capped',
        status: 'probation',
        probation_until: current.probation_until,
      };
    }
    return {
      allowed: true,
      reason: 'probation_allowed',
      status: 'probation',
      probation_until: current.probation_until,
    };
  }

  return { allowed: true, reason: 'active' };
}

// =============================================================================
// Telemetry continuity probe (VTID-04770)
// =============================================================================

/**
 * Result of a telemetry continuity probe. All three counters reflect what
 * the database returned for the probe key after the write — not the full
 * class history.
 */
export interface TelemetryContinuityResult {
  ok: boolean;
  /** Number of rows found for the probe key in voice_healing_history. */
  dispatch_count: number;
  /** Rows with verdict='rollback' for the probe key. */
  rollback_count: number;
  /** Rows with verdict='suppressed' for the probe key. */
  suppressed_count: number;
  /** Human-readable reason when ok=false. */
  detail?: string;
}

/**
 * VTID-04770 — "VERIFY THEN HOLD" post-migration check.
 *
 * Writes a synthetic suppressed verdict for the well-known probe key
 * (class='bedrock-verification-test', signature='probe_continuity_check'),
 * then reads back the history for that key and verifies the row appears.
 * This confirms that appendVerdict → voice_healing_history round-trip is
 * working post-Bedrock-transport migration, without touching real incident
 * classes.
 *
 * The probe key is intentionally outside VOICE_FAILURE_CLASSES so it can
 * never be confused with a real dispatch. It is safe to call from an ops
 * endpoint or a scheduled health check.
 *
 * Never throws — returns ok=false with a detail string on any failure.
 */
export async function probeTelemetryContinuity(): Promise<TelemetryContinuityResult> {
  const PROBE_CLASS = 'bedrock-verification-test';
  const PROBE_SIG = 'probe_continuity_check';

  const empty: TelemetryContinuityResult = {
    ok: false,
    dispatch_count: 0,
    rollback_count: 0,
    suppressed_count: 0,
  };

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { ...empty, detail: 'supabase_not_configured' };
  }

  // 1. Write a synthetic suppressed verdict.
  const wrote = await appendVerdict({
    class: PROBE_CLASS,
    normalized_signature: PROBE_SIG,
    verdict: 'suppressed',
    gateway_revision: process.env.K_REVISION ?? null,
    vtid: 'VTID-04770',
  });
  if (!wrote) {
    return { ...empty, detail: 'write_failed' };
  }

  // 2. Read back the history for the probe key (last 24 h is enough).
  try {
    const since = isoMinusHours(24);
    const url =
      `${SUPABASE_URL}/rest/v1/voice_healing_history?` +
      `class=eq.${encodeURIComponent(PROBE_CLASS)}&` +
      `normalized_signature=eq.${encodeURIComponent(PROBE_SIG)}&` +
      `dispatched_at=gte.${encodeURIComponent(since)}&` +
      `select=verdict`;
    const res = await fetch(url, { headers: supabaseHeaders() });
    if (!res.ok) {
      return { ...empty, detail: `read_failed_${res.status}` };
    }
    const rows = (await res.json()) as Array<{ verdict: string }>;
    if (rows.length === 0) {
      return { ...empty, detail: 'write_not_visible' };
    }
    const dispatch_count = rows.length;
    const rollback_count = rows.filter((r) => r.verdict === 'rollback').length;
    const suppressed_count = rows.filter((r) => r.verdict === 'suppressed').length;
    return { ok: true, dispatch_count, rollback_count, suppressed_count };
  } catch (err: any) {
    return { ...empty, detail: `read_threw: ${err?.message ?? String(err)}` };
  }
}
