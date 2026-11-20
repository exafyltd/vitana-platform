/**
 * Delivery loop controls: whether the loop runs, how far it may go, and the bounds on what one cycle may do.
 *
 * Every control fails CLOSED: an unreadable or unknown value is the most restrictive one. Turning the loop on, or a level above
 * L1, is the owner's step (vitana-owner-autonomy.md stop 13); nothing in this module can raise a level by itself.
 *
 *   DELIVERY_LOOP_ENABLED          exactly 'true' runs the loop; anything else is off
 *   DELIVERY_LOOP_AUTONOMY         L0 | L1 | L2 | L3; unset is L1; any other value is L0
 *   DELIVERY_LOOP_PROJECTS         comma separated GitLab project paths the loop may read and write; unset is none
 *   DELIVERY_LOOP_MAX_ACTIONS      most side effects (GitLab writes, task dispatches) of one cycle; default 5, bounded 0..50
 *   DELIVERY_LOOP_HEAL_MAX_ATTEMPTS  repair attempts per failure fingerprint before the loop stops and escalates; default 3, bounded 1..5
 *   DELIVERY_LOOP_BRANCH_PREFIXES  the branches the loop owns, comma separated prefixes; default `dev-autopilot/,delivery-loop/`. It repairs
 *                                  and reviews only these: the lane branches of the Kiro and Claude sessions have their own builders and
 *                                  reviewer, and a second writer on the same branch is worse than a red pipeline.
 *   DELIVERY_LOOP_HEAL_MAIN        exactly 'true' also repairs a failed pipeline of `main`; default off (the fix-forward drivers own it)
 *   DELIVERY_LOOP_REWORK_MAX_ROUNDS  review-and-rework rounds on one merge request before a human is asked; default 2, bounded 1..3
 *
 * The execution plane's own kill switch (system_controls autopilot_execution_enabled, read through `isArmed`) gates `act`:
 * disarmed means the loop observes, records and prepares, and does not execute.
 */
import type { Autonomy, LoopAction } from './types';

export const AUTONOMY_LEVELS: readonly Autonomy[] = ['L0', 'L1', 'L2', 'L3'];
export const DEFAULT_AUTONOMY: Autonomy = 'L1';
export const DEFAULT_MAX_ACTIONS = 5;
export const MAX_ACTIONS_CEILING = 50;
export const DEFAULT_HEAL_MAX_ATTEMPTS = 3;
export const HEAL_MAX_ATTEMPTS_CEILING = 5;
export const DEFAULT_REWORK_MAX_ROUNDS = 2;
export const REWORK_MAX_ROUNDS_CEILING = 3;
export const DEFAULT_BRANCH_PREFIXES: readonly string[] = ['dev-autopilot/', 'delivery-loop/'];

/** The lowest level that allows each action. */
const LEVEL_FOR: Record<LoopAction, Autonomy> = { record: 'L1', learn: 'L1', prepare: 'L2', act: 'L3' };

export function isLoopEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DELIVERY_LOOP_ENABLED === 'true';
}

/** Unset is L1 (recommend). A value that is not one of the four levels is L0 (observe only): a typo never raises the level. */
export function autonomyFrom(env: NodeJS.ProcessEnv = process.env): Autonomy {
  const raw = env.DELIVERY_LOOP_AUTONOMY;
  if (raw === undefined || raw === '') return DEFAULT_AUTONOMY;
  const v = raw.trim();
  return (AUTONOMY_LEVELS as readonly string[]).includes(v) ? (v as Autonomy) : 'L0';
}

/** True when `level` is at or above the level the action needs. */
export function allows(level: Autonomy, action: LoopAction): boolean {
  return AUTONOMY_LEVELS.indexOf(level) >= AUTONOMY_LEVELS.indexOf(LEVEL_FOR[action]);
}

export function projectsFrom(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DELIVERY_LOOP_PROJECTS ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(p));
}

function boundedInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

export function maxActionsFrom(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.DELIVERY_LOOP_MAX_ACTIONS, DEFAULT_MAX_ACTIONS, 0, MAX_ACTIONS_CEILING);
}

export function healMaxAttemptsFrom(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.DELIVERY_LOOP_HEAL_MAX_ATTEMPTS, DEFAULT_HEAL_MAX_ATTEMPTS, 1, HEAL_MAX_ATTEMPTS_CEILING);
}

/** Plain branch prefixes only (`dev-autopilot/`): no pattern, no `..`, so an env value can never widen into "every branch". */
export function branchPrefixesFrom(env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.DELIVERY_LOOP_BRANCH_PREFIXES === undefined) return [...DEFAULT_BRANCH_PREFIXES];
  return env.DELIVERY_LOOP_BRANCH_PREFIXES
    .split(',')
    .map((p) => p.trim())
    .filter((p) => /^[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(p) || /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._/-]*\/$/.test(p))
    .filter((p) => !p.includes('..') && !p.includes('//'));
}

export function healMainFrom(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DELIVERY_LOOP_HEAL_MAIN === 'true';
}

export function reworkMaxRoundsFrom(env: NodeJS.ProcessEnv = process.env): number {
  return boundedInt(env.DELIVERY_LOOP_REWORK_MAX_ROUNDS, DEFAULT_REWORK_MAX_ROUNDS, 1, REWORK_MAX_ROUNDS_CEILING);
}

export interface Controls {
  enabled: boolean;
  autonomy: Autonomy;
  /** The execution plane's kill switch: true when execution is armed. */
  armed: boolean;
  projects: string[];
  maxActions: number;
  healMaxAttempts: number;
  /** The branches the loop owns: it repairs and reviews only these (and `main` when healMain). */
  branchPrefixes: string[];
  healMain: boolean;
  reworkMaxRounds: number;
}

/** Is this branch one the loop may repair and review? `main` only when the owner asked for it, and only for repair. */
export function ownsBranch(c: Pick<Controls, 'branchPrefixes' | 'healMain'>, branch: string | null, purpose: 'heal' | 'review'): boolean {
  if (!branch) return false;
  if (c.branchPrefixes.some((p) => branch.startsWith(p))) return true;
  return purpose === 'heal' && c.healMain && branch === 'main';
}

/**
 * What this cycle may do. `isArmed` is the execution plane's switch (isAutopilotExecutionArmed); a failure reading it is
 * "not armed", so the loop never executes on a guess.
 */
export async function readControls(env: NodeJS.ProcessEnv, isArmed: () => Promise<boolean>): Promise<Controls> {
  let armed = false;
  try {
    armed = (await isArmed()) === true;
  } catch {
    armed = false;
  }
  return {
    enabled: isLoopEnabled(env),
    autonomy: autonomyFrom(env),
    armed,
    projects: projectsFrom(env),
    maxActions: maxActionsFrom(env),
    healMaxAttempts: healMaxAttemptsFrom(env),
    branchPrefixes: branchPrefixesFrom(env),
    healMain: healMainFrom(env),
    reworkMaxRounds: reworkMaxRoundsFrom(env),
  };
}

/** May the loop do `action` now? `act` also needs the execution plane armed; nothing is allowed when the loop is off. */
export function mayDo(c: Controls, action: LoopAction): boolean {
  if (!c.enabled) return false;
  if (!allows(c.autonomy, action)) return false;
  return action === 'act' ? c.armed : true;
}
