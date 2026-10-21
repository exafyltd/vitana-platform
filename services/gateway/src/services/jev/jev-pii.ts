/**
 * VTID-04473: PII handling before a state leaves for TypeSafe.
 *
 * TypeSafe is a third party; zero data retention is enterprise-only and no DPA
 * is signed yet (docs/JEV-INTEGRATION-PLAN.md, owner decision 3). Every
 * decision declares a policy:
 *   redact — emails, phone numbers and IBANs are replaced before sending
 *   forbid — the call is refused if any of them is present
 * Names and free-text identity are NOT detected here; that is exactly why
 * sending member content waits on the DPA, and why community is off.
 */

export type JevPiiPolicy = 'redact' | 'forbid';
export type JevPiiKind = 'email' | 'phone' | 'iban';

// A phone candidate needs 8+ digits and must not start with an ISO date
// (':' is outside the phone class, so '2026-09-25 10:15' arrives as '2026-09-25 10').
const isPhone = (m: string): boolean =>
  (m.match(/\d/g) || []).length >= 8 && !/^\d{4}-\d{2}-\d{2}(?!\d)/.test(m.trim());

const PATTERNS: Array<{ kind: JevPiiKind; re: RegExp; token: string; accept?: (m: string) => boolean }> = [
  { kind: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, token: '[email]' },
  // IBAN before phone: an IBAN's digit run would otherwise read as a phone number.
  { kind: 'iban', re: /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, token: '[iban]' },
  { kind: 'phone', re: /(?<![\w.])\+?\d[\d ()./-]{7,}\d(?![\w.])/g, token: '[phone]', accept: isPhone },
];

export function scanPii(text: string): JevPiiKind[] {
  const found = new Set<JevPiiKind>();
  for (const p of PATTERNS) {
    for (const m of text.match(p.re) || []) {
      if (!p.accept || p.accept(m)) {
        found.add(p.kind);
        break;
      }
    }
  }
  return [...found];
}

export function redactText(text: string): { text: string; redactions: number } {
  let out = text;
  let n = 0;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (m) => {
      if (p.accept && !p.accept(m)) return m;
      n++;
      return p.token;
    });
  }
  return { text: out, redactions: n };
}

/** Walks any JSON-shaped value and applies the policy to every string in it. */
export function applyPiiPolicy(
  value: unknown,
  policy: JevPiiPolicy,
): { ok: true; value: unknown; redactions: number } | { ok: false; kinds: JevPiiKind[] } {
  if (policy === 'forbid') {
    const kinds = new Set<JevPiiKind>();
    walk(value, (s) => {
      for (const k of scanPii(s)) kinds.add(k);
      return s;
    });
    return kinds.size ? { ok: false, kinds: [...kinds] } : { ok: true, value, redactions: 0 };
  }
  let total = 0;
  const redacted = walk(value, (s) => {
    const r = redactText(s);
    total += r.redactions;
    return r.text;
  });
  return { ok: true, value: redacted, redactions: total };
}

function walk(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => walk(v, fn));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, fn);
    return out;
  }
  return value;
}
