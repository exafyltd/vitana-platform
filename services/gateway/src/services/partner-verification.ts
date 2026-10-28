/**
 * VTID-04486 — partner verification rules (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §7).
 *
 * Pure functions only. The route runs the checks that need I/O
 * (partner-verification-io.ts), hands the results here, and stores what
 * `computeVerification` returns as the `verification` step row.
 *
 * Levels:
 *   0  verified email + website ownership (the website's domain matches the
 *      email domain, or a DNS TXT record / meta tag carries the org's token)
 *   1  level 0 + EU VAT id valid in VIES (not required outside the EU) +
 *      business verification (spec Q2 — no provider decided yet)
 *   2  level 1 + licence/accreditation proof (spec Q6 — no provider yet)
 * The DPA that level 2 also names is its own checklist step (`dpa`).
 *
 * A check that has no provider yet reports `not_configured`, which is never
 * `passed`: a type that needs level 1 or 2 cannot finish this step until the
 * provider exists. That is deliberate — the step says exactly why.
 */

import { EU_COUNTRIES } from './partner-onboarding-checklist';

export type CheckStatus = 'passed' | 'failed' | 'pending' | 'unavailable' | 'not_required' | 'not_configured';

export interface VerificationChecks {
  email_verified: CheckStatus;
  domain: CheckStatus;
  vat: CheckStatus;
  business_verification: CheckStatus;
  licence: CheckStatus;
}

export interface VerificationOutcome {
  /** Highest level fully met, or null when not even level 0 is. */
  level_reached: 0 | 1 | 2 | null;
  step_status: 'done' | 'failed' | 'in_progress';
  /** Machine-readable codes for what stands between the org and its level. */
  missing: string[];
}

const LEVEL_CHECKS: ReadonlyArray<ReadonlyArray<keyof VerificationChecks>> = [
  ['email_verified', 'domain'],
  ['vat', 'business_verification'],
  ['licence'],
];

const MISSING_CODE: Record<keyof VerificationChecks, Partial<Record<CheckStatus, string>>> = {
  email_verified: { failed: 'email_not_verified', pending: 'email_not_verified', unavailable: 'email_check_unavailable' },
  domain: { failed: 'domain_proof', pending: 'domain_proof', unavailable: 'domain_check_unavailable' },
  vat: { failed: 'vat_invalid', pending: 'vat_id', unavailable: 'vat_check_unavailable' },
  business_verification: { not_configured: 'business_verification_not_configured', pending: 'business_verification' },
  licence: { not_configured: 'licence_verification_not_configured', pending: 'licence' },
};

function met(status: CheckStatus): boolean {
  return status === 'passed' || status === 'not_required';
}

export function computeVerification(required: 0 | 1 | 2, checks: VerificationChecks): VerificationOutcome {
  let reached: 0 | 1 | 2 | null = null;
  for (let level = 0; level <= 2; level++) {
    if (!LEVEL_CHECKS[level].every((k) => met(checks[k]))) break;
    reached = level as 0 | 1 | 2;
  }

  const relevant = LEVEL_CHECKS.slice(0, required + 1).flat();
  const open = relevant.filter((k) => !met(checks[k]));
  const missing = open.map((k) => MISSING_CODE[k][checks[k]] ?? `${k}_${checks[k]}`);

  let step_status: VerificationOutcome['step_status'];
  if (reached !== null && reached >= required) step_status = 'done';
  else if (open.some((k) => checks[k] === 'failed')) step_status = 'failed';
  else step_status = 'in_progress';

  return { level_reached: reached, step_status, missing };
}

// ---------------------------------------------------------------------------
// VAT
// ---------------------------------------------------------------------------

export function isEuCountry(country: string | null | undefined): boolean {
  return typeof country === 'string' && EU_COUNTRIES.has(country);
}

/** VIES uses EL for Greece; every other member state uses its ISO code. */
export function viesCountryCode(country: string): string {
  return country === 'GR' ? 'EL' : country;
}

/**
 * Splits a VAT id into the VIES country code and number. Accepts the id with
 * or without its country prefix and with the spaces, dots and dashes people
 * type. Returns null when what is left cannot be a VAT number.
 */
export function normalizeVatNumber(vatId: string, country: string): { country_code: string; number: string } | null {
  const cc = viesCountryCode(country.toUpperCase());
  let v = vatId.toUpperCase().replace(/[\s.\-_/]/g, '');
  if (v.startsWith(cc) || (cc === 'EL' && v.startsWith('GR'))) v = v.slice(2);
  if (!/^[A-Z0-9+*]{2,12}$/.test(v)) return null;
  return { country_code: cc, number: v };
}

// ---------------------------------------------------------------------------
// Domain ownership
// ---------------------------------------------------------------------------

/**
 * Mailbox providers: an address there says nothing about who owns a website,
 * so a matching domain is never accepted as proof for them.
 */
export const FREE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch', 'web.de', 't-online.de',
  'freenet.de', 'proton.me', 'protonmail.com', 'mail.com', 'yandex.com', 'zoho.com', 'posteo.de', 'mailbox.org',
]);

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
    return h.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function emailDomainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 1) return null;
  const d = email.slice(at + 1).toLowerCase().trim().replace(/\.$/, '');
  return d.includes('.') ? d : null;
}

/** True when one domain is the other or a subdomain of it. */
export function domainsMatch(websiteHost: string, emailDomain: string): boolean {
  if (FREE_EMAIL_DOMAINS.has(emailDomain)) return false;
  return websiteHost === emailDomain || websiteHost.endsWith(`.${emailDomain}`) || emailDomain.endsWith(`.${websiteHost}`);
}

export const DOMAIN_TXT_PREFIX = '_vitana-verification';
export const META_TAG_NAME = 'vitana-site-verification';

export function domainProofInstructions(host: string, token: string) {
  return {
    token,
    dns_txt_name: `${DOMAIN_TXT_PREFIX}.${host}`,
    dns_txt_value: `vitana-verification=${token}`,
    meta_tag: `<meta name="${META_TAG_NAME}" content="${token}">`,
  };
}

export function txtRecordsContainToken(records: string[][], token: string): boolean {
  return records.some((chunks) => chunks.join('').trim() === `vitana-verification=${token}`);
}

export function htmlContainsMetaToken(body: string, token: string): boolean {
  const metas = body.match(/<meta\b[^>]*>/gi) ?? [];
  return metas.some((tag) => {
    const name = /\bname\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    return name?.toLowerCase() === META_TAG_NAME && content?.trim() === token;
  });
}
