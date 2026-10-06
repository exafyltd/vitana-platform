/**
 * VTID-04868 — Plan Sparring Gate: canonical plan text + hash (N6).
 *
 * The hash binds a sparring record to the exact plan the owner approved. It is
 * checked again at allocation (DB trigger compares final_plan_hash), at spec
 * approval and in PR CI, so EVERY implementation must produce identical bytes.
 * The algorithm, in order:
 *
 *   1. Take ONLY the text between the fixed markers `<!-- plan:begin -->` and
 *      `<!-- plan:end -->` (exactly one of each, begin before end). Planner
 *      responses, notes and anything outside the markers are not hashed.
 *   2. Strip a leading BOM (U+FEFF).
 *   3. Unicode NFC normalisation.
 *   4. CRLF → LF, then any lone CR → LF.
 *   5. Strip trailing whitespace (spaces/tabs/other \s except the newline) on
 *      every line.
 *   6. Drop leading and trailing blank lines; collapse every run of 2+ blank
 *      lines into a single blank line.
 *   7. Exactly one trailing newline.
 *   8. sha256 over the UTF-8 bytes, lowercase hex.
 *
 * Pure, no I/O. Exported for the route, the reconciler and tests.
 */

import { createHash } from 'crypto';

export const PLAN_BEGIN_MARKER = '<!-- plan:begin -->';
export const PLAN_END_MARKER = '<!-- plan:end -->';

export type ExtractResult =
  | { ok: true; body: string }
  | { ok: false; error: 'markers_missing' | 'markers_duplicated' | 'markers_out_of_order' };

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

/** Step 1: the raw text between the markers (not yet canonicalised). */
export function extractPlanBody(text: string): ExtractResult {
  const begins = countOccurrences(text, PLAN_BEGIN_MARKER);
  const ends = countOccurrences(text, PLAN_END_MARKER);
  if (begins === 0 || ends === 0) return { ok: false, error: 'markers_missing' };
  if (begins > 1 || ends > 1) return { ok: false, error: 'markers_duplicated' };
  const b = text.indexOf(PLAN_BEGIN_MARKER);
  const e = text.indexOf(PLAN_END_MARKER);
  if (e < b) return { ok: false, error: 'markers_out_of_order' };
  return { ok: true, body: text.slice(b + PLAN_BEGIN_MARKER.length, e) };
}

/** Steps 2–7 applied to an already-extracted body. */
export function canonicalizePlanBody(body: string): string {
  let t = body.replace(/^﻿/, '');
  t = t.normalize('NFC');
  t = t.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = t.split('\n').map((l) => l.replace(/[^\S\n]+$/u, ''));
  const out: string[] = [];
  for (const line of lines) {
    const blank = line.length === 0;
    if (blank && (out.length === 0 || out[out.length - 1].length === 0)) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1].length === 0) out.pop();
  return out.join('\n') + '\n';
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export type CanonicalPlan =
  | { ok: true; canonical: string; hash: string }
  | { ok: false; error: string };

/** Full pipeline: markers → canonical text → sha256. */
export function canonicalPlanHash(text: string): CanonicalPlan {
  if (typeof text !== 'string') return { ok: false, error: 'plan_not_text' };
  // The BOM may precede the begin marker; strip it before locating markers.
  const extracted = extractPlanBody(text.replace(/^﻿/, ''));
  if (!extracted.ok) return { ok: false, error: extracted.error };
  const canonical = canonicalizePlanBody(extracted.body);
  if (canonical.trim().length === 0) return { ok: false, error: 'plan_body_empty' };
  return { ok: true, canonical, hash: sha256Hex(canonical) };
}
