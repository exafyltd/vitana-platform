/**
 * VTID-04731 — the CSV catalogue parser behind
 * POST /api/v1/partner-onboarding/:orgId/catalogue/products/import.
 */

import {
  CSV_MAX_CHARS,
  CSV_MAX_ROWS,
  majorUnitsToCents,
  parseCatalogueCsv,
  parseCsv,
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
    expect(both.errors).toEqual([{ line: 2, field: 'price_cents', message: 'give price or price_cents, not both' }]);
  });

  it('reports schema errors per line and field, including the ships-to rule', () => {
    const r = parseCatalogueCsv(`${HEADER}\n${ROW}\nNo ship,1,EUR,https://a.example,DE,\n,1,EUR,nope,DE,DE`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors).toEqual(expect.arrayContaining([
      { line: 3, field: 'ships_to_countries', message: expect.stringMatching(/ships_to_countries or ships_to_regions/) },
      { line: 4, field: 'title', message: expect.any(String) },
      { line: 4, field: 'affiliate_url', message: expect.any(String) },
    ]));
  });

  it('reports a row with the wrong number of fields', () => {
    const r = parseCatalogueCsv(`${HEADER}\nA,1,EUR`);
    expect(r.errors).toEqual([{ line: 2, message: 'expected 6 fields, found 3' }]);
  });

  it.each([
    ['', 'the file is empty'],
    [HEADER, 'the file has no product rows'],
    [`${HEADER},affilate_url\n${ROW},x`, 'unknown column(s): affilate_url'],
    [`title,title,price,currency,affiliate_url,origin_country\nA,A,1,EUR,https://a.example,DE`, 'duplicate column(s): title'],
    [`title,price,currency,origin_country\nA,1,EUR,DE`, 'missing required column: affiliate_url'],
    [`title,currency,affiliate_url,origin_country\nA,EUR,https://a.example,DE`, 'missing required column: price or price_cents'],
  ])('file error: %j', (csv, message) => {
    const r = parseCatalogueCsv(csv);
    expect(r.fileError).toBe(message);
    expect(r.rows).toEqual([]);
  });

  it('enforces the row and size limits', () => {
    const tooMany = [HEADER, ...Array.from({ length: CSV_MAX_ROWS + 1 }, () => ROW)].join('\n');
    expect(parseCatalogueCsv(tooMany).fileError).toBe(`the file has ${CSV_MAX_ROWS + 1} product rows; the limit is ${CSV_MAX_ROWS}`);
    const atLimit = [HEADER, ...Array.from({ length: CSV_MAX_ROWS }, () => ROW)].join('\n');
    expect(parseCatalogueCsv(atLimit).rows).toHaveLength(CSV_MAX_ROWS);
    expect(parseCatalogueCsv('x'.repeat(CSV_MAX_CHARS + 1)).fileError).toMatch(/larger than/);
  });
});
