/**
 * VTID-04466: exploration budget + starting map for the agent executor.
 *
 * Measured live (2026-09-10 → 09-24): 68 agent runs died on the turn cap and
 * 49 of them never edited a single file. Together they made 3,636
 * `search_text` and 2,853 `read_file` calls (~95 navigation calls per run)
 * while the codebase index — loaded on every run since VTID-04229 — was
 * queried 11 times. The agent was searching blind until the budget ran out.
 *
 * Two changes:
 *   1. Starting map. Before turn 1 the runner queries the index with the
 *      task text and puts the result in the task prompt, so the first turn
 *      starts from the likely files, their callers and their tests.
 *   2. Exploration budget. A run that has not edited anything gets, once
 *      each: a "commit" nudge at 35% of its turns, a hand-off instruction at
 *      80% (finish with findings, no more exploration), and a stop at 90%.
 *      The thresholds are deliberately late: in the same window six of ~40
 *      successful runs made their FIRST edit between turns 64 and 91, so a
 *      stop at 50% would have killed real work. The stop only reclaims the
 *      last 10% of a run that has shown no sign of converging, and turns a
 *      silent turn-cap death into a named, breaker-visible reason.
 */

import { indexQuery, type CodeIndexBundle } from '../codeintel-index';

export type ExplorationVerdict = 'continue' | 'commit' | 'handoff' | 'stop';

export interface ExplorationThresholds {
  commitAt: number;
  handoffAt: number;
  stopAt: number;
}

/** Thresholds for a loop of `maxTurns`; null when the loop is too short to need them. */
export function explorationThresholds(maxTurns: number): ExplorationThresholds | null {
  if (!Number.isFinite(maxTurns) || maxTurns < 30) return null;
  const commitAt = Math.max(10, Math.round(maxTurns * 0.35));
  const handoffAt = Math.max(commitAt + 5, Math.round(maxTurns * 0.8));
  const stopAt = Math.min(maxTurns - 1, Math.max(handoffAt + 3, Math.round(maxTurns * 0.9)));
  return { commitAt, handoffAt, stopAt };
}

export class ExplorationBudget {
  private committed = false;
  private handedOff = false;

  constructor(private readonly t: ExplorationThresholds) {}

  /**
   * Called after each turn's tools ran; `hasEdited` is sticky for the run.
   * A 'commit'/'handoff' verdict repeats until `delivered()` is called for
   * it, so a turn where another prompt wins (the stall re-plan) does not
   * swallow it.
   */
  record(turn: number, hasEdited: boolean): ExplorationVerdict {
    if (hasEdited) return 'continue';
    if (turn >= this.t.stopAt) return 'stop';
    if (turn >= this.t.handoffAt && !this.handedOff) return 'handoff';
    if (turn >= this.t.commitAt && !this.committed && !this.handedOff) return 'commit';
    return 'continue';
  }

  /** The loop sent the prompt for this verdict. */
  delivered(v: ExplorationVerdict): void {
    if (v === 'handoff') { this.handedOff = true; this.committed = true; }
    if (v === 'commit') this.committed = true;
  }
}

export function buildCommitPrompt(turn: number, maxTurns: number): string {
  return [
    `You have used ${turn} of ${maxTurns} turns and have not changed any file yet.`,
    'Stop reading files one at a time. If you know where the change goes, make it now with edit_file or write_file,',
    'then run the checks. If you do not know yet, ask the code index once (dev_index_query with the symbol or behaviour,',
    'or dev_graph_path between two names) and then edit. Reading more files without a plan will not finish this task.',
  ].join(' ');
}

export function buildHandoffPrompt(turn: number, maxTurns: number): string {
  return [
    `You have used ${turn} of ${maxTurns} turns without changing any file. Do not explore further.`,
    'Either make the smallest correct edit now and verify it, or call finish(summary, pr_title, pr_body) with NO edits,',
    'where summary says what you found: the files and functions involved, what the change should be, and what blocked you.',
    'A finish without edits opens no PR; its summary is handed to the operator.',
  ].join(' ');
}

export function explorationStopError(turn: number): string {
  return `agent explored ${turn} turns without editing any file (exploration budget)`;
}

const STARTING_MAP_BUDGET_CHARS = 3500;
const STARTING_MAP_QUERY_CHARS = 400;

/** First meaningful lines of the task, stripped of markdown noise, for the index query. */
export function startingMapQuery(taskText: string, filesReferenced: string[] = []): string {
  const text = (taskText || '')
    .split('\n')
    .map((l) => l.replace(/^[#>*\-\s`]+/, '').trim())
    .filter((l) => l.length > 0 && !/^(vtid|files?|acceptance|scope)\b[:\s]/i.test(l))
    .join(' ')
    .slice(0, STARTING_MAP_QUERY_CHARS);
  const files = filesReferenced.slice(0, 4).join(' ');
  return `${files} ${text}`.trim();
}

/**
 * The index answer for the task, as a prompt section. Empty string when there
 * is no index or nothing matched — the prompt then reads exactly as before.
 */
export function buildStartingMap(bundle: CodeIndexBundle | null | undefined, taskText: string, filesReferenced: string[] = []): string {
  if (!bundle) return '';
  const q = startingMapQuery(taskText, filesReferenced);
  if (!q) return '';
  let r;
  try {
    r = indexQuery(bundle, q, { budgetChars: STARTING_MAP_BUDGET_CHARS, maxSeeds: 6 });
  } catch {
    return '';
  }
  if (!r.ok || r.seeds.length === 0) return '';
  return [
    '## Starting map (from the codebase index, before your first turn)',
    'These are the most likely places for this task, with what they call and what calls them.',
    'Start from them; use dev_index_query / dev_graph_path for anything else instead of searching file by file.',
    '',
    r.text,
  ].join('\n');
}
