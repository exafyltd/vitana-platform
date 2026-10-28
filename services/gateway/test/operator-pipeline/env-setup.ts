/**
 * VTID-04465 — process environment for the operator pipeline suite.
 *
 * Imported FIRST by the suite: several pipeline modules read their switches
 * into module-level constants at load time (DRY_RUN in the executor, the
 * bridge and the watcher; the bridge's GitHub token; the agent runner's turn
 * cap), so these must be in place before any of them is required.
 *
 * Nothing here points at a real service: SUPABASE_URL is the in-memory
 * platform's origin and the GitHub token is a placeholder the fake GitHub
 * never checks.
 */

import { FAKE_SUPABASE_URL } from '../support-pipeline/fake-platform';

export const MACHINE_TOKEN = 'operator-suite-machine-token-000000000000000000';
export const JWT_SECRET = 'operator-suite-jwt-secret-not-a-real-secret-000000';

Object.assign(process.env, {
  SUPABASE_URL: FAKE_SUPABASE_URL,
  SUPABASE_SERVICE_ROLE: 'service-role',
  SUPABASE_JWT_SECRET: JWT_SECRET,
  // Live paths everywhere: the suite must exercise the real branches, not the
  // dry-run synthesis (VTID-04004 made a dry-run watcher skip real PRs).
  DEV_AUTOPILOT_DRY_RUN: 'false',
  DEV_AUTOPILOT_WATCHER_LIVE: 'true',
  // Read by github-service, the bridge (module constant) and the agent runner.
  GITHUB_SAFE_MERGE_TOKEN: 'placeholder-token-for-the-fake-github',
  // A small cap keeps the turn-cap scenario short; the golden path finishes in 4.
  AGENT_MAX_TURNS: '8',
  AGENT_CODE_INDEX_ENABLED: 'false',
  AGENT_MEMORY_CONTEXT_ENABLED: 'false',
  // Operator console / on-ramp switches (also re-asserted per test).
  OPERATOR_EXECUTION_ONRAMP_ENABLED: 'true',
  OPERATOR_VTID_SELF_ALLOCATE_ENABLED: 'true',
  OPERATOR_PR_APPROVAL_REQUIRED: 'true',
  OPERATOR_MACHINE_AUTH_ENABLED: 'true',
  OPERATOR_MACHINE_AUTH_TOKEN: MACHINE_TOKEN,
});

for (const k of [
  'DEV_AUTOPILOT_USE_JOB',
  'DEV_AUTOPILOT_USE_WORKER',
  'DEV_AUTOPILOT_EXECUTOR',
  'DEV_AUTOPILOT_PR_APPROVAL_REQUIRED',
  'DEV_AUTOPILOT_LLM_REVIEW_ENABLED',
  'ORCHESTRATOR_RUN_LEASE_ENABLED',
  'OPERATOR_THREADS_ENABLED',
  'OPERATOR_TURN_MEMORY_ENABLED',
  'OPERATOR_BOOTSTRAP_PACK_ENABLED',
  'OPERATOR_ONRAMP_EXECUTOR',
  'GATEWAY_URL',
  'VITANA_ENV',
]) {
  delete process.env[k];
}
