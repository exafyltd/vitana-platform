/**
 * VTID-05209 — what Vitanaland already knows about a business's country and
 * website, so supplier screens and the connected AI suggest a value instead of
 * asking (Commerce UX contract; backend rules §13c rule 9).
 *
 * Pure: no I/O. Callers read the stored facts and the caller's confirmed email
 * and pass them in. A suggestion is never written by itself — the supplier
 * confirms it on screen, or the assistant confirms it with the supplier and
 * then calls update_business.
 *
 * Order, strongest first:
 *   country: stored → VAT ID prefix → website country-code domain → (no website
 *            known) the business email's country-code domain
 *   website: stored → a confirmed, non-free-mail email domain
 * Two reliable country sources that disagree (VAT AT…, website .de) give no
 * suggestion: the supplier is asked. No IP lookup, no fetching of the site.
 */
import { EU_COUNTRIES } from './partner-onboarding-checklist';
import { FREE_EMAIL_DOMAINS, emailDomainOf, hostOf } from './partner-verification';

export type CountrySource = 'stored' | 'vat_id' | 'website_domain' | 'email_domain';
export type WebsiteSource = 'stored' | 'email_domain';

export interface Suggestion<S> {
  value: string;
  source: S;
}

export interface CompanySuggestions {
  country: Suggestion<CountrySource> | null;
  website: Suggestion<WebsiteSource> | null;
}

export interface InferenceInput {
  stored?: { country?: string | null; website?: string | null; vat_id?: string | null } | null;
  /** A VAT ID typed but not saved yet. The stored one wins. */
  vatId?: string | null;
  /** A website typed but not saved yet. The stored one wins. */
  website?: string | null;
  email?: string | null;
  emailConfirmed?: boolean;
}

/** ISO 3166-1 alpha-2 codes a business can register with (as the frontend list). */
const COUNTRY_CODES: ReadonlySet<string> = new Set(
  (
    'AD AE AF AG AI AL AM AO AR AT AU AW AZ BA BB BD BE BF BG BH BI BJ BM BN BO BR BS BT BW BY BZ ' +
    'CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR ' +
    'GA GB GD GE GH GI GL GM GN GQ GR GT GW GY HK HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE ' +
    'KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MO ' +
    'MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PR PS PT PW PY QA RO ' +
    'RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT ' +
    'TV TW TZ UA UG US UY UZ VA VC VE VN VU WS XK YE ZA ZM ZW'
  ).split(' '),
);

/**
 * Country-code domains sold worldwide as generic names: they say nothing about
 * where a business is.
 */
const VANITY_TLDS: ReadonlySet<string> = new Set([
  'ac', 'ad', 'ag', 'ai', 'am', 'as', 'bz', 'cc', 'cd', 'cm', 'co', 'cx', 'dj', 'fm', 'gg', 'gl', 'gs', 'im', 'io',
  'je', 'la', 'ly', 'md', 'me', 'ms', 'mu', 'nu', 'pw', 'sc', 'sh', 'so', 'st', 'tk', 'tm', 'to', 'tv', 'vc', 'vg',
  'ws',
]);

/** Country-code domains whose label is not the ISO code. */
const TLD_ALIASES: Record<string, string> = { uk: 'GB' };

/** Multi-part public suffixes, read before the last label (`shop.example.co.uk` → GB). */
const MULTI_PART_SUFFIXES: Record<string, string> = {
  'co.uk': 'GB', 'org.uk': 'GB', 'me.uk': 'GB', 'ltd.uk': 'GB', 'plc.uk': 'GB',
  'com.au': 'AU', 'net.au': 'AU', 'org.au': 'AU',
  'co.nz': 'NZ', 'org.nz': 'NZ',
  'com.br': 'BR', 'com.mx': 'MX', 'com.ar': 'AR', 'com.tr': 'TR', 'com.cn': 'CN', 'com.sg': 'SG',
  'co.at': 'AT', 'or.at': 'AT',
  'co.za': 'ZA', 'co.jp': 'JP', 'co.kr': 'KR', 'co.in': 'IN', 'co.il': 'IL',
  'com.pl': 'PL', 'com.pt': 'PT', 'com.es': 'ES', 'com.gr': 'GR', 'com.cy': 'CY', 'com.mt': 'MT',
};

/** The country a host's domain ending names, or null for generic/vanity endings. */
export function countryFromHost(host: string | null | undefined): string | null {
  if (!host) return null;
  const labels = host.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  if (labels.length < 2) return null;
  const lastTwo = labels.slice(-2).join('.');
  if (labels.length >= 3 && MULTI_PART_SUFFIXES[lastTwo]) return MULTI_PART_SUFFIXES[lastTwo];
  const tld = labels[labels.length - 1];
  if (TLD_ALIASES[tld]) return TLD_ALIASES[tld];
  if (tld.length !== 2 || VANITY_TLDS.has(tld)) return null;
  const code = tld.toUpperCase();
  return COUNTRY_CODES.has(code) ? code : null;
}

/** The EU member state a VAT ID's prefix names (`EL` → GR), or null. */
export function countryFromVatId(vatId: string | null | undefined): string | null {
  if (typeof vatId !== 'string') return null;
  const v = vatId.toUpperCase().replace(/[\s.\-_/]/g, '');
  if (!/^[A-Z]{2}[A-Z0-9+*]{2,12}$/.test(v)) return null;
  const prefix = v.slice(0, 2);
  const code = prefix === 'EL' ? 'GR' : prefix;
  return EU_COUNTRIES.has(code) ? code : null;
}

function hostOfLoose(website: string | null | undefined): string | null {
  if (typeof website !== 'string' || !website.trim()) return null;
  const w = website.trim();
  return hostOf(/^https?:\/\//i.test(w) ? w : `https://${w}`);
}

function storedCountry(v: string | null | undefined): string | null {
  return typeof v === 'string' && /^[A-Z]{2}$/.test(v) ? v : null;
}

export function inferCompanyFacts(input: InferenceInput): CompanySuggestions {
  const stored = input.stored ?? {};
  const emailDomain = input.emailConfirmed ? emailDomainOf(input.email) : null;
  const businessEmailDomain = emailDomain && !FREE_EMAIL_DOMAINS.has(emailDomain) ? emailDomain : null;

  // Website: a saved value always wins; otherwise the confirmed business email's domain.
  let website: Suggestion<WebsiteSource> | null = null;
  if (typeof stored.website === 'string' && stored.website.trim()) website = { value: stored.website, source: 'stored' };
  else if (businessEmailDomain) website = { value: `https://${businessEmailDomain}`, source: 'email_domain' };

  // Country: a saved value always wins.
  const saved = storedCountry(stored.country);
  if (saved) return { country: { value: saved, source: 'stored' }, website };

  const fromVat = countryFromVatId(stored.vat_id || input.vatId);
  const knownHost = hostOfLoose(stored.website) ?? hostOfLoose(input.website);
  const fromWebsite = countryFromHost(knownHost);
  // The email's domain only stands in when no website is known at all.
  const fromEmail = knownHost ? null : countryFromHost(businessEmailDomain);

  const candidates: Array<Suggestion<CountrySource>> = [];
  if (fromVat) candidates.push({ value: fromVat, source: 'vat_id' });
  if (fromWebsite) candidates.push({ value: fromWebsite, source: 'website_domain' });
  if (fromEmail) candidates.push({ value: fromEmail, source: 'email_domain' });
  if (candidates.length === 0) return { country: null, website };
  // Reliable sources that disagree: ask the supplier.
  if (new Set(candidates.map((c) => c.value)).size > 1) return { country: null, website };
  return { country: candidates[0], website };
}
