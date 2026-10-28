/**
 * No-PII-leak guard (runbook Sec. 0.3 item 8, Sec. 3, Sec. 9).
 *
 * PII must NEVER reach: application/server logs, LLM prompts/model context,
 * tracing spans, browser-automation screenshots/recordings/DOM dumps, OASIS event
 * payloads, or test fixtures. This module redacts at the boundary and asserts the
 * absence of PII before a payload crosses into any of those sinks.
 */
import { PiiLeakError } from './errors';

export type PiiSink = 'log' | 'llm_prompt' | 'trace' | 'browser_artifact' | 'oasis_event' | 'fixture';

export const REDACTION = '[REDACTED]';

/** Field names treated as PII regardless of value (redacted, never asserted-through). */
const PII_FIELD_FRAGMENTS = [
  'email',
  'phone',
  'ssn',
  'tax_id',
  'taxid',
  'ein',
  'vat',
  'eori',
  'passport',
  'national_id',
  'dob',
  'date_of_birth',
  'birth',
  'address',
  'street',
  'postcode',
  'zip',
  'iban',
  'bank_account',
  'account_number',
  'routing',
  'card_number',
  'member_id',
  'full_name',
  'first_name',
  'last_name',
  'legal_name',
  'officer_name',
];

/** Value patterns that look like PII even in an unlabeled string. */
const PII_VALUE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/ },
  { name: 'iban', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/ },
  { name: 'credit_card', re: /\b(?:\d[ -]?){13,19}\b/ },
  { name: 'us_ssn', re: /\b\d{3}-\d{2}-\d{4}\b/ },
  { name: 'e164_phone', re: /\+\d{7,15}\b/ },
];

function isPiiFieldName(field: string): boolean {
  const f = field.toLowerCase();
  // A bare "*_ref" pointer to a vaulted value is allowed through.
  if (f.endsWith('_ref')) return false;
  return PII_FIELD_FRAGMENTS.some((frag) => f.includes(frag));
}

function valueLooksLikePii(value: string): string | null {
  for (const { name, re } of PII_VALUE_PATTERNS) {
    if (re.test(value)) return name;
  }
  return null;
}

/**
 * Deep-redact a payload: PII-named fields and PII-looking string values become
 * `[REDACTED]`. Returns a new object; input is not mutated. Use at every boundary
 * before logging/prompting/emitting.
 */
export function redact<T>(input: T): T {
  return _redact(input) as T;
}

function _redact(input: unknown): unknown {
  if (typeof input === 'string') {
    let out = input;
    for (const { re } of PII_VALUE_PATTERNS) {
      out = out.replace(new RegExp(re.source, 'g'), REDACTION);
    }
    return out;
  }
  if (input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(_redact);

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isPiiFieldName(key)) {
      out[key] = REDACTION;
    } else {
      out[key] = _redact(value);
    }
  }
  return out;
}

/** Collected PII findings for assertion error messages. */
function findPii(input: unknown, path: string, found: string[]): void {
  if (typeof input === 'string') {
    const hit = valueLooksLikePii(input);
    if (hit) found.push(`${path || '<root>'}: value looks like ${hit}`);
    return;
  }
  if (input === null || typeof input !== 'object') return;
  if (Array.isArray(input)) {
    input.forEach((v, i) => findPii(v, `${path}[${i}]`, found));
    return;
  }
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    if (isPiiFieldName(key)) {
      // A non-empty, non-redacted PII field is a leak.
      if (value !== undefined && value !== null && value !== REDACTION && value !== '') {
        found.push(`${here}: PII field present`);
      }
    }
    findPii(value, here, found);
  }
}

/**
 * Throw PiiLeakError if `payload` contains PII bound for `sink`. Call this right
 * before the payload crosses into a sink; if it throws, redact() first.
 */
export function assertNoPii(payload: unknown, sink: PiiSink): void {
  const found: string[] = [];
  findPii(payload, '', found);
  if (found.length > 0) {
    throw new PiiLeakError(
      `PII would leak into ${sink} (Sec. 9): ${found.slice(0, 5).join('; ')}` +
        (found.length > 5 ? ` (+${found.length - 5} more)` : ''),
    );
  }
}

/**
 * Scrub a browser-automation artifact (screenshot text/DOM dump/recording metadata)
 * to a PII-free form. Browser artifacts are scrubbed or discarded immediately after
 * use (Sec. 9). Returns the scrubbed artifact; asserts it is clean afterward.
 */
export function scrubBrowserArtifact<T>(artifact: T): T {
  const scrubbed = redact(artifact);
  assertNoPii(scrubbed, 'browser_artifact');
  return scrubbed;
}
