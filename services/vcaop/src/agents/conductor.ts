/**
 * Conductor (AGNT-CONDUCT-0001, runbook Sec. 2.2 / Sec. 6).
 *
 * Plans a job: chooses the connector tier from the provider policy and emits the
 * ordered steps, honoring policy (PLANNER role → Claude). Produces no side effects;
 * a denied provider yields no plan.
 */
import { PolicyEngine, AutomationAllowed } from '../guardrails/policy-engine';
import { ConnectorMode } from '../connectors/connector';
import { ModelRouter, DefaultModelRouter } from './llm-router';

export type JobGoal = 'onboard' | 'operate';

export interface PlanStep {
  kind: string;
  /** True if this step is expected to require a human (KYB / irreversible submit). */
  humanGated?: boolean;
}

export interface JobPlan {
  providerId: string;
  goal: JobGoal;
  connectorTier: ConnectorMode;
  plannerModel: string;
  steps: PlanStep[];
}

const TIER_BY_AUTOMATION: Record<Exclude<AutomationAllowed, 'denied'>, ConnectorMode> = {
  api_only: 'api',
  oauth_only: 'oauth',
  browser_with_human_submit: 'browser',
  manual_only: 'manual',
};

export class Conductor {
  constructor(private readonly policyEngine: PolicyEngine, private readonly router: ModelRouter = new DefaultModelRouter()) {}

  /** Build a plan honoring the provider policy. Throws if the provider is denied/unknown. */
  planJob(providerId: string, goal: JobGoal): JobPlan {
    const policy = this.policyEngine.getPolicy(providerId);
    if (policy.automation_allowed === 'denied') {
      throw new Error(`cannot plan: provider ${providerId} automation is denied`);
    }
    const connectorTier = TIER_BY_AUTOMATION[policy.automation_allowed];
    const plannerModel = this.router.route('PLANNER');

    const steps: PlanStep[] =
      goal === 'onboard'
        ? [
            { kind: 'prepare_identity' },
            { kind: 'register', humanGated: policy.registration_method === 'human_required' },
            { kind: 'verify' },
            ...(policy.kyb_required ? [{ kind: 'kyb', humanGated: true } as PlanStep] : []),
            { kind: 'activate' },
          ]
        : [{ kind: 'authenticate' }, { kind: 'operate' }, { kind: 'record_result' }];

    return { providerId, goal, connectorTier, plannerModel, steps };
  }
}
