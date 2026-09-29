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

import { ProductSchema } from '../routes/vcaop-portal-my-products';
import type { z } from 'zod';

export const CSV_MAX_CHARS = 1_000_000;
export const CSV_MAX_ROWS = 500;

export type ProductDraft = z.infer<typeof ProductSchema>;

export interface CsvRowError {
  /** 1-based line in the file; the header is line 1. */
  line: number;
  field?: string;
  message: string;
}

export interface CsvImportResult {
  /** A problem with the file as a whole: nothing in it can be judged row by row. */
  fileError: string | null;
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
    errors.push({ line, field: cents, message: `give ${major} or ${cents}, not both` });
    return undefined;
  }
  if (m) {
    const v = majorUnitsToCents(m);
    if (v === null) errors.push({ line, field: major, message: `not a money amount: ${m}` });
    return v ?? undefined;
  }
  if (c) {
    if (!/^\d{1,11}$/.test(c)) {
      errors.push({ line, field: cents, message: `not a whole number of cents: ${c}` });
      return undefined;
    }
    return Number(c);
  }
  return undefined;
}

export function parseCatalogueCsv(input: string): CsvImportResult {
  const empty = (fileError: string, columns: string[] = []): CsvImportResult => ({ fileError, rows: [], errors: [], columns });
  if (typeof input !== 'string' || input.trim() === '') return empty('the file is empty');
  if (input.length > CSV_MAX_CHARS) return empty(`the file is larger than ${CSV_MAX_CHARS} characters`);

  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const delimiter = detectDelimiter(text.split(/\r?\n/, 1)[0] ?? '');
  const parsed = parseCsv(text, delimiter);
  if (parsed.error) return empty(parsed.error);
  const [header, ...data] = parsed.records;
  if (!header) return empty('the file has no header row');

  const columns = header.cells.map((c) => c.trim().toLowerCase());
  const unknown = columns.filter((c) => !CSV_COLUMNS.includes(c));
  if (unknown.length) return empty(`unknown column(s): ${unknown.join(', ')}`, columns);
  const dup = columns.filter((c, idx) => columns.indexOf(c) !== idx);
  if (dup.length) return empty(`duplicate column(s): ${[...new Set(dup)].join(', ')}`, columns);
  for (const required of ['title', 'currency', 'affiliate_url', 'origin_country']) {
    if (!columns.includes(required)) return empty(`missing required column: ${required}`, columns);
  }
  if (!columns.includes('price') && !columns.includes('price_cents')) {
    return empty('missing required column: price or price_cents', columns);
  }
  if (data.length === 0) return empty('the file has no product rows', columns);
  if (data.length > CSV_MAX_ROWS) return empty(`the file has ${data.length} product rows; the limit is ${CSV_MAX_ROWS}`, columns);

  const rows: CsvImportResult['rows'] = [];
  const errors: CsvRowError[] = [];
  for (const rec of data) {
    if (rec.cells.length !== columns.length) {
      errors.push({ line: rec.line, message: `expected ${columns.length} fields, found ${rec.cells.length}` });
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
        errors.push({ line: rec.line, field, message: issue.message });
      }
      continue;
    }
    rows.push({ line: rec.line, product: result.data });
  }
  return { fileError: null, rows, errors, columns };
}
