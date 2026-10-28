/**
 * Worker-core (AGNT-WORKER-0002, runbook Sec. 2.2 / Sec. 6).
 *
 * Executes a conductor plan via a Connector (WORKER role → Gemini Flash). Each step
 * maps to a connector call; a step that hits a human gate / CAPTCHA is recorded as
 * `human_required` and the job is `blocked` (awaiting human) — never silently
 * skipped or failed. All guardrails are enforced inside the connector.
 */
import { JobPlan } from './conductor';
import { Connector, JobContext, BusinessIdentity, OperateAction } from '../connectors/connector';
import { HumanTaskRequired, CaptchaEncountered } from '../guardrails/errors';
import { ModelRouter, DefaultModelRouter } from './llm-router';
import { ExecutedStep } from './validator';

export interface WorkerOptions {
  identity?: BusinessIdentity;
  operateAction?: OperateAction;
}

export interface WorkerResult {
  status: 'completed' | 'blocked' | 'failed';
  workerModel: string;
  steps: ExecutedStep[];
  data: Record<string, unknown>;
}

export class Worker {
  constructor(private readonly router: ModelRouter = new DefaultModelRouter()) {}

  async executePlan(plan: JobPlan, connector: Connector, ctx: JobContext, opts: WorkerOptions = {}): Promise<WorkerResult> {
    const steps: ExecutedStep[] = [];
    const data: Record<string, unknown> = {};
    let blocked = false;

    for (const step of plan.steps) {
      try {
        switch (step.kind) {
          case 'register':
            await connector.register(opts.identity ?? { tenantId: ctx.tenantId, legalName: '', entityType: '' }, ctx);
            steps.push({ kind: step.kind, status: 'done' });
            break;
          case 'verify':
            data.verify = await connector.verify(ctx);
            steps.push({ kind: step.kind, status: 'done' });
            break;
          case 'operate':
          case 'route_cart':
            data.operate = await connector.operate(opts.operateAction ?? { kind: step.kind }, ctx);
            steps.push({ kind: step.kind, status: 'done' });
            break;
          default:
            // Internal orchestration steps (prepare_identity, activate, kyb, …).
            if (step.humanGated) {
              steps.push({ kind: step.kind, status: 'human_required' });
              blocked = true;
            } else {
              steps.push({ kind: step.kind, status: 'done' });
            }
        }
      } catch (e) {
        if (e instanceof HumanTaskRequired || e instanceof CaptchaEncountered) {
          steps.push({ kind: step.kind, status: 'human_required' });
          blocked = true;
        } else {
          steps.push({ kind: step.kind, status: 'failed' });
          return { status: 'failed', workerModel: this.router.route('WORKER'), steps, data };
        }
      }
    }

    return { status: blocked ? 'blocked' : 'completed', workerModel: this.router.route('WORKER'), steps, data };
  }
}
