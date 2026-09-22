/**
 * Developer Autopilot — Safety Gate
 *
 * Pure-function evaluator that runs on every approve-auto-execute, per-finding
 * (including each row in a batch approval). A plan may only enter the execution
 * queue if every rule returns `ok=true`. Any violation short-circuits the gate
 * and is surfaced as a row-level error chip in the UI.
 *
 * Rules (all configurable via dev_autopilot_config):
 *   - Kill switch not engaged
 *   - risk_class in {low, medium}
 *   - All plan.files_to_modify inside allow-scope glob AND none in deny-scope
 *   - Plan includes at least one test file change when non-deletion edits exist
 *   - Daily budget not yet exhausted
 *   - auto_fix_depth < max_auto_fix_depth (prevents self-heal loops)
 *
 * VTID-04132: the scope and test-coverage rules above are SKIPPED when
 * `ctx.is_open_ended` is set (an operator-execution-onramp.ts open-ended
 * agent plan) — see SafetyContext.is_open_ended for why; they are enforced
 * instead, post-hoc, against the agent's real diff.
 *
 * The gate is deliberately pure: it receives a snapshot of config + context and
 * emits a decision. Callers persist the decision + violations; the gate does
 * not mutate DB state or emit events.
 */

const LOG_PREFIX = '[dev-autopilot-safety]';

// =============================================================================
// Types
// =============================================================================

export type RiskClass = 'low' | 'medium' | 'high';

export interface SafetyConfig {
  kill_switch: boolean;
  daily_budget: number;
  concurrency_cap: number;
  max_auto_fix_depth: number;
  allow_scope: string[];
  deny_scope: string[];
}

export interface SafetyContext {
  /** Snapshot of dev_autopilot_config (singleton row). */
  config: SafetyConfig;
  /** Count of dev_autopilot_executions approved today (UTC midnight) in any
   *  non-terminal status. Used to enforce daily_budget. */
  approved_today: number;
  /** For self-heal children: depth of the proposed execution (0 for root). */
  auto_fix_depth: number;
  /**
   * VTID-02676 once used this to let feedback-bridged findings bypass the
   * kill switch. VTID-04308 removed that exemption: a support ticket is one
   * more intake source and obeys the same kill switch as every other lane.
   * Kept on the type (informational, still set by the executor) so callers
   * and telemetry that pass it keep compiling.
   */
  is_feedback_lane?: boolean;

  /**
   * The scanner that produced the finding (e.g. 'npm-audit-scanner-v1',
   * 'rls-policy-scanner-v1'). Optional — when set, the gate applies
   * per-scanner scope overrides so the finding's canonical fix is allowed
   * even when the global allow/deny rules would block it. Examples:
   *   - npm-audit-scanner-v1 / cve-scanner-v1 → allow `**\/package.json`,
   *     `**\/pnpm-lock.yaml` (the only valid CVE fix is a dep bump)
   *   - rls-policy-scanner-v1 / schema-drift-scanner-v1 → lift the
   *     `supabase/migrations/**` deny rule (the canonical fix is a NEW
   *     dated migration; the executor's "never modify existing migrations"
   *     rule still applies separately)
   *   - workflow-fix-scanner-v1 / ci-fix-scanner-v1 → lift `.github/workflows/**`
   *     deny rule
   * The 2026-05-08 audit found that without these overrides, ~40% of
   * findings produced test-only PRs that fail CI 100% of the time.
   */
  scanner?: string;

  /**
   * VTID-04132: when this context represents an OPEN-ENDED agent-executor
   * plan (operator-execution-onramp.ts's `autopilot_run_task`, spec_snapshot
   * .intake === 'open_ended'), rules 3 (scope) and 4 (tests_missing) are
   * SKIPPED here and enforced instead, post-hoc, against the agent's real
   * diff (`agent-scope.ts`'s `checkChangedFilesScope`/`hasTestCoverage`,
   * VTID-04006) — exactly as operator-execution-onramp.ts's own module doc
   * has always said they would be. Before this flag existed, that promise
   * was never honoured: `plan.files_to_modify` for an open-ended request is
   * derived by `extractFilePaths()` scanning the raw, unstructured prose the
   * user/model wrote — a request that says "add a unit test in
   * services/gateway/test/ confirming X" (a real, reproduced case) names no
   * literal file path, so the pre-flight gate rejected it as tests_missing
   * before the agent ever ran, even though the agent — which discovers
   * files and would have written a concrete test file — was never given the
   * chance. All three real Operator Console failures traced on 2026-09-20
   * (two attempts at one task, one at another) had this exact shape. Kill
   * switch, risk_class, daily_budget and max_auto_fix_depth are NOT
   * file-list-dependent and still apply pre-flight, unchanged.
   */
  is_open_ended?: boolean;
}

export interface SafetyPlan {
  risk_class: RiskClass;
  /** Files the plan proposes to modify (repo-relative paths, forward slashes). */
  files_to_modify: string[];
  /** Files the plan proposes to delete (subset of files_to_modify usually). */
  files_to_delete?: string[];
}

export type ViolationCode =
  | 'kill_switch_engaged'
  | 'risk_class_too_high'
  | 'file_outside_allow_scope'
  | 'file_in_deny_scope'
  | 'tests_missing'
  | 'daily_budget_exhausted'
  | 'max_auto_fix_depth_reached';

export interface SafetyViolation {
  code: ViolationCode;
  message: string;
  detail?: Record<string, unknown>;
}

export interface SafetyDecision {
  ok: boolean;
  violations: SafetyViolation[];
}

// =============================================================================
// Glob matching (minimal — avoids pulling in a dep for a handful of patterns)
// =============================================================================

/**
 * Matches a file path against a simple glob with `**` (any depth),
 * `*` (any segment content except '/'), and literal segments. Anchored.
 */
export function matchGlob(path: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  // Escape regex specials except our wildcards
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // **  → match across segments (optionally including trailing /)
        re += '.*';
        i += 2;
        // consume a following '/' if present so "a/**/b" matches "a/b"
        if (pattern[i] === '/') i += 1;
        continue;
      }
      // single * → anything but '/'
      re += '[^/]*';
      i += 1;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i += 1;
      continue;
    }
    if ('.+^$(){}|[]\\'.includes(c)) {
      re += '\\' + c;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp('^' + re + '$');
}

function matchesAnyGlob(path: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (matchGlob(path, p)) return true;
  }
  return false;
}

// =============================================================================
// Test-file heuristic
// =============================================================================

const TEST_FILE_PATTERNS = [
  /\.test\.[jt]sx?$/i,
  /\.spec\.[jt]sx?$/i,
  /(^|\/)(__tests__|tests?)\//i,
];

export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some(rx => rx.test(path));
}

// =============================================================================
// Per-scanner scope overrides
// =============================================================================
//
// Some scanners' canonical fixes touch files the global allow/deny rules
// block on purpose. Without overrides, those findings produce test-only
// PRs that fail CI deterministically. Adjust effective allow/deny based
// on the finding's scanner.
//
// Conservative defaults: each override matches a SPECIFIC scanner identifier.
// Unknown scanners get no override — same surface as before.

const PACKAGE_MANIFEST_GLOBS = ['**/package.json', '**/pnpm-lock.yaml'];
const MIGRATIONS_DENY_GLOB = 'supabase/migrations/**';
const WORKFLOWS_DENY_GLOB = '.github/workflows/**';

const NPM_AUDIT_SCANNERS = new Set<string>(['npm-audit-scanner-v1', 'cve-scanner-v1']);
const NEW_MIGRATION_SCANNERS = new Set<string>([
  'rls-policy-scanner-v1',
  'schema-drift-scanner-v1',
]);
const WORKFLOW_SCANNERS = new Set<string>(['workflow-fix-scanner-v1', 'ci-fix-scanner-v1']);

export function applyScannerOverrides(
  allowScope: string[],
  denyScope: string[],
  scanner: string | undefined,
): { effectiveAllow: string[]; effectiveDeny: string[] } {
  if (!scanner) {
    return { effectiveAllow: allowScope, effectiveDeny: denyScope };
  }
  let effectiveAllow = allowScope;
  let effectiveDeny = denyScope;

  // npm-audit / cve: dep bumps land in package.json. Add to allow.
  if (NPM_AUDIT_SCANNERS.has(scanner)) {
    effectiveAllow = effectiveAllow.concat(PACKAGE_MANIFEST_GLOBS);
  }

  // rls-policy / schema-drift: canonical fix is a NEW dated migration.
  // Lift the migrations deny rule (executor enforces "never modify
  // existing migrations" separately via the planner prompt + reviewers).
  if (NEW_MIGRATION_SCANNERS.has(scanner)) {
    effectiveDeny = effectiveDeny.filter(g => g !== MIGRATIONS_DENY_GLOB);
  }

  // workflow / ci scanners: fix is in .github/workflows/*. Lift that deny.
  if (WORKFLOW_SCANNERS.has(scanner)) {
    effectiveDeny = effectiveDeny.filter(g => g !== WORKFLOWS_DENY_GLOB);
  }

  return { effectiveAllow, effectiveDeny };
}

// =============================================================================
// Main gate
// =============================================================================

export function evaluateSafetyGate(plan: SafetyPlan, ctx: SafetyContext): SafetyDecision {
  const violations: SafetyViolation[] = [];

  // 1. Kill switch — applies to every lane, feedback tickets included
  //    (VTID-04308 removed the VTID-02676 feedback-lane exemption).
  if (ctx.config.kill_switch) {
    violations.push({
      code: 'kill_switch_engaged',
      message: 'Dev Autopilot kill switch is armed. Disarm it before approving new executions.',
    });
    // Kill switch is decisive — no reason to evaluate anything else.
    return { ok: false, violations };
  }

  // 2. Risk class
  if (plan.risk_class === 'high') {
    violations.push({
      code: 'risk_class_too_high',
      message: 'High-risk findings require a human-written PR. Auto-execution is gated off.',
      detail: { risk_class: plan.risk_class },
    });
  }

  // 3. Scope — allow + deny, with per-scanner overrides (see SafetyContext.scanner doc)
  // VTID-04132: skipped for an open-ended agent plan — files_to_modify here
  // is only what extractFilePaths() happened to find in unstructured prose,
  // not an authoritative list. agent-scope.ts's checkChangedFilesScope()
  // enforces the same allow/deny globs post-hoc against the real diff.
  if (!ctx.is_open_ended) {
    const { effectiveAllow, effectiveDeny } = applyScannerOverrides(
      ctx.config.allow_scope,
      ctx.config.deny_scope,
      ctx.scanner,
    );
    const filesOutsideAllow: string[] = [];
    const filesInDeny: string[] = [];
    for (const f of plan.files_to_modify) {
      if (!matchesAnyGlob(f, effectiveAllow)) {
        filesOutsideAllow.push(f);
      }
      if (matchesAnyGlob(f, effectiveDeny)) {
        filesInDeny.push(f);
      }
    }
    if (filesOutsideAllow.length > 0) {
      violations.push({
        code: 'file_outside_allow_scope',
        message: `Plan touches ${filesOutsideAllow.length} file(s) outside the allow-scope.`,
        detail: { files: filesOutsideAllow },
      });
    }
    if (filesInDeny.length > 0) {
      violations.push({
        code: 'file_in_deny_scope',
        message: `Plan touches ${filesInDeny.length} file(s) in the deny-scope.`,
        detail: { files: filesInDeny },
      });
    }
  }

  // 4. Test coverage — required when there's any non-deletion edit.
  // VTID-04132: skipped for an open-ended agent plan for the same reason —
  // agent-scope.ts's hasTestCoverage() enforces this post-hoc against the
  // agent's real diff, which can (and does) add the concrete test file the
  // raw prose never named.
  if (!ctx.is_open_ended) {
    const deletions = new Set(plan.files_to_delete || []);
    const nonDeletionEdits = plan.files_to_modify.filter(f => !deletions.has(f));
    const hasNonDeletionEdits = nonDeletionEdits.length > 0;
    if (hasNonDeletionEdits) {
      const hasTestFile = plan.files_to_modify.some(isTestFile);
      if (!hasTestFile) {
        violations.push({
          code: 'tests_missing',
          message: 'Plan must add or modify at least one test file when making non-deletion edits.',
        });
      }
    }
  }

  // 5. Daily budget
  if (ctx.approved_today >= ctx.config.daily_budget) {
    violations.push({
      code: 'daily_budget_exhausted',
      message: `Daily auto-execution budget exhausted (${ctx.approved_today}/${ctx.config.daily_budget}). Resets at UTC midnight.`,
      detail: { approved_today: ctx.approved_today, daily_budget: ctx.config.daily_budget },
    });
  }

  // 6. Self-heal depth cap
  if (ctx.auto_fix_depth >= ctx.config.max_auto_fix_depth) {
    violations.push({
      code: 'max_auto_fix_depth_reached',
      message: `Self-heal depth cap reached (${ctx.auto_fix_depth}/${ctx.config.max_auto_fix_depth}). Escalate for human review.`,
      detail: { auto_fix_depth: ctx.auto_fix_depth, max_auto_fix_depth: ctx.config.max_auto_fix_depth },
    });
  }

  return { ok: violations.length === 0, violations };
}

// =============================================================================
// Listing-time pre-flight (VTID-01974)
// =============================================================================

/**
 * Lightweight gate dry-run for the findings listing endpoint.
 *
 * Why this exists: the full evaluateSafetyGate() needs a generated plan
 * (files_to_modify, deletions, etc.) and runs *after* the user clicks
 * Approve & execute. By then it's too late — the user already faced a
 * dead-end button. This pre-flight runs at /queue listing time using only
 * the scanner's spec_snapshot (file_path + risk_class), so the UI can
 * route findings the executor cannot act on into a manual-review lane
 * before rendering the Approve button.
 *
 * It checks the two violations that are decidable from scanner data
 * alone:
 *   - risk_class_too_high (plan-independent)
 *   - file_outside_allow_scope on the scanner-reported file_path
 *     (the LLM may add more files when planning, but if the seed file
 *      is already out of scope, no plan can rescue it)
 *
 * It does NOT enumerate later-stage gates (tests_missing, daily_budget,
 * kill_switch, max_auto_fix_depth) — those depend on plan output, current
 * counters, or runtime config the executor reads at approval time and are
 * better surfaced through the existing post-approval failure banner.
 */
export interface PreflightInput {
  /** Scanner's reported file path. Pass an empty string if unknown — the
   *  preflight will return auto_actionable=false with reason
   *  'file_path_unknown' since we can't gate without it. */
  file_path: string;
  /** Risk class on the recommendation row. Defaults to 'medium' upstream
   *  if missing (matching the gate). */
  risk_class: RiskClass;
  /** Allow- and deny-globs from dev_autopilot_config. */
  allow_scope: string[];
  deny_scope: string[];
}

export type PreflightBlockReason =
  | 'risk_class_too_high'
  | 'file_outside_allow_scope'
  | 'file_in_deny_scope'
  | 'file_path_unknown';

export interface PreflightResult {
  /** false → UI should hide Approve & execute, route to manual lane. */
  auto_actionable: boolean;
  /** First reason the preflight blocked, in stable priority order:
   *    risk_class_too_high → file_outside_allow_scope → file_in_deny_scope.
   *  Null when auto_actionable=true. */
  block_reason: PreflightBlockReason | null;
  /** Short human-readable explanation suitable for inline UI rendering. */
  block_message: string | null;
}

export function dryRunPreflight(input: PreflightInput): PreflightResult {
  if (input.risk_class === 'high') {
    return {
      auto_actionable: false,
      block_reason: 'risk_class_too_high',
      block_message:
        'High-risk findings require a human-written PR. Auto-execution is gated off; use Reject + handle manually.',
    };
  }

  if (!input.file_path) {
    return {
      auto_actionable: false,
      block_reason: 'file_path_unknown',
      block_message:
        'Scanner did not record a target file_path; the executor cannot scope a fix automatically.',
    };
  }

  if (matchesAnyGlob(input.file_path, input.deny_scope)) {
    return {
      auto_actionable: false,
      block_reason: 'file_in_deny_scope',
      block_message: `${input.file_path} is in the executor's deny-scope. Manual fix required.`,
    };
  }

  if (!matchesAnyGlob(input.file_path, input.allow_scope)) {
    return {
      auto_actionable: false,
      block_reason: 'file_outside_allow_scope',
      block_message: `${input.file_path} is outside the executor's allow-scope. Manual fix required.`,
    };
  }

  return { auto_actionable: true, block_reason: null, block_message: null };
}

// Intentional log tag for service boot tracing consistency
export { LOG_PREFIX };
