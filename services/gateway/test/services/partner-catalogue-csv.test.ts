/**
 * VTID-04731 — the CSV catalogue parser behind
 * POST /api/v1/partner-onboarding/:orgId/catalogue/products/import.
 */

import {
  CSV_MAX_CHARS,
  CSV_MAX_ROWS,
  MAX_PRICE_CENTS,
  majorUnitsToCents,
  parseCatalogueCsv,
  parseCsv,
  schemaIssueCode,
} from '../../src/services/partner-catalogue-csv';

const HEADER = 'title,price,currency,affiliate_url,origin_country,ships_to_countries';
const ROW = 'Omega 3,19.99,EUR,https://acme.example/p/omega,DE,DE';

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and blank lines', () => {
    const { records, error } = parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n"multi\nline",z\n', ',');
    expect(error).toBeNull();
    expect(records).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['x, y', 'say "hi"'] },
      { line: 4, cells: ['multi\nline', 'z'] },
    ]);
  });

  it('reports an unterminated quote', () => {
    expect(parseCsv('a\n"open', ',').error).toMatch(/unterminated quoted field starting on line 2/);
  });
});

describe('majorUnitsToCents', () => {
  it.each([
    ['19.99', 1999], ['19,99', 1999], ['20', 2000], ['0.5', 50], ['0,05', 5], ['1.10', 110],
  ])('%s -> %d', (raw, cents) => expect(majorUnitsToCents(raw)).toBe(cents));

  it.each(['', 'abc', '-1', '1.999', '1.2.3', '€5'])('%s is not a money amount', (raw) => {
    expect(majorUnitsToCents(raw)).toBeNull();
  });
});

describe('parseCatalogueCsv', () => {
  it('validates rows with the supplier ProductSchema', () => {
    const r = parseCatalogueCsv(`${HEADER}\n${ROW}`);
    expect(r.fileError).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{
      line: 2,
      product: expect.objectContaining({
        title: 'Omega 3', price_cents: 1999, currency: 'EUR', origin_country: 'DE',
        ships_to_countries: ['DE'], images: [], availability: 'in_stock', attributes: {},
      }),
    }]);
  });

  it('VTID-04783: carries category and subcategory columns through to the draft', () => {
    const r = parseCatalogueCsv(`${HEADER},category,subcategory\n${ROW},supplements,vitamins`);
    expect(r.fileError).toBeNull();
    expect(r.errors).toEqual([]);
    expect(r.rows[0].product).toEqual(expect.objectContaining({ category: 'supplements', subcategory: 'vitamins' }));
  });

  it('accepts semicolon files, a BOM, and case-insensitive headers', () => {
    const csv = '﻿Title;Price;Currency;Affiliate_URL;Origin_Country;Ships_To_Regions\nTee;12,50;eur;https://acme.example/t;de;EU|UK';
    const r = parseCatalogueCsv(csv);
    expect(r.fileError).toBeNull();
    expect(r.rows[0].product).toMatchObject({ price_cents: 1250, currency: 'EUR', ships_to_regions: ['EU', 'UK'] });
  });

  it('accepts price_cents instead of price, but not both', () => {
    const ok = parseCatalogueCsv(`title,price_cents,currency,affiliate_url,origin_country,ships_to_countries\nA,500,EUR,https://a.example,DE,DE`);
    expect(ok.rows[0].product.price_cents).toBe(500);
    const both = parseCatalogueCsv(`title,price,price_cents,currency,affiliate_url,origin_country,ships_to_countries\nA,5,500,EUR,https://a.example,DE,DE`);
    expect(both.errors).toEqual([{
      line: 2, field: 'price_cents', message: 'give price or price_cents, not both',
      code: 'price_both', params: { major: 'price', cents: 'price_cents' },
    }]);
  });

  it('rejects prices the integer column cannot hold, in both forms', () => {
    const h = 'title,price,price_cents,currency,affiliate_url,origin_country,ships_to_countries';
    const r = parseCatalogueCsv(`${h}\nA,21474836.47,,EUR,https://a.example,DE,DE\nB,21474836.48,,EUR,https://a.example,DE,DE\nC,,2147483648,EUR,https://a.example,DE,DE`);
    expect(r.rows.map((x) => x.line)).toEqual([2]);
    expect(r.errors).toEqual([
      { line: 3, field: 'price', message: `amount too large (max ${MAX_PRICE_CENTS} cents)`, code: 'amount_too_large', params: { max: MAX_PRICE_CENTS } },
      { line: 4, field: 'price_cents', message: `amount too large (max ${MAX_PRICE_CENTS} cents)`, code: 'amount_too_large', params: { max: MAX_PRICE_CENTS } },
    ]);
  });

  it('reports schema errors per line and field, including the ships-to rule', () => {
    const r = parseCatalogueCsv(`${HEADER}\n${ROW}\nNo ship,1,EUR,https://a.example,DE,\n,1,EUR,nope,DE,DE`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual(expect.arrayContaining([
      { line: 3, field: 'ships_to_countries', message: expect.stringMatching(/ships_to_countries or ships_to_regions/), code: 'ships_to_required' },
      { line: 4, field: 'title', message: expect.any(String), code: 'required' },
      { line: 4, field: 'affiliate_url', message: expect.any(String), code: 'invalid_url' },
    ]));
  });

  it('reports a row with the wrong number of fields', () => {
    const r = parseCatalogueCsv(`${HEADER}\nA,1,EUR`);
    expect(r.errors).toEqual([{ line: 2, message: 'expected 6 fields, found 3', code: 'field_count', params: { expected: 6, found: 3 } }]);
  });

  it.each([
    ['', 'the file is empty', 'empty', undefined],
    [HEADER, 'the file has no product rows', 'no_rows', undefined],
    [`${HEADER},affilate_url\n${ROW},x`, 'unknown column(s): affilate_url', 'unknown_columns', { columns: 'affilate_url' }],
    [`title,title,price,currency,affiliate_url,origin_country\nA,A,1,EUR,https://a.example,DE`, 'duplicate column(s): title', 'duplicate_columns', { columns: 'title' }],
    [`title,price,currency,origin_country\nA,1,EUR,DE`, 'missing required column: affiliate_url', 'missing_column', { column: 'affiliate_url' }],
    [`title,currency,affiliate_url,origin_country\nA,EUR,https://a.example,DE`, 'missing required column: price or price_cents', 'missing_price_column', undefined],
    ['a\n"open', 'unterminated quoted field starting on line 2', 'unterminated_quote', { line: 2 }],
  ])('file error: %j', (csv, message, code, params) => {
    const r = parseCatalogueCsv(csv);
    expect(r.fileError).toBe(message);
    expect(r.fileErrorCode).toBe(code);
    expect(r.fileErrorParams).toEqual(params);
    expect(r.rows).toEqual([]);
  });

  it('enforces the row and size limits', () => {
    const tooMany = [HEADER, ...Array.from({ length: CSV_MAX_ROWS + 1 }, () => ROW)].join('\n');
    expect(parseCatalogueCsv(tooMany).fileError).toBe(`the file has ${CSV_MAX_ROWS + 1} product rows; the limit is ${CSV_MAX_ROWS}`);
    expect(parseCatalogueCsv(tooMany)).toMatchObject({ fileErrorCode: 'too_many_rows', fileErrorParams: { count: CSV_MAX_ROWS + 1, limit: CSV_MAX_ROWS } });
    const atLimit = [HEADER, ...Array.from({ length: CSV_MAX_ROWS }, () => ROW)].join('\n');
    expect(parseCatalogueCsv(atLimit).rows).toHaveLength(CSV_MAX_ROWS);
    expect(parseCatalogueCsv('x'.repeat(CSV_MAX_CHARS + 1)).fileError).toMatch(/larger than/);
    expect(parseCatalogueCsv('x'.repeat(CSV_MAX_CHARS + 1)).fileErrorCode).toBe('too_large');
  });
});

describe('schemaIssueCode (VTID-04746)', () => {
  it.each([
    [{ code: 'invalid_type', received: 'undefined', expected: 'string', path: [], message: '' }, { code: 'required' }],
    [{ code: 'invalid_type', received: 'number', expected: 'string', path: [], message: '' }, { code: 'invalid_value' }],
    [{ code: 'too_small', type: 'string', minimum: 1, inclusive: true, exact: false, path: [], message: '' }, { code: 'required' }],
    [{ code: 'too_small', type: 'string', minimum: 2, inclusive: true, exact: true, path: [], message: '' }, { code: 'wrong_length', params: { length: 2 } }],
    [{ code: 'too_small', type: 'number', minimum: 0, inclusive: true, exact: false, path: [], message: '' }, { code: 'too_short', params: { min: 0 } }],
    [{ code: 'too_big', type: 'string', maximum: 512, inclusive: true, exact: false, path: [], message: '' }, { code: 'too_long', params: { max: 512 } }],
    [{ code: 'invalid_string', validation: 'url', path: [], message: '' }, { code: 'invalid_url' }],
    [{ code: 'invalid_enum_value', options: ['in_stock', 'unknown'], received: 'x', path: [], message: '' }, { code: 'invalid_choice', params: { options: 'in_stock, unknown' } }],
    [{ code: 'custom', path: [], message: 'something else' }, { code: 'invalid_value' }],
  ])('%j', (issue, expected) => {
    expect(schemaIssueCode(issue as never)).toEqual(expected);
  });

  it('every row error the parser returns carries a code', () => {
    const r = parseCatalogueCsv(`${HEADER}\n,1,eur,nope,DEU,DE\nB,x,EUR,https://a.example,DE,DE`);
    expect(r.errors.length).toBeGreaterThan(0);
    for (const e of r.errors) expect(typeof e.code).toBe('string');
  });
});
