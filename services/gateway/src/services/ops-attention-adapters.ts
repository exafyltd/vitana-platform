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
  | 'decisions';

export type AttentionSourceId =
  | 'service_health'
  | 'release'
  | 'voice_supervisor'
  | 'autonomy'
  | 'operator_pipeline'
  | 'governance'
  | 'decisions_waiting';

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
];
