/**
 * Validator-core (AGNT-VALID-0003, runbook Sec. 2.2 / Sec. 6).
 *
 * Verifies execution and gates sensitive actions (VALIDATOR role → Claude):
 *  - rejects any execution where a human-gated step was auto-completed (skipped gate)
 *  - refuses to confirm a commission/reward without a confirmed postback
 *    (rewards go pending → confirmed ONLY on a verified postback)
 */
import { PlanStep } from './conductor';
import { ModelRouter, DefaultModelRouter } from './llm-router';

export type StepStatus = 'done' | 'human_required' | 'failed';

export interface ExecutedStep {
  kind: string;
  status: StepStatus;
}

export interface CommissionLike {
  status: 'pending' | 'confirmed' | 'reversed';
  postbackRef?: string | null;
}

export interface ValidationResult {
  ok: boolean;
  reasons: string[];
  validatorModel: string;
}

export class Validator {
  constructor(private readonly router: ModelRouter = new DefaultModelRouter()) {}

  /**
   * Validate that no human-gated step was auto-completed. A human-gated step must
   * be `human_required` (routed to a human), never `done` by the agent.
   */
  validateExecution(plan: PlanStep[], executed: ExecutedStep[]): ValidationResult {
    const reasons: string[] = [];
    for (const planStep of plan) {
      if (!planStep.humanGated) continue;
      const ex = executed.find((e) => e.kind === planStep.kind);
      if (ex && ex.status === 'done') {
        reasons.push(`human-gated step "${planStep.kind}" was auto-completed (gate skipped)`);
      }
    }
    return { ok: reasons.length === 0, reasons, validatorModel: this.router.route('VALIDATOR') };
  }

  /** A commission may move pending→confirmed ONLY with a confirmed postback. */
  canConfirmCommission(c: CommissionLike): boolean {
    return !!c.postbackRef && c.postbackRef.trim().length > 0;
  }

  /** Throw unless the commission can be confirmed (refuses unverified commission). */
  assertConfirmable(c: CommissionLike): void {
    if (!this.canConfirmCommission(c)) {
      throw new Error('refusing to confirm commission without a verified postback');
    }
  }
}
