/**
 * VTID-04643 — Testing & QA rebuild P4: the Run Tests launcher.
 *
 * Which workflows an exafy admin may start from the Command Hub, and how.
 *
 * The launch list is an explicit, reviewed allowlist — never "every workflow
 * with workflow_dispatch". Owner rule (agreed 2026-09-26): anything that writes
 * or changes data runs on staging only; production gets read-only monitors and
 * health checks; deploys are never started from here (PUBLISH owns those).
 * Staging writes reach the production database (CLAUDE.md rule 31), so a
 * workflow is only listed after reading what it does, and the reason is kept
 * next to it.
 *
 * Every other catalogued workflow with a manual trigger is shown as "not
 * launchable" with the reason, so the supervisor sees the gap instead of a
 * missing button.
 */
import type { TestCatalog } from './test-catalog';

export type LaunchEnvironment = 'dev_pr' | 'staging' | 'production';

export interface LaunchPolicy {
  repo: string;
  file: string;
  label: string;
  environment: LaunchEnvironment;
  /** What a run does, in one sentence. Shown on the button. */
  effect: string;
  /** Inputs the launcher fills or asks for. */
  inputs?: 'e2e_projects' | 'staging_verify_gateway';
}

const P = 'exafyltd/vitana-platform';
const F = 'exafyltd/vitana-v1';

export const LAUNCH_POLICY: LaunchPolicy[] = [
  // Development / PR suites: run on a GitHub runner against the code on main; touch no deployment.
  { repo: P, file: 'TEST-SUITE.yml', label: 'Gateway + services unit tests', environment: 'dev_pr', effect: 'Runs the gateway Jest suite and the service suites on main in GitHub Actions.' },
  { repo: P, file: 'CALENDAR-REGRESSION.yml', label: 'Calendar regression (platform)', environment: 'dev_pr', effect: 'Runs the calendar golden tests on main.' },
  { repo: P, file: 'AURORA-I18N-INTEGRATION.yml', label: 'Aurora i18n integration', environment: 'dev_pr', effect: 'Runs the i18n integration tests against an ephemeral Postgres.' },
  { repo: F, file: 'UNIT-TESTS.yml', label: 'Frontend unit tests (Vitest)', environment: 'dev_pr', effect: 'Runs the vitana-v1 Vitest suite on main.' },
  { repo: F, file: 'CALENDAR-REGRESSION.yml', label: 'Calendar regression (frontend)', environment: 'dev_pr', effect: 'Runs the vitana-v1 calendar golden tests on main.' },
  // Staging: tests against the staging deployment. Read-only by construction (P0 / VTID-04482 / VTID-04613).
  { repo: P, file: 'E2E-TEST-RUN.yml', label: 'End-to-end (Playwright) on staging', environment: 'staging', effect: 'Runs the chosen Playwright projects read-only against the staging community app.', inputs: 'e2e_projects' },
  { repo: P, file: 'STAGING-VERIFY.yml', label: 'Re-run staging verification (gateway)', environment: 'staging', effect: 'Re-runs the smoke and change suites against the commit staging serves now.', inputs: 'staging_verify_gateway' },
  { repo: P, file: 'E2E-ORB-MONITOR.yml', label: 'ORB widget monitor on staging', environment: 'staging', effect: 'Loads the ORB widget and hub on staging; reports a failure to self-healing, as its schedule does every 15 minutes.' },
  // Production: read-only database health checks (RPC reads), the same ones their schedules run.
  { repo: P, file: 'ALERT-PUSH-DISPATCH-HEALTH.yml', label: 'Push dispatch health', environment: 'production', effect: 'Reads the push backlog; the run fails when it is stuck. Read-only.' },
  { repo: P, file: 'ALERT-ORB-SESSION-STATE-HEALTH.yml', label: 'ORB session state health', environment: 'production', effect: 'Reads ORB session-state health. Read-only.' },
  { repo: P, file: 'ALERT-ORB-BOOTSTRAP-LATENCY.yml', label: 'ORB bootstrap latency', environment: 'production', effect: 'Reads ORB bootstrap latency. Read-only.' },
  { repo: P, file: 'ALERT-OASIS-LEDGER-INTEGRITY.yml', label: 'OASIS ledger integrity', environment: 'production', effect: 'Reads the VTID ledger integrity check. Read-only.' },
  { repo: P, file: 'ALERT-NEWDAY-BRIEFING-LOOP.yml', label: 'New-day briefing loop', environment: 'production', effect: 'Reads the new-day briefing health check. Read-only.' },
  { repo: P, file: 'ALERT-WELCOME-GREETING-HEALTH.yml', label: 'Welcome greeting health', environment: 'production', effect: 'Reads the welcome-greeting health check. Read-only.' },
  { repo: P, file: 'ALERT-APP-USERS-IDENTITY-DRIFT.yml', label: 'App users identity drift', environment: 'production', effect: 'Reads identity drift between app_users and auth. Read-only.' },
  { repo: P, file: 'SMOKE-WELCOME-GREETING.yml', label: 'Welcome greeting trigger (structure)', environment: 'production', effect: 'Reads the welcome-chat trigger definition through an RPC. Read-only.' },
];

/** Why a manually triggerable catalogued workflow is not on the list. */
export function notLaunchableReason(w: { kind: string; flags?: string[]; environments?: string[]; file: string }): string {
  if (w.kind === 'deploy_smoke') return 'Deploy workflow: deployments go through PUBLISH, not the test launcher.';
  if ((w.flags || []).includes('dead_host')) return 'Points at a host that no longer exists (decommissioned GCP).';
  if ((w.flags || []).includes('ui_test_touches_production')) return 'A UI test that touches production; it must move to staging first.';
  if (w.kind === 'gate') return 'A pull-request gate: it runs on the pull request it judges.';
  if (w.kind === 'job') return 'A scheduled job, not a test.';
  return 'Not reviewed as read-only yet (it may write data or post messages); not launchable from here.';
}

export interface LaunchableEntry extends LaunchPolicy {
  launchable: true;
  in_catalog: boolean;
  kind: string | null;
}

export interface NotLaunchableEntry {
  repo: string;
  file: string;
  kind: string;
  environments: string[];
  launchable: false;
  reason: string;
}

export function listLaunchable(catalog: Pick<TestCatalog, 'workflows'> | null): { launchable: LaunchableEntry[]; not_launchable: NotLaunchableEntry[] } {
  const workflows = (catalog?.workflows || []) as Array<{ repo: string; file: string; kind: string; environments: string[]; flags: string[]; manual_trigger: boolean }>;
  const fullRepo = (r: string) => (r === 'platform' ? P : r === 'frontend' ? F : r);
  const launchable = LAUNCH_POLICY.map((p) => {
    const w = workflows.find((x) => fullRepo(x.repo) === p.repo && x.file === p.file);
    return { ...p, launchable: true as const, in_catalog: !!w, kind: w?.kind || null };
  });
  const listed = new Set(LAUNCH_POLICY.map((p) => `${p.repo}|${p.file}`));
  const not_launchable = workflows
    .filter((w) => w.manual_trigger && !listed.has(`${fullRepo(w.repo)}|${w.file}`))
    .map((w) => ({ repo: fullRepo(w.repo), file: w.file, kind: w.kind, environments: w.environments || [], launchable: false as const, reason: notLaunchableReason(w) }));
  return { launchable, not_launchable };
}

export interface LaunchRequest {
  repo?: unknown;
  workflow?: unknown;
  reason?: unknown;
  projects?: unknown;
}

export type LaunchValidation =
  | { ok: true; policy: LaunchPolicy; reason: string; projects: string[] }
  | { ok: false; status: number; error: string };

/** Pure validation of a launch request. The route resolves inputs that need I/O (the staging commit). */
export function validateLaunch(body: LaunchRequest, allowedE2eProjects: string[]): LaunchValidation {
  const repo = typeof body.repo === 'string' ? body.repo : '';
  const workflow = typeof body.workflow === 'string' ? body.workflow : '';
  const policy = LAUNCH_POLICY.find((p) => p.repo === repo && p.file === workflow);
  if (!policy) return { ok: false, status: 403, error: `${repo || '?'} ${workflow || '?'} is not on the launch list` };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 5) return { ok: false, status: 400, error: 'reason is required (at least 5 characters): every manual run is recorded with why it was started' };
  if (reason.length > 500) return { ok: false, status: 400, error: 'reason is too long (500 characters at most)' };
  let projects: string[] = [];
  if (policy.inputs === 'e2e_projects') {
    const raw = Array.isArray(body.projects) ? body.projects : [];
    projects = [...new Set(raw.filter((x): x is string => typeof x === 'string'))];
    if (projects.length === 0) return { ok: false, status: 400, error: 'choose at least one Playwright project' };
    const unknown = projects.filter((p) => !allowedE2eProjects.includes(p));
    if (unknown.length) return { ok: false, status: 400, error: `unknown Playwright project(s): ${unknown.join(', ')}` };
  }
  return { ok: true, policy, reason, projects };
}

/** The workflow_dispatch inputs sent to GitHub. Staging E2E is always read-only and always staging. */
export function dispatchInputs(policy: LaunchPolicy, projects: string[], stagingCommit: string | null, stagingCommunityUrl: string): Record<string, string> {
  if (policy.inputs === 'e2e_projects') {
    return { projects: projects.join(','), community_url: stagingCommunityUrl, read_only: 'true' };
  }
  if (policy.inputs === 'staging_verify_gateway') {
    if (!stagingCommit) throw new Error('could not read the commit staging serves');
    return { service: 'gateway', commit_sha: stagingCommit };
  }
  return {};
}
