/**
 * VTID-04394 (Orchestrator v2, P4): progress ledger + stall detection for the
 * agent loop (docs/ORCHESTRATOR-REDESIGN-PLAN.md §3.3 "Progress ledger /
 * stall detection", §5 P4 exit "a looping run stops with a `stalled` reason").
 *
 * Each turn is recorded as progress or not:
 *   - progress   — a successful edit (write/edit/delete), a passing check, or
 *                  a tool call never made before in this run (new information);
 *   - no progress — every call repeats an earlier call exactly (same tool,
 *                  same arguments) or failed.
 * After `replanAfter` consecutive non-progress turns the loop gets ONE
 * re-plan prompt; if non-progress continues to `stopAfter`, the run ends with
 * `stalled: true`. This generalises the per-check guard (VTID-04016/04163)
 * and the turn-cap breaker (VTID-04243) from "this check keeps failing" and
 * "the budget ran out" to "the run is going in circles".
 *
 * Deliberately conservative: reading a new file or a new line range counts
 * as progress, so exploration never stalls — only exact repetition does.
 */

export interface StallOptions {
  replanAfter: number;
  stopAfter: number;
}

export const DEFAULT_STALL: Readonly<StallOptions> = Object.freeze({ replanAfter: 6, stopAfter: 10 });

export const REPLAN_PROMPT = [
  'Your last turns repeated earlier tool calls without making progress.',
  'Stop repeating them. State in one line what is blocking you, then either take a different concrete step',
  '(read a different file, change the code, run a different check) or call finish with what you have and say what is unresolved.',
].join(' ');

export interface TurnCall { name: string; args: Record<string, unknown>; isError?: boolean; passedCheck?: boolean }

export type ProgressVerdict = 'progress' | 'no_progress' | 'replan' | 'stalled';

const MUTATING: ReadonlySet<string> = new Set(['write_file', 'edit_file', 'delete_file']);

function stableArgs(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableArgs).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Record<string, unknown>).sort().map((k) => `${k}:${stableArgs((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

export function callSignature(name: string, args: Record<string, unknown> | undefined): string {
  return `${name}(${stableArgs(args ?? {})})`;
}

export class ProgressLedger {
  private readonly seen = new Set<string>();
  private idle = 0;
  private replanned = false;
  readonly rounds: Array<{ turn: number; progress: boolean; new_calls: number; repeated_calls: number }> = [];

  constructor(private readonly opts: StallOptions = DEFAULT_STALL) {}

  get idleTurns(): number { return this.idle; }
  get hasReplanned(): boolean { return this.replanned; }

  /** Record one turn's tool calls and say what the loop should do next. */
  record(turn: number, calls: TurnCall[]): ProgressVerdict {
    let fresh = 0;
    let repeated = 0;
    let progress = false;
    for (const c of calls) {
      const sig = callSignature(c.name, c.args);
      const isNew = !this.seen.has(sig);
      this.seen.add(sig);
      if (isNew) fresh++; else repeated++;
      if (!c.isError && (MUTATING.has(c.name) || c.passedCheck || isNew)) progress = true;
    }
    this.rounds.push({ turn, progress, new_calls: fresh, repeated_calls: repeated });
    if (this.rounds.length > 500) this.rounds.shift();
    if (progress) {
      this.idle = 0;
      return 'progress';
    }
    this.idle++;
    if (this.idle >= this.opts.stopAfter) return 'stalled';
    if (this.idle >= this.opts.replanAfter && !this.replanned) {
      this.replanned = true;
      return 'replan';
    }
    return 'no_progress';
  }
}
