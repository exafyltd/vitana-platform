/**
 * VTID-04807: Jev P2 gate A5 — which existing test suites should run for a
 * Dev Autopilot diff? (docs/JEV-INTEGRATION-PLAN.md §10.4 A5)
 *
 *   test_selection   (JEV_TEST_SELECTION_MODE = off | shadow | enforce)
 *
 * Before opening a PR the agent runner re-runs tsc and the jest suites paired
 * to the changed files by name (`<stem>.test.ts`) plus the suites that read a
 * changed frontend asset (VTID-04617). A suite that IMPORTS a changed module
 * under another name is never run there, so CI is the first to run it —
 * "Gateway Service Tests" / "Gateway (Jest)" failed 8 of the ~42 Dev Autopilot
 * CI failures in the 30 days to 2026-10-01.
 *
 * After the runner's own checks pass, the suites that import a changed module
 * (and are not already run) are listed from the clone — synchronously, before
 * the workspace can be cleaned up. Each (max 8) goes to Jev
 * `test_suite_relevance` with the suite's path, the changed modules it imports
 * and its describe/test titles. One `jev_shadow_decisions` row per execution.
 * When CI reports, the row records whether a failing suite was one Jev would
 * have run (agreed), one it would have skipped (disagreed) or neither (null).
 * No enforce behaviour: running Jev's picks in the runner comes after the data.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import * as repo from '../jev-repository';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome } from '../jev-shadow';
import type { CiCheckEvidence } from './ci-failure-gate';

export const TEST_SELECTION_GATE = 'test_selection';
export const MAX_CANDIDATES = 8;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-executor', system: true } as const;
const OUTCOME_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000;
const SOURCE_RE = /\.[cm]?[jt]sx?$/;
const TEST_RE = /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[cm]?[jt]sx?$/;

export interface SuiteCandidate {
  path: string;
  imports_changed: string[];
  test_titles: string[];
}

export interface TestSelectionInput {
  changed_files: string[];
  candidates: SuiteCandidate[];
  importers_total: number;
}

export function isTestSelectionOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return jevGateMode(TEST_SELECTION_GATE, env) !== 'off';
}

const stemOf = (p: string) => path.basename(p).replace(SOURCE_RE, '');
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** describe / test / it titles, in order, at most 30. */
export function extractTestTitles(src: string): string[] {
  const out: string[] = [];
  const re = /\b(?:describe|test|it)(?:\.each\([\s\S]*?\))?\(\s*(['"`])((?:(?!\1).){1,160})\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) && out.length < 30) out.push(m[2]);
  return out;
}

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listTestFiles(p)); }
    else if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * The suites under `<project>/test` that import a changed source module and
 * that the runner does not already run (not a changed test, not name-paired).
 * Synchronous: it must finish while the clone still exists.
 */
export function collectTestSelectionInput(repoDir: string, changed: string[]): TestSelectionInput | null {
  const changedTests = new Set(changed.filter((p) => TEST_RE.test(p)).map((p) => path.basename(p)));
  const byProject = new Map<string, string[]>();
  for (const rel of changed) {
    const m = /^(services\/[^/]+)\//.exec(rel);
    if (!m || !SOURCE_RE.test(rel) || TEST_RE.test(rel)) continue;
    const stems = byProject.get(m[1]) ?? [];
    const stem = stemOf(rel);
    if (stem && stem !== 'index' && !stems.includes(stem)) stems.push(stem);
    byProject.set(m[1], stems);
  }
  if (byProject.size === 0) return null;
  const candidates: SuiteCandidate[] = [];
  for (const [project, stems] of byProject) {
    const paired = new RegExp(`^(${stems.map(escapeRe).join('|')})\\.(test|spec)\\.`);
    const importRe = new RegExp(`(?:from\\s+|require\\(\\s*|import\\(\\s*)['"][^'"]*/(${stems.map(escapeRe).join('|')})(?:\\.[cm]?[jt]sx?)?['"]`, 'g');
    for (const file of listTestFiles(path.join(repoDir, project, 'test'))) {
      const base = path.basename(file);
      if (changedTests.has(base) || paired.test(base)) continue;
      let src: string;
      try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const hits = new Set<string>();
      let m: RegExpExecArray | null;
      importRe.lastIndex = 0;
      while ((m = importRe.exec(src))) hits.add(m[1]);
      if (hits.size) candidates.push({ path: path.relative(repoDir, file), imports_changed: [...hits], test_titles: extractTestTitles(src) });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.imports_changed.length - a.imports_changed.length || a.path.localeCompare(b.path));
  return { changed_files: changed.slice(0, 20), candidates: candidates.slice(0, MAX_CANDIDATES), importers_total: candidates.length };
}

/** Ask Jev about each candidate suite and write one row. Returns the row id or null; never throws. */
export async function runTestSelectionCheck(a: {
  executionId: string;
  title: string;
  input: TestSelectionInput;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}): Promise<string | null> {
  const env = a.env ?? process.env;
  const mode = jevGateMode(TEST_SELECTION_GATE, env);
  if (mode === 'off') return null;
  try {
    const judged: Array<{ path: string; run: boolean | null; probability: number | null }> = [];
    let cost = 0;
    let lastOutcome = 'fallback';
    let lastReason: string | undefined;
    for (const c of a.input.candidates) {
      const r = await decide(
        'test_suite_relevance',
        { change_title: a.title.slice(0, 300) || '(untitled)', changed_files: a.input.changed_files, test_path: c.path, imports_changed: c.imports_changed, test_titles: c.test_titles },
        SYSTEM_CALLER,
        { ...(a.decideOptions || {}), source: `gate:${TEST_SELECTION_GATE}`, env },
      );
      if (r.ok) { cost += r.cost_usd; lastOutcome = r.outcome === 'decided' || lastOutcome === 'decided' ? 'decided' : r.outcome; }
      else lastReason = r.reason;
      judged.push({
        path: c.path,
        run: r.ok && r.outcome === 'decided' ? r.verdict.value === true : null,
        probability: r.ok ? r.answers.run?.probability ?? null : null,
      });
    }
    return await recordJevShadowDecision(
      {
        gate: TEST_SELECTION_GATE,
        decision: 'test_suite_relevance',
        mode,
        plane: 'internal',
        tenant_id: null,
        subject_type: 'dev_autopilot_execution',
        subject_ref: a.executionId,
        jev_outcome: lastOutcome,
        jev_verdict: {
          candidates: judged,
          jev_selected: judged.filter((j) => j.run === true).map((j) => j.path),
          importers_total: a.input.importers_total,
          ...(lastReason && lastOutcome === 'fallback' ? { reason: lastReason } : {}),
        },
        jev_confidence: null,
        system_action: 'runner_paired_suites_only',
        cost_usd: cost,
      },
      a.sb,
    );
  } catch (err: any) {
    console.warn(`[jev] ${TEST_SELECTION_GATE} check failed for ${a.executionId}: ${err?.message || err}`);
    return null;
  }
}

/** Failing jest suites named in CI log excerpts (`FAIL test/x.test.ts`), by basename. */
export function failingSuites(evidence: CiCheckEvidence[]): string[] {
  const out = new Set<string>();
  for (const e of evidence) {
    if (e.unavailable || !e.excerpt) continue;
    const re = /\bFAIL\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(e.excerpt))) out.add(path.basename(m[1]));
  }
  return [...out];
}

/** What CI said, compared with Jev's picks. Never throws. */
export async function recordTestSelectionOutcome(
  executionId: string,
  ci: { passed: boolean; evidence?: CiCheckEvidence[] },
  opts: { sb?: SupabaseClient | null; now?: () => number } = {},
): Promise<void> {
  try {
    const sb = opts.sb === undefined ? getSupabase() : opts.sb;
    if (!sb) return;
    const since = new Date((opts.now ?? Date.now)() - OUTCOME_LOOKBACK_MS).toISOString();
    const { data, error } = await repo.fetchRecentShadowRow(sb, TEST_SELECTION_GATE, executionId, since);
    if (error || !data) return;
    const row = data as { id: string; jev_verdict?: { candidates?: Array<{ path: string; run: boolean | null }> } };
    if (ci.passed) { await recordJevShadowOutcome(row.id, 'ci_passed', null, sb); return; }
    const failing = failingSuites(ci.evidence || []);
    if (failing.length === 0) { await recordJevShadowOutcome(row.id, 'ci_failed_no_jest_suite', null, sb); return; }
    const cands = (row.jev_verdict?.candidates || []).filter((c) => failing.includes(path.basename(c.path)));
    if (cands.length === 0) { await recordJevShadowOutcome(row.id, 'ci_jest_failed:outside_candidates', null, sb); return; }
    if (cands.some((c) => c.run === true)) { await recordJevShadowOutcome(row.id, 'ci_jest_failed:jev_selected', true, sb); return; }
    const judged = cands.some((c) => c.run === false);
    await recordJevShadowOutcome(row.id, judged ? 'ci_jest_failed:jev_skipped' : 'ci_jest_failed:jev_undecided', judged ? false : null, sb);
  } catch (err: any) {
    console.warn(`[jev] ${TEST_SELECTION_GATE} outcome not recorded for ${executionId}: ${err?.message || err}`);
  }
}
