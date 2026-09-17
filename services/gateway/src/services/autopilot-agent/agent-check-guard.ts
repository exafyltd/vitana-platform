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
 */

import type { CheckKind } from './agent-tools';

/** Failed attempts of one key allowed since the last edit before refusing. */
export const MAX_FAILED_ATTEMPTS_WITHOUT_EDIT = 2;
const UNGUARDED: ReadonlySet<CheckKind> = new Set<CheckKind>(['git_diff', 'git_status']);

export function checkGuardKey(kind: CheckKind, target?: string): string {
  return `${kind} ${(target || '').trim()}`.trim();
}

export class RepeatedCheckGuard {
  private failed = new Map<string, number>();
  private refusals = 0;

  /** Call on every file mutation — the tree changed, so every check may change. */
  markEdited(): void {
    this.failed.clear();
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

  /** How many runs this guard prevented — reported in the PR's evidence pack. */
  refusedCount(): number {
    return this.refusals;
  }
}
