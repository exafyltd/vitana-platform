/**
 * VTID-05148 — learn-outcomes routine (Loop Engineering Phase 4, loop L3 Learn).
 *
 * Outcomes were recorded (self_healing_log, dev_autopilot_outcomes) but
 * nothing read them to act. This loader closes the smallest loop on top of
 * what exists, once per UTC day at 12:00 (routines/learn-outcomes.md):
 *
 *   P1  every fix (self_healing_log outcome=fixed with diagnosis.pr_url) gets
 *       diagnosis.tests_added from its own PR's changed files (GitHub PR files
 *       API, at most MAX_PRS_PER_RUN PRs per run). A fix whose PR shipped no
 *       test becomes ONE write_test finding through the missing-test insert
 *       (routes/test-contracts-missing.ts), deduped by fix VTID + endpoint.
 *       A GitHub error leaves the row untouched for the next run.
 *   P2  Mondays (UTC) only: graduation proposals from dev_autopilot_outcomes
 *       (30 days, exec_outcome set) as OASIS learn.graduation.proposed, and
 *       learn.graduation.withdrawn for an open proposal whose class regressed.
 *       A proposal is never applied: this file writes no eligibility flag and
 *       no autonomy level (a source test pins that).
 *   P3  the three L3 metrics, stored in the run's findings; a class whose
 *       repeat-failure rate is above the limit breaches (checks.ts).
 *
 * Writes, all of them: PATCH self_healing_log.diagnosis (read-modify-write of
 * the whole object), the write_test finding insert, and OASIS events.
 */

import type { MissingTestRecommendationInput } from '../../routes/test-contracts-missing';
import { checkLearnOutcomes, LearnMetrics, RepeatFailureClass, RoutineVerdict } from './checks';

export const LEARN_VTID = 'VTID-05148';
export const LEARN_SOURCE = 'routine.learn-outcomes';
export const WINDOW_DAYS = 30;
export const FOLLOW_UP_DAYS = 7;
export const MAX_PRS_PER_RUN = 50;
export const GRADUATION_MIN_EXECUTIONS = 20;
export const GRADUATION_MIN_SUCCESS_RATE = 0.95;
export const GRADUATION_WITHDRAW_BELOW = 0.9;
export const PROPOSED_TOPIC = 'learn.graduation.proposed';
export const WITHDRAWN_TOPIC = 'learn.graduation.withdrawn';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 1000;
const MAX_ROWS = 10000;

// =============================================================================
// P1 — which tests a fix's PR shipped
// =============================================================================

/** *.test.ts, *.test.cjs, *.spec.ts, or anything under a test/ or __tests__/ directory. */
export function isTestFile(path: string): boolean {
  return (
    /\.test\.ts$/.test(path) ||
    /\.test\.cjs$/.test(path) ||
    /\.spec\.ts$/.test(path) ||
    /(^|\/)test\//.test(path) ||
    /(^|\/)__tests__\//.test(path)
  );
}

/** Test files the PR added or changed (a removed test is not a test added). */
export function testsAddedFrom(files: Array<{ filename: string; status?: string }>): string[] {
  return files.filter((f) => f.status !== 'removed' && isTestFile(f.filename)).map((f) => f.filename);
}

export function parsePrUrl(url: unknown): { repo: string; number: number } | null {
  const m = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(String(url || ''));
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export function escapedBugDedupeKey(vtid: string, endpoint: string): string {
  return `learn-outcomes:${vtid}:${endpoint}`;
}

export function escapedBugFinding(
  id: string,
  row: { id: string; vtid: string; endpoint: string },
  prUrl: string
): MissingTestRecommendationInput {
  const spec_markdown = `# Regression test for fix ${row.vtid}

The fix \`${row.vtid}\` for \`${row.endpoint}\` was merged in ${prUrl} without a test. A bug that escaped once can escape again: nothing stops the same regression from coming back.

## What to do

1. Read the fix PR (${prUrl}) and name the behaviour it restored.
2. Add a unit or integration test under \`services/gateway/test/\` that fails on the code before the fix and passes after it.
3. Change no production code in this PR.

## Dedupe key

\`${escapedBugDedupeKey(row.vtid, row.endpoint)}\` — the learn-outcomes routine (VTID-05148) files one finding per fix.
`;
  return {
    id,
    title: `Write regression test for fix ${row.vtid}: ${row.endpoint}`,
    summary: `Fix ${row.vtid} on ${row.endpoint} shipped without a test (${prUrl}). Add a test that fails before the fix and passes after it.`,
    spec_markdown,
    files_referenced: /[/.]/.test(row.endpoint) ? [row.endpoint] : [],
    dedupe_key: escapedBugDedupeKey(row.vtid, row.endpoint),
    capability: row.vtid,
    target_endpoint: row.endpoint,
    extra_snapshot: {
      repair_kind: 'write_test',
      source: 'learn-outcomes',
      fix_vtid: row.vtid,
      fix_pr_url: prUrl,
      self_healing_log_id: row.id,
    },
  };
}

// =============================================================================
// P3 — the L3 metrics (pure)
// =============================================================================

export interface FixRow {
  id: string;
  endpoint: string;
  failure_class: string | null;
  created_at: string;
  /** diagnosis.tests_added — null when the key is absent (rows from before P1). */
  tests_added: unknown;
  /** diagnosis.repair_pattern_id — set only by an execution that reused a pattern. */
  repair_pattern_id: string | null;
}

export interface FollowUpRow {
  endpoint: string;
  created_at: string;
}

const rate = (n: number, d: number): number | null => (d > 0 ? n / d : null);

/**
 * A fix is repeated when a row for the same endpoint with outcome
 * pending/failed/escalated is created within FOLLOW_UP_DAYS after it.
 * Grouped by the fixed row's failure_class.
 */
export function computeRepeatFailure(
  fixes: FixRow[],
  followUps: FollowUpRow[],
  truncated = false,
  followUpDays = FOLLOW_UP_DAYS
): LearnMetrics['repeat_failure'] {
  const byEndpoint = new Map<string, number[]>();
  for (const f of followUps) {
    const t = Date.parse(f.created_at);
    if (Number.isNaN(t)) continue;
    byEndpoint.set(f.endpoint, [...(byEndpoint.get(f.endpoint) || []), t]);
  }
  const classes = new Map<string, { fixes: number; repeated: number }>();
  let repeatedTotal = 0;
  for (const fix of fixes) {
    const t = Date.parse(fix.created_at);
    const repeated = (byEndpoint.get(fix.endpoint) || []).some((x) => x > t && x <= t + followUpDays * DAY_MS);
    const key = fix.failure_class || 'unknown';
    const c = classes.get(key) || { fixes: 0, repeated: 0 };
    c.fixes += 1;
    if (repeated) {
      c.repeated += 1;
      repeatedTotal += 1;
    }
    classes.set(key, c);
  }
  const by_class: RepeatFailureClass[] = [...classes.entries()]
    .map(([failure_class, c]) => ({ failure_class, fixes: c.fixes, repeated: c.repeated, rate: rate(c.repeated, c.fixes) }))
    .sort((a, b) => b.fixes - a.fixes || a.failure_class.localeCompare(b.failure_class));
  return {
    fixes: fixes.length,
    repeated: repeatedTotal,
    rate: rate(repeatedTotal, fixes.length),
    follow_up_days: followUpDays,
    by_class,
    truncated,
  };
}

/** Rows without tests_added (written before P1) are unknown, never counted as missing. */
export function computeEscapedBugsToTests(fixes: FixRow[]): LearnMetrics['escaped_bugs_to_tests'] {
  let with_tests = 0;
  let without_tests = 0;
  let unknown = 0;
  for (const f of fixes) {
    if (!Array.isArray(f.tests_added)) unknown += 1;
    else if (f.tests_added.length > 0) with_tests += 1;
    else without_tests += 1;
  }
  return { with_tests, without_tests, unknown, share: rate(with_tests, with_tests + without_tests) };
}

/** No number is invented: until an execution records a repair_patterns reference, this is not_measured. */
export function computePatternReuse(fixes: FixRow[]): LearnMetrics['pattern_reuse'] {
  const reused = fixes.filter((f) => typeof f.repair_pattern_id === 'string' && f.repair_pattern_id.length > 0).length;
  if (reused === 0) {
    return {
      state: 'not_measured',
      reason:
        'no fix records a repair_patterns reference (diagnosis.repair_pattern_id); the executor does not look patterns up yet — auto-record and reuse are PR-L5.1',
    };
  }
  return { state: 'measured', fixes: fixes.length, reused, share: rate(reused, fixes.length) };
}

export function computeLearnMetrics(fixes: FixRow[], followUps: FollowUpRow[], truncated = false): LearnMetrics {
  return {
    window_days: WINDOW_DAYS,
    repeat_failure: computeRepeatFailure(fixes, followUps, truncated),
    pattern_reuse: computePatternReuse(fixes),
    escaped_bugs_to_tests: computeEscapedBugsToTests(fixes),
  };
}

// =============================================================================
// P2 — graduation proposals (pure)
// =============================================================================

export interface OutcomeRow {
  scanner_name: string;
  risk_class: string | null;
  exec_outcome: string;
  human_modified_plan: boolean | null;
}

export interface ClassStats {
  class_key: string;
  scanner_name: string;
  risk_class: string | null;
  executions: number;
  successes: number;
  success_rate: number | null;
  rolled_back: number;
  human_modified: number;
}

export const classKey = (scanner: string, risk: string | null): string => `${scanner}|${risk ?? 'unknown'}`;

/** Groups executed outcomes (exec_outcome set) by (scanner_name, risk_class). */
export function graduationStats(rows: OutcomeRow[]): ClassStats[] {
  const m = new Map<string, ClassStats>();
  for (const r of rows) {
    if (!r.exec_outcome) continue;
    const key = classKey(r.scanner_name, r.risk_class);
    const s = m.get(key) || {
      class_key: key,
      scanner_name: r.scanner_name,
      risk_class: r.risk_class ?? null,
      executions: 0,
      successes: 0,
      success_rate: null,
      rolled_back: 0,
      human_modified: 0,
    };
    s.executions += 1;
    if (r.exec_outcome === 'success') s.successes += 1;
    if (r.exec_outcome === 'rolled_back') s.rolled_back += 1;
    if (r.human_modified_plan === true) s.human_modified += 1;
    s.success_rate = rate(s.successes, s.executions);
    m.set(key, s);
  }
  return [...m.values()].sort((a, b) => a.class_key.localeCompare(b.class_key));
}

/** Eligibility is checked separately (autopilot_recommendations); a class with no named scanner is never proposed. */
export function isGraduationCandidate(s: ClassStats): boolean {
  return (
    s.scanner_name !== 'unknown' &&
    s.executions >= GRADUATION_MIN_EXECUTIONS &&
    s.success_rate != null &&
    s.success_rate >= GRADUATION_MIN_SUCCESS_RATE &&
    s.rolled_back === 0 &&
    s.human_modified === 0
  );
}

/** Withdraw an open proposal when its class drops below 90 % or gets a rollback; no executions = no evidence. */
export function shouldWithdraw(s: ClassStats | undefined): boolean {
  if (!s || s.executions === 0) return false;
  return (s.success_rate != null && s.success_rate < GRADUATION_WITHDRAW_BELOW) || s.rolled_back > 0;
}

export interface GraduationEvent {
  id?: string;
  topic: string;
  created_at: string;
  message?: string | null;
  metadata: Record<string, unknown> | null;
}

/** Open = the latest proposed/withdrawn event of a class is a proposal. */
export function openGraduationProposals(events: GraduationEvent[]): GraduationEvent[] {
  const latest = new Map<string, GraduationEvent>();
  for (const e of events) {
    const key = e.metadata && typeof e.metadata.class_key === 'string' ? (e.metadata.class_key as string) : null;
    if (!key || (e.topic !== PROPOSED_TOPIC && e.topic !== WITHDRAWN_TOPIC)) continue;
    const prev = latest.get(key);
    if (!prev || Date.parse(e.created_at) > Date.parse(prev.created_at)) latest.set(key, e);
  }
  return [...latest.values()]
    .filter((e) => e.topic === PROPOSED_TOPIC)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

export function graduationRule(s: Pick<ClassStats, 'scanner_name' | 'risk_class'>): string {
  return (
    `autopilot_recommendations.auto_exec_eligible for scanner ${s.scanner_name}, risk ${s.risk_class ?? 'unknown'}: ` +
    'false → true — a human decision on the existing Dev Autopilot config surfaces, never applied by code'
  );
}

// =============================================================================
// Dependencies and the run
// =============================================================================

export interface LearnEvent {
  type: string;
  status: 'info';
  message: string;
  payload: Record<string, unknown>;
}

export interface LearnDeps {
  /** Supabase REST GET (path from /rest/v1/…); throws on a failed read. */
  get: <T>(path: string) => Promise<T>;
  /** PATCH self_healing_log.diagnosis with the WHOLE object. */
  patchDiagnosis: (id: string, diagnosis: Record<string, unknown>) => Promise<void>;
  githubConfigured: () => boolean;
  /** The PR's changed files; throws on a GitHub error. */
  prFiles: (repo: string, number: number) => Promise<Array<{ filename: string; status?: string }>>;
  insertWriteTestFinding: (input: MissingTestRecommendationInput) => Promise<{ ok: boolean; error?: string }>;
  newId: () => string;
  emit: (event: LearnEvent) => Promise<void>;
}

async function getPaged<T>(deps: LearnDeps, path: string): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    if (offset >= MAX_ROWS) return { rows, truncated: true };
    const page = await deps.get<T[]>(`${path}&limit=${PAGE}&offset=${offset}`);
    rows.push(...(page || []));
    if (!page || page.length < PAGE) return { rows, truncated: false };
  }
}

interface PendingFixRow {
  id: string;
  vtid: string;
  endpoint: string;
  diagnosis: Record<string, unknown> | null;
}

/** P1. Never writes "no tests" for a PR it could not read. */
export async function recordTestsAdded(deps: LearnDeps): Promise<Record<string, unknown>> {
  if (!deps.githubConfigured()) return { state: 'skipped', reason: 'github_token_missing' };
  const rows =
    (await deps.get<PendingFixRow[]>(
      '/rest/v1/self_healing_log?outcome=eq.fixed&diagnosis->>pr_url=not.is.null&diagnosis->tests_added=is.null' +
        `&select=id,vtid,endpoint,diagnosis&order=created_at.desc&limit=${MAX_PRS_PER_RUN}`
    )) || [];
  const c = {
    checked: 0,
    with_tests: 0,
    without_tests: 0,
    findings_created: 0,
    findings_deduped: 0,
    github_errors: 0,
    write_errors: 0,
    unparsable_pr_url: 0,
  };
  for (const row of rows.slice(0, MAX_PRS_PER_RUN)) {
    const diagnosis = row.diagnosis || {};
    const prUrl = String(diagnosis.pr_url || '');
    const pr = parsePrUrl(prUrl);
    if (!pr) {
      c.unparsable_pr_url += 1;
      continue;
    }
    c.checked += 1;
    let files: Array<{ filename: string; status?: string }>;
    try {
      files = await deps.prFiles(pr.repo, pr.number);
    } catch {
      c.github_errors += 1;
      continue; // row untouched — retried next run
    }
    const tests = testsAddedFrom(files);
    if (tests.length === 0) {
      const key = escapedBugDedupeKey(row.vtid, row.endpoint);
      const existing =
        (await deps.get<Array<{ id: string }>>(
          `/rest/v1/autopilot_recommendations?spec_snapshot->>dedupe_key=eq.${encodeURIComponent(key)}&select=id&limit=1`
        )) || [];
      if (existing.length > 0) {
        c.findings_deduped += 1;
      } else {
        const r = await deps.insertWriteTestFinding(escapedBugFinding(deps.newId(), row, prUrl));
        if (!r.ok) {
          c.write_errors += 1;
          continue; // no lesson filed → leave the row for the next run
        }
        c.findings_created += 1;
      }
    }
    try {
      // Read-modify-write: the whole diagnosis goes back, tests_added merged in.
      await deps.patchDiagnosis(row.id, { ...diagnosis, tests_added: tests });
    } catch {
      c.write_errors += 1;
      continue;
    }
    if (tests.length) c.with_tests += 1;
    else c.without_tests += 1;
  }
  return { state: 'ran', ...c, capped: rows.length >= MAX_PRS_PER_RUN };
}

/** P2. Mondays (UTC) only. Emits events; changes no flag. */
export async function graduationStep(deps: LearnDeps, now: Date): Promise<Record<string, unknown>> {
  if (now.getUTCDay() !== 1) return { state: 'skipped', reason: 'graduation runs on Mondays (UTC)' };
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString();
  const { rows, truncated } = await getPaged<OutcomeRow>(
    deps,
    `/rest/v1/dev_autopilot_outcomes?exec_outcome=not.is.null&created_at=gte.${encodeURIComponent(since)}` +
      '&select=scanner_name,risk_class,exec_outcome,human_modified_plan&order=created_at.asc,id.asc'
  );
  const stats = graduationStats(rows);
  const byKey = new Map(stats.map((s) => [s.class_key, s]));
  const events =
    (await deps.get<GraduationEvent[]>(
      `/rest/v1/oasis_events?topic=in.(${PROPOSED_TOPIC},${WITHDRAWN_TOPIC})` +
        '&select=id,topic,created_at,message,metadata&order=created_at.desc&limit=1000'
    )) || [];
  const open = openGraduationProposals(events);
  const openKeys = new Set(open.map((e) => String((e.metadata || {}).class_key)));

  const withdrawn: string[] = [];
  for (const e of open) {
    const key = String((e.metadata || {}).class_key);
    const s = byKey.get(key);
    if (!shouldWithdraw(s)) continue;
    await deps.emit({
      type: WITHDRAWN_TOPIC,
      status: 'info',
      message: `Graduation proposal withdrawn for ${key}: success ${Math.round((s!.success_rate ?? 0) * 1000) / 10}%, ${s!.rolled_back} rolled back in ${WINDOW_DAYS} days`,
      payload: { ...s!, window_days: WINDOW_DAYS, proposal_event_id: e.id ?? null, withdraw_below: GRADUATION_WITHDRAW_BELOW },
    });
    withdrawn.push(key);
    openKeys.delete(key);
  }

  const proposed: string[] = [];
  const already_eligible: string[] = [];
  for (const s of stats) {
    if (openKeys.has(s.class_key) || !isGraduationCandidate(s)) continue;
    const risk = s.risk_class == null ? 'risk_class=is.null' : `risk_class=eq.${encodeURIComponent(s.risk_class)}`;
    const recs =
      (await deps.get<Array<Record<string, unknown>>>(
        `/rest/v1/autopilot_recommendations?spec_snapshot->>scanner=eq.${encodeURIComponent(s.scanner_name)}&${risk}` +
          '&select=auto_exec_eligible&order=created_at.desc&limit=50'
      )) || [];
    // Read only: a class whose recent findings are all already eligible has nothing to graduate.
    if (recs.length > 0 && recs.every((r) => r['auto_exec_eligible'] === true)) {
      already_eligible.push(s.class_key);
      continue;
    }
    await deps.emit({
      type: PROPOSED_TOPIC,
      status: 'info',
      message: `Graduation proposed for ${s.class_key}: ${s.successes}/${s.executions} executions succeeded in ${WINDOW_DAYS} days, none rolled back, no plan edited by a human`,
      payload: { ...s, window_days: WINDOW_DAYS, rule: graduationRule(s) },
    });
    proposed.push(s.class_key);
  }
  return {
    state: 'ran',
    window_days: WINDOW_DAYS,
    executions: rows.length,
    truncated,
    classes: stats.length,
    open_before: open.length,
    proposed,
    withdrawn,
    already_eligible,
  };
}

/** P3 reads + the whole run. A failed Supabase read throws (the run is a failure, never green). */
export async function runLearnOutcomes(deps: LearnDeps = productionLearnDeps(), now: Date = new Date()): Promise<RoutineVerdict> {
  const tests_added = await recordTestsAdded(deps);
  const since = encodeURIComponent(new Date(now.getTime() - WINDOW_DAYS * DAY_MS).toISOString());
  const fixes = await getPaged<FixRow>(
    deps,
    `/rest/v1/self_healing_log?outcome=eq.fixed&created_at=gte.${since}` +
      '&select=id,endpoint,failure_class,created_at,tests_added:diagnosis->tests_added,repair_pattern_id:diagnosis->>repair_pattern_id' +
      '&order=created_at.asc,id.asc'
  );
  const followUps = await getPaged<FollowUpRow>(
    deps,
    `/rest/v1/self_healing_log?outcome=in.(pending,failed,escalated)&created_at=gte.${since}` +
      '&select=endpoint,created_at&order=created_at.asc,id.asc'
  );
  const metrics = computeLearnMetrics(fixes.rows, followUps.rows, fixes.truncated || followUps.truncated);
  const graduation = await graduationStep(deps, now);
  return checkLearnOutcomes(metrics, { tests_added, graduation });
}

// =============================================================================
// Production dependencies
// =============================================================================

function supa(): { url: string; key: string } {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE not set');
  return { url, key };
}

const githubToken = (): string => process.env.GITHUB_SAFE_MERGE_TOKEN || process.env.GITHUB_TOKEN || '';

export function productionLearnDeps(): LearnDeps {
  return {
    get: async <T>(path: string): Promise<T> => {
      const s = supa();
      const res = await fetch(`${s.url}${path}`, { headers: { apikey: s.key, Authorization: `Bearer ${s.key}` } });
      if (!res.ok) throw new Error(`GET ${path.split('?')[0]} → ${res.status} ${(await res.text()).slice(0, 300)}`);
      return (await res.json()) as T;
    },
    patchDiagnosis: async (id, diagnosis) => {
      const s = supa();
      const res = await fetch(`${s.url}/rest/v1/self_healing_log?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { apikey: s.key, Authorization: `Bearer ${s.key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ diagnosis }),
      });
      if (!res.ok) throw new Error(`PATCH self_healing_log → ${res.status} ${(await res.text()).slice(0, 300)}`);
    },
    githubConfigured: () => githubToken().length > 0,
    prFiles: async (repo, number) => {
      const files: Array<{ filename: string; status?: string }> = [];
      // GitHub lists at most 3,000 files per PR; three pages of 100 cover every fix PR in practice.
      for (let page = 1; page <= 3; page++) {
        const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            Authorization: `Bearer ${githubToken()}`,
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'vitana-learn-outcomes',
          },
        });
        if (!res.ok) throw new Error(`GitHub PR files ${repo}#${number} → ${res.status}`);
        const batch = (await res.json()) as Array<{ filename: string; status?: string }>;
        files.push(...batch);
        if (batch.length < 100) break;
      }
      return files;
    },
    insertWriteTestFinding: async (input) => {
      const { insertMissingTestRecommendation } = require('../../routes/test-contracts-missing');
      const res = await insertMissingTestRecommendation(input);
      return res.ok ? { ok: true } : { ok: false, error: `${res.status} ${(await res.text()).slice(0, 300)}` };
    },
    newId: () => require('crypto').randomUUID(),
    emit: async (event) => {
      const { emitOasisEvent } = require('../oasis-event-service');
      await emitOasisEvent({ vtid: LEARN_VTID, source: LEARN_SOURCE, ...event });
    },
  };
}
