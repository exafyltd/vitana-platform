/**
 * Voice Spec Hints (VTID-01960, PR #3)
 *
 * Deterministic fix-spec library for voice failure classes. When the
 * self-healing pipeline diagnoses a voice synthetic endpoint
 * (`voice-error://<class>`), it consults this module before falling back
 * to Gemini. Deterministic specs are:
 *   - Reviewable in PRs (no LLM-output drift between runs).
 *   - Hashable to a stable spec_hash that the Spec Memory Gate keys on.
 *   - Conservative — when the fix touches deploy/env/auth surfaces, the
 *     spec describes verification + redeploy steps rather than rotating
 *     keys or restarting services autonomously.
 *
 * Coverage in v1:
 *   - voice.config_missing            (deterministic, env-vars on Cloud Run)
 *   - voice.config_fallback_active    (deterministic, fallback masking real env)
 *   - voice.auth_rejected             (deterministic, ADC + 401 path verification)
 *   - voice.model_stall               (stub — retry+reconnect guidance)
 *   - voice.upstream_disconnect       (stub — same)
 *   - voice.tts_failed                (stub — re-init TTS client)
 *   - voice.session_leak              (stub — kill stale sessions)
 *
 * Other classes (tool_loop, audio_one_way, permission_denied, unknown)
 * fall through to the existing Gemini path.
 *
 * Plan: .claude/plans/the-biggest-issues-and-fizzy-wozniak.md
 */

import { createHash } from 'crypto';
import { VoiceFailureClass } from './voice-failure-taxonomy';

export interface VoiceSpecHint {
  /** Markdown spec body in the 9-section format the validator expects. */
  spec: string;
  /** Stable sha256 of the spec body — Spec Memory Gate key. */
  spec_hash: string;
  /** Human-readable summary for logs and OASIS events. */
  summary: string;
  /** True if the spec contains deploy/env/workflow edits. Used by callers
   *  to apply additional guardrails (e.g., Phase 5 sentinel may treat
   *  deploy-impacting fixes with stricter recurrence thresholds). */
  touches_deploy: boolean;
}

function specWithHash(spec: string, summary: string, touchesDeploy: boolean): VoiceSpecHint {
  return {
    spec,
    spec_hash: createHash('sha256').update(spec).digest('hex'),
    summary,
    touches_deploy: touchesDeploy,
  };
}

// =============================================================================
// Deterministic specs
// =============================================================================

const SPEC_CONFIG_MISSING = `# SELF-HEAL: ORB Voice config_missing — verify Vertex env on Cloud Run

## Goal
Restore ORB voice-to-voice (Vertex AI Gemini Live) sessions by ensuring \`VERTEX_PROJECT_ID\` and \`GCP_PROJECT_ID\` are populated on the deployed Cloud Run revision of the gateway service.

## Non-negotiable Governance Rules Touched
- CLAUDE.md ALWAYS rule 11: Always use GCP project \`lovable-vitana-vers1\`.
- CLAUDE.md ALWAYS rule 12: Always deploy in \`us-central1\`.
- CLAUDE.md ALWAYS rule 18: Always deploy via the canonical deploy scripts.

## Scope
Verify and (if missing) restore the Vertex env vars on the Cloud Run gateway service. Do NOT rotate Google service-account credentials. Do NOT change Vertex region or project ID values — only ensure they are present and equal to the canonical \`lovable-vitana-vers1\`.

## Changes
1. Run: \`gcloud run services describe gateway --region=us-central1 --project=lovable-vitana-vers1 --format='value(spec.template.spec.containers[0].env)'\`. Confirm \`VERTEX_PROJECT_ID\` and \`GCP_PROJECT_ID\` exist.
2. If absent: re-run \`.github/workflows/EXEC-DEPLOY.yml\` against \`main\` for the gateway service. The workflow already sets these env vars (see VTID-01219, ORB Voice Protection).
3. If present but empty: dispatch a manual EXEC-DEPLOY with input \`environment=dev\` to re-apply env from the workflow definition.
4. The hardcoded fallback in \`services/gateway/src/routes/orb-live.ts:1029\` (project_id=\`'lovable-vitana-vers1'\`) is a safety net only — do not rely on it as the long-term fix.

## Files to Modify
- None directly. The remediation re-runs the existing deploy workflow.
- If a config drift is found in \`.github/workflows/EXEC-DEPLOY.yml\` (env var removed), restore the \`VERTEX_PROJECT_ID\` / \`GCP_PROJECT_ID\` lines.

## Acceptance Criteria
- \`GET https://gateway-q74ibpv6ia-uc.a.run.app/api/v1/orb/health\` returns \`gemini_configured: true\` and \`tts_client_ready: true\`.
- One synthetic voice probe session (PR #4) completes with \`audio_chunks > 0\` (post-chime) AND \`turn_complete\` AND a model utterance containing the expected token.
- No new \`orb.live.startup.config_missing\` or \`orb.live.config_missing\` events emitted in the 30 minutes following the fix.

## Verification Steps
1. Curl \`/api/v1/orb/health\` and parse JSON; confirm flags above.
2. Run the synthetic Voice Probe (PR #4 — \`voice-synthetic-probe.runVoiceProbe()\`).
3. Query \`oasis_events\` for the last 30 minutes; assert no \`orb.live.config_missing\` rows.

## Rollback Plan
Cloud Run keeps prior revisions. If the redeploy itself causes a regression, route 100% traffic to the previous revision: \`gcloud run services update-traffic gateway --to-revisions=<prev>=100 --region=us-central1\`.

## Risk Level
LOW — re-applying the same canonical env via the canonical workflow. No code changes. Rollback is a single \`update-traffic\` command.
`;

const SPEC_CONFIG_FALLBACK_ACTIVE = `# SELF-HEAL: ORB Voice config_fallback_active — replace fallback with real env

## Goal
ORB voice sessions are using the hardcoded fallback project_id (\`lovable-vitana-vers1\`) at \`services/gateway/src/routes/orb-live.ts:1029\` because \`VERTEX_PROJECT_ID\` is empty in the deployed Cloud Run env. Sessions appear healthy but the env-driven configuration is silently broken. Replace the fallback usage with a properly populated env var so the issue surfaces correctly on future deploys.

## Non-negotiable Governance Rules Touched
- CLAUDE.md ALWAYS rule 11: GCP project \`lovable-vitana-vers1\`.
- CLAUDE.md ALWAYS rule 18: Canonical deploy scripts.
- CLAUDE.md NEVER rule 35: Never allow silent model fallback.

## Scope
Identical to \`voice.config_missing\` — verify and restore Vertex env vars on Cloud Run. Distinct class because the fallback masks the symptom; treat as a higher-priority remediation than passive monitoring even when sessions appear healthy.

## Changes
1. Inspect Cloud Run env (see voice.config_missing spec).
2. Re-run EXEC-DEPLOY against the gateway service.
3. Confirm \`VERTEX_PROJECT_ID\` is now read from env, not from the fallback.

## Files to Modify
- None directly; re-runs the existing deploy workflow.

## Acceptance Criteria
- After re-deploy, \`GET /api/v1/orb/health\` reports \`vertex_project_id\` matching the env (not the fallback).
- A synthetic probe completes successfully.
- No new \`orb.live.config_missing\` or \`orb.live.startup.config_missing\` events emitted with \`status='warning'\` in the 30 minutes following the fix.

## Verification Steps
Same as voice.config_missing. Additionally: confirm via gateway logs that the startup-time config validation log line for the fallback is no longer printed on the new revision.

## Rollback Plan
Same as voice.config_missing — Cloud Run revision pinning.

## Risk Level
LOW — same blast radius as voice.config_missing (re-applying the canonical workflow).
`;

const SPEC_AUTH_REJECTED = `# SELF-HEAL: ORB Voice auth_rejected — verify Vertex ADC + 401 guard

## Goal
Voice session Live API connection failed with an authentication error (UNAUTHENTICATED / HTTP 401 / JWT expired / invalid service account). Confirm Application Default Credentials (ADC) on Cloud Run, JWT signing keys, and the \`optionalAuth\` 401 reject path at \`services/gateway/src/routes/orb-live.ts:10542\` (BOOTSTRAP-ORB-AUTH-REJECT, 2026-03-28). Do NOT auto-rotate keys.

## Non-negotiable Governance Rules Touched
- CLAUDE.md NEVER rule 33: Never override AI routing rules.
- CLAUDE.md NEVER rule 8: Never bypass governance gates.
- ORB Auth feedback (memory): optionalAuth silent-anonymous pitfall — invalid Bearer tokens must 401, not become anonymous sessions.

## Scope
Diagnostic + verification spec. The remediation is to confirm three preconditions hold; if any are false, the fix is to flag for ops, not to auto-rotate.

## Changes
1. Confirm Cloud Run gateway service account has \`roles/aiplatform.user\` on \`lovable-vitana-vers1\`. Run: \`gcloud projects get-iam-policy lovable-vitana-vers1 --flatten='bindings[].members' --filter='bindings.role:aiplatform.user'\`.
2. Confirm \`GOOGLE_APPLICATION_CREDENTIALS\` is unset in the Cloud Run env (ADC should be auto-resolved on Cloud Run; explicit GAC overrides break ADC).
3. Confirm the 401 guard at \`orb-live.ts:10542\` is reached for invalid Bearer tokens (grep for the BOOTSTRAP-ORB-AUTH-REJECT comment in the deployed source).
4. If JWT signing keys appear expired or rotated, page ops via Gchat self-healing-snapshot — do NOT auto-rotate keys.

## Files to Modify
- None for the auto-fix path. If ops decides to refresh signing keys, that's a manual change to Supabase JWT config (out of scope for autonomous remediation).

## Acceptance Criteria
- A synthetic Voice Probe (PR #4) completes \`turn_complete\` without a connection_failed event.
- No new \`orb.live.connection_failed\` events with \`status='error'\` and a UNAUTHENTICATED/401/JWT signature in the 30 minutes following the verification.

## Verification Steps
1. Curl \`/api/v1/orb/health\`; assert \`google_auth_ready: true\`.
2. Run synthetic Voice Probe.
3. Confirm via gcloud logging that no \`UNAUTHENTICATED\` errors appear from the gateway service account in the last 30 minutes.

## Rollback Plan
This spec is read-only / verify-only by design. There is nothing to roll back. If the underlying issue requires key rotation, ops handles that out-of-band.

## Risk Level
LOW — verification-only. No state changes attempted by this spec.
`;

const SPEC_MODEL_STALL_STUB = `# SELF-HEAL: ORB Voice model_stall — transient retry guidance (stub)

## Goal
The Vertex AI Live API stalled mid-response. The existing watchdog (\`orb-live.ts\`) already force-closes the upstream WS and triggers a transparent reconnect. This spec is a stub — the inner-loop watchdog handles the per-session recovery. Self-healing's role is to monitor recurrence and escalate via the Recurrence Sentinel (PR #5) if the stall pattern persists across many sessions.

## Non-negotiable Governance Rules Touched
- None for the stub path. Recurrence escalation policy is owned by the Sentinel.

## Scope
No autonomous remediation. Defer to the Sentinel for cross-session pattern detection.

## Changes
- None.

## Files to Modify
- None.

## Acceptance Criteria
- Self-healing row terminates with \`outcome=escalated\`, \`reason='watchdog_handles_per_session'\`. Not a failure — the inner-loop watchdog is the appropriate remediation layer.

## Verification Steps
1. Confirm watchdog telemetry shows reconnect attempts within 12s of stall_detected events.
2. If recurrence_after_fix_ms is consistently low, the Sentinel will quarantine the class and spawn the Architecture Investigator (PR #6).

## Rollback Plan
N/A — no changes applied.

## Risk Level
LOW — explicitly no-op.
`;

const SPEC_UPSTREAM_DISCONNECT_STUB = SPEC_MODEL_STALL_STUB.replace(
  /model_stall/g,
  'upstream_disconnect',
).replace(/Vertex AI Live API stalled mid-response/, 'Vertex AI Live upstream WebSocket dropped');

const SPEC_TTS_FAILED_STUB = `# SELF-HEAL: ORB Voice tts_failed — re-init TTS client (stub)

## Goal
Cloud Text-to-Speech client initialization or synthesis failed. The fallback chain in \`orb-live.ts\` already covers this case at session level. This spec defers to the Sentinel for cross-session recurrence detection.

## Non-negotiable Governance Rules Touched
- CLAUDE.md NEVER rule 35: Never allow silent model fallback (the fallback_used / fallback_error events are explicit, not silent — the existing classification covers this).

## Scope
No autonomous remediation in v1. Sentinel + Investigator handle persistence cases.

## Changes
- None.

## Files to Modify
- None.

## Acceptance Criteria
- Row terminates \`outcome=escalated\` if no further \`orb.live.fallback_*\` events fire within 30 minutes.

## Verification Steps
1. Query oasis_events for fallback_error / fallback_used in last 30 min for this gateway revision.
2. If repeated, Sentinel quarantine triggers Architecture Investigator.

## Rollback Plan
N/A.

## Risk Level
LOW.
`;

const SPEC_SESSION_LEAK_STUB = `# SELF-HEAL: ORB Voice session_leak — kill stale sessions (stub)

## Goal
Active voice session count crossed the leak threshold. \`orb-live.ts\` already calls \`liveSessions.delete(sid)\` on SSE close (VTID-SESSION-LEAK-FIX). This spec defers per-incident remediation to that path; if leaks recur, the Sentinel will quarantine.

## Non-negotiable Governance Rules Touched
- None for the stub path.

## Scope
No autonomous remediation in v1.

## Changes
- None.

## Files to Modify
- None.

## Acceptance Criteria
- Row terminates \`outcome=escalated\` after one observation window.

## Verification Steps
1. Inspect \`/api/v1/orb/health\` \`active_sessions\` count.
2. If consistently elevated, Sentinel triggers Investigator.

## Rollback Plan
N/A.

## Risk Level
LOW.
`;

// =============================================================================
// Public API
// =============================================================================

const SPEC_TABLE: Partial<Record<VoiceFailureClass, () => VoiceSpecHint>> = {
  'voice.config_missing': () =>
    specWithHash(SPEC_CONFIG_MISSING, 'Re-run EXEC-DEPLOY for gateway env restore', true),
  'voice.config_fallback_active': () =>
    specWithHash(SPEC_CONFIG_FALLBACK_ACTIVE, 'Re-run EXEC-DEPLOY to remove fallback masking', true),
  'voice.auth_rejected': () =>
    specWithHash(SPEC_AUTH_REJECTED, 'Verify ADC + 401 guard for ORB Live (read-only)', false),
  'voice.model_stall': () =>
    specWithHash(SPEC_MODEL_STALL_STUB, 'Defer to watchdog + Sentinel (no-op)', false),
  'voice.upstream_disconnect': () =>
    specWithHash(SPEC_UPSTREAM_DISCONNECT_STUB, 'Defer to watchdog + Sentinel (no-op)', false),
  'voice.tts_failed': () =>
    specWithHash(SPEC_TTS_FAILED_STUB, 'Defer to fallback path + Sentinel (no-op)', false),
  'voice.session_leak': () =>
    specWithHash(SPEC_SESSION_LEAK_STUB, 'Defer to SSE-close path + Sentinel (no-op)', false),
};

/**
 * Return a deterministic spec for the given voice failure class, or null
 * if no hint exists (caller should fall through to Gemini).
 */
export function getVoiceSpecHint(klass: string): VoiceSpecHint | null {
  const factory = SPEC_TABLE[klass as VoiceFailureClass];
  return factory ? factory() : null;
}

/**
 * Parse the voice failure class out of a synthetic endpoint string. Returns
 * null if the endpoint is not a voice-error:// URL.
 */
export function parseVoiceClassFromEndpoint(endpoint: string): string | null {
  const m = /^voice-error:\/\/([a-z._-]+)$/.exec(endpoint || '');
  return m ? m[1] : null;
}
