/**
 * Voice→SelfHealing Adapter (VTID-01959, PR #2)
 *
 * Bridges voice OASIS error events into the existing self-healing pipeline
 * via the synthetic endpoint convention `voice-error://<class>` (allowlisted
 * in PR #0). The adapter is fire-and-forget from orb-live.ts hot paths so
 * voice session handling is never blocked by classification or HTTP work.
 *
 * Flow per call:
 *   1. Filter synthetic probe sessions (metadata.synthetic === true).
 *   2. Read mode flag (system_config.voice_self_healing_mode):
 *        - off    → return early (this PR's default)
 *        - shadow → classify + dedupe + log "would-dispatch", do NOT POST
 *        - live   → classify + dedupe + POST to /api/v1/self-healing/report
 *   3. Classify the session (voice-session-classifier).
 *   4. 5-tuple Supabase dedupe — INSERT ON CONFLICT DO NOTHING on
 *      (class, normalized_signature, gateway_revision, tenant_scope, hour_bucket).
 *      Conflict = another instance/session in the same hour already dispatched
 *      this signature, so skip.
 *   5. Build ServiceStatus and POST to /report (mode=live only).
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import {
  classifyVoiceSession,
  VoiceClassification,
} from './voice-session-classifier';
import { getVoiceSpecHint } from './voice-spec-hints';
import { lookupSpecMemory } from './voice-spec-memory';
import { isDispatchAllowed } from './voice-recurrence-sentinel';
import { emitOasisEvent } from './oasis-event-service';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
// Cloud Run sets K_REVISION; fall back to BUILD_INFO for local/dev.
const GATEWAY_REVISION =
  process.env.K_REVISION || process.env.BUILD_INFO || 'unknown';

export type SelfHealingMode = 'off' | 'shadow' | 'live';

const MODE_CACHE_TTL_MS = 30_000;
let cachedMode: SelfHealingMode | null = null;
let cachedModeAt = 0;

/**
 * Read `system_config.voice_self_healing_mode`. Default 'off' on any error
 * (missing config row, Supabase unreachable, malformed value). Cached for
 * 30s so the hot path doesn't read Supabase per emit.
 */
export async function getVoiceSelfHealingMode(force?: boolean): Promise<SelfHealingMode> {
  const now = Date.now();
  if (!force && cachedMode && now - cachedModeAt < MODE_CACHE_TTL_MS) {
    return cachedMode;
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    cachedMode = 'off';
    cachedModeAt = now;
    return 'off';
  }
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/system_config?key=eq.voice_self_healing_mode&select=value&limit=1`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
        },
      },
    );
    if (res.ok) {
      const rows = (await res.json()) as Array<{ value?: string }>;
      const v = rows[0]?.value;
      if (v === 'off' || v === 'shadow' || v === 'live') {
        cachedMode = v;
        cachedModeAt = now;
        return v;
      }
    }
  } catch {
    /* fall through to default */
  }
  cachedMode = 'off';
  cachedModeAt = now;
  return 'off';
}

/** Test helper — invalidate the mode cache. */
export function _resetModeCacheForTests(): void {
  cachedMode = null;
  cachedModeAt = 0;
}

export interface DispatchOptions {
  sessionId: string;
  /** Optional tenant scope for dedupe. Defaults to 'global'. */
  tenantScope?: string;
  /**
   * Session metadata. If `synthetic === true` the dispatch is suppressed
   * (used by future Synthetic Voice Probe — PR #4).
   */
  metadata?: Record<string, unknown>;
}

export type DispatchAction =
  | 'dispatched'
  | 'shadow_logged'
  | 'mode_off'
  | 'synthetic_skipped'
  | 'dedupe_hit'
  | 'classifier_no_error'
  | 'spec_memory_blocked'
  | 'sentinel_quarantined'
  | 'sentinel_probation_capped'
  | 'error';

export interface DispatchResult {
  action: DispatchAction;
  class?: string;
  normalized_signature?: string;
  detail?: string;
  http_status?: number;
}

function hourBucketIso(): string {
  const d = new Date();
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

interface DedupeReservation {
  first: boolean;
  error?: string;
}

async function tryReserveDedupe(
  klass: string,
  signature: string,
  tenantScope: string,
): Promise<DedupeReservation> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return { first: false, error: 'no_supabase' };
  }
  const row = {
    class: klass,
    normalized_signature: signature,
    gateway_revision: GATEWAY_REVISION,
    tenant_scope: tenantScope,
    hour_bucket: hourBucketIso(),
  };
  // ON CONFLICT DO NOTHING via Prefer: resolution=ignore-duplicates.
  // Combined with return=representation, the response body length tells us
  // whether the row was newly inserted (length 1) or already existed (0).
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/voice_healing_dedupe`,
      {
        method: 'POST',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=ignore-duplicates,return=representation',
        },
        body: JSON.stringify(row),
      },
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { first: false, error: `dedupe_${res.status}_${txt.slice(0, 80)}` };
    }
    const inserted = (await res.json()) as Array<unknown>;
    return { first: Array.isArray(inserted) && inserted.length > 0 };
  } catch (err: any) {
    return { first: false, error: `dedupe_fetch: ${err?.message ?? 'unknown'}` };
  }
}

interface ServiceStatusPayload {
  name: string;
  endpoint: string;
  status: 'down';
  http_status: number;
  response_body: string;
  response_time_ms: number;
  error_message: string;
}

function buildServiceStatus(c: VoiceClassification): ServiceStatusPayload {
  const evidence = JSON.stringify(c.evidence).slice(0, 4000);
  const errorMessage =
    c.evidence.stall_description ||
    `${c.class} (signature: ${c.normalized_signature}, errors: ${c.evidence.error_count})`;
  return {
    name: 'orb-voice-pipeline',
    endpoint: `voice-error://${c.class}`,
    status: 'down',
    http_status: 0,
    response_body: evidence,
    response_time_ms: 0,
    error_message: errorMessage,
  };
}

async function postSelfHealingReport(
  c: VoiceClassification,
): Promise<{ ok: boolean; status?: number; detail?: string }> {
  const payload = {
    timestamp: new Date().toISOString(),
    total: 1,
    live: 0,
    services: [buildServiceStatus(c)],
  };
  try {
    const res = await fetch(`${GATEWAY_URL}/api/v1/self-healing/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, status: res.status, detail: txt.slice(0, 200) };
    }
    return { ok: true, status: res.status };
  } catch (err: any) {
    return { ok: false, detail: err?.message ?? 'unknown' };
  }
}

/**
 * Classify the session and dispatch to self-healing if the (class,
 * signature) hasn't been dispatched in this hour. Returns a structured
 * result describing what happened. Does not throw — all internal errors
 * are surfaced as `action: 'error'`.
 */
export async function dispatchVoiceFailure(
  opts: DispatchOptions,
): Promise<DispatchResult> {
  if (opts.metadata?.synthetic === true) {
    return { action: 'synthetic_skipped' };
  }

  const mode = await getVoiceSelfHealingMode();
  if (mode === 'off') {
    return { action: 'mode_off' };
  }

  let classification: VoiceClassification;
  try {
    classification = await classifyVoiceSession(opts.sessionId);
  } catch (err: any) {
    return { action: 'error', detail: `classify_failed: ${err?.message ?? 'unknown'}` };
  }

  // Healthy session (no error events, no stall) → don't dispatch. Note we
  // still dispatch when class is voice.unknown but severity === 'error',
  // because that means we observed errors we couldn't classify — investigator
  // needs that signal.
  if (classification.class === 'voice.unknown' && classification.severity !== 'error') {
    return {
      action: 'classifier_no_error',
      class: classification.class,
      normalized_signature: classification.normalized_signature,
    };
  }



  // VTID-01962 (PR #5): Recurrence Sentinel quarantine check. If the
  // (class, signature) pair is quarantined, suppress dispatch and emit
  // voice.healing.dispatch.suppressed. Probation status allows dispatch
  // but caps daily volume — adapter respects probation_capped.
  const dispatchDecision = await isDispatchAllowed(
    classification.class,
    classification.normalized_signature,
  );
  if (!dispatchDecision.allowed) {
    try {
      await emitOasisEvent({
        vtid: 'VTID-VOICE-HEALING',
        type: 'voice.healing.dispatch.suppressed',
        source: 'voice-self-healing-adapter',
        status: 'warning',
        message: `Sentinel ${dispatchDecision.reason} — dispatch suppressed for ${classification.class}`,
        payload: {
          class: classification.class,
          normalized_signature: classification.normalized_signature,
          reason: dispatchDecision.reason,
          status: dispatchDecision.status,
          probation_until: dispatchDecision.probation_until,
          session_id: opts.sessionId,
        },
      });
    } catch {
      /* best-effort telemetry */
    }
    return {
      action:
        dispatchDecision.reason === 'probation_capped'
          ? 'sentinel_probation_capped'
          : 'sentinel_quarantined',
      class: classification.class,
      normalized_signature: classification.normalized_signature,
      detail: dispatchDecision.reason,
    };
  }

  // VTID-01960 (PR #3): Spec Memory Gate. Only applies when we know which
  // spec WILL run — i.e., a deterministic hint exists. For Gemini-fallback
  // classes the spec_hash isn't known until generateAndStoreFixSpec runs,
  // so the gate is bypassed here (the dedupe/circuit-breaker handles
  // those). When a hint exists, look up (spec_hash, signature) in the last
  // 72h: a probe_failed/rollback row OR a stale 'success' row whose
  // signature is recurring → block dispatch and emit
  // voice.healing.spec_memory.blocked. Investigator queue (PR #6) will
  // pick these up.
  const hint = getVoiceSpecHint(classification.class);
  if (hint) {
    const decision = await lookupSpecMemory(
      hint.spec_hash,
      classification.normalized_signature,
      true,
    );
    if (decision.block) {
      try {
        await emitOasisEvent({
          vtid: 'VTID-VOICE-HEALING',
          type: 'voice.healing.spec_memory.blocked',
          source: 'voice-self-healing-adapter',
          status: 'warning',
          message: `Spec Memory Gate blocked dispatch for ${classification.class} (${decision.reason})`,
          payload: {
            class: classification.class,
            normalized_signature: classification.normalized_signature,
            spec_hash: hint.spec_hash,
            reason: decision.reason,
            matched_outcome: decision.matched?.outcome,
            matched_attempted_at: decision.matched?.attempted_at,
            matched_vtid: decision.matched?.vtid,
            session_id: opts.sessionId,
          },
        });
      } catch {
        /* best-effort telemetry */
      }
      return {
        action: 'spec_memory_blocked',
        class: classification.class,
        normalized_signature: classification.normalized_signature,
        detail: decision.reason,
      };
    }
  }

  const tenantScope = opts.tenantScope || 'global';
  const dedup = await tryReserveDedupe(
    classification.class,
    classification.normalized_signature,
    tenantScope,
  );
  if (!dedup.first) {
    return {
      action: 'dedupe_hit',
      class: classification.class,
      normalized_signature: classification.normalized_signature,
      detail: dedup.error,
    };
  }

  if (mode === 'shadow') {
    return {
      action: 'shadow_logged',
      class: classification.class,
      normalized_signature: classification.normalized_signature,
    };
  }

  // mode === 'live'
  const post = await postSelfHealingReport(classification);
  if (!post.ok) {
    return {
      action: 'error',
      class: classification.class,
      normalized_signature: classification.normalized_signature,
      http_status: post.status,
      detail: `report_${post.status ?? 'fetch'}: ${post.detail ?? ''}`,
    };
  }
  return {
    action: 'dispatched',
    class: classification.class,
    normalized_signature: classification.normalized_signature,
    http_status: post.status,
  };
}

/**
 * Fire-and-forget wrapper for orb-live.ts hot paths. Always returns
 * synchronously; never throws. Internal errors are logged at warn level.
 */
export function dispatchVoiceFailureFireAndForget(opts: DispatchOptions): void {
  dispatchVoiceFailure(opts).catch((err) => {
    console.warn(
      '[voice-self-healing-adapter] fire-and-forget dispatch failed:',
      err?.message ?? err,
    );
  });
}
