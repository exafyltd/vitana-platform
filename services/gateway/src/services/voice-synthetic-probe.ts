/**
 * Synthetic Voice Probe (VTID-01961, PR #4)
 *
 * After self-healing dispatches a fix that targets a voice synthetic endpoint
 * (`voice-error://<class>`), we need a deterministic verification step
 * BEFORE marking the row recovered. The probe is the load-bearing safety
 * for the autopilot inner loop — without it, a "fix" claim could be wrong
 * and we'd never know.
 *
 * v1 probe: HTTP-based health verification.
 *   - GET /api/v1/orb/health on the deployed gateway revision
 *   - Assert all of:
 *       gemini_configured === true
 *       tts_client_ready === true
 *       voice_conversation_enabled === true
 *       fallback_chat_tts.available === true
 *
 * Each assertion failure produces a stable failure_mode_code so failures
 * themselves become signatures the Architecture Investigator (PR #6) can
 * cluster.
 *
 * v2 (post-canary): exercise the audio path with a pre-recorded utterance
 * + semantic-token check. The plan calls for chime-aware probe semantics
 * (filter chunks before model_start_speaking, require turn_complete and
 * a `ready` token in the model utterance). v2 will land that.
 *
 * The probe never throws — internal errors surface as ok=false with a
 * failure_mode_code. Probe self-test runs on first call to validate the
 * probe code is itself working.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const PROBE_TIMEOUT_MS = 15_000;

export type ProbeFailureModeCode =
  | 'health_unreachable'
  | 'health_non_2xx'
  | 'health_malformed_json'
  | 'gemini_not_configured'
  | 'tts_not_ready'
  | 'voice_disabled'
  | 'fallback_chat_tts_unavailable'
  | 'probe_timeout'
  | 'probe_error';

export interface ProbeResult {
  ok: boolean;
  failure_mode_code: ProbeFailureModeCode | null;
  duration_ms: number;
  evidence: {
    health_status?: number;
    gemini_configured?: unknown;
    tts_client_ready?: unknown;
    voice_conversation_enabled?: unknown;
    fallback_chat_tts_available?: unknown;
    error?: string;
  };
}

interface ProbeOptions {
  /** Override gateway URL (used by self-test against a stub). */
  gatewayUrl?: string;
  /** Override timeout (used by self-test). */
  timeoutMs?: number;
}

/**
 * Run the synthetic voice probe against the configured (or override) gateway.
 * Returns a structured verdict; never throws. The verdict drives the
 * reconciler's mark-recovered vs mark-probe-failed decision.
 */
export async function runVoiceProbe(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const url = `${opts.gatewayUrl || GATEWAY_URL}/api/v1/orb/health`;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    const duration_ms = Date.now() - startedAt;
    const isTimeout = err?.name === 'TimeoutError' || /timeout|aborted/i.test(err?.message || '');
    return {
      ok: false,
      failure_mode_code: isTimeout ? 'probe_timeout' : 'health_unreachable',
      duration_ms,
      evidence: { error: String(err?.message ?? err) },
    };
  }

  const duration_ms = Date.now() - startedAt;

  if (!res.ok) {
    return {
      ok: false,
      failure_mode_code: 'health_non_2xx',
      duration_ms,
      evidence: { health_status: res.status },
    };
  }

  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (err: any) {
    return {
      ok: false,
      failure_mode_code: 'health_malformed_json',
      duration_ms,
      evidence: { health_status: res.status, error: String(err?.message ?? err) },
    };
  }

  const gemini_configured = body.gemini_configured;
  const tts_client_ready = body.tts_client_ready;
  const voice_conversation_enabled = body.voice_conversation_enabled;
  const fallback = (body.fallback_chat_tts || {}) as Record<string, unknown>;
  const fallback_chat_tts_available = fallback.available;

  const evidence = {
    health_status: res.status,
    gemini_configured,
    tts_client_ready,
    voice_conversation_enabled,
    fallback_chat_tts_available,
  };

  if (gemini_configured !== true) {
    return { ok: false, failure_mode_code: 'gemini_not_configured', duration_ms, evidence };
  }
  if (tts_client_ready !== true) {
    return { ok: false, failure_mode_code: 'tts_not_ready', duration_ms, evidence };
  }
  if (voice_conversation_enabled !== true) {
    return { ok: false, failure_mode_code: 'voice_disabled', duration_ms, evidence };
  }
  if (fallback_chat_tts_available !== true) {
    return {
      ok: false,
      failure_mode_code: 'fallback_chat_tts_unavailable',
      duration_ms,
      evidence,
    };
  }

  return {
    ok: true,
    failure_mode_code: null,
    duration_ms,
    evidence,
  };
}

let lastProbeAt = 0;
const RATE_LIMIT_MS = 60_000;

/**
 * Rate-limited probe — at most once per minute globally. Used by the
 * reconciler to avoid hammering /orb/health if many voice rows come due
 * in the same tick.
 */
export async function runVoiceProbeRateLimited(opts: ProbeOptions = {}): Promise<ProbeResult> {
  const now = Date.now();
  if (now - lastProbeAt < RATE_LIMIT_MS) {
    return {
      ok: false,
      failure_mode_code: 'probe_error',
      duration_ms: 0,
      evidence: { error: 'rate_limited' },
    };
  }
  lastProbeAt = now;
  return runVoiceProbe(opts);
}

/** Test helper — reset rate-limit state. */
export function _resetProbeRateLimitForTests(): void {
  lastProbeAt = 0;
}
