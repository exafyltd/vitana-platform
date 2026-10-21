/**
 * VTID-05153 — the supplier catalogue check's deterministic rules
 * (services/catalog-check/validators.ts, claim-prescreen.ts): normalizer,
 * required/money checks at their boundaries, duplicate keys in order, media
 * outcomes and the outage guard, the claim pre-screen, strikes, and the
 * candidate priority.
 */
import {
  canonicalAffiliateUrl,
  CatalogCheckResult,
  checkRow,
  CheckRow,
  contentHash,
  decide,
  findDuplicates,
  imagesToProbe,
  isProbeOutage,
  mediaErrors,
  normalizeRow,
  priorityOf,
  ProbeOutcome,
  selectCandidates,
  validateRow,
  writebackFields,
} from '../src/services/catalog-check/validators';
import { CLAIM_PATTERNS, prescreenClaims } from '../src/services/catalog-check/claim-prescreen';

const NOW = new Date('2026-10-14T13:00:00Z');
const HOUR = 3600 * 1000;

function row(over: Partial<CheckRow> = {}): CheckRow {
  return {
    id: 'p-1',
    merchant_id: 'm-1',
    title: 'Magnesium Glycinate 400 mg',
    description: 'Supports normal muscle function.',
    brand: 'Acme',
    price_cents: 2490,
    compare_at_price_cents: null,
    currency: 'EUR',
    images: ['https://img.example.com/a.jpg'],
    affiliate_url: 'https://shop.example.com/products/mag',
    origin_country: 'DE',
    ships_to_countries: ['DE', 'AT'],
    ships_to_regions: null,
    availability: 'in_stock',
    category: 'supplements',
    subcategory: null,
    attributes: { kind: 'product', source: 'mcp' },
    gtin: null,
    sku: null,
    certifications: [],
    is_active: false,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}
const codes = (r: CheckRow) => validateRow(normalizeRow(r).row).map((e) => e.code);

describe('normalize (S02): lossless, idempotent, nothing invented', () => {
  it('trims and collapses title/brand, upper-cases ISO codes, drops empty strings, de-duplicates images', () => {
    const { row: n, fields } = normalizeRow(row({
      title: '  Magnesium   Glycinate\t400 mg ',
      brand: ' Acme  Labs ',
      currency: 'eur',
      origin_country: 'de',
      ships_to_countries: ['de', '', 'at'],
      images: ['https://img.example.com/a.jpg', '', 'https://img.example.com/a.jpg', 'https://img.example.com/b.jpg'],
    }));
    expect(n).toMatchObject({
      title: 'Magnesium Glycinate 400 mg',
      brand: 'Acme Labs',
      currency: 'EUR',
      origin_country: 'DE',
      ships_to_countries: ['DE', 'AT'],
      images: ['https://img.example.com/a.jpg', 'https://img.example.com/b.jpg'],
    });
    expect(fields.sort()).toEqual(['brand', 'currency', 'images', 'origin_country', 'ships_to_countries', 'title']);
  });

  it('is idempotent and changes nothing on a clean row', () => {
    const once = normalizeRow(row({ title: ' a  b ' })).row;
    const twice = normalizeRow(once);
    expect(twice.row).toEqual(once);
    expect(twice.fields).toEqual([]);
    expect(normalizeRow(row()).fields).toEqual([]);
  });

  it('invents nothing: a blank title becomes missing (an error), and is never written back', () => {
    const { row: n, fields } = normalizeRow(row({ title: '   ', description: '' }));
    expect(n.title).toBeNull();
    expect(n.description).toBeNull();
    expect(codes(row({ title: '   ' }))).toContain('required');
    expect(writebackFields(n, fields)).toEqual({});
  });

  it('leaves price, availability, category and other attributes alone', () => {
    const r = row({ price_cents: 0, attributes: { kind: 'product', dose: ' 2 caps ' } });
    const n = normalizeRow(r).row;
    expect(n.price_cents).toBe(0);
    expect(n.attributes).toEqual(r.attributes);
    expect(n.category).toBe('supplements');
  });
});

describe('required fields and money, at their boundaries', () => {
  it('a complete product passes', () => {
    expect(codes(row())).toEqual([]);
  });
  it('price 0 fails for a product (stricter than isCompleteOffering) but not for a service', () => {
    expect(codes(row({ price_cents: 0 }))).toEqual(['price_not_positive']);
    expect(codes(row({ price_cents: 1 }))).toEqual([]);
    expect(codes(row({ price_cents: 0, images: [], attributes: { kind: 'service' } }))).toEqual([]);
  });
  it('compare-at below price fails, equal passes', () => {
    expect(codes(row({ compare_at_price_cents: 2489 }))).toEqual(['compare_at_below_price']);
    expect(codes(row({ compare_at_price_cents: 2490 }))).toEqual([]);
  });
  it('a 3-letter code that is not ISO 4217 fails; a lower-case valid one is normalized first', () => {
    expect(codes(row({ currency: 'EUX' }))).toEqual(['currency_not_iso4217']);
    expect(codes(row({ currency: 'usd' }))).toEqual([]);
    expect(codes(row({ currency: 'EURO' }))).toEqual(expect.arrayContaining(['invalid_value', 'incomplete_offering']));
  });
  it('no image fails for a product', () => {
    expect(codes(row({ images: [] }))).toEqual(['image_missing']);
  });
  it('missing required fields come back as codes with the field, never text', () => {
    const errs = validateRow(normalizeRow(row({ affiliate_url: null, ships_to_countries: null })).row);
    expect(errs).toEqual(expect.arrayContaining([
      { code: 'required', field: 'affiliate_url', params: {} },
      { code: 'ships_nowhere', field: 'ships_to_countries', params: {} },
      { code: 'incomplete_offering', field: null, params: {} },
    ]));
    for (const e of errs) expect(Object.keys(e).sort()).toEqual(['code', 'field', 'params']);
  });
});

describe('duplicates within the supplier (S05), keys in order', () => {
  const a = row({ id: 'p-a', created_at: '2026-10-01T00:00:00Z', title: 'Zinc', affiliate_url: 'https://Shop.Example.com/z?utm_source=x', gtin: '4001', sku: 'S1' });
  it('gtin first, the newer row names the older', () => {
    const b = row({ id: 'p-b', created_at: '2026-10-02T00:00:00Z', title: 'Other', affiliate_url: 'https://other.example.com/', gtin: '4001' });
    expect(findDuplicates([b, a]).get('p-b')).toEqual({ duplicate_of: 'p-a', key: 'gtin', other_title: 'Zinc' });
    expect(findDuplicates([b, a]).has('p-a')).toBe(false);
  });
  it('gtin only counts under the same merchant', () => {
    const b = row({ id: 'p-b', merchant_id: 'm-2', created_at: '2026-10-02T00:00:00Z', title: 'Other', affiliate_url: 'https://other.example.com/', gtin: '4001' });
    expect(findDuplicates([a, b]).has('p-b')).toBe(false);
  });
  it('sku second', () => {
    const b = row({ id: 'p-b', created_at: '2026-10-02T00:00:00Z', title: 'Other', affiliate_url: 'https://other.example.com/', sku: 'S1' });
    expect(findDuplicates([a, b]).get('p-b')?.key).toBe('sku');
  });
  it('canonical affiliate_url third (host case, utm_* stripped)', () => {
    const b = row({ id: 'p-b', created_at: '2026-10-02T00:00:00Z', title: 'Other', affiliate_url: 'https://shop.example.com/z?utm_campaign=y' });
    expect(canonicalAffiliateUrl('https://Shop.Example.com/z?utm_source=x&id=1')).toBe('https://shop.example.com/z?id=1');
    expect(findDuplicates([a, b]).get('p-b')).toMatchObject({ duplicate_of: 'p-a', key: 'affiliate_url' });
  });
  it('normalized title last', () => {
    const b = row({ id: 'p-b', created_at: '2026-10-02T00:00:00Z', title: '  zinc ', affiliate_url: 'https://other.example.com/' });
    expect(findDuplicates([a, b]).get('p-b')).toMatchObject({ duplicate_of: 'p-a', key: 'title' });
  });
  it('a duplicate is a needs_fix error carrying the other row’s title; the id stays internal', () => {
    const out = checkRow(row({ id: 'p-b' }), {
      now: NOW, probes: [{ kind: 'ok' }], outage: false, claimCheck: prescreenClaims,
      duplicate: { duplicate_of: 'p-a', key: 'title', other_title: 'Zinc' },
    });
    expect(out.result.state).toBe('needs_fix');
    expect(out.result.duplicate_of).toBe('p-a');
    expect(out.result.errors).toContainEqual({ code: 'duplicate', field: 'title', params: { key: 'title', other_title: 'Zinc' } });
  });
});

describe('media (S06) outcomes and the outage guard', () => {
  it('maps each failing probe to a code; ok probes add nothing', () => {
    const o: ProbeOutcome[] = [
      { kind: 'ok' },
      { kind: 'http_error', status: 404 },
      { kind: 'not_image', content_type: 'text/html' },
      { kind: 'blocked' },
      { kind: 'network_error' },
    ];
    expect(mediaErrors(o, false).map((e) => [e.code, e.params.index])).toEqual([
      ['image_unreachable', 1],
      ['image_not_image', 2],
      ['image_blocked', 3],
      ['image_unreachable', 4],
    ]);
  });
  it('probes at most 3 images per row', () => {
    expect(imagesToProbe(row({ images: ['https://a/1', 'https://a/2', 'https://a/3', 'https://a/4'] }))).toHaveLength(3);
  });
  it('more than half of the probes failing at the network level is an outage; exactly half is not', () => {
    const net: ProbeOutcome = { kind: 'network_error' };
    const ok: ProbeOutcome = { kind: 'ok' };
    expect(isProbeOutage([net, net, ok])).toBe(true);
    expect(isProbeOutage([net, ok])).toBe(false);
    expect(isProbeOutage([])).toBe(false);
    expect(isProbeOutage([{ kind: 'http_error', status: 404 }, { kind: 'http_error', status: 404 }])).toBe(false);
  });
  it('in an outage the row records image_unchecked, gets no image error and no strike', () => {
    const prev: CatalogCheckResult = {
      v: 1, state: 'needs_fix', checked_at: '2026-10-13T13:00:00Z', content_hash: contentHash(row({ price_cents: 0 })),
      errors: [], flags: [], normalized: [], fingerprint: 'price_not_positive', strikes: 2,
    };
    const r = row({ price_cents: 0, attributes: { ...row().attributes, catalog_check: prev } });
    const out = checkRow(r, { now: NOW, probes: [{ kind: 'network_error' }], outage: true, duplicate: null, claimCheck: prescreenClaims });
    expect(out.result.flags).toContain('image_unchecked');
    expect(out.result.errors.map((e) => e.code)).toEqual(['price_not_positive']);
    expect(out.result.strikes).toBe(2);
    expect(out.result.state).toBe('needs_fix');
  });
});

describe('claim pre-screen (S03): EN/DE hits and misses, a flag never verifies or blocks', () => {
  it.each([
    ['Cures cancer naturally', 'claim_disease_en'],
    ['Helps prevent heart disease', 'claim_disease_en'],
    ['Diabetes is what this formula treats', 'claim_disease_en'],
    ['Heilt Arthrose in 30 Tagen', 'claim_disease_de'],
    ['Wirkt gegen Krebs', 'claim_disease_de'],
    ['Um Alzheimer vorzubeugen: beugt Demenz vor', 'claim_disease_de'],
  ])('%s → %s', (text, flag) => {
    expect(prescreenClaims(text, 'en').flags).toContain(flag);
  });

  it.each([
    'Supports normal muscle function.',
    'Trägt zu einer normalen Funktion des Immunsystems bei.',
    'Vegan capsules, 120 per pack.',
    'Dog treats with salmon',
  ])('no flag: %s', (text) => {
    expect(prescreenClaims(text, 'de').flags).toEqual([]);
  });

  it('a claim flag only routes to needs_review; there is no "verified" state and no block', () => {
    const out = checkRow(row({ description: 'Cures cancer.' }), { now: NOW, probes: [{ kind: 'ok' }], outage: false, duplicate: null, claimCheck: prescreenClaims });
    expect(out.result.state).toBe('needs_review');
    expect(out.result.errors).toEqual([]);
    expect(out.result.strikes).toBe(0);
    expect(JSON.stringify(out.result)).not.toMatch(/verified/i);
    // Copy is never edited.
    expect(out.normalizedRow.description).toBe('Cures cancer.');
    expect(CLAIM_PATTERNS.length).toBeGreaterThan(0);
  });

  it('declared certifications are recorded as declared, never verified, and change no state', () => {
    const out = checkRow(row({ certifications: ['GMP'] }), { now: NOW, probes: [{ kind: 'ok' }], outage: false, duplicate: null, claimCheck: prescreenClaims });
    expect(out.result.flags).toEqual(['certifications_declared']);
    expect(out.result.state).toBe('ready_for_review');
  });
});

describe('strikes: the same fingerprint three times returns the row; an edit resets', () => {
  const r = row({ price_cents: 0 });
  const hash = contentHash(r);
  const err = [{ code: 'price_not_positive', field: 'price_cents', params: {} }];
  const res = (over: Partial<CatalogCheckResult>): CatalogCheckResult => ({
    v: 1, state: 'needs_fix', checked_at: 'x', content_hash: hash, errors: err, flags: [], normalized: [], fingerprint: 'price_not_positive', strikes: 1, ...over,
  });

  it('1 → 2 → 3 = returned_to_supplier', () => {
    expect(decide(null, { content_hash: hash, errors: err, flags: [], outage: false })).toEqual({ state: 'needs_fix', strikes: 1, fingerprint: 'price_not_positive' });
    expect(decide(res({ strikes: 1 }), { content_hash: hash, errors: err, flags: [], outage: false }).strikes).toBe(2);
    expect(decide(res({ strikes: 2 }), { content_hash: hash, errors: err, flags: [], outage: false })).toEqual({
      state: 'returned_to_supplier', strikes: 3, fingerprint: 'price_not_positive',
    });
  });
  it('an edit (content_hash differs) or a different error set starts over', () => {
    expect(decide(res({ strikes: 2, content_hash: 'other' }), { content_hash: hash, errors: err, flags: [], outage: false }).strikes).toBe(1);
    expect(decide(res({ strikes: 2, fingerprint: 'image_missing' }), { content_hash: hash, errors: err, flags: [], outage: false }).strikes).toBe(1);
  });
  it('a clean row has no strikes', () => {
    expect(decide(res({ strikes: 2 }), { content_hash: hash, errors: [], flags: [], outage: false })).toEqual({ state: 'ready_for_review', strikes: 0, fingerprint: '' });
  });
  it('content_hash ignores the reserved keys and whitespace-only edits, but sees a real edit', () => {
    expect(contentHash(row({ attributes: { kind: 'product', source: 'mcp', catalog_check: { x: 1 }, admin_listing: { d: 1 } } }))).toBe(contentHash(row()));
    expect(contentHash(row({ title: ' Magnesium  Glycinate 400 mg' }))).toBe(contentHash(row()));
    expect(contentHash(row({ price_cents: 2590 }))).not.toBe(contentHash(row()));
    expect(contentHash(row({ attributes: { kind: 'product', source: 'csv' } }))).not.toBe(contentHash(row()));
  });
});

describe('candidate priority and the cap', () => {
  const result = (r: CheckRow, over: Partial<CatalogCheckResult>): CheckRow => ({
    ...r,
    attributes: {
      ...(r.attributes ?? {}),
      catalog_check: { v: 1, state: 'ready_for_review', checked_at: NOW.toISOString(), content_hash: contentHash(r), errors: [], flags: [], normalized: [], fingerprint: '', strikes: 0, ...over },
    },
  });
  const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  it('unchecked and changed first, then needs_fix older than 20 h, then ready older than 7 days', () => {
    const unchecked = row({ id: 'u' });
    const changed = { ...result(row({ id: 'c' }), { checked_at: ago(HOUR) }), title: 'Edited title' };
    const fixOld = result(row({ id: 'f' }), { state: 'needs_fix', strikes: 1, checked_at: ago(21 * HOUR) });
    const fixFresh = result(row({ id: 'f2' }), { state: 'needs_fix', strikes: 1, checked_at: ago(19 * HOUR) });
    const readyOld = result(row({ id: 'r' }), { checked_at: ago(8 * 24 * HOUR) });
    const readyFresh = result(row({ id: 'r2' }), { checked_at: ago(6 * 24 * HOUR) });
    const returned = result(row({ id: 'x' }), { state: 'returned_to_supplier', strikes: 3, checked_at: ago(30 * 24 * HOUR) });
    const review = result(row({ id: 'n' }), { state: 'needs_review', checked_at: ago(30 * 24 * HOUR) });
    const unchecked2 = result(row({ id: 'i' }), { flags: ['image_unchecked'] });
    expect(priorityOf(unchecked, NOW)).toBe(1);
    expect(priorityOf(changed, NOW)).toBe(1);
    expect(priorityOf(unchecked2, NOW)).toBe(1);
    expect(priorityOf(fixOld, NOW)).toBe(2);
    expect(priorityOf(fixFresh, NOW)).toBeNull();
    expect(priorityOf(readyOld, NOW)).toBe(3);
    expect(priorityOf(readyFresh, NOW)).toBeNull();
    expect(priorityOf(returned, NOW)).toBeNull();
    expect(priorityOf(review, NOW)).toBeNull();
    const picked = selectCandidates([readyOld, fixOld, returned, changed, unchecked, review, readyFresh], NOW);
    expect(picked.map((r) => r.id)).toEqual(['u', 'c', 'f', 'r']);
  });

  it('an edit re-opens a returned row', () => {
    const returned = result(row({ id: 'x' }), { state: 'returned_to_supplier', strikes: 3 });
    expect(priorityOf({ ...returned, price_cents: 2990 }, NOW)).toBe(1);
  });

  it('caps at 20 rows per run', () => {
    const many = Array.from({ length: 45 }, (_, i) => row({ id: `p-${String(i).padStart(2, '0')}` }));
    const picked = selectCandidates(many, NOW);
    expect(picked).toHaveLength(20);
    expect(picked[0].id).toBe('p-00');
  });
});
