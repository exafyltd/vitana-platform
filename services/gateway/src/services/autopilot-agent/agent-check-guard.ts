/**
 * VTID-04016: repeated-identical-check guard for the agent's `run_check`.
 *
 * Observed on Test Run #4b (VTID-04012, execution 4f7d5ea4): the model
 * re-ran `run_check tsc` nine times — every run failing with the same
 * output, no file edited in between — spending ~18 of its 22 minutes on
 * checks whose result it already had. A failing check only changes its
 * outcome when the tree changes, so re-running one with no edit in between
 * is pure cost.
 *
 * Rule: a `(kind, target)` check that has already FAILED since the last
 * file mutation (write_file / edit_file / delete_file) may be attempted
 * once more (a genuine flake — a killed process, a timeout — gets one
 * honest retry); the attempt after that is refused before anything runs,
 * with a tool error telling the model to edit first. Any mutation resets
 * the guard for every key. Passing checks are never counted; `git_diff` /
 * `git_status` are inspections, not checks, and are never guarded.
 *
 * VTID-04163: the same class of waste exists on the READ side. Batch
 * VTIDs 04149-04162 (12 of 14 one-line CSS/JS/a11y tasks) all hit the
 * 120-turn cap without ever calling `finish` — `oasis_events` shows the
 * model re-issuing the exact same `read_file`/`search_text` call on the
 * same path/pattern several times (e.g. VTID-04149 read
 * `styles.css` at turns 2, 10, 12, 16 and 17, byte-identical args every
 * time) instead of acting on the content it already retrieved. A pure
 * navigation call with no edit in between is deterministic — an identical
 * `(tool, args)` pair can only return an identical result — so a second
 * exact repeat is pure cost, exactly like the run_check case above.
 */

import type { CheckKind } from './agent-tools';

/** Failed attempts of one key allowed since the last edit before refusing. */
export const MAX_FAILED_ATTEMPTS_WITHOUT_EDIT = 2;
const UNGUARDED: ReadonlySet<CheckKind> = new Set<CheckKind>(['git_diff', 'git_status']);

/** VTID-04163: identical navigation calls allowed since the last edit
 *  before refusing the next exact repeat. */
export const MAX_NAV_REPEATS_WITHOUT_EDIT = 1;
const GUARDED_NAV_TOOLS: ReadonlySet<string> = new Set(['read_file', 'search_text', 'list_dir', 'find_files']);

export function checkGuardKey(kind: CheckKind, target?: string): string {
  return `${kind} ${(target || '').trim()}`.trim();
}

/** Stable key for a navigation call: tool name + its arguments, sorted so
 *  key order in the model's own JSON can't defeat the dedupe. */
export function navGuardKey(tool: string, args: Record<string, unknown> | undefined): string {
  const entries = Object.entries(args || {}).sort(([a], [b]) => a.localeCompare(b));
  return `${tool} ${JSON.stringify(entries)}`;
}

export class RepeatedCheckGuard {
  private failed = new Map<string, number>();
  private navSeen = new Map<string, number>();
  private refusals = 0;
  private navRefusals = 0;

  /** Call on every file mutation — the tree changed, so every check (and
   *  every navigation result) may change. */
  markEdited(): void {
    this.failed.clear();
    this.navSeen.clear();
  }

  /** Call BEFORE running a check. A string means "refuse with this message". */
  shouldRefuse(kind: CheckKind, target?: string): string | null {
    if (UNGUARDED.has(kind)) return null;
    const key = checkGuardKey(kind, target);
    const n = this.failed.get(key) || 0;
    if (n < MAX_FAILED_ATTEMPTS_WITHOUT_EDIT) return null;
    this.refusals += 1;
    return [
      `run_check ${key} refused: it has already failed ${n} time(s) since your last file edit and nothing in the tree has changed, so the result would be identical.`,
      `Fix the reported error with edit_file/write_file first, then re-run the check. (VTID-04016 repeated-check guard)`,
    ].join(' ');
  }

  /** Call AFTER a check ran. Only failures count. */
  record(kind: CheckKind, target: string | undefined, ok: boolean): void {
    if (UNGUARDED.has(kind) || ok) return;
    const key = checkGuardKey(kind, target);
    this.failed.set(key, (this.failed.get(key) || 0) + 1);
  }

  /** Call BEFORE a navigation tool (read_file/search_text/list_dir/find_files)
   *  runs. A string means "refuse with this message"; on success the call is
   *  recorded immediately (unlike checks, a nav result needs no separate
   *  pass/fail — same args + no edit ⇒ same output, so seeing it once is
   *  enough to know a repeat is wasted). */
  shouldRefuseNav(tool: string, args: Record<string, unknown> | undefined): string | null {
    if (!GUARDED_NAV_TOOLS.has(tool)) return null;
    const key = navGuardKey(tool, args);
    const n = this.navSeen.get(key) || 0;
    if (n >= MAX_NAV_REPEATS_WITHOUT_EDIT) {
      this.navRefusals += 1;
      return [
        `${tool} refused: you already called it with these exact arguments since your last edit, so the result would be identical to what you already have.`,
        `Act on the content you already retrieved, or change the arguments (a different path/pattern/range) to get new information. (VTID-04163 repeated-navigation guard)`,
      ].join(' ');
    }
    this.navSeen.set(key, n + 1);
    return null;
  }

  /** How many runs this guard prevented — reported in the PR's evidence pack. */
  refusedCount(): number {
    return this.refusals;
  }

  /** How many navigation repeats this guard prevented. */
  navRefusedCount(): number {
    return this.navRefusals;
  }
}
