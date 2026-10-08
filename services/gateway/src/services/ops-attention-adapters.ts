/**
 * VTID-04876 — Command Hub Overview Phase 1: the seven /ops/attention adapters
 * and the numeric severity rubric (plan A, "Phase 1 adapters + rubric", as
 * amended by N4 / N5 / N7).
 *
 * Every adapter is a pure function of an `AttentionReads` object (the data it
 * needs, read in-process — never an HTTP self-call, plan REVISION 2 F3) and a
 * clock. It returns CANDIDATES, not final items: the aggregator
 * (services/ops-attention.ts) applies env-scoped fingerprints, time-based
 * hysteresis and the per-adapter 3 s timeout. Production reads live in
 * services/ops-attention-reads.ts; tests inject fakes.
 *
 * Rubric (P1 = members impacted now / safety guard tripped; P2 = pipeline
 * blocked, control engaged, human decision waiting long; P3 = degraded or
 * trending):
 *
 *   service_health     P1 golden-path check failing >= 2 min
 *                      P2 any other check failing >= 2 min
 *                      P3 degraded (>= 2 min)
 *   release            P1 latest prod deploy failed / rolled back within 2 h
 *                      P2 STAGING-VERIFY failed on the latest staging deploy
 *                      P3 STAGING-VERIFY stale > 72 h; prod != staging commit
 *                         for > 48 h; a legacy deploy-failure topic in 24 h
 *   voice_supervisor   P1 system_wide verdict; P2 segment critical; P3 warning
 *                      (+ P3 quarantined voice classes / open architecture
 *                      reports, carried over from /ops/action-required)
 *   autonomy           P2 critical supervisor alert, self-heal rolled_back
 *                      P3 warning alert, self-heal escalated
 *                      (kill switch -> governance, N7; approvals -> decisions)
 *   operator_pipeline  P2 autonomous task broken, or no heartbeat > 60 min
 *                      (N4: isAutonomousExecutionTask() only; heartbeat age,
 *                      never updated_at; no 30–60 min band)
 *   governance         P2 governance kill-switch control disarmed; Dev
 *                      Autopilot kill switch engaged (one fingerprint, N7);
 *                      critical violation.  P3 other open violation
 *   decisions_waiting  P2 waiting > 4 h; P3 waiting > 1 h
 *
 * Phase 2 (VTID-04885) adds six in-process adapters:
 *
 *   cost_budgets       P2 an LLM daily budget (orchestrator, shadow) is over,
 *                         or a tenant's Jev community budget is exhausted
 *                      P3 an LLM daily budget is at >= 80%, or a Jev
 *                         community budget crossed 80% this month
 *   tests_contracts    P2 a test workflow is failing on main for >= 2 runs
 *                      P3 a test workflow's latest run on main failed; a
 *                         capability contract is failing
 *                         (STAGING-VERIFY stays with the release adapter)
 *   routines           P2 a routine failed >= 3 times in a row
 *                      P3 a routine's last run failed, is overdue, or has
 *                         been running for > 6 h
 *   support_tickets    P2 a p0 ticket is open, or a p1 ticket waits > 4 h
 *                      P3 a p1 ticket waits > 1 h; any ticket open > 72 h
 *   llm_google_fallback P2 any LLM call in 24 h that landed on Google
 *                         (vertex/gemini) — a fallback, or a stage routed at it
 *                         (CLAUDE.md §2b / IF-THEN 29: an incident)
 *   stuck_vtids        P3 session-plane VTIDs in progress with no ledger
 *                         update for > 72 h (autonomous tasks belong to
 *                         operator_pipeline)
 *   cloudwatch_alarms  P1 a CloudWatch alarm in ALARM whose name starts with
 *                         `vitana-gateway-prod-` (the production-gateway
 *                         alarms, VTID-04987 naming convention)
 *                      P2 every other alarm in ALARM (incl. staging's)
 *                      Registered only when OPS_ATTENTION_CLOUDWATCH_ENABLED
 *                      is exactly 'true' (attentionAdapters()).
 *
 * The Command Hub is admin-facing and English by design: titles and details
 * here are operator text, not member-facing copy (no i18n catalog).
 */

export type Severity = 'P1' | 'P2' | 'P3';
export type AttentionDomain =
  | 'platform'
  | 'release'
  | 'voice'
  | 'autonomy'
  | 'operator'
  | 'governance'
  | 'decisions'
  // VTID-04885
  | 'llm'
  | 'quality'
  | 'cost'
  | 'support'
  | 'jobs';

export type AttentionSourceId =
  | 'service_health'
  | 'release'
  | 'voice_supervisor'
  | 'autonomy'
  | 'operator_pipeline'
  | 'governance'
  | 'decisions_waiting'
  // VTID-04885
  | 'cost_budgets'
  | 'tests_contracts'
  | 'routines'
  | 'support_tickets'
  | 'llm_google_fallback'
  | 'stuck_vtids'
  // VTID-04987 (gated: attentionAdapters())
  | 'cloudwatch_alarms';

export interface Deeplink {
  section: string;
  tab: string;
  query: Record<string, string>;
}

/** What an adapter reports; the aggregator turns it into an item. */
export interface Candidate {
  /** Stable entity key within the source (never a count or a timestamp). */
  key: string;
  domain: AttentionDomain;
  severity: Severity;
  title: string;
  detail: string;
  /**
   * When the condition started, from the source itself (ISO). null = the
   * source has no timestamp; the aggregator uses ops_attention_state.
   */
  since: string | null;
  /** How long the condition must hold before it is shown (ms). */
  hold_ms: number;
  count: number;
  deeplink: Deeplink;
  evidence: Record<string, unknown>;
}

export interface AdapterOutput {
  candidates: Candidate[];
  /**
   * Set when part of the source could not be read. The source is reported
   * UNKNOWN, and whatever candidates were found are still shown.
   */
  partial_error?: string;
}

export interface AdapterContext {
  now: number;
}

// ── Thresholds ──────────────────────────────────────────────────────────────

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** N5: "failing >= 2 checks" = failing for >= 2 min by probe timestamps. */
export const HEALTH_HOLD_MS = 2 * MIN;
export const PROD_DEPLOY_FAIL_WINDOW_MS = 2 * HOUR;
export const STAGING_VERIFY_STALE_MS = 72 * HOUR;
export const COMMIT_DRIFT_HOLD_MS = 48 * HOUR;
export const LEGACY_DEPLOY_FAIL_WINDOW_MS = 24 * HOUR;
/** N4: stuck = no claim heartbeat for more than 60 min. */
export const OPERATOR_STUCK_MS = 60 * MIN;
/** worker_heartbeat() extends claim_expires_at to now() + 60 min. */
export const CLAIM_TTL_MS = 60 * MIN;
export const DECISION_P3_MS = 1 * HOUR;
export const DECISION_P2_MS = 4 * HOUR;
export const SELF_HEAL_LOOKBACK_MS = 24 * HOUR;

/** System controls whose DISARMED state stops a governed pipeline (§5). */
export const GOVERNANCE_KILL_SWITCH_CONTROLS = ['autopilot_execution_enabled', 'vtid_allocator_enabled'] as const;

/** Self-heal endpoints with their own dashboard (same blocklist as /ops/action-required). */
export const SELF_HEAL_ENDPOINT_BLOCKLIST = ['dev_autopilot.', 'autopilot.'];

// ── Deep-link contract (plan F10) ───────────────────────────────────────────

/**
 * The query parameters a Command Hub screen actually reads on navigation.
 * app.js's OVERVIEW_DEEPLINK_QUERY_CONTRACT mirrors this map; a unit test
 * keeps the two equal and walks every adapter deeplink against
 * NAVIGATION_CONFIG. A deeplink may only carry a query its screen reads.
 */
export const DEEPLINK_QUERY_CONTRACT: Record<string, string[]> = {
  'command-hub/tasks': ['vtid'],
  'oasis/vtid-ledger': ['vtid'],
  'voice/sessions': ['session'],
  // VTID-04885: the Feedback module is routable; ?ticket= opens the ticket drawer.
  'feedback/inbox': ['ticket'],
};

export function link(section: string, tab: string, query: Record<string, string> = {}): Deeplink {
  return { section, tab, query };
}

// ── Reads (implemented in ops-attention-reads.ts) ───────────────────────────

export interface HealthItem {
  name: string;
  url: string;
  group: string;
  golden_path?: boolean;
  status: string;
  healthy: boolean;
  http_status: number | null;
  latency_ms: number;
}

export interface OasisEventRow {
  topic: string;
  created_at: string;
  metadata?: Record<string, unknown> | null;
}

export interface BuildInfoCheck {
  status: string;
  reason?: string;
  commit?: string | null;
  [k: string]: unknown;
}

export interface VoiceVerdictLite {
  scope: string;
  key: string;
  label: string;
  metric: string;
  severity: 'critical' | 'warning';
  message: string;
  sessions: number;
}

export interface SupervisorAlertLite {
  severity: 'critical' | 'warning' | 'info';
  text: string;
  tab: string;
}

export interface SelfHealRow {
  vtid: string;
  endpoint: string;
  failure_class: string | null;
  outcome: string;
  created_at: string;
}

export interface LedgerRow {
  vtid: string;
  title: string | null;
  metadata: unknown;
  claimed_by: string | null;
  claim_started_at: string | null;
  claim_expires_at: string | null;
  updated_at: string | null;
}

export interface ControlRow {
  key: string;
  enabled: boolean;
  reason?: string | null;
  updated_by: string | null;
  updated_at: string | null;
}

export interface ViolationRow {
  id: string;
  severity: number;
  status: string;
  created_at: string;
  rule_code?: string | null;
}

export interface WaitingRow {
  /** Entity id (execution id, self-heal row id, VTID). */
  id: string;
  vtid?: string | null;
  title?: string | null;
  waiting_since: string;
}

export interface AttentionReads {
  healthSummary(): Promise<{ checked_at: string; items: HealthItem[] }>;
  /** Newest event among `topics` created at/after `sinceIso`, or null. */
  latestEvent(topics: string[], sinceIso: string): Promise<OasisEventRow | null>;
  buildInfo(which: 'prod' | 'staging'): Promise<BuildInfoCheck>;
  voiceOverview(): Promise<{ verdict_summary: string; verdicts: VoiceVerdictLite[]; window: string; generated_at: string; truncated?: boolean }>;
  voiceQuarantines(): Promise<Array<{ class: string; quarantined_at: string; reason: string | null }>>;
  voiceArchitectureReports(): Promise<Array<{ id: string; class: string; generated_at: string; track: string }>>;
  supervisorAlerts(): Promise<SupervisorAlertLite[]>;
  selfHealOutcomes(sinceIso: string): Promise<SelfHealRow[]>;
  pipelineBrokenVtids(): Promise<string[]>;
  inProgressLedger(): Promise<LedgerRow[]>;
  isAutonomous(row: LedgerRow): boolean;
  systemControls(): Promise<ControlRow[]>;
  devAutopilotKillSwitch(): Promise<{ engaged: boolean } | null>;
  openViolations(): Promise<ViolationRow[]>;
  devAutopilotAwaitingApproval(): Promise<WaitingRow[]>;
  selfHealPendingApproval(): Promise<WaitingRow[]>;
  prApprovalsPending(): Promise<WaitingRow[]>;
  // ── VTID-04885 (Phase 2) ──
  /** Today's (UTC) LLM budget lines (services/orchestrator/budgets.ts). */
  llmBudgetLines(): Promise<{ since: string; lines: BudgetLineLite[]; truncated: boolean }>;
  /** jev.budget.threshold_crossed events at/after `sinceIso`. */
  jevBudgetAlerts(sinceIso: string): Promise<OasisEventRow[]>;
  /** Completed CI test runs on main at/after `sinceIso` (ci_test_runs). */
  ciTestRuns(sinceIso: string): Promise<{ rows: CiRunLite[]; last_synced_at: string | null }>;
  /** Capability contracts whose status is 'fail' (test_contracts). */
  failingTestContracts(): Promise<ContractRow[]>;
  /** Enabled routines with their last-run columns (routines). */
  routines(): Promise<RoutineRow[]>;
  /** Open support tickets that are p0/p1 or older than `agedBeforeIso`. */
  openSupportTickets(agedBeforeIso: string): Promise<TicketRow[]>;
  /** llm.call.completed events at/after `sinceIso` served by a Google provider. */
  llmGoogleCalls(sinceIso: string): Promise<LlmCallRow[]>;
  // ── VTID-04886 (Phase 3) ──
  /** The 24 h timeline: events among TIMELINE_TOPICS at/after `sinceIso`, newest first. */
  timelineEvents(sinceIso: string): Promise<OasisEventRow[]>;
  // ── VTID-04987 ──
  /**
   * CloudWatch alarms currently in ALARM (DescribeAlarms, read-only), at most
   * CLOUDWATCH_ALARM_CAP; `truncated` when the cap was hit. Throws when the
   * alarms could not be read — never "no alarms".
   */
  cloudwatchAlarms(): Promise<{ alarms: CloudWatchAlarmLite[]; truncated: boolean }>;
}

/** VTID-04987: one CloudWatch alarm in ALARM state. */
export interface CloudWatchAlarmLite {
  name: string;
  type: 'metric' | 'composite';
  /** null for a composite alarm. */
  namespace: string | null;
  metric_name: string | null;
  state_reason: string | null;
  /** When the alarm entered its current state (ISO), or null. */
  state_updated_at: string | null;
}

/**
 * VTID-04886: the topics the 24 h change & incident timeline shows — the
 * deploy, verify, rollback and kill-switch topics the adapters already read,
 * plus governance control changes. Self-heal rows come from self_healing_log.
 */
export const TIMELINE_TOPICS = [
  'prod.deploy.completed', 'prod.deploy.failed', 'prod.deploy.rolled_back',
  'staging.deploy.completed', 'staging.deploy.failed',
  'staging.verify.passed', 'staging.verify.failed',
  'deploy.gateway.failed', 'cicd.deploy.service.failed',
  'dev_autopilot.kill_switch.activated', 'dev_autopilot.kill_switch.deactivated',
  'governance.control.updated',
];
/** timelineEvents() reads at most this many rows. */
export const TIMELINE_READ_LIMIT = 200;
/** Row cap of the self-heal outcome read (shared by the autonomy adapter and the timeline). */
export const SELF_HEAL_READ_LIMIT = 100;

export interface BudgetLineLite {
  scope: 'platform' | 'agent' | 'run';
  key: string;
  spent_usd: number;
  limit_usd: number;
  used_pct: number;
  over: boolean;
}

export interface CiRunLite {
  repo: string;
  workflow_file: string;
  workflow_name: string | null;
  branch: string | null;
  conclusion: string | null;
  html_url: string | null;
  run_created_at: string;
}

export interface ContractRow {
  id: string;
  capability: string;
  service: string | null;
  status: string;
  last_run_at: string | null;
  last_failure_signature: string | null;
}

export interface RoutineRow {
  name: string;
  display_name: string | null;
  cron_schedule: string;
  last_run_at: string | null;
  last_run_status: string | null;
  consecutive_failures: number;
  created_at: string | null;
}

export interface TicketRow {
  id: string;
  ticket_number: string | null;
  kind: string | null;
  status: string;
  priority: string;
  created_at: string;
}

export interface LlmCallRow {
  created_at: string;
  provider: string | null;
  model: string | null;
  stage: string | null;
  service: string | null;
  fallback_used: boolean;
}

// ── helpers ─────────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();
const ageMs = (at: string | null | undefined, now: number) => (at ? now - Date.parse(at) : NaN);
const mins = (ms: number) => Math.round(ms / MIN);

function fmtAge(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown';
  const m = Math.max(0, Math.round(ms / MIN));
  if (m < 120) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}

function errMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** Settle a partial read: value or undefined + an error string. */
async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
}

// ── 1. Service health ───────────────────────────────────────────────────────

const HEALTH_NOT_CHECKED = ['no_access', 'not_configured'];
const HEALTH_DEGRADED = ['degraded', 'warning'];

export async function serviceHealthAdapter(reads: AttentionReads): Promise<AdapterOutput> {
  const summary = await reads.healthSummary();
  const candidates: Candidate[] = [];
  // A golden-path check that could not be measured (no_access /
  // not_configured) is missing data, never a pass: the source goes UNKNOWN.
  const goldenUnchecked: string[] = [];
  for (const it of summary.items) {
    if (it.healthy) continue;
    const status = String(it.status || '').toLowerCase();
    if (HEALTH_NOT_CHECKED.includes(status)) {
      if (it.golden_path) goldenUnchecked.push(`${it.name} (${status})`);
      continue;
    }
    const degraded = HEALTH_DEGRADED.includes(status);
    const severity: Severity = degraded ? 'P3' : it.golden_path ? 'P1' : 'P2';
    candidates.push({
      key: it.url,
      domain: 'platform',
      severity,
      title: `${it.name} ${degraded ? 'degraded' : 'failing'}`,
      detail:
        `${it.group} · status ${status || 'unknown'}` +
        (it.http_status !== null ? ` · HTTP ${it.http_status}` : ' · no response') +
        (it.golden_path ? ' · golden path' : ''),
      since: null,
      hold_ms: HEALTH_HOLD_MS,
      count: 1,
      // The full grouped Service Health panel is on the Overview itself
      // (details below the queue); there is no dedicated screen yet.
      deeplink: link('overview', 'system-overview'),
      evidence: {
        url: it.url,
        status,
        http_status: it.http_status,
        latency_ms: it.latency_ms,
        golden_path: !!it.golden_path,
        checked_at: summary.checked_at,
      },
    });
  }
  return goldenUnchecked.length
    ? { candidates, partial_error: `golden_path_not_checked: ${goldenUnchecked.join(', ')}` }
    : { candidates };
}

// ── 2. Release ──────────────────────────────────────────────────────────────

export const PROD_DEPLOY_TOPICS = ['prod.deploy.completed', 'prod.deploy.failed', 'prod.deploy.rolled_back'];
export const STAGING_VERIFY_TOPICS = ['staging.verify.passed', 'staging.verify.failed'];
export const STAGING_DEPLOY_TOPICS = ['staging.deploy.completed', 'staging.deploy.failed'];
export const LEGACY_DEPLOY_FAILURE_TOPICS = ['deploy.gateway.failed', 'cicd.deploy.service.failed'];

export async function releaseAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const candidates: Candidate[] = [];
  const errors: string[] = [];

  const [prod, verify, stagingDeploy, legacy] = await Promise.all([
    reads.latestEvent(PROD_DEPLOY_TOPICS, iso(now - 30 * 24 * HOUR)),
    reads.latestEvent(STAGING_VERIFY_TOPICS, iso(now - 30 * 24 * HOUR)),
    reads.latestEvent(STAGING_DEPLOY_TOPICS, iso(now - 30 * 24 * HOUR)),
    reads.latestEvent(LEGACY_DEPLOY_FAILURE_TOPICS, iso(now - LEGACY_DEPLOY_FAIL_WINDOW_MS)),
  ]);

  // P1 — the newest prod deploy failed or was rolled back (VTID-04647) < 2 h ago.
  if (prod && prod.topic !== 'prod.deploy.completed' && ageMs(prod.created_at, now) <= PROD_DEPLOY_FAIL_WINDOW_MS) {
    const rolledBack = prod.topic === 'prod.deploy.rolled_back';
    candidates.push({
      key: 'prod_deploy_failed',
      domain: 'release',
      severity: 'P1',
      title: rolledBack ? 'Production deploy rolled back' : 'Production deploy failed',
      detail: `${prod.topic} ${fmtAge(ageMs(prod.created_at, now))} ago` +
        (rolledBack ? ' — the previous build is serving' : ' — the previous build keeps serving (auto-rollback)'),
      since: prod.created_at,
      hold_ms: 0,
      count: 1,
      deeplink: link('operator', 'deployments'),
      evidence: { topic: prod.topic, created_at: prod.created_at, metadata: prod.metadata ?? null },
    });
  }

  // P2 — STAGING-VERIFY failed on the latest staging deploy (no newer deploy since).
  const verifyFailed = verify && verify.topic === 'staging.verify.failed';
  const newerDeploy =
    stagingDeploy && verify && stagingDeploy.topic === 'staging.deploy.completed' &&
    Date.parse(stagingDeploy.created_at) > Date.parse(verify.created_at);
  if (verifyFailed && !newerDeploy) {
    candidates.push({
      key: 'staging_verify_failed',
      domain: 'release',
      severity: 'P2',
      title: 'STAGING-VERIFY failed on the latest staging build',
      detail: `staging.verify.failed ${fmtAge(ageMs(verify!.created_at, now))} ago — no PUBLISH until it passes`,
      since: verify!.created_at,
      hold_ms: 0,
      count: 1,
      deeplink: link('testing-qa', 'runs'),
      evidence: { topic: verify!.topic, created_at: verify!.created_at, metadata: verify!.metadata ?? null },
    });
  }

  // P3 — STAGING-VERIFY has not passed for > 72 h.
  const lastPass = verify && verify.topic === 'staging.verify.passed' ? verify : null;
  if (!verify || (lastPass && ageMs(lastPass.created_at, now) > STAGING_VERIFY_STALE_MS)) {
    candidates.push({
      key: 'staging_verify_stale',
      domain: 'release',
      severity: 'P3',
      title: 'STAGING-VERIFY is stale',
      detail: lastPass
        ? `last pass ${fmtAge(ageMs(lastPass.created_at, now))} ago (threshold 72 h)`
        : 'no STAGING-VERIFY result in 30 days',
      since: lastPass ? iso(Date.parse(lastPass.created_at) + STAGING_VERIFY_STALE_MS) : null,
      hold_ms: 0,
      count: 1,
      deeplink: link('testing-qa', 'runs'),
      evidence: { last_topic: verify?.topic ?? null, last_at: verify?.created_at ?? null },
    });
  }

  // P3 — a legacy deploy-failure topic in the last 24 h.
  if (legacy) {
    candidates.push({
      key: `legacy_deploy_failed:${legacy.topic}`,
      domain: 'release',
      severity: 'P3',
      title: `Deploy failure reported (${legacy.topic})`,
      detail: `${fmtAge(ageMs(legacy.created_at, now))} ago`,
      since: legacy.created_at,
      hold_ms: 0,
      count: 1,
      deeplink: link('operator', 'deployments'),
      evidence: { topic: legacy.topic, created_at: legacy.created_at, metadata: legacy.metadata ?? null },
    });
  }

  // P3 — prod and staging gateways on different commits for > 48 h.
  const [prodInfo, stagingInfo] = await Promise.all([settle(reads.buildInfo('prod')), settle(reads.buildInfo('staging'))]);
  const commitOf = (r: typeof prodInfo, which: string): string | null => {
    if (!r.ok) {
      errors.push(`build_info_${which}: ${r.error}`);
      return null;
    }
    if (r.value.status !== 'ok' || !r.value.commit) {
      errors.push(`build_info_${which}: ${r.value.reason || r.value.status}`);
      return null;
    }
    return String(r.value.commit);
  };
  const prodCommit = commitOf(prodInfo, 'prod');
  const stagingCommit = commitOf(stagingInfo, 'staging');
  if (prodCommit && stagingCommit && prodCommit !== stagingCommit) {
    candidates.push({
      key: 'commit_drift',
      domain: 'release',
      severity: 'P3',
      title: 'Production is behind staging',
      detail: `prod ${prodCommit} ≠ staging ${stagingCommit} for more than 48 h`,
      since: null,
      hold_ms: COMMIT_DRIFT_HOLD_MS,
      count: 1,
      deeplink: link('operator', 'deployments'),
      evidence: { prod_commit: prodCommit, staging_commit: stagingCommit },
    });
  }

  return errors.length ? { candidates, partial_error: errors.join('; ') } : { candidates };
}

// ── 3. Voice supervisor ─────────────────────────────────────────────────────

export async function voiceSupervisorAdapter(reads: AttentionReads): Promise<AdapterOutput> {
  const [overview, quarantines, reports] = await Promise.all([
    reads.voiceOverview(),
    settle(reads.voiceQuarantines()),
    settle(reads.voiceArchitectureReports()),
  ]);
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  // Verdicts over a row-capped read are incomplete: keep what was found (a P1
  // stays visible) but the source is UNKNOWN, never a clean OK.
  if (overview.truncated) errors.push('voice_overview: fact read truncated at the row cap');

  for (const v of overview.verdicts || []) {
    const system = v.scope === 'system';
    const severity: Severity = system && v.severity === 'critical' ? 'P1' : v.severity === 'critical' ? 'P2' : 'P3';
    candidates.push({
      key: `${v.scope}:${v.key}:${v.metric}`,
      domain: 'voice',
      severity,
      title: system ? `Voice: ${v.metric} across all sessions` : `Voice: ${v.metric} for ${v.scope} ${v.label}`,
      detail: v.message,
      // The verdict is already computed over a window (minimum sample per
      // segment): no extra hold; `since` = first observed (state).
      since: null,
      hold_ms: 0,
      count: 1,
      deeplink: link('voice', 'overview'),
      evidence: {
        verdict_summary: overview.verdict_summary,
        window: overview.window,
        scope: v.scope,
        key: v.key,
        metric: v.metric,
        sessions: v.sessions,
        severity: v.severity,
      },
    });
  }

  if (quarantines.ok) {
    for (const q of quarantines.value) {
      candidates.push({
        key: `quarantine:${q.class}`,
        domain: 'voice',
        severity: 'P3',
        title: `Voice class quarantined: ${q.class}`,
        detail: `Auto-healing stopped for this class. Reason: ${q.reason || 'thresholds tripped'}`,
        since: q.quarantined_at,
        hold_ms: 0,
        count: 1,
        deeplink: link('voice', 'issues-healing'),
        evidence: { class: q.class, quarantined_at: q.quarantined_at },
      });
    }
  } else errors.push(`voice_healing_quarantine: ${quarantines.error}`);

  if (reports.ok) {
    for (const r of reports.value) {
      candidates.push({
        key: `architecture_report:${r.id}`,
        domain: 'voice',
        severity: 'P3',
        title: `Voice architecture recommendation: ${r.class}`,
        detail: `Track ${r.track} — needs a human read`,
        since: r.generated_at,
        hold_ms: 0,
        count: 1,
        deeplink: link('voice', 'issues-healing'),
        evidence: { id: r.id, class: r.class, track: r.track },
      });
    }
  } else errors.push(`voice_architecture_reports: ${reports.error}`);

  return errors.length ? { candidates, partial_error: errors.join('; ') } : { candidates };
}

// ── 4. Autonomy ─────────────────────────────────────────────────────────────

const AUTOPILOT_TABS = ['registry', 'scanners', 'impact-rules', 'auto-approve', 'runs', 'live', 'engine'];

/** N7: the kill switch belongs to governance; approvals belong to decisions. */
export function isOwnedElsewhere(alert: SupervisorAlertLite): boolean {
  const t = alert.text.toLowerCase();
  return t.startsWith('kill switch is on') || t.includes('waiting for your approval');
}

/** A stable key for an alert whose text carries changing numbers. */
export function alertKey(alert: SupervisorAlertLite): string {
  const norm = alert.text.toLowerCase().replace(/"[^"]*"/g, '').replace(/[0-9]+(\.[0-9]+)?/g, '#').replace(/\s+/g, ' ').trim();
  return `${alert.tab}:${norm.slice(0, 80)}`;
}

export async function autonomyAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const [alerts, heals] = await Promise.all([
    reads.supervisorAlerts(),
    settle(reads.selfHealOutcomes(iso(now - SELF_HEAL_LOOKBACK_MS))),
  ]);
  const candidates: Candidate[] = [];

  for (const a of alerts) {
    if (a.severity === 'info' || isOwnedElsewhere(a)) continue;
    candidates.push({
      key: `alert:${alertKey(a)}`,
      domain: 'autonomy',
      severity: a.severity === 'critical' ? 'P2' : 'P3',
      title: a.text.length > 120 ? `${a.text.slice(0, 117)}…` : a.text,
      detail: `Dev Autopilot supervisor (${a.severity})`,
      since: null,
      hold_ms: 0,
      count: 1,
      deeplink: link('autopilot', AUTOPILOT_TABS.includes(a.tab) ? a.tab : 'live'),
      evidence: { severity: a.severity, tab: a.tab, text: a.text },
    });
  }

  if (!heals.ok) return { candidates, partial_error: `self_healing_log: ${heals.error}` };

  // One item per endpoint: highest severity wins, count = rows, since = oldest.
  const byEndpoint = new Map<string, SelfHealRow[]>();
  for (const r of heals.value) {
    if (SELF_HEAL_ENDPOINT_BLOCKLIST.some((p) => (r.endpoint || '').startsWith(p))) continue;
    const arr = byEndpoint.get(r.endpoint) || [];
    arr.push(r);
    byEndpoint.set(r.endpoint, arr);
  }
  for (const [endpoint, rows] of byEndpoint) {
    const rolledBack = rows.some((r) => r.outcome === 'rolled_back');
    const sorted = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    const latest = sorted[sorted.length - 1];
    candidates.push({
      key: `self_heal:${endpoint}`,
      domain: 'autonomy',
      severity: rolledBack ? 'P2' : 'P3',
      title: `Self-healing ${rolledBack ? 'rolled back' : 'escalated'}: ${endpoint}`,
      detail: `${rows.length} row(s) in 24 h · latest ${latest.vtid} (${latest.failure_class || 'unknown class'})`,
      since: sorted[0].created_at,
      hold_ms: 0,
      count: rows.length,
      deeplink: link('oasis', 'vtid-ledger', { vtid: latest.vtid }),
      evidence: { endpoint, outcomes: rows.map((r) => r.outcome), latest_vtid: latest.vtid },
    });
  }
  return { candidates };
}

// ── 5. Operator pipeline ────────────────────────────────────────────────────

/** Last sign of life for a claimed task (N4), or null when unclaimed. */
export function lastHeartbeatMs(row: LedgerRow): number | null {
  if (!row.claimed_by) return null;
  if (row.claim_expires_at) return Date.parse(row.claim_expires_at) - CLAIM_TTL_MS;
  if (row.claim_started_at) return Date.parse(row.claim_started_at);
  return null;
}

export async function operatorPipelineAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const [rows, broken] = await Promise.all([reads.inProgressLedger(), settle(reads.pipelineBrokenVtids())]);
  const autonomous = rows.filter((r) => reads.isAutonomous(r));
  const brokenSet = new Set(broken.ok ? broken.value : []);
  const candidates: Candidate[] = [];

  for (const r of autonomous) {
    const hb = lastHeartbeatMs(r);
    const silentMs = hb === null ? NaN : now - hb;
    const stuck = Number.isFinite(silentMs) && silentMs > OPERATOR_STUCK_MS;
    const isBroken = brokenSet.has(r.vtid);
    if (!stuck && !isBroken) continue;
    candidates.push({
      key: r.vtid,
      domain: 'operator',
      severity: 'P2',
      title: `${isBroken ? 'Broken' : 'Stuck'} autonomous task ${r.vtid}`,
      detail:
        (r.title ? `${r.title} · ` : '') +
        (hb === null ? 'not claimed' : `no heartbeat for ${fmtAge(silentMs)}`) +
        (r.claimed_by ? ` · claimed by ${r.claimed_by}` : ''),
      since: hb !== null ? iso(hb) : null,
      hold_ms: 0,
      count: 1,
      deeplink: link('command-hub', 'tasks', { vtid: r.vtid }),
      evidence: {
        claimed_by: r.claimed_by,
        claim_started_at: r.claim_started_at,
        claim_expires_at: r.claim_expires_at,
        silent_min: Number.isFinite(silentMs) ? mins(silentMs) : null,
        broken: isBroken,
      },
    });
  }
  return broken.ok ? { candidates } : { candidates, partial_error: `pipeline_summary: ${broken.error}` };
}

// ── 6. Governance ───────────────────────────────────────────────────────────

export async function governanceAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const [controls, killSwitch, violations] = await Promise.all([
    reads.systemControls(),
    settle(reads.devAutopilotKillSwitch()),
    settle(reads.openViolations()),
  ]);
  const candidates: Candidate[] = [];
  const errors: string[] = [];

  for (const key of GOVERNANCE_KILL_SWITCH_CONTROLS) {
    const c = controls.find((x) => x.key === key);
    if (!c || c.enabled) continue;
    candidates.push({
      key: `control:${key}`,
      domain: 'governance',
      severity: 'P2',
      title: `Control disarmed: ${key}`,
      detail: `by ${c.updated_by || 'unknown'}${c.reason ? ` — ${c.reason}` : ''}`,
      since: c.updated_at,
      hold_ms: 0,
      count: 1,
      deeplink: link('governance', 'controls'),
      evidence: { key, updated_by: c.updated_by, updated_at: c.updated_at, reason: c.reason ?? null },
    });
  }

  if (killSwitch.ok) {
    if (killSwitch.value && killSwitch.value.engaged) {
      const ev = await settle(reads.latestEvent(['dev_autopilot.kill_switch.activated'], iso(ctx.now - 90 * 24 * HOUR)));
      const at = ev.ok && ev.value ? ev.value.created_at : null;
      candidates.push({
        // N7: the one fingerprint for the kill switch.
        key: 'dev_autopilot_kill_switch',
        domain: 'governance',
        severity: 'P2',
        title: 'Dev Autopilot kill switch engaged',
        detail: at ? `activated ${at} (dev_autopilot.kill_switch.activated)` : 'no activation event in 90 days',
        since: at,
        hold_ms: 0,
        count: 1,
        deeplink: link('autopilot', 'auto-approve'),
        evidence: { activated_at: at },
      });
    } else if (!killSwitch.value) errors.push('dev_autopilot_config: row missing');
  } else errors.push(`dev_autopilot_config: ${killSwitch.error}`);

  if (violations.ok) {
    const critical = violations.value.filter((v) => v.severity >= 4);
    const other = violations.value.filter((v) => v.severity < 4);
    const oldest = (vs: ViolationRow[]) => vs.map((v) => v.created_at).sort()[0];
    if (critical.length) {
      candidates.push({
        key: 'violations:critical',
        domain: 'governance',
        severity: 'P2',
        title: `${critical.length} critical governance violation(s) open`,
        detail: critical.slice(0, 3).map((v) => v.rule_code || v.id).join(', '),
        since: oldest(critical),
        hold_ms: 0,
        count: critical.length,
        deeplink: link('governance', 'violations'),
        evidence: { ids: critical.slice(0, 20).map((v) => v.id) },
      });
    }
    if (other.length) {
      candidates.push({
        key: 'violations:open',
        domain: 'governance',
        severity: 'P3',
        title: `${other.length} governance violation(s) open`,
        detail: other.slice(0, 3).map((v) => v.rule_code || v.id).join(', '),
        since: oldest(other),
        hold_ms: 0,
        count: other.length,
        deeplink: link('governance', 'violations'),
        evidence: { ids: other.slice(0, 20).map((v) => v.id) },
      });
    }
  } else errors.push(`governance_violations: ${violations.error}`);

  return errors.length ? { candidates, partial_error: errors.join('; ') } : { candidates };
}

// ── 7. Decisions waiting ────────────────────────────────────────────────────

interface DecisionKind {
  key: string;
  label: string;
  load: (r: AttentionReads) => Promise<WaitingRow[]>;
  list: Deeplink;
  one: (row: WaitingRow) => Deeplink;
}

const DECISION_KINDS: DecisionKind[] = [
  {
    key: 'dev_autopilot_approval',
    label: 'Dev Autopilot execution(s) awaiting approval',
    load: (r) => r.devAutopilotAwaitingApproval(),
    list: link('autopilot', 'live'),
    one: () => link('autopilot', 'live'),
  },
  {
    key: 'self_heal_approval',
    label: 'self-healing fix(es) awaiting approval',
    load: (r) => r.selfHealPendingApproval(),
    list: link('autonomy', 'self-healing'),
    one: (row) => (row.vtid ? link('oasis', 'vtid-ledger', { vtid: row.vtid }) : link('autonomy', 'self-healing')),
  },
  {
    key: 'pr_approval',
    label: 'PR approval(s) waiting',
    load: (r) => r.prApprovalsPending(),
    list: link('command-hub', 'approvals'),
    one: (row) => (row.vtid ? link('command-hub', 'tasks', { vtid: row.vtid }) : link('command-hub', 'approvals')),
  },
];

export async function decisionsWaitingAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const results = await Promise.all(DECISION_KINDS.map((k) => settle(k.load(reads))));
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  const allFailed = results.every((r) => !r.ok);

  DECISION_KINDS.forEach((kind, i) => {
    const res = results[i];
    if (!res.ok) {
      errors.push(`${kind.key}: ${res.error}`);
      return;
    }
    const waiting = res.value
      .map((row) => ({ row, age: ageMs(row.waiting_since, now) }))
      .filter((x) => Number.isFinite(x.age) && x.age > DECISION_P3_MS)
      .sort((a, b) => b.age - a.age);
    if (!waiting.length) return;
    const oldest = waiting[0];
    const severity: Severity = oldest.age > DECISION_P2_MS ? 'P2' : 'P3';
    candidates.push({
      key: kind.key,
      domain: 'decisions',
      severity,
      title: `${waiting.length} ${kind.label}`,
      detail:
        `oldest waiting ${fmtAge(oldest.age)}` +
        (oldest.row.title ? ` — ${oldest.row.title}` : oldest.row.vtid ? ` — ${oldest.row.vtid}` : ''),
      since: oldest.row.waiting_since,
      hold_ms: 0,
      count: waiting.length,
      deeplink: waiting.length === 1 ? kind.one(oldest.row) : kind.list,
      evidence: {
        over_4h: waiting.filter((w) => w.age > DECISION_P2_MS).length,
        over_1h: waiting.length,
        oldest_id: oldest.row.id,
      },
    });
  });

  if (allFailed) throw new Error(errors.join('; '));
  return errors.length ? { candidates, partial_error: errors.join('; ') } : { candidates };
}

// ── 8. Cost & budgets (VTID-04885) ──────────────────────────────────────────

/** "Trending past 80%" (plan Phase 2, cost & budgets). */
export const BUDGET_TREND_PCT = 80;
export const JEV_BUDGET_TOPIC = 'jev.budget.threshold_crossed';

function monthStartUtc(now: number): string {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
}

const usd = (n: number) => `$${(Math.round(n * 100) / 100).toFixed(2)}`;

export async function costBudgetsAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const [spend, jev] = await Promise.all([
    settle(reads.llmBudgetLines()),
    settle(reads.jevBudgetAlerts(monthStartUtc(ctx.now))),
  ]);
  if (!spend.ok && !jev.ok) throw new Error(`llm_budgets: ${spend.error}; jev_budget: ${jev.error}`);
  const candidates: Candidate[] = [];
  const errors: string[] = [];
  const orchestrator = link('autopilot', 'orchestrator');

  if (spend.ok) {
    if (spend.value.truncated) errors.push('llm_budgets: spend read truncated at the row cap');
    const runsOver: BudgetLineLite[] = [];
    const runsNear: BudgetLineLite[] = [];
    for (const l of spend.value.lines) {
      const near = !l.over && l.used_pct >= BUDGET_TREND_PCT;
      if (!l.over && !near) continue;
      if (l.scope === 'run') {
        (l.over ? runsOver : runsNear).push(l);
        continue;
      }
      const what = l.scope === 'platform' ? 'Platform LLM budget' : `LLM budget for ${l.key}`;
      candidates.push({
        // The budget resets every UTC day: one fingerprint per line per day.
        key: `llm_budget:${l.scope}:${l.key}:${spend.value.since.slice(0, 10)}`,
        domain: 'cost',
        severity: l.over ? 'P2' : 'P3',
        title: l.over ? `${what} crossed today` : `${what} at ${Math.round(l.used_pct)}% today`,
        detail: `${usd(l.spent_usd)} of ${usd(l.limit_usd)} per day (shadow: not enforced yet)`,
        since: null,
        hold_ms: 0,
        count: 1,
        deeplink: orchestrator,
        evidence: { ...l, since: spend.value.since },
      });
    }
    for (const [rows, over] of [[runsOver, true], [runsNear, false]] as const) {
      if (!rows.length) continue;
      const worst = [...rows].sort((a, b) => b.used_pct - a.used_pct);
      candidates.push({
        key: `llm_budget:runs:${over ? 'over' : 'near'}:${spend.value.since.slice(0, 10)}`,
        domain: 'cost',
        severity: over ? 'P2' : 'P3',
        title: over
          ? `${rows.length} run(s) over the per-run LLM budget today`
          : `${rows.length} run(s) past ${BUDGET_TREND_PCT}% of the per-run LLM budget today`,
        detail: worst.slice(0, 3).map((l) => `${l.key} ${usd(l.spent_usd)}`).join(', ') +
          ` (limit ${usd(worst[0].limit_usd)} per run per day)`,
        since: null,
        hold_ms: 0,
        count: rows.length,
        deeplink: orchestrator,
        evidence: { runs: worst.slice(0, 20).map((l) => ({ vtid: l.key, spent_usd: l.spent_usd, used_pct: l.used_pct })) },
      });
    }
  } else errors.push(`llm_budgets: ${spend.error}`);

  if (jev.ok) {
    // One item per tenant × month: the highest level crossed wins.
    const byTenant = new Map<string, { level: number; ev: OasisEventRow }>();
    for (const ev of jev.value) {
      const m = (ev.metadata || {}) as Record<string, unknown>;
      const tenant = String(m.tenant_id || 'unknown');
      const level = Number(m.level_pct) || 0;
      const prev = byTenant.get(tenant);
      if (!prev || level > prev.level) byTenant.set(tenant, { level, ev });
    }
    for (const [tenant, { level, ev }] of byTenant) {
      const m = (ev.metadata || {}) as Record<string, unknown>;
      const exhausted = level >= 100;
      candidates.push({
        key: `jev_budget:${tenant}:${String(m.month || monthStartUtc(ctx.now).slice(0, 10))}`,
        domain: 'cost',
        severity: exhausted ? 'P2' : 'P3',
        title: exhausted
          ? `Jev community budget exhausted for tenant ${tenant}`
          : `Jev community budget past ${level}% for tenant ${tenant}`,
        detail: `${m.spent_usd !== undefined ? usd(Number(m.spent_usd)) : '?'} of ${m.budget_usd !== undefined ? usd(Number(m.budget_usd)) : '?'} this month` +
          (exhausted ? ' — member decisions fall back to rules' : '') + ' (Jev card: /command-hub/jev.html)',
        since: ev.created_at,
        hold_ms: 0,
        count: 1,
        deeplink: orchestrator,
        evidence: { topic: ev.topic, created_at: ev.created_at, level_pct: level, tenant_id: tenant, month: m.month ?? null },
      });
    }
  } else errors.push(`jev_budget: ${jev.error}`);

  return errors.length ? { candidates, partial_error: errors.join('; ') } : { candidates };
}

// ── 9. Tests & contracts (VTID-04885) ───────────────────────────────────────

export const TESTS_LOOKBACK_MS = 7 * 24 * HOUR;
/** ci_test_runs is synced lazily (on a Testing & QA read); older = unknown. */
export const CI_SYNC_STALE_MS = 24 * HOUR;
const CI_SUCCESS = 'success';
const CI_VERDICTS = new Set(['success', 'failure', 'timed_out', 'startup_failure']);

export async function testsContractsAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const [runs, contracts] = await Promise.all([
    settle(reads.ciTestRuns(iso(now - TESTS_LOOKBACK_MS))),
    settle(reads.failingTestContracts()),
  ]);
  if (!runs.ok && !contracts.ok) throw new Error(`ci_test_runs: ${runs.error}; test_contracts: ${contracts.error}`);
  const candidates: Candidate[] = [];
  const errors: string[] = [];

  if (runs.ok) {
    const synced = runs.value.last_synced_at;
    if (!synced || now - Date.parse(synced) > CI_SYNC_STALE_MS) {
      errors.push(`ci_test_runs: not synced for ${synced ? fmtAge(now - Date.parse(synced)) : 'ever'} (synced when Testing & QA is opened)`);
    }
    // Newest first per workflow; only runs on main with a pass/fail verdict.
    const byWf = new Map<string, CiRunLite[]>();
    for (const r of runs.value.rows) {
      if (r.branch !== 'main' || !CI_VERDICTS.has(String(r.conclusion))) continue;
      const k = `${r.repo}|${r.workflow_file}`;
      const arr = byWf.get(k) || [];
      arr.push(r);
      byWf.set(k, arr);
    }
    for (const [k, list] of byWf) {
      list.sort((a, b) => Date.parse(b.run_created_at) - Date.parse(a.run_created_at));
      if (list[0].conclusion === CI_SUCCESS) continue;
      let streak = 0;
      for (const r of list) {
        if (r.conclusion === CI_SUCCESS) break;
        streak++;
      }
      const firstFail = list[streak - 1];
      candidates.push({
        key: `workflow:${k}`,
        domain: 'quality',
        severity: streak >= 2 ? 'P2' : 'P3',
        title: `${list[0].workflow_name || list[0].workflow_file} failing on main`,
        detail: `${list[0].repo} · ${streak} failed run(s) in a row · latest ${fmtAge(now - Date.parse(list[0].run_created_at))} ago`,
        since: firstFail.run_created_at,
        hold_ms: 0,
        count: streak,
        deeplink: link('testing-qa', 'runs'),
        evidence: { repo: list[0].repo, workflow_file: list[0].workflow_file, latest_url: list[0].html_url, failing_streak: streak },
      });
    }
  } else errors.push(`ci_test_runs: ${runs.error}`);

  if (contracts.ok) {
    const failing = contracts.value;
    if (failing.length) {
      const oldest = failing.map((c) => c.last_run_at).filter((x): x is string => !!x).sort()[0] ?? null;
      candidates.push({
        key: 'contracts:fail',
        domain: 'quality',
        severity: 'P3',
        title: `${failing.length} capability contract(s) failing`,
        detail: failing.slice(0, 3).map((c) => `${c.capability}${c.service ? ` (${c.service})` : ''}`).join(', '),
        since: oldest,
        hold_ms: 0,
        count: failing.length,
        deeplink: link('testing-qa', 'test-contracts'),
        evidence: { ids: failing.slice(0, 20).map((c) => c.id) },
      });
    }
  } else errors.push(`test_contracts: ${contracts.error}`);

  return errors.length ? { candidates, partial_error: errors.join('; ') } : { candidates };
}

// ── 10. Routines / scheduled jobs (VTID-04885) ──────────────────────────────

export const ROUTINE_FAILURE_STREAK_P2 = 3;
export const ROUTINE_RUNNING_STUCK_MS = 6 * HOUR;
/** A run is overdue once 1.5 schedule intervals passed without one. */
export const ROUTINE_OVERDUE_FACTOR = 1.5;

/**
 * The interval between two runs of a 5-field cron, or null when the shape is
 * not one of the simple ones the routines use (then overdue is not judged).
 * Day-of-week set → weekly; day-of-month set → monthly; '*' or '* /N' hour →
 * hourly (N h); fixed minute + hour → daily.
 */
export function cronIntervalMs(spec: string): number | null {
  const f = String(spec || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (mon !== '*') return null;
  if (dow !== '*') return dom === '*' ? 7 * 24 * HOUR : null;
  if (dom !== '*') return /^\d+$/.test(dom) ? 31 * 24 * HOUR : null;
  if (hour === '*') return /^\d+$/.test(min) ? HOUR : null;
  const step = hour.match(/^\*\/(\d+)$/);
  if (step) return Number(step[1]) * HOUR;
  if (/^\d+$/.test(hour) && /^\d+$/.test(min)) return 24 * HOUR;
  return null;
}

export async function routinesAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const rows = await reads.routines();
  const candidates: Candidate[] = [];
  const unjudged: string[] = [];
  const catalog = link('routines', 'catalog');
  const history = link('routines', 'history');

  for (const r of rows) {
    const name = r.display_name || r.name;
    const status = String(r.last_run_status || '');
    if (status === 'failure') {
      const streak = Math.max(1, Number(r.consecutive_failures) || 0);
      candidates.push({
        key: `failed:${r.name}`,
        domain: 'jobs',
        severity: streak >= ROUTINE_FAILURE_STREAK_P2 ? 'P2' : 'P3',
        title: `Routine failed: ${name}`,
        detail: `${streak} failure(s) in a row · last run ${r.last_run_at ? fmtAge(now - Date.parse(r.last_run_at)) + ' ago' : 'unknown'}`,
        since: r.last_run_at,
        hold_ms: 0,
        count: streak,
        deeplink: history,
        evidence: { name: r.name, consecutive_failures: r.consecutive_failures, last_run_at: r.last_run_at },
      });
      continue;
    }
    if (status === 'running' && r.last_run_at && now - Date.parse(r.last_run_at) > ROUTINE_RUNNING_STUCK_MS) {
      candidates.push({
        key: `running:${r.name}`,
        domain: 'jobs',
        severity: 'P3',
        title: `Routine still running: ${name}`,
        detail: `started ${fmtAge(now - Date.parse(r.last_run_at))} ago (threshold 6 h)`,
        since: iso(Date.parse(r.last_run_at) + ROUTINE_RUNNING_STUCK_MS),
        hold_ms: 0,
        count: 1,
        deeplink: history,
        evidence: { name: r.name, last_run_at: r.last_run_at },
      });
      continue;
    }
    const interval = cronIntervalMs(r.cron_schedule);
    if (interval === null) {
      unjudged.push(r.name);
      continue;
    }
    const lastAt = r.last_run_at || r.created_at;
    if (!lastAt) continue;
    const dueBy = Date.parse(lastAt) + interval * ROUTINE_OVERDUE_FACTOR;
    if (now > dueBy) {
      candidates.push({
        key: `overdue:${r.name}`,
        domain: 'jobs',
        severity: 'P3',
        title: `Routine overdue: ${name}`,
        detail: r.last_run_at
          ? `last run ${fmtAge(now - Date.parse(r.last_run_at))} ago (schedule ${r.cron_schedule})`
          : `never ran (schedule ${r.cron_schedule})`,
        since: iso(dueBy),
        hold_ms: 0,
        count: 1,
        deeplink: catalog,
        evidence: { name: r.name, cron_schedule: r.cron_schedule, last_run_at: r.last_run_at },
      });
    }
  }
  // An unparseable schedule cannot be judged overdue: say so, never "on time".
  return unjudged.length
    ? { candidates, partial_error: `routines: schedule not understood for ${unjudged.slice(0, 5).join(', ')}` }
    : { candidates };
}

// ── 11. Support tickets (VTID-04885) ────────────────────────────────────────

export const TICKET_AGED_MS = 72 * HOUR;
export const TICKET_P1_WAIT_P3_MS = 1 * HOUR;
export const TICKET_P1_WAIT_P2_MS = 4 * HOUR;
/** Statuses that end a ticket (idx_feedback_tickets_priority_status excludes them). */
export const TICKET_CLOSED_STATUSES = ['resolved', 'user_confirmed', 'rejected', 'wont_fix', 'duplicate'];

function ticketLink(rows: TicketRow[]): Deeplink {
  return rows.length === 1 ? link('feedback', 'inbox', { ticket: rows[0].id }) : link('feedback', 'inbox');
}

export async function supportTicketsAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const rows = (await reads.openSupportTickets(iso(now - TICKET_AGED_MS)))
    .filter((t) => !TICKET_CLOSED_STATUSES.includes(t.status));
  const oldestFirst = (a: TicketRow, b: TicketRow) => Date.parse(a.created_at) - Date.parse(b.created_at);
  const candidates: Candidate[] = [];
  const label = (t: TicketRow) => t.ticket_number || t.id;

  const p0 = rows.filter((t) => t.priority === 'p0').sort(oldestFirst);
  const p1 = rows.filter((t) => t.priority === 'p1' && now - Date.parse(t.created_at) > TICKET_P1_WAIT_P3_MS).sort(oldestFirst);
  const urgentIds = new Set([...p0, ...p1].map((t) => t.id));
  const aged = rows.filter((t) => !urgentIds.has(t.id) && now - Date.parse(t.created_at) > TICKET_AGED_MS).sort(oldestFirst);

  if (p0.length) {
    candidates.push({
      key: 'tickets:p0',
      domain: 'support',
      severity: 'P2',
      title: `${p0.length} urgent (p0) support ticket(s) open`,
      detail: `oldest ${label(p0[0])} (${p0[0].kind || 'ticket'}) open ${fmtAge(now - Date.parse(p0[0].created_at))}`,
      since: p0[0].created_at,
      hold_ms: 0,
      count: p0.length,
      deeplink: ticketLink(p0),
      evidence: { ids: p0.slice(0, 20).map((t) => t.id) },
    });
  }
  if (p1.length) {
    const oldestAge = now - Date.parse(p1[0].created_at);
    candidates.push({
      key: 'tickets:p1',
      domain: 'support',
      severity: oldestAge > TICKET_P1_WAIT_P2_MS ? 'P2' : 'P3',
      title: `${p1.length} high-priority (p1) support ticket(s) waiting`,
      detail: `oldest ${label(p1[0])} (${p1[0].kind || 'ticket'}) open ${fmtAge(oldestAge)}`,
      since: p1[0].created_at,
      hold_ms: 0,
      count: p1.length,
      deeplink: ticketLink(p1),
      evidence: { ids: p1.slice(0, 20).map((t) => t.id) },
    });
  }
  if (aged.length) {
    candidates.push({
      key: 'tickets:aged',
      domain: 'support',
      severity: 'P3',
      title: `${aged.length} support ticket(s) open for more than 72 h`,
      detail: `oldest ${label(aged[0])} (${aged[0].priority}, ${aged[0].status}) open ${fmtAge(now - Date.parse(aged[0].created_at))}`,
      since: iso(Date.parse(aged[0].created_at) + TICKET_AGED_MS),
      hold_ms: 0,
      count: aged.length,
      deeplink: ticketLink(aged),
      evidence: { ids: aged.slice(0, 20).map((t) => t.id) },
    });
  }
  return { candidates };
}

// ── 12. LLM Google fallback (VTID-04885) ────────────────────────────────────

export const LLM_GOOGLE_WINDOW_MS = 24 * HOUR;
/** Providers that are Google (CLAUDE.md §2b: never a sanctioned LLM-routing destination). */
export const GOOGLE_LLM_PROVIDERS = ['vertex', 'google', 'gemini'];

export function isGoogleLlmCall(row: Pick<LlmCallRow, 'provider' | 'model'>): boolean {
  const p = String(row.provider || '').toLowerCase();
  const m = String(row.model || '').toLowerCase();
  return GOOGLE_LLM_PROVIDERS.includes(p) || m.startsWith('gemini');
}

export async function llmGoogleFallbackAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const rows = (await reads.llmGoogleCalls(iso(now - LLM_GOOGLE_WINDOW_MS))).filter(isGoogleLlmCall);
  const candidates: Candidate[] = [];
  for (const fallback of [true, false]) {
    const set = rows
      .filter((r) => r.fallback_used === fallback)
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
    if (!set.length) continue;
    const stages = [...new Set(set.map((r) => r.stage || r.service || 'unknown'))];
    candidates.push({
      key: fallback ? 'google_fallback' : 'google_routed',
      domain: 'llm',
      severity: 'P2',
      title: fallback
        ? `${set.length} LLM call(s) fell back to Google in 24 h`
        : `${set.length} LLM call(s) routed at Google in 24 h`,
      detail: `stages: ${stages.slice(0, 4).join(', ')} · latest ${fmtAge(now - Date.parse(set[set.length - 1].created_at))} ago — ` +
        'a Google landing is an incident (CLAUDE.md §2b)',
      since: set[0].created_at,
      hold_ms: 0,
      count: set.length,
      deeplink: link('models-evaluations', 'routing'),
      evidence: {
        stages,
        providers: [...new Set(set.map((r) => r.provider))],
        models: [...new Set(set.map((r) => r.model))].slice(0, 5),
        latest_at: set[set.length - 1].created_at,
      },
    });
  }
  return { candidates };
}

// ── 13. Stuck session VTIDs (VTID-04885) ────────────────────────────────────

export const STUCK_VTID_MS = 72 * HOUR;
/** inProgressLedger() reads at most this many rows; a full page is truncated. */
export const LEDGER_READ_LIMIT = 500;

export async function stuckVtidsAdapter(reads: AttentionReads, ctx: AdapterContext): Promise<AdapterOutput> {
  const now = ctx.now;
  const rows = await reads.inProgressLedger();
  const stuck = rows
    .filter((r) => !reads.isAutonomous(r))
    .filter((r) => r.updated_at && now - Date.parse(r.updated_at) > STUCK_VTID_MS)
    .sort((a, b) => Date.parse(a.updated_at!) - Date.parse(b.updated_at!));
  const candidates: Candidate[] = [];
  if (stuck.length) {
    candidates.push({
      key: 'session_vtids_stale',
      domain: 'operator',
      severity: 'P3',
      title: `${stuck.length} session VTID(s) in progress with no update for more than 72 h`,
      detail: stuck.slice(0, 3).map((r) => `${r.vtid}${r.title ? ` (${r.title.slice(0, 40)})` : ''}`).join(', '),
      since: iso(Date.parse(stuck[0].updated_at!) + STUCK_VTID_MS),
      hold_ms: 0,
      count: stuck.length,
      deeplink: stuck.length === 1 ? link('command-hub', 'tasks', { vtid: stuck[0].vtid }) : link('oasis', 'vtid-ledger'),
      evidence: { vtids: stuck.slice(0, 20).map((r) => r.vtid), oldest_update: stuck[0].updated_at },
    });
  }
  return rows.length >= LEDGER_READ_LIMIT
    ? { candidates, partial_error: `vtid_ledger: in-progress read hit the ${LEDGER_READ_LIMIT}-row cap` }
    : { candidates };
}

// ── 14. CloudWatch alarms (VTID-04987) ──────────────────────────────────────

/**
 * Alarm-name prefix of the production-gateway alarms. An alarm in ALARM
 * whose name starts with it is P1; every other alarm in ALARM is P2.
 * scripts/aws/setup-gateway-alb-health-alarm.sh creates
 * `vitana-gateway-prod-no-healthy-targets` under this convention; a future
 * production-gateway alarm must use the same prefix to page as P1.
 */
export const GATEWAY_PROD_ALARM_PREFIX = 'vitana-gateway-prod-';

export async function cloudwatchAlarmsAdapter(reads: AttentionReads): Promise<AdapterOutput> {
  const { alarms, truncated } = await reads.cloudwatchAlarms();
  const candidates: Candidate[] = alarms.map((a) => {
    const p1 = a.name.startsWith(GATEWAY_PROD_ALARM_PREFIX);
    return {
      key: a.name,
      domain: 'platform',
      severity: p1 ? 'P1' : 'P2',
      title: `CloudWatch alarm ${a.name} in ALARM`,
      detail:
        (a.namespace ? `${a.namespace}${a.metric_name ? ` ${a.metric_name}` : ''}` : a.type === 'composite' ? 'composite alarm' : 'metric alarm') +
        (a.state_reason ? ` · ${a.state_reason.slice(0, 160)}` : '') +
        (p1 ? ' · production gateway' : ''),
      // CloudWatch already held the condition for its own evaluation
      // periods before it entered ALARM: no second hold here.
      since: a.state_updated_at,
      hold_ms: 0,
      count: 1,
      // The platform tile's screen (no dedicated alarms screen).
      deeplink: link('overview', 'system-overview'),
      evidence: {
        alarm_name: a.name,
        namespace: a.namespace,
        reason: a.state_reason,
        state_updated_at: a.state_updated_at,
        alarm_type: a.type,
        metric_name: a.metric_name,
      },
    };
  });
  return truncated
    ? { candidates, partial_error: `cloudwatch: DescribeAlarms hit the ${alarms.length}-alarm cap; more alarms may be in ALARM` }
    : { candidates };
}

// ── Registry ────────────────────────────────────────────────────────────────

export interface AdapterSpec {
  id: AttentionSourceId;
  run: (reads: AttentionReads, ctx: AdapterContext) => Promise<AdapterOutput>;
  /** Time budget for this source; defaults to ADAPTER_TIMEOUT_MS (3 s). */
  timeoutMs?: number;
}

export const ATTENTION_ADAPTERS: AdapterSpec[] = [
  // service_health probes the whole registry (5 s per probe, in parallel) and
  // the autonomy snapshot is a heavy read; both get a longer budget so a slow
  // but healthy source does not read UNKNOWN (owner decision 2026-10-04).
  { id: 'service_health', run: (r) => serviceHealthAdapter(r), timeoutMs: 8_000 },
  { id: 'release', run: releaseAdapter },
  { id: 'voice_supervisor', run: (r) => voiceSupervisorAdapter(r) },
  { id: 'autonomy', run: autonomyAdapter, timeoutMs: 6_000 },
  { id: 'operator_pipeline', run: operatorPipelineAdapter },
  { id: 'governance', run: governanceAdapter },
  { id: 'decisions_waiting', run: decisionsWaitingAdapter },
  // VTID-04885 (Phase 2). The spend read pages through today's
  // llm.call.completed events (up to 20 pages), so it gets the same 8 s budget
  // as service health; every other new source is one bounded query (3 s).
  { id: 'cost_budgets', run: costBudgetsAdapter, timeoutMs: 8_000 },
  { id: 'tests_contracts', run: testsContractsAdapter },
  { id: 'routines', run: routinesAdapter },
  { id: 'support_tickets', run: supportTicketsAdapter },
  { id: 'llm_google_fallback', run: llmGoogleFallbackAdapter },
  { id: 'stuck_vtids', run: stuckVtidsAdapter },
];

/**
 * VTID-04987: the CloudWatch source. Not in ATTENTION_ADAPTERS — it is
 * registered only behind its flag, by attentionAdapters(). The read itself is
 * bounded at 5 s (ops-attention-cloudwatch.ts), so its budget is 6 s.
 */
export const CLOUDWATCH_ALARMS_ADAPTER: AdapterSpec = { id: 'cloudwatch_alarms', run: (r) => cloudwatchAlarmsAdapter(r), timeoutMs: 6_000 };

/** VTID-04987: the CloudWatch source's gate. Exact string 'true'; anything else is off. */
export function isCloudwatchAlarmsEnabled(): boolean {
  return (process.env.OPS_ATTENTION_CLOUDWATCH_ENABLED ?? 'false') === 'true';
}

/**
 * VTID-04987: the adapters the aggregator runs — ATTENTION_ADAPTERS, plus the
 * CloudWatch source when OPS_ATTENTION_CLOUDWATCH_ENABLED is 'true'. Decided
 * here, once; the aggregator and the tile summary both read it.
 */
export function attentionAdapters(): AdapterSpec[] {
  return isCloudwatchAlarmsEnabled() ? [...ATTENTION_ADAPTERS, CLOUDWATCH_ALARMS_ADAPTER] : ATTENTION_ADAPTERS;
}

/**
 * VTID-04987: why a source a tile lists is not registered. Such a source is
 * shown on its tile as not monitored — never ok, never unknown.
 */
export const GATED_SOURCE_REASONS: Partial<Record<AttentionSourceId, string>> = {
  cloudwatch_alarms:
    'OPS_ATTENTION_CLOUDWATCH_ENABLED is not "true" on this deployment, so CloudWatch alarms are not read. ' +
    'The gateway task role needs cloudwatch:DescribeAlarms first (scripts/aws/setup-gateway-cloudwatch-read-grant.sh).',
};

/**
 * VTID-04885: sources the plan names that have no in-process adapter yet.
 * Their domain tile says "not yet monitored" for them — never unknown, never OK.
 * Empty since VTID-04987 wired cloudwatch_alarms; kept for future sources.
 */
export const NOT_WIRED_SOURCES: Array<{ id: string; domain: TileDomainKey; reason: string }> = [];

// ── Domain tiles (VTID-04885) ───────────────────────────────────────────────

export type TileDomainKey =
  | 'platform' | 'release' | 'voice' | 'llm' | 'autonomy' | 'operator' | 'governance'
  | 'quality' | 'cost' | 'support' | 'commerce' | 'data' | 'jobs';

export interface TileDomain {
  key: TileDomainKey;
  label: string;
  /** Adapters whose items roll up into this tile; [] = not yet monitored. */
  sources: AttentionSourceId[];
  /** Where the tile's click-through lands (a NAVIGATION_CONFIG screen). */
  deeplink: Deeplink;
}

/** The plan's 13 domains, in display order. */
export const TILE_DOMAINS: TileDomain[] = [
  { key: 'platform', label: 'Platform & Services', sources: ['service_health', 'cloudwatch_alarms'], deeplink: link('overview', 'system-overview') },
  { key: 'release', label: 'Release Pipeline', sources: ['release'], deeplink: link('operator', 'deployments') },
  { key: 'voice', label: 'Voice / ORB', sources: ['voice_supervisor'], deeplink: link('voice', 'overview') },
  { key: 'llm', label: 'AI & LLM Routing', sources: ['llm_google_fallback'], deeplink: link('models-evaluations', 'routing') },
  { key: 'autonomy', label: 'Autonomy', sources: ['autonomy'], deeplink: link('autopilot', 'live') },
  // Decisions waiting (approvals of VTIDs, executions and self-heal fixes) roll up here.
  { key: 'operator', label: 'Operator & VTIDs', sources: ['operator_pipeline', 'stuck_vtids', 'decisions_waiting'], deeplink: link('command-hub', 'tasks') },
  { key: 'governance', label: 'Governance', sources: ['governance'], deeplink: link('governance', 'controls') },
  { key: 'quality', label: 'Quality', sources: ['tests_contracts'], deeplink: link('testing-qa', 'overview') },
  { key: 'cost', label: 'Cost & Budgets', sources: ['cost_budgets'], deeplink: link('autopilot', 'orchestrator') },
  { key: 'support', label: 'Community & Support', sources: ['support_tickets'], deeplink: link('feedback', 'inbox') },
  { key: 'commerce', label: 'Moderation & Commerce', sources: [], deeplink: link('commerce', 'overview') },
  { key: 'data', label: 'Data & Memory', sources: [], deeplink: link('databases', 'supabase') },
  { key: 'jobs', label: 'Scheduled Jobs', sources: ['routines'], deeplink: link('routines', 'catalog') },
];
