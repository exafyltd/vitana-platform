/**
 * Human-gate guard (runbook Sec. 3, Sec. 4.2 human_task).
 *
 * HUMAN_REQUIRED actions cannot be performed by an agent. A connector hitting one
 * MUST emit a `human_task` and halt the step — not bypassable.
 */
import { HumanTaskRequired } from './errors';

export const HUMAN_REQUIRED_ACTIONS = [
  'KYB',
  'LIVENESS',
  'CAPTCHA',
  'PAYOUT_BANK_LINK',
  'PRIVILEGE_ESCALATION',
  'IRREVERSIBLE_SUBMIT',
  'TRANSFER',
  'REAUTH', // OAuth refresh-token revoked -> human re-auth (magic link), account degraded (Sec. 4.5)
] as const;

export type HumanRequiredAction = (typeof HUMAN_REQUIRED_ACTIONS)[number];

const HUMAN_SET = new Set<string>(HUMAN_REQUIRED_ACTIONS);

export function requiresHuman(action: string): action is HumanRequiredAction {
  return HUMAN_SET.has(action);
}

export interface HumanTask {
  type: HumanRequiredAction;
  /** Pre-filled, secret/PII-free payload (else vault refs). */
  payload: Record<string, unknown>;
  /** Named officer / assignee (Sec. 4.2). */
  assignee?: string;
}

/** Callback the caller provides to actually persist/emit the human_task. */
export type EmitHumanTask = (task: HumanTask) => void;

/**
 * Enforce the human gate for `action`. If the action is HUMAN_REQUIRED, emit a
 * human_task (via the provided sink) and throw HumanTaskRequired to halt the step.
 * No-op (returns) for non-gated actions.
 *
 * The gate emits BEFORE throwing so the task is never lost.
 */
export function enforceHumanGate(
  action: string,
  emit: EmitHumanTask,
  taskInput?: Partial<Omit<HumanTask, 'type'>>,
): void {
  if (!requiresHuman(action)) return;
  emit({
    type: action,
    payload: taskInput?.payload ?? {},
    assignee: taskInput?.assignee,
  });
  throw new HumanTaskRequired(action);
}
