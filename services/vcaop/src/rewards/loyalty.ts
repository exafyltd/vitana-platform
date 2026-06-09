/**
 * Consented read-only loyalty links (RWD-LOYAL-0004, runbook Sec. 4.6 / Sec. 9).
 *
 * Loyalty linking is consented, read-only, official-API-only, credential-free. No
 * endpoint may pool/transfer/resell loyalty value (loyalty-guard). Links are
 * persisted via the loyalty-safe path (no password/secret field).
 */
import { Repository, newId } from '../api/repository';
import { OasisSink } from '../api/oasis-sink';
import { assertLoyaltyLinkValid, assertLoyaltyEndpointAllowed, UserRewardLink } from '../guardrails/loyalty-guard';
import { assertLoyaltyRecordCredentialFree } from '../guardrails/no-credential-store';

export interface LinkLoyaltyInput {
  userId: string;
  program: string;
  /** Optional user-provided member id (NOT a credential). */
  memberId?: string;
  consentRef: string;
  /** Optional official-API token reference (Secret Manager ref, never a value). */
  officialApiTokenRef?: string;
}

export class LoyaltyService {
  constructor(private readonly repo: Repository, private readonly oasis: OasisSink) {}

  /** Create a consented, read-only, credential-free loyalty link. */
  async link(input: LinkLoyaltyInput): Promise<{ id: string }> {
    const link: UserRewardLink = {
      program: input.program,
      member_id: input.memberId,
      consent_ref: input.consentRef,
      official_api_token_ref: input.officialApiTokenRef,
      read_only: true,
    };
    assertLoyaltyLinkValid(link); // read_only + credential-free
    const record = {
      id: newId('user_reward_link'),
      user_id: input.userId,
      program: input.program,
      member_id: input.memberId ?? null,
      consent_ref: input.consentRef,
      official_api_token_ref: input.officialApiTokenRef ?? null,
      read_only: true,
    };
    assertLoyaltyRecordCredentialFree(record); // schema-incapable of credentials
    const saved = await this.repo.create('user_reward_link', record);
    await this.oasis.emit({
      type: 'vcaop.loyalty.linked', source: 'loyalty', status: 'success',
      message: `loyalty link created for ${input.program}`,
      payload: { linkId: saved.id, userId: input.userId, program: input.program },
    });
    return { id: saved.id };
  }

  /** Guard a loyalty endpoint name — refuses any pool/transfer/resale semantics. */
  assertEndpointAllowed(name: string): void {
    assertLoyaltyEndpointAllowed(name);
  }
}
