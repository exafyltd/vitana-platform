/**
 * Loyalty guard (runbook Sec. 0.3 item 4/5, Sec. 3, Sec. 4.6).
 *
 * Loyalty paths are read-only, credential-free, official-API-only. No endpoint may
 * pool/transfer/resell loyalty value. A `user_reward_link` is consented and
 * read-only; it is schema-incapable of holding credentials.
 */
import { LoyaltyGuardViolation } from './errors';
import { assertNoAccountMarketSemantics } from './no-account-market';

export interface UserRewardLink {
  program: string;
  /** User-provided member id (optional). NOT a credential. */
  member_id?: string;
  /** Consent record reference. */
  consent_ref?: string;
  /** Official-API token reference (if any) — a Secret Manager ref, never a value. */
  official_api_token_ref?: string;
  read_only: boolean;
  [k: string]: unknown;
}

/** Field fragments that would make a loyalty link credential-bearing (forbidden). */
const CREDENTIAL_FRAGMENTS = [
  'password',
  'passwd',
  'secret',
  'credential',
  'login',
  'pin',
  'session',
  'cookie',
];

/**
 * Validate a consented read-only loyalty link:
 *  - read_only must be true
 *  - no credential-bearing fields (only *_ref references allowed)
 */
export function assertLoyaltyLinkValid(link: UserRewardLink): void {
  if (link.read_only !== true) {
    throw new LoyaltyGuardViolation(
      `Loyalty link for "${link.program}" must be read_only=true (consented, read-only; Sec. 4.6)`,
    );
  }
  for (const key of Object.keys(link)) {
    const k = key.toLowerCase();
    if (k.endsWith('_ref')) continue; // references are allowed
    if (CREDENTIAL_FRAGMENTS.some((frag) => k.includes(frag))) {
      throw new LoyaltyGuardViolation(
        `Loyalty link must be credential-free; field "${key}" is credential-bearing ` +
          `(loyalty linking is official-API-only, read-only; Sec. 0.3 item 4)`,
      );
    }
  }
}

/**
 * Assert a loyalty-related endpoint/action does not implement pool/transfer/resale.
 * Delegates to the account-market guard plus loyalty-specific verbs.
 */
export function assertLoyaltyEndpointAllowed(name: string): void {
  assertNoAccountMarketSemantics(name);
  const n = (name ?? '').toLowerCase();
  if (/(redeem|transfer|withdraw|cash[_-]?out|sell|pool|broker)/.test(n) && /(loyalty|miles|points)/.test(n)) {
    throw new LoyaltyGuardViolation(
      `Refused loyalty endpoint "${name}": loyalty value cannot be pooled/transferred/resold (Sec. 0.3 item 5)`,
    );
  }
}
