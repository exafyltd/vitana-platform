/**
 * VTID-04006: post-hoc scope enforcement for the agent executor.
 *
 * The single-shot executor could only ever touch the files it was handed,
 * so scope was enforced BEFORE the LLM call on `files_referenced`. The agent
 * can read anything and edit anything inside the clone — so the same
 * allow/deny globs from `dev_autopilot_config` are enforced AFTER the work,
 * on `git status`, before anything is committed. Deny wins over allow, as in
 * evaluateSafetyGate().
 */

import { matchGlob } from '../dev-autopilot-safety';
import type { ChangedFile } from './agent-workspace';

export interface ScopeCheck {
  ok: boolean;
  outside_allow: string[];
  in_deny: string[];
  /** Human-readable reason, empty when ok. */
  reason: string;
}

function matchesAny(p: string, globs: string[]): boolean {
  return globs.some((g) => matchGlob(p, g));
}

export function checkChangedFilesScope(
  changed: ChangedFile[],
  allow: string[],
  deny: string[],
  /** Paths the runner itself writes (evidence pack) — always permitted. */
  runnerOwned: string[] = [],
): ScopeCheck {
  const outside_allow: string[] = [];
  const in_deny: string[] = [];
  for (const f of changed) {
    if (runnerOwned.some((g) => matchGlob(f.path, g))) continue;
    if (matchesAny(f.path, deny)) in_deny.push(f.path);
    else if (!matchesAny(f.path, allow)) outside_allow.push(f.path);
  }
  const parts: string[] = [];
  if (in_deny.length) parts.push(`file_in_deny_scope: ${in_deny.join(', ')}`);
  if (outside_allow.length) parts.push(`file_outside_allow_scope: ${outside_allow.join(', ')}`);
  return { ok: parts.length === 0, outside_allow, in_deny, reason: parts.join('; ') };
}

/** Test-coverage rule, same shape as the safety gate's `tests_missing`. */
export function hasTestCoverage(changed: ChangedFile[], isTestFile: (p: string) => boolean): boolean {
  const edits = changed.filter((f) => f.action !== 'delete');
  if (edits.length === 0) return true;
  return edits.some((f) => isTestFile(f.path));
}
