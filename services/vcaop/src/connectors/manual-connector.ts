/**
 * ManualConnector (CONN-MANUAL-0005, runbook Sec. 4.4 / 4.2).
 *
 * The human-task generator: every operation becomes a pre-filled human_task. The
 * task payload is secret/PII-free — it carries REFERENCES to the business identity
 * and documents (the officer's RLS-protected portal renders the actual values),
 * plus the list of field NAMES to complete. The payload is asserted PII-free
 * (no-pii-leak) before the task is emitted.
 *
 * Guardrails enforced by BaseConnector first. Every method halts with
 * HumanTaskRequired after emitting the task (that IS the expected outcome).
 */
import { BaseConnector } from './base-connector';
import {
  ConnectorMode,
  BusinessIdentity,
  JobContext,
  OperateAction,
  RegisterResult,
  VerifyResult,
  OperateResult,
  HealthResult,
  ProviderAccount,
} from './connector';
import { PolicyEngine } from '../guardrails/policy-engine';
import { assertNoPii } from '../guardrails/no-pii-leak';
import { HumanRequiredAction } from '../guardrails/human-gate';

/** Business fields a human pre-fills (NAMES only — values live in the portal). */
const PREFILL_FIELD_NAMES = ['legal_name', 'entity_type', 'registration_no', 'vat_eori', 'ein', 'registered_address'];

export class ManualConnector extends BaseConnector {
  constructor(policyEngine: PolicyEngine) {
    super(policyEngine);
  }

  mode(): ConnectorMode {
    return 'manual';
  }

  /** Build a secret/PII-free, pre-filled task payload from references (Sec. 4.2). */
  private buildPayload(ctx: JobContext, identity: BusinessIdentity | null, action: string): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      provider_id: ctx.providerId,
      action,
      // reference, not values — officer's portal renders the actual identity under RLS
      business_identity_ref: (identity?.officerIdRef ? `business_identity:${identity.tenantId}` : `business_identity:${ctx.tenantId}`),
      officer_id_ref: identity?.officerIdRef ?? null,
      required_document_refs: identity?.documentRefs ?? [],
      fields_to_complete: PREFILL_FIELD_NAMES,
    };
    // Fail loudly if any PII slipped into the task payload.
    assertNoPii(payload, 'oasis_event');
    return payload;
  }

  private emitAndHalt(action: string, ctx: JobContext, identity: BusinessIdentity | null, taskType: HumanRequiredAction): never {
    const payload = this.buildPayload(ctx, identity, action);
    this.requireHuman(taskType, ctx, payload);
  }

  /** Pre-fill the registration human task (used by BaseConnector.register's human gate). */
  protected buildRegistrationTaskPayload(identity: BusinessIdentity, ctx: JobContext): Record<string, unknown> {
    return this.buildPayload(ctx, identity, 'register');
  }

  protected async doRegister(identity: BusinessIdentity, ctx: JobContext): Promise<RegisterResult> {
    // Reached only if a manual provider is NOT human_required (rare); still a human task.
    this.emitAndHalt('register', ctx, identity, 'IRREVERSIBLE_SUBMIT');
  }

  protected async doVerify(ctx: JobContext): Promise<VerifyResult> {
    this.emitAndHalt('verify', ctx, null, 'IRREVERSIBLE_SUBMIT');
  }

  protected async doOperate(action: OperateAction, ctx: JobContext): Promise<OperateResult> {
    this.emitAndHalt(action.kind, ctx, null, 'IRREVERSIBLE_SUBMIT');
  }

  protected async doHealthCheck(account: ProviderAccount): Promise<HealthResult> {
    return { status: 'unknown', details: { providerId: account.providerId, note: 'manual connector — human-operated' } };
  }
}
