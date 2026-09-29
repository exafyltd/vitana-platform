/**
 * VTID-04731 — CSV catalogue import for partner onboarding
 * (docs/COMMERCE-SELF-SERVICE-PARTNER-ONBOARDING-SPEC.md §6.2).
 *
 * Pure: text in, validated product drafts and per-line errors out. The route
 * (routes/partner-onboarding-catalogue.ts) decides what to write.
 *
 * Every row is judged by the supplier portal's own ProductSchema, so a CSV row
 * can never be something the one-product form would refuse. The file format:
 *
 *   - a header row, one column per product field; column names are matched
 *     case-insensitively, and an unknown column is an error (a typo such as
 *     `affilate_url` would otherwise drop a required field without a word);
 *   - comma separated, or semicolon separated when the header has no comma
 *     (spreadsheets in German locales export that way);
 *   - RFC 4180 quoting (`"a, b"`, `""` for a quote inside a quoted field);
 *   - list columns (images, ships_to_countries, ships_to_regions) use `|`
 *     between items, since both field separators already mean something;
 *   - price as `price` in major units (`19.99` or `19,99`) or `price_cents`,
 *     never both. Major units are converted by string, never through a float.
 *
 * `attributes` (vertical-specific answers) are not a CSV column: they are
 * keyed per vertical and belong to the one-product form.
 */

import { ProductSchema, SHIPS_SOMEWHERE_MESSAGE } from '../routes/vcaop-portal-my-products';
import type { z, ZodIssue } from 'zod';

export const CSV_MAX_CHARS = 1_000_000;
export const CSV_MAX_ROWS = 500;
/** products.price_cents and compare_at_price_cents are Postgres `integer`. */
export const MAX_PRICE_CENTS = 2_147_483_647;

export type ProductDraft = z.infer<typeof ProductSchema>;

/**
 * VTID-04746: every error carries a stable `code` (+ `params`) next to its
 * English `message`, so the portal renders it in the partner's language
 * (CLAUDE.md: backend-supplied UI text ships a key and params, never a raw
 * string). `message` stays for logs and API callers.
 */
export type CsvErrorParams = Record<string, string | number>;

export type CsvFileErrorCode =
  | 'empty'
  | 'too_large'
  | 'no_header'
  | 'unknown_columns'
  | 'duplicate_columns'
  | 'missing_column'
  | 'missing_price_column'
  | 'no_rows'
  | 'too_many_rows'
  | 'unterminated_quote';

export type CsvRowErrorCode =
  | 'field_count'
  | 'price_both'
  | 'not_money'
  | 'not_cents'
  | 'amount_too_large'
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'wrong_length'
  | 'invalid_url'
  | 'invalid_choice'
  | 'ships_to_required'
  | 'invalid_value';

export interface CsvRowError {
  /** 1-based line in the file; the header is line 1. */
  line: number;
  field?: string;
  message: string;
  code: CsvRowErrorCode;
  params?: CsvErrorParams;
}

export interface CsvImportResult {
  /** A problem with the file as a whole: nothing in it can be judged row by row. */
  fileError: string | null;
  fileErrorCode: CsvFileErrorCode | null;
  fileErrorParams?: CsvErrorParams;
  rows: Array<{ line: number; product: ProductDraft }>;
  errors: CsvRowError[];
  columns: string[];
}

const TEXT_COLUMNS = [
  'title', 'description', 'brand', 'currency', 'affiliate_url',
  'origin_country', 'availability', 'category',
] as const;
const LIST_COLUMNS = ['images', 'ships_to_countries', 'ships_to_regions'] as const;
const MONEY_COLUMNS = ['price', 'price_cents', 'compare_at_price', 'compare_at_price_cents'] as const;

export const CSV_COLUMNS: readonly string[] = [...TEXT_COLUMNS, ...LIST_COLUMNS, ...MONEY_COLUMNS];

/** RFC 4180 records. Returns the records with the line each one starts on. */
export function parseCsv(text: string, delimiter: string): { records: Array<{ line: number; cells: string[] }>; error: string | null } {
  const records: Array<{ line: number; cells: string[] }> = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  let i = 0;
  const pushRecord = () => {
    cells.push(cell);
    // A blank line is not a record.
    if (!(cells.length === 1 && cells[0].trim() === '')) records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      if (ch === '\n') line += 1;
      cell += ch; i += 1; continue;
    }
    if (ch === '"' && cell === '') { quoted = true; i += 1; continue; }
    if (ch === delimiter) { cells.push(cell); cell = ''; i += 1; continue; }
    if (ch === '\r' && text[i + 1] === '\n') { i += 1; continue; }
    if (ch === '\n' || ch === '\r') {
      pushRecord();
      line += 1;
      recordLine = line;
      i += 1;
      continue;
    }
    cell += ch; i += 1;
  }
  if (quoted) return { records, error: `unterminated quoted field starting on line ${recordLine}` };
  if (cell !== '' || cells.length > 0) pushRecord();
  return { records, error: null };
}

/** `19.99` / `19,99` / `20` → 1999 / 1999 / 2000. Null when it is not a money amount. */
export function majorUnitsToCents(raw: string): number | null {
  const m = /^(\d{1,9})(?:[.,](\d{1,2}))?$/.exec(raw.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  return Number(m[1]) * 100 + Number(frac);
}

function splitList(raw: string): string[] {
  return raw.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
}

function detectDelimiter(firstLine: string): string {
  return !firstLine.includes(',') && firstLine.includes(';') ? ';' : ',';
}

function money(
  row: Record<string, string>,
  major: string,
  cents: string,
  line: number,
  errors: CsvRowError[],
): number | undefined {
  const m = row[major]?.trim() ?? '';
  const c = row[cents]?.trim() ?? '';
  if (m && c) {
    errors.push({ line, field: cents, message: `give ${major} or ${cents}, not both`, code: 'price_both', params: { major, cents } });
    return undefined;
  }
  let value: number | null = null;
  let field = major;
  if (m) {
    value = majorUnitsToCents(m);
    if (value === null) errors.push({ line, field: major, message: `not a money amount: ${m}`, code: 'not_money', params: { value: m } });
  } else if (c) {
    field = cents;
    value = /^\d{1,11}$/.test(c) ? Number(c) : null;
    if (value === null) errors.push({ line, field: cents, message: `not a whole number of cents: ${c}`, code: 'not_cents', params: { value: c } });
  }
  if (value === null) return undefined;
  // Checked here, not left to the insert: a dry run must reject what the
  // real import would fail on.
  if (value > MAX_PRICE_CENTS) {
    errors.push({ line, field, message: `amount too large (max ${MAX_PRICE_CENTS} cents)`, code: 'amount_too_large', params: { max: MAX_PRICE_CENTS } });
    return undefined;
  }
  return value;
}

export function parseCatalogueCsv(input: string): CsvImportResult {
  const empty = (
    code: CsvFileErrorCode,
    fileError: string,
    params?: CsvErrorParams,
    columns: string[] = [],
  ): CsvImportResult => ({ fileError, fileErrorCode: code, ...(params ? { fileErrorParams: params } : {}), rows: [], errors: [], columns });
  if (typeof input !== 'string' || input.trim() === '') return empty('empty', 'the file is empty');
  if (input.length > CSV_MAX_CHARS) {
    return empty('too_large', `the file is larger than ${CSV_MAX_CHARS} characters`, { max: CSV_MAX_CHARS });
  }

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
  const parsed = parseCsv(text, delimiter);
  if (parsed.error) {
    const line = Number(/line (\d+)/.exec(parsed.error)?.[1] ?? 0);
    return empty('unterminated_quote', parsed.error, { line });
  }
  const [header, ...data] = parsed.records;
  if (!header) return empty('no_header', 'the file has no header row');

  const columns = header.cells.map((c) => c.trim().toLowerCase());
  const unknown = columns.filter((c) => !CSV_COLUMNS.includes(c));
  if (unknown.length) {
    return empty('unknown_columns', `unknown column(s): ${unknown.join(', ')}`, { columns: unknown.join(', ') }, columns);
  }
  const dup = columns.filter((c, idx) => columns.indexOf(c) !== idx);
  if (dup.length) {
    const names = [...new Set(dup)].join(', ');
    return empty('duplicate_columns', `duplicate column(s): ${names}`, { columns: names }, columns);
  }
  for (const required of ['title', 'currency', 'affiliate_url', 'origin_country']) {
    if (!columns.includes(required)) {
      return empty('missing_column', `missing required column: ${required}`, { column: required }, columns);
    }
  }
  if (!columns.includes('price') && !columns.includes('price_cents')) {
    return empty('missing_price_column', 'missing required column: price or price_cents', undefined, columns);
  }
  if (data.length === 0) return empty('no_rows', 'the file has no product rows', undefined, columns);
  if (data.length > CSV_MAX_ROWS) {
    return empty(
      'too_many_rows',
      `the file has ${data.length} product rows; the limit is ${CSV_MAX_ROWS}`,
      { count: data.length, limit: CSV_MAX_ROWS },
      columns,
    );
  }

  const rows: CsvImportResult['rows'] = [];
  const errors: CsvRowError[] = [];
  for (const rec of data) {
    if (rec.cells.length !== columns.length) {
      errors.push({
        line: rec.line,
        message: `expected ${columns.length} fields, found ${rec.cells.length}`,
        code: 'field_count',
        params: { expected: columns.length, found: rec.cells.length },
      });
      continue;
    }
    const row: Record<string, string> = {};
    columns.forEach((c, idx) => { row[c] = rec.cells[idx]; });

    const before = errors.length;
    const candidate: Record<string, unknown> = {};
    for (const c of TEXT_COLUMNS) {
      const v = row[c]?.trim();
      if (v) candidate[c] = v;
    }
    for (const c of LIST_COLUMNS) {
      if (row[c] !== undefined) {
        const items = splitList(row[c]);
        if (items.length) candidate[c] = c === 'ships_to_countries' ? items.map((x) => x.toUpperCase()) : items;
      }
    }
    const price = money(row, 'price', 'price_cents', rec.line, errors);
    if (price !== undefined) candidate.price_cents = price;
    const compare = money(row, 'compare_at_price', 'compare_at_price_cents', rec.line, errors);
    if (compare !== undefined) candidate.compare_at_price_cents = compare;
    if (errors.length > before) continue;

    const result = ProductSchema.safeParse(candidate);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path.length ? String(issue.path[0]) : undefined;
        errors.push({ line: rec.line, field, message: issue.message, ...schemaIssueCode(issue) });
      }
      continue;
    }
    rows.push({ line: rec.line, product: result.data });
  }
  return { fileError: null, fileErrorCode: null, rows, errors, columns };
}

/** A product-schema issue as a stable code (+ params) the portal can translate. */
export function schemaIssueCode(issue: ZodIssue): { code: CsvRowErrorCode; params?: CsvErrorParams } {
  switch (issue.code) {
    case 'invalid_type':
      return { code: issue.received === 'undefined' ? 'required' : 'invalid_value' };
    case 'too_small':
      if (issue.exact) return { code: 'wrong_length', params: { length: Number(issue.minimum) } };
      if (issue.type === 'string' && Number(issue.minimum) === 1) return { code: 'required' };
      return { code: 'too_short', params: { min: Number(issue.minimum) } };
    case 'too_big':
      if (issue.exact) return { code: 'wrong_length', params: { length: Number(issue.maximum) } };
      return { code: 'too_long', params: { max: Number(issue.maximum) } };
    case 'invalid_string':
      return { code: issue.validation === 'url' ? 'invalid_url' : 'invalid_value' };
    case 'invalid_enum_value':
      return { code: 'invalid_choice', params: { options: issue.options.join(', ') } };
    case 'custom':
      return { code: issue.message === SHIPS_SOMEWHERE_MESSAGE ? 'ships_to_required' : 'invalid_value' };
    default:
      return { code: 'invalid_value' };
  }
}
