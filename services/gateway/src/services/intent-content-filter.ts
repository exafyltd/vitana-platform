/**
 * VTID-01973: Content filter (P2-A stub).
 *
 * Regex-based profanity + obvious-PII (phone, email, IBAN) detector.
 * Stricter rules for partner_seek and social_seek where PII leaks are
 * higher-stakes. P2-C swaps this for a real moderation service.
 */

import type { IntentKind } from './intent-classifier';

interface CheckResult {
  ok: boolean;
  reasons: string[];
}

const PROFANITY = [
  // English
  /\b(f[*u]ck|sh[*i]t|c[*u]nt|b[*i]tch|asshole|dick|pussy)\b/i,
  // German
  /\b(scheiße|arschloch|fotze|wichser)\b/i,
];

const PII_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PII_PHONE = /\b\+?\d[\d\s\-]{7,}\d\b/;
const PII_IBAN = /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/;

function isValidLuhn(value: string): boolean {
  let sum = 0;
  let shouldDouble = false;
  for (let i = value.length - 1; i >= 0; i--) {
    let digit = parseInt(value.charAt(i), 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

function detectPII(text: string): string[] {
  const found: string[] = [];
  if (PII_EMAIL.test(text)) found.push('email');
  if (PII_PHONE.test(text)) found.push('phone');
  if (PII_IBAN.test(text)) found.push('iban');

  const ccRegex = /\b(?:\d[ -]*){13,19}\b/g;
  let match;
  while ((match = ccRegex.exec(text)) !== null) {
    const digitsOnly = match[0].replace(/[ -]/g, '');
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19) {
      if (isValidLuhn(digitsOnly)) {
        found.push('credit_card');
        break;
      }
    }
  }

  return found;
}

function detectProfanity(text: string): boolean {
  return PROFANITY.some((rx) => rx.test(text));
}

export function checkIntentContent(args: {
  kind: IntentKind;
  title: string;
  scope: string;
}): CheckResult {
  const reasons: string[] = [];
  const blob = `${args.title} ${args.scope}`;

  // Profanity is always blocked.
  if (detectProfanity(blob)) reasons.push('profanity');

  const piiFound = detectPII(blob);
  if (piiFound.length > 0) {
    // partner_seek and social_seek: PII = hard reject (high-stakes privacy).
    if (args.kind === 'partner_seek' || args.kind === 'social_seek') {
      reasons.push(...piiFound.map((p) => `pii_${p}_blocked_strict`));
    } else {
      // Commercial / activity / mutual_aid: warn but allow — users sometimes
      // legitimately want to share contact info for a paid job. Log it though.
      reasons.push(...piiFound.map((p) => `pii_${p}_warning`));
    }
  }

  // Hard rejects: profanity OR strict PII.
  const hardReject = reasons.some((r) => r === 'profanity' || r.endsWith('_blocked_strict'));
  return { ok: !hardReject, reasons };
}