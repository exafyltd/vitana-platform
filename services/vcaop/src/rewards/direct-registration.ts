/**
 * Direct publisher registration (RWD-DIRECT-0003, runbook Sec. 2.1 / Sec. 6).
 *
 * For the top direct affiliate programs (Amazon Associates, Awin, CJ, Impact,
 * Rakuten, Booking/Expedia, …), generate an application via the KYB human-task path.
 * NEVER auto-submits identity: it produces human tasks (site/app details, tax, bank
 * link) for a human to complete. PII-free task payloads (refs + field names only).
 */
import { Repository, newId } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { assertNoPii } from '../guardrails/no-pii-leak';

/** Top direct programs reserved for direct registration (Sec. 2.1). */
export const TOP_DIRECT_PROGRAMS = [
  'amazon_associates', 'awin', 'cj', 'impact', 'rakuten_advertising',
  'booking', 'expedia', 'ebay_partner', 'walmart_affiliate', 'target_affiliate',
] as const;

export interface DirectApplicationInput {
  tenantId: string;
  programId: string;
  /** Site/app the publisher will promote with (non-PII business asset). */
  siteOrApp: string;
  /** Vault refs for identity/tax/bank — never raw values. */
  businessIdentityRef?: string;
}

export interface DirectApplication {
  programId: string;
  taskIds: string[];
}

export class DirectRegistration {
  constructor(private readonly repo: Repository, private readonly oasis: OasisSink) {}

  /** Generate the human tasks for a direct program application. No auto-submit. */
  async apply(input: DirectApplicationInput): Promise<DirectApplication> {
    const base = {
      tenant_id: input.tenantId,
      provider_id: input.programId,
      status: 'open' as const,
    };
    // Three human tasks: publisher application, tax form, bank/payout link.
    const appPayload = {
      program_id: input.programId,
      site_or_app: input.siteOrApp,
      business_identity_ref: input.businessIdentityRef ?? `business_identity:${input.tenantId}`,
      fields_to_complete: ['site_url', 'app_name', 'promotion_method'],
    };
    const taxPayload = { program_id: input.programId, fields_to_complete: ['tax_classification', 'tax_id_ref'] };
    const bankPayload = { program_id: input.programId, fields_to_complete: ['payout_bank_ref'] };
    for (const p of [appPayload, taxPayload, bankPayload]) assertNoPii(p, 'oasis_event');

    const appTask = await this.repo.create('human_task', { id: newId('human_task'), ...base, type: 'IRREVERSIBLE_SUBMIT', payload: appPayload });
    const taxTask = await this.repo.create('human_task', { id: newId('human_task'), ...base, type: 'KYB', payload: taxPayload });
    const bankTask = await this.repo.create('human_task', { id: newId('human_task'), ...base, type: 'PAYOUT_BANK_LINK', payload: bankPayload });

    const taskIds = [appTask.id, taxTask.id, bankTask.id];
    await this.oasis.emit({
      type: 'vcaop.direct_registration.applied', source: 'direct-registration', status: 'info',
      message: `direct application generated for ${input.programId} (human-completed)`,
      payload: { programId: input.programId, taskIds },
    });
    return { programId: input.programId, taskIds };
  }
}
