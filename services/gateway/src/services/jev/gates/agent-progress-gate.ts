/**
 * VTID-04764: Jev P1 gate A1 — is a Dev Autopilot coding run converging?
 * (docs/JEV-INTEGRATION-PLAN.md §10.4 A1)
 *
 *   agent_progress   (JEV_AGENT_PROGRESS_MODE = off | shadow | enforce)
 *   every JEV_AGENT_PROGRESS_EVERY turns (default 10, min 3)
 *
 * Evidence (14 days to 2026-09-30): the agent made 13,256 calls on 650M
 * input tokens ($151); 21 of 675 executions completed; 75 runs ran into the
 * turn cap (≈$100). The loop's own rules (progress ledger, exploration
 * budget) catch "no edit yet" and "same call again"; they do not catch a
 * run that edits but never converges — the one that burns to the cap.
 *
 * The gate sees every completed tool turn (agent-loop `onTurnSnapshot`),
 * keeps a short activity window, and on every Nth turn asks Jev
 * `agent_progress_check`: continue / commit / handoff / stop. It never
 * blocks or changes the loop — enforce is a later, separate change.
 * Each check is a `jev_shadow_decisions` row next to the loop's own action;
 * when the run ends, every row gets the outcome and `agreed`:
 *   continue/commit predicted  and the run opened its PR    → agreed
 *   handoff/stop predicted     and the run failed/capped    → agreed
 *   otherwise                                               → disagreed
 * An abstained or failed Jev answer is recorded with agreed = null.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabase } from '../../../lib/supabase';
import { decide, DecideOptions } from '../jev-decision-service';
import { jevGateMode, recordJevShadowDecision, recordJevShadowOutcome, JevGateMode } from '../jev-shadow';
import type { AgentTurnSnapshot } from '../../autopilot-agent/agent-loop';

export const AGENT_PROGRESS_GATE = 'agent_progress';
export const AGENT_PROGRESS_DEFAULT_EVERY = 10;
const ACTIVITY_WINDOW = 30;
const SYSTEM_CALLER = { actor_id: 'dev-autopilot-agent', system: true } as const;

export function agentProgressEvery(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number.parseInt(env.JEV_AGENT_PROGRESS_EVERY || '', 10);
  return Number.isFinite(n) && n >= 3 ? Math.min(n, 100) : AGENT_PROGRESS_DEFAULT_EVERY;
}

export type AgentRunOutcome = 'pr_opened' | 'fix_pushed' | 'awaiting_approval' | 'failed' | 'cancelled';

export interface AgentProgressGateOptions {
  executionId: string;
  findingId: string;
  /** Short task summary: the plan's title/first lines, never file contents. */
  task: string;
  env?: NodeJS.ProcessEnv;
  sb?: SupabaseClient | null;
  /** Test seam for the Jev call. */
  decideOptions?: Omit<DecideOptions, 'source' | 'env'>;
}

export interface AgentProgressGate {
  readonly mode: JevGateMode;
  /** Wire to runAgentLoop's onTurnSnapshot. Never throws, never awaits. */
  onTurn(snapshot: AgentTurnSnapshot): void;
  /** Call once when the run ends (every exit path). Waits for in-flight checks. */
  finish(outcome: AgentRunOutcome): Promise<void>;
  /** For tests: the shadow rows written so far with their prediction. */
  readonly checks: ReadonlyArray<{ id: string | null; turn: number; next_step: string | null; outcome: string }>;
}

const NOOP: AgentProgressGate = {
  mode: 'off',
  onTurn: () => undefined,
  finish: async () => undefined,
  checks: [],
};

function describeCall(c: AgentTurnSnapshot['calls'][number], turn: number): string {
  const status = c.passedCheck ? 'passed' : c.isError ? 'error' : 'ok';
  return `t${turn} ${c.name}${c.path ? ` ${c.path.slice(0, 100)}` : ''} ${status}`;
}

/**
 * Builds the gate for one run. With the mode off it is a no-op object: no
 * read, no write, no call — the loop pays nothing.
 */
export function createAgentProgressGate(o: AgentProgressGateOptions): AgentProgressGate {
  const env = o.env ?? process.env;
  const mode = jevGateMode(AGENT_PROGRESS_GATE, env);
  if (mode === 'off') return NOOP;
  const every = agentProgressEvery(env);
  const sb = o.sb === undefined ? getSupabase() : o.sb;
  const activity: string[] = [];
  let failedChecks = 0;
  let passedChecks = 0;
  let turnsSeen = 0;
  const checks: Array<{ id: string | null; turn: number; next_step: string | null; outcome: string }> = [];
  let chain: Promise<void> = Promise.resolve();

  const runCheck = async (s: AgentTurnSnapshot, recent: string[], failed: number, passed: number): Promise<void> => {
    try {
      const r = await decide(
        'agent_progress_check',
        {
          task: o.task.slice(0, 2000) || '(no task summary)',
          turn: s.turn,
          max_turns: Math.max(s.maxTurns, s.turn),
          tool_calls: s.toolCalls,
          has_edited: s.hasEdited,
          idle_turns: s.idleTurns,
          failed_checks: failed,
          passed_checks: passed,
          recent_activity: recent,
        },
        SYSTEM_CALLER,
        { ...(o.decideOptions || {}), source: `gate:${AGENT_PROGRESS_GATE}`, env },
      );
      const nextStep = r.ok ? String(r.verdict.value) : null;
      const id = await recordJevShadowDecision(
        {
          gate: AGENT_PROGRESS_GATE,
          decision: 'agent_progress_check',
          mode,
          plane: 'internal',
          tenant_id: null,
          subject_type: 'dev_autopilot_execution',
          subject_ref: o.executionId,
          jev_outcome: r.outcome,
          jev_verdict: r.ok
            ? { next_step: nextStep, will_finish: r.answers.will_finish?.probability ?? null, turn: s.turn, finding_id: o.findingId }
            : { reason: r.reason, turn: s.turn, finding_id: o.findingId },
          jev_confidence: r.ok ? r.verdict.confidence : null,
          system_action: s.loopAction,
          cost_usd: r.ok ? r.cost_usd : 0,
        },
        sb,
      );
      checks.push({ id, turn: s.turn, next_step: r.ok && r.outcome === 'decided' ? nextStep : null, outcome: r.outcome });
    } catch (err: any) {
      console.warn(`[jev] ${AGENT_PROGRESS_GATE} check failed at turn ${s.turn}: ${err?.message || err}`);
    }
  };

  return {
    mode,
    checks,
    onTurn(s) {
      try {
        turnsSeen += 1;
        for (const c of s.calls) {
          if (c.name === 'run_check') {
            if (c.passedCheck) passedChecks += 1;
            else if (c.isError) failedChecks += 1;
          }
          activity.push(describeCall(c, s.turn));
        }
        while (activity.length > ACTIVITY_WINDOW) activity.shift();
        if (turnsSeen % every !== 0) return;
        const recent = activity.slice();
        const failed = failedChecks;
        const passed = passedChecks;
        // Ordered, never awaited by the loop.
        chain = chain.then(() => runCheck(s, recent, failed, passed));
      } catch (err: any) {
        console.warn(`[jev] ${AGENT_PROGRESS_GATE} snapshot dropped: ${err?.message || err}`);
      }
    },
    async finish(outcome) {
      try {
        await chain;
        const success = outcome === 'pr_opened' || outcome === 'fix_pushed' || outcome === 'awaiting_approval';
        for (const c of checks) {
          if (!c.id) continue;
          const agreed =
            outcome === 'cancelled' || c.next_step === null
              ? null
              : (c.next_step === 'continue' || c.next_step === 'commit') === success;
          await recordJevShadowOutcome(c.id, `run_${outcome}`, agreed, sb);
        }
      } catch (err: any) {
        console.warn(`[jev] ${AGENT_PROGRESS_GATE} outcome not recorded: ${err?.message || err}`);
      }
    },
  };
}
