/**
 * VTID-05153 — deterministic checks for supplier catalogue rows
 * (Loop Engineering Phase 5, loop L9 Supplier catalog, wave 1).
 *
 * Pure: no I/O. The media probe is injected (run.ts passes the SSRF-guarded
 * HEAD probe from platform-detect.ts). No LLM. Steps, in order:
 *   1. normalize (S02) — lossless canonical form only, then the row is judged
 *      by ProductSchema, the schema every ingestion path uses. Nothing is
 *      invented: a missing value stays missing and becomes an error.
 *   2. required fields and money — isCompleteOffering plus price > 0 for a
 *      product (deliberately stricter than isCompleteOffering, which accepts
 *      0), ISO 4217 currency, compare-at ≥ price, one image for a product.
 *   3. duplicates within the supplier (S05) — gtin/sku under the same
 *      merchant, then canonical affiliate_url, then normalized title; only
 *      within the same supplier, the newer row names the older.
 *   4. media (S06) — at most MAX_IMAGES_PER_ROW probes per row; a run where
 *      more than half of the probes fail at the network level records
 *      `image_unchecked` instead (no strike).
 *   5. claims (S03) — pre-screen only (claim-prescreen.ts); a flag routes the
 *      row to `needs_review`, a person decides.
 *   6. certificates (S04) — deferred: certifications are recorded as
 *      `certifications_declared`, never as verified.
 *
 * Every error is a code + field + params, never English text.
 */

import { createHash } from 'crypto';
import { ProductSchema, shipsSomewhere, stripReservedAttributes } from '../../routes/vcaop-portal-my-products';
import { isCompleteOffering } from '../partner-onboarding-checklist';

/** The one wave-1 category. */
export const CATALOG_CHECK_CATEGORY = 'supplements';
export const CATALOG_CHECK_VERSION = 1;
export const MAX_IMAGES_PER_ROW = 3;
/** Three checks failing the same way return the row to the supplier. */
export const MAX_STRIKES = 3;
/** More than this share of a run's probes failing at the network level is an outage, not bad data. */
export const OUTAGE_SHARE = 0.5;

export type CheckState = 'ready_for_review' | 'needs_fix' | 'needs_review' | 'returned_to_supplier';

export interface CheckError {
  code: string;
  field: string | null;
  params: Record<string, unknown>;
}

/** Stored at products.attributes.catalog_check (a reserved key). */
export interface CatalogCheckResult {
  v: 1;
  state: CheckState;
  checked_at: string;
  content_hash: string;
  errors: CheckError[];
  flags: string[];
  duplicate_of?: string;
  normalized: string[];
  fingerprint: string;
  strikes: number;
}

/** The product columns the check reads. */
export interface CheckRow {
  id: string;
  merchant_id: string;
  title?: string | null;
  description?: string | null;
  brand?: string | null;
  price_cents?: number | null;
  compare_at_price_cents?: number | null;
  currency?: string | null;
  images?: string[] | null;
  affiliate_url?: string | null;
  origin_country?: string | null;
  ships_to_countries?: string[] | null;
  ships_to_regions?: string[] | null;
  availability?: string | null;
  category?: string | null;
  subcategory?: string | null;
  attributes?: Record<string, unknown> | null;
  gtin?: string | null;
  sku?: string | null;
  certifications?: string[] | null;
  is_active?: boolean | null;
  created_at?: string | null;
}

// =============================================================================
// 1. Normalize (S02)
// =============================================================================

/** Fields normalization may change. Only these are ever written back. */
export const NORMALIZABLE_FIELDS = [
  'title',
  'brand',
  'description',
  'currency',
  'origin_country',
  'images',
  'ships_to_countries',
  'ships_to_regions',
  'affiliate_url',
] as const;
export type NormalizableField = (typeof NORMALIZABLE_FIELDS)[number];

const collapse = (v: unknown): string | null => {
  if (typeof v !== 'string') return v == null ? null : (v as any);
  const s = v.trim().replace(/\s+/g, ' ');
  return s.length ? s : null;
};
const nonEmpty = (v: unknown): string | null => {
  if (typeof v !== 'string') return v == null ? null : (v as any);
  return v.trim().length ? v : null;
};
const upper = (v: unknown): string | null => {
  if (typeof v !== 'string') return v == null ? null : (v as any);
  const s = v.trim().toUpperCase();
  return s.length ? s : null;
};
function cleanList(v: unknown, map: (s: string) => string, dedupe: boolean): string[] | null {
  if (!Array.isArray(v)) return v == null ? null : (v as any);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') continue;
    const m = map(item);
    if (!m.length) continue;
    if (dedupe && out.includes(m)) continue;
    out.push(m);
  }
  return out;
}

/**
 * Lossless canonical form: whitespace trimmed and collapsed in title and brand,
 * ISO codes upper-cased, empty strings dropped, duplicate images removed.
 * Idempotent. `fields` names what changed.
 */
export function normalizeRow(row: CheckRow): { row: CheckRow; fields: NormalizableField[] } {
  const next: CheckRow = {
    ...row,
    title: collapse(row.title),
    brand: collapse(row.brand),
    description: nonEmpty(row.description),
    currency: upper(row.currency),
    origin_country: upper(row.origin_country),
    images: cleanList(row.images, (s) => s.trim(), true),
    ships_to_countries: cleanList(row.ships_to_countries, (s) => s.trim().toUpperCase(), false),
    ships_to_regions: cleanList(row.ships_to_regions, (s) => s.trim(), false),
    affiliate_url: nonEmpty(row.affiliate_url),
  };
  const fields = NORMALIZABLE_FIELDS.filter(
    (f) => JSON.stringify(next[f] ?? null) !== JSON.stringify(row[f] ?? null)
  );
  return { row: next, fields };
}

/**
 * What a write may set back on a row that is not live: the changed fields
 * whose canonical value exists. An empty value turned missing is judged as
 * missing but never written (a NULL is not a canonical form of a title).
 */
export function writebackFields(normalized: CheckRow, fields: NormalizableField[]): Partial<Record<NormalizableField, unknown>> {
  const out: Partial<Record<NormalizableField, unknown>> = {};
  for (const f of fields) {
    if (normalized[f] != null) out[f] = normalized[f];
  }
  return out;
}

/** The supplier-mutable fields content_hash covers (attributes without the reserved keys). */
export const HASHED_FIELDS = [
  'title',
  'description',
  'price_cents',
  'compare_at_price_cents',
  'currency',
  'images',
  'affiliate_url',
  'origin_country',
  'ships_to_countries',
  'ships_to_regions',
  'category',
] as const;

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = stable((v as any)[k]);
    return o;
  }
  return v === undefined ? null : v;
}

/** sha256 over the canonical supplier-mutable fields. The routine's own write never changes it. */
export function contentHash(row: CheckRow): string {
  const n = normalizeRow(row).row;
  const payload: Record<string, unknown> = {};
  for (const f of HASHED_FIELDS) payload[f] = n[f] ?? null;
  payload.attributes = stripReservedAttributes((n.attributes as Record<string, unknown>) ?? {});
  return createHash('sha256').update(JSON.stringify(stable(payload))).digest('hex');
}

// =============================================================================
// 2. Required fields and money
// =============================================================================

/** ISO 4217 active alphabetic codes. */
export const ISO_4217: ReadonlySet<string> = new Set(
  (
    'AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD ' +
    'CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD ' +
    'GNF GTQ GYD HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT ' +
    'LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR ' +
    'NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP ' +
    'STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XCG ' +
    'XOF XPF YER ZAR ZMW ZWG'
  ).split(' ')
);

const kindOf = (row: CheckRow): 'product' | 'service' =>
  (row.attributes as Record<string, unknown> | null)?.kind === 'service' ? 'service' : 'product';

function zodErrors(row: CheckRow): CheckError[] {
  const candidate: Record<string, unknown> = {};
  const keys = [
    'title', 'description', 'brand', 'price_cents', 'currency', 'compare_at_price_cents', 'images',
    'affiliate_url', 'origin_country', 'ships_to_countries', 'ships_to_regions', 'availability',
    'category', 'subcategory', 'attributes',
  ] as const;
  for (const k of keys) {
    const v = (row as any)[k];
    if (v !== null && v !== undefined) candidate[k] = v;
  }
  const parsed = ProductSchema.safeParse(candidate);
  if (parsed.success) return [];
  const out: CheckError[] = [];
  for (const issue of parsed.error.issues) {
    const field = issue.path.length ? String(issue.path[0]) : null;
    let code: string;
    if (issue.code === 'custom') code = 'ships_nowhere';
    else if (issue.code === 'invalid_type' && (issue as any).received === 'undefined') code = 'required';
    else code = 'invalid_value';
    if (!out.some((e) => e.code === code && e.field === field)) out.push({ code, field, params: {} });
  }
  return out;
}

/** Steps 1–2 on an already-normalized row. */
export function validateRow(row: CheckRow): CheckError[] {
  const errors = zodErrors(row);
  const add = (code: string, field: string | null, params: Record<string, unknown> = {}) => {
    if (!errors.some((e) => e.code === code && e.field === field)) errors.push({ code, field, params });
  };
  // ProductSchema's ships-somewhere refine only runs once the fields parse, so it is checked here too.
  if (!shipsSomewhere({ ships_to_countries: row.ships_to_countries ?? undefined, ships_to_regions: row.ships_to_regions ?? undefined })) {
    add('ships_nowhere', 'ships_to_countries');
  }
  if (!isCompleteOffering(row)) add('incomplete_offering', null);
  const kind = kindOf(row);
  if (kind === 'product' && typeof row.price_cents === 'number' && !(Number.isInteger(row.price_cents) && row.price_cents > 0)) {
    add('price_not_positive', 'price_cents');
  }
  if (typeof row.currency === 'string' && row.currency.length === 3 && !ISO_4217.has(row.currency.toUpperCase())) {
    add('currency_not_iso4217', 'currency', { currency: row.currency });
  }
  if (
    typeof row.compare_at_price_cents === 'number' &&
    typeof row.price_cents === 'number' &&
    row.compare_at_price_cents < row.price_cents
  ) {
    add('compare_at_below_price', 'compare_at_price_cents');
  }
  if (kind === 'product' && (row.images?.length ?? 0) === 0) add('image_missing', 'images');
  return errors;
}

// =============================================================================
// 3. Duplicates within the supplier (S05)
// =============================================================================

/** Lower-case scheme and host, utm_* query parameters removed. Unparsable → the trimmed text. */
export function canonicalAffiliateUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  try {
    const u = new URL(raw.trim());
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    for (const k of [...u.searchParams.keys()]) {
      if (/^utm_/i.test(k)) u.searchParams.delete(k);
    }
    return u.toString();
  } catch {
    return raw.trim();
  }
}

export const titleKey = (t: string | null | undefined): string | null => {
  const c = collapse(t);
  return c ? c.toLowerCase() : null;
};

export interface DuplicateHit {
  duplicate_of: string;
  key: 'gtin' | 'sku' | 'affiliate_url' | 'title';
  other_title: string | null;
}

const older = (a: CheckRow, b: CheckRow): boolean => {
  const ta = a.created_at ?? '';
  const tb = b.created_at ?? '';
  return ta === tb ? a.id < b.id : ta < tb;
};

/**
 * Rows of ONE supplier (the caller groups by partner organization). The newer
 * row of a pair gets the hit, naming the oldest row it matches; keys in order.
 */
export function findDuplicates(rows: CheckRow[]): Map<string, DuplicateHit> {
  const hits = new Map<string, DuplicateHit>();
  const sorted = [...rows].sort((a, b) => (older(a, b) ? -1 : older(b, a) ? 1 : 0));
  const keyFns: Array<[DuplicateHit['key'], (r: CheckRow) => string | null]> = [
    ['gtin', (r) => (r.gtin && r.gtin.trim() ? `${r.merchant_id}|${r.gtin.trim()}` : null)],
    ['sku', (r) => (r.sku && r.sku.trim() ? `${r.merchant_id}|${r.sku.trim()}` : null)],
    ['affiliate_url', (r) => canonicalAffiliateUrl(r.affiliate_url)],
    ['title', (r) => titleKey(r.title)],
  ];
  const firstSeen = keyFns.map(() => new Map<string, CheckRow>());
  for (const r of sorted) {
    for (let i = 0; i < keyFns.length; i++) {
      const [key, fn] = keyFns[i];
      const k = fn(r);
      if (!k) continue;
      const first = firstSeen[i].get(k);
      if (first) {
        if (!hits.has(r.id)) hits.set(r.id, { duplicate_of: first.id, key, other_title: collapse(first.title) });
      } else {
        firstSeen[i].set(k, r);
      }
    }
  }
  return hits;
}

// =============================================================================
// 4. Media (S06)
// =============================================================================

export type ProbeOutcome =
  | { kind: 'ok' }
  | { kind: 'http_error'; status: number | null }
  | { kind: 'not_image'; content_type: string | null }
  | { kind: 'blocked' }
  | { kind: 'network_error' };

export type ImageProbe = (url: string) => Promise<ProbeOutcome>;

export const imagesToProbe = (row: CheckRow): string[] => (row.images ?? []).slice(0, MAX_IMAGES_PER_ROW);

/** True when more than OUTAGE_SHARE of the run's probes failed at the network level. */
export function isProbeOutage(outcomes: ProbeOutcome[]): boolean {
  if (outcomes.length === 0) return false;
  const network = outcomes.filter((o) => o.kind === 'network_error').length;
  return network / outcomes.length > OUTAGE_SHARE;
}

/** Media errors for one row's probe outcomes (index = position in images). Empty in an outage. */
export function mediaErrors(outcomes: ProbeOutcome[], outage: boolean): CheckError[] {
  if (outage) return [];
  const errors: CheckError[] = [];
  outcomes.forEach((o, index) => {
    if (o.kind === 'http_error') errors.push({ code: 'image_unreachable', field: 'images', params: { index, status: o.status } });
    else if (o.kind === 'network_error') errors.push({ code: 'image_unreachable', field: 'images', params: { index, reason: 'network' } });
    else if (o.kind === 'not_image') errors.push({ code: 'image_not_image', field: 'images', params: { index, content_type: o.content_type } });
    else if (o.kind === 'blocked') errors.push({ code: 'image_blocked', field: 'images', params: { index } });
  });
  return errors;
}

// =============================================================================
// 3 strikes and the result
// =============================================================================

export const fingerprintOf = (errors: CheckError[]): string => [...new Set(errors.map((e) => e.code))].sort().join('|');

export const isClaimFlag = (f: string): boolean => f.startsWith('claim_');

/**
 * Strikes count checks that failed the same way on the same content. A changed
 * row (content_hash) or a different set of error codes starts over at 1. In a
 * probe outage the previous strikes and fingerprint carry over unchanged.
 */
export function decide(
  prev: CatalogCheckResult | null,
  input: { content_hash: string; errors: CheckError[]; flags: string[]; outage: boolean }
): { state: CheckState; strikes: number; fingerprint: string } {
  const fingerprint = fingerprintOf(input.errors);
  if (input.errors.length === 0) {
    return { state: input.flags.some(isClaimFlag) ? 'needs_review' : 'ready_for_review', strikes: 0, fingerprint };
  }
  const sameRow = !!prev && prev.content_hash === input.content_hash;
  let strikes: number;
  let fp = fingerprint;
  if (input.outage && sameRow && prev!.strikes > 0) {
    strikes = prev!.strikes;
    fp = prev!.fingerprint;
  } else if (sameRow && prev!.fingerprint === fingerprint && prev!.strikes > 0) {
    strikes = prev!.strikes + 1;
  } else {
    strikes = 1;
  }
  return { state: strikes >= MAX_STRIKES ? 'returned_to_supplier' : 'needs_fix', strikes, fingerprint: fp };
}

/** A stored result, if it is one this version wrote. */
export function readResult(row: CheckRow): CatalogCheckResult | null {
  const cc = (row.attributes as Record<string, unknown> | null)?.catalog_check as CatalogCheckResult | undefined;
  return cc && typeof cc === 'object' && cc.v === CATALOG_CHECK_VERSION && typeof cc.state === 'string' ? cc : null;
}

/**
 * One row's full check, given its probe outcomes and whether the run is in a
 * probe outage. `duplicate` comes from findDuplicates over the supplier's rows.
 */
export function checkRow(
  raw: CheckRow,
  ctx: {
    now: Date;
    probes: ProbeOutcome[];
    outage: boolean;
    duplicate: DuplicateHit | null;
    claimCheck: (text: string, locale: string) => { flags: string[] };
  }
): { result: CatalogCheckResult; normalizedRow: CheckRow; normalizedFields: NormalizableField[] } {
  const { row, fields } = normalizeRow(raw);
  const errors = validateRow(row);
  if (ctx.duplicate) {
    errors.push({
      code: 'duplicate',
      field: ctx.duplicate.key,
      params: { key: ctx.duplicate.key, other_title: ctx.duplicate.other_title },
    });
  }
  errors.push(...mediaErrors(ctx.probes, ctx.outage));
  errors.sort((a, b) => (a.code === b.code ? String(a.field).localeCompare(String(b.field)) : a.code.localeCompare(b.code)));

  const flags = new Set<string>();
  const text = [row.title, row.description].filter(Boolean).join('\n');
  for (const f of ctx.claimCheck(text, '').flags) flags.add(f);
  if (ctx.outage && imagesToProbe(row).length > 0) flags.add('image_unchecked');
  const declared = (row.certifications ?? []).filter((c) => typeof c === 'string' && c.trim());
  if (declared.length > 0) flags.add('certifications_declared');

  const content_hash = contentHash(raw);
  const flagList = [...flags].sort();
  const d = decide(readResult(raw), { content_hash, errors, flags: flagList, outage: ctx.outage });
  const result: CatalogCheckResult = {
    v: 1,
    state: d.state,
    checked_at: ctx.now.toISOString(),
    content_hash,
    errors,
    flags: flagList,
    ...(ctx.duplicate ? { duplicate_of: ctx.duplicate.duplicate_of } : {}),
    normalized: fields,
    fingerprint: d.fingerprint,
    strikes: d.strikes,
  };
  return { result, normalizedRow: row, normalizedFields: fields };
}

// =============================================================================
// Candidate priority
// =============================================================================

export const RECHECK_NEEDS_FIX_AFTER_MS = 20 * 60 * 60 * 1000;
export const RECHECK_READY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ROWS_PER_RUN = 20;

/**
 * 1 = never checked, changed since the check (content_hash), or checked while
 *     images could not be probed;
 * 2 = needs_fix with strikes < 3, last check > 20 h ago;
 * 3 = ready_for_review last checked > 7 days ago (media re-check);
 * null = not due (returned_to_supplier or needs_review unchanged: a person acts next).
 */
export function priorityOf(row: CheckRow, now: Date): 1 | 2 | 3 | null {
  const prev = readResult(row);
  if (!prev) return 1;
  if (prev.content_hash !== contentHash(row)) return 1;
  if (prev.flags?.includes('image_unchecked')) return 1;
  const age = now.getTime() - Date.parse(prev.checked_at);
  if (prev.state === 'needs_fix' && prev.strikes < MAX_STRIKES && age > RECHECK_NEEDS_FIX_AFTER_MS) return 2;
  if (prev.state === 'ready_for_review' && age > RECHECK_READY_AFTER_MS) return 3;
  return null;
}

/** At most `cap` rows: by priority, then the oldest check first, then the oldest row. */
export function selectCandidates<T extends CheckRow>(rows: T[], now: Date, cap = MAX_ROWS_PER_RUN): T[] {
  const ranked = rows
    .map((r) => ({ r, p: priorityOf(r, now), at: readResult(r)?.checked_at ?? '' }))
    .filter((x): x is { r: T; p: 1 | 2 | 3; at: string } => x.p !== null);
  ranked.sort((a, b) => {
    if (a.p !== b.p) return a.p - b.p;
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    const ca = a.r.created_at ?? '';
    const cb = b.r.created_at ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a.r.id < b.r.id ? -1 : 1;
  });
  return ranked.slice(0, cap).map((x) => x.r);
}
