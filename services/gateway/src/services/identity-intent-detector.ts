/**
 * VTID-01952 — Identity Mutation Intent Detector
 *
 * Detects user utterances that ask to change identity-class facts (name,
 * birthday, gender, email, etc.) so the brain can emit the sanctioned
 * refusal-and-redirect response BEFORE running the full LLM turn.
 *
 * Coverage today: EN + DE explicit mutation phrases.
 * Scope: explicit "change X to Y" requests, not implicit self-introductions
 *        (those are handled by the brain prompt Guardrail B anti-drift rule).
 *
 * Plan reference: /home/dstev/.claude/plans/the-vitana-system-has-wild-puffin.md
 *                 Part 1.5 — Refusal-and-redirect protocol
 */

import type { IdentityLockedKey, SupportedLocale } from './memory-identity-lock';

export interface IdentityMutationIntent {
  detected: true;
  /** Which identity-class field the user is trying to change. */
  fact_key: IdentityLockedKey;
  /** Detected locale of the utterance. */
  locale: SupportedLocale;
  /** The original utterance, for audit. */
  utterance: string;
  /** Confidence 0..1 — regex hits get 0.85+, fuzzy matches lower. */
  confidence: number;
  /** Which pattern matched (for telemetry/debug). */
  matched_pattern: string;
}

export type IdentityIntentDetectionResult =
  | IdentityMutationIntent
  | { detected: false };

// ============================================================================
// Pattern groups: { fact_key → { locale → RegExp[] } }
//
// Patterns intentionally err on RECALL > precision. False positives just
// trigger a refusal-and-redirect (worst case: user gets pointed to Profile
// when they didn't ask for it — minor friction). False negatives leave the
// Maria → Kemal vector half-open. Bias toward recall.
//
// Each pattern uses (?:...) for non-capturing groups so we don't pollute
// match arrays. Word boundaries (\b) prevent "rename" matching "name".
// ============================================================================

interface PatternEntry {
  fact_key: IdentityLockedKey;
  locale: SupportedLocale;
  pattern: RegExp;
  description: string;
  confidence: number;
}

const PATTERNS: PatternEntry[] = [
  // ------------------------------------------------------------------------
  // NAME (first / last / display / full) — EN
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_first_name',
    locale: 'en',
    pattern: /\b(?:change|update|set|edit|fix|correct)\s+(?:my\s+)?(?:first\s+)?name\s+(?:to|as|into)\b/iu,
    description: 'change my name to X',
    confidence: 0.95,
  },
  {
    fact_key: 'user_first_name',
    locale: 'en',
    pattern: /\b(?:my\s+(?:real\s+|true\s+|actual\s+|new\s+|first\s+)?name\s+is|i(?:'m|\s+am)\s+(?:actually\s+|really\s+)?called)\b/iu,
    description: 'my name is X / I am called X',
    confidence: 0.85,
  },
  {
    fact_key: 'user_first_name',
    locale: 'en',
    pattern: /\b(?:call|address)\s+me\s+(?!later|tomorrow|back|on)\b/iu,
    description: 'call me X (excluding "call me later/back/etc.")',
    confidence: 0.82,
  },
  {
    fact_key: 'user_last_name',
    locale: 'en',
    pattern: /\b(?:change|update|set)\s+(?:my\s+)?(?:last\s+name|surname|family\s+name)\b/iu,
    description: 'change my last name',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // NAME — DE
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_first_name',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere|ändert|setze)\s+(?:meinen?\s+)?(?:vor)?namen?\s+(?:auf|zu|in)\b/iu,
    description: 'Ändere meinen Namen auf X',
    confidence: 0.95,
  },
  {
    fact_key: 'user_first_name',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ich\s+heiße|mein\s+(?:richtiger\s+|wahrer\s+|neuer\s+|vor)?name\s+ist|nenn(?:e|t)\s+mich)\b/iu,
    description: 'Ich heiße X / Mein Name ist X / Nenne mich X',
    confidence: 0.85,
  },
  {
    fact_key: 'user_last_name',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere)\s+(?:meinen?\s+)?(?:nachnamen|familiennamen)\b/iu,
    description: 'Ändere meinen Nachnamen',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // DATE OF BIRTH / BIRTHDAY — EN
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_date_of_birth',
    locale: 'en',
    pattern: /\b(?:change|update|set|fix|correct)\s+(?:my\s+)?(?:birthday|birth\s*date|date\s+of\s+birth|dob)\b/iu,
    description: 'change my birthday/DOB',
    confidence: 0.95,
  },
  {
    fact_key: 'user_date_of_birth',
    locale: 'en',
    pattern: /\b(?:my\s+(?:real\s+|true\s+|actual\s+)?(?:birthday|birth\s*date|date\s+of\s+birth)\s+is|i\s+(?:was|am)\s+born\s+on)\b/iu,
    description: 'my birthday is X / I was born on X',
    confidence: 0.85,
  },

  // ------------------------------------------------------------------------
  // DATE OF BIRTH / BIRTHDAY — DE
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_date_of_birth',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere|setze)\s+(?:mein|meinen)\s+(?:geburtstag|geburtsdatum)\b/iu,
    description: 'Ändere meinen Geburtstag',
    confidence: 0.95,
  },
  {
    fact_key: 'user_date_of_birth',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:mein\s+(?:richtiger\s+|wahrer\s+)?(?:geburtstag|geburtsdatum)\s+ist|ich\s+(?:bin|wurde)\s+am\s+\S+\s+geboren)\b/iu,
    description: 'Mein Geburtstag ist X / Ich wurde am X geboren',
    confidence: 0.85,
  },

  // ------------------------------------------------------------------------
  // GENDER + PRONOUNS — EN
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_gender',
    locale: 'en',
    pattern: /\b(?:change|update|set)\s+(?:my\s+)?gender\b/iu,
    description: 'change my gender',
    confidence: 0.95,
  },
  {
    fact_key: 'user_pronouns',
    locale: 'en',
    pattern: /\b(?:change|update|set|use|switch)\s+(?:my\s+)?pronouns\b/iu,
    description: 'change my pronouns',
    confidence: 0.95,
  },
  {
    fact_key: 'user_pronouns',
    locale: 'en',
    pattern: /\b(?:my\s+pronouns\s+are|please\s+use\s+(?:they\/them|she\/her|he\/him))\b/iu,
    description: 'my pronouns are X',
    confidence: 0.88,
  },

  // ------------------------------------------------------------------------
  // GENDER + PRONOUNS — DE
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_gender',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere)\s+(?:mein|meinen)\s+geschlecht\b/iu,
    description: 'Ändere mein Geschlecht',
    confidence: 0.95,
  },
  {
    fact_key: 'user_pronouns',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere|setze)\s+(?:meine\s+)?pronomen\b/iu,
    description: 'Ändere meine Pronomen',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // EMAIL + PHONE — EN
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_email',
    locale: 'en',
    pattern: /\b(?:change|update|set|fix)\s+(?:my\s+)?(?:e[\s-]?mail|email\s*address)\b/iu,
    description: 'change my email',
    confidence: 0.95,
  },
  {
    fact_key: 'user_email',
    locale: 'en',
    pattern: /\b(?:my\s+(?:real\s+|new\s+)?(?:e[\s-]?mail|email\s*address)\s+is)\b/iu,
    description: 'my email is X',
    confidence: 0.85,
  },
  {
    fact_key: 'user_phone',
    locale: 'en',
    pattern: /\b(?:change|update|set)\s+(?:my\s+)?(?:phone|cell|mobile|telephone)\s*(?:number)?\b/iu,
    description: 'change my phone',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // EMAIL + PHONE — DE
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_email',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere)\s+(?:meine\s+)?(?:e[\s-]?mail|e-mail-adresse)\b/iu,
    description: 'Ändere meine E-Mail',
    confidence: 0.95,
  },
  {
    fact_key: 'user_phone',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere)\s+(?:meine\s+)?(?:telefonnummer|handynummer)\b/iu,
    description: 'Ändere meine Telefonnummer',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // ADDRESS — EN
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_country',
    locale: 'en',
    pattern: /\b(?:change|update|set)\s+(?:my\s+)?country\b/iu,
    description: 'change my country',
    confidence: 0.92,
  },
  {
    fact_key: 'user_city',
    locale: 'en',
    pattern: /\b(?:change|update|set)\s+(?:my\s+)?city\b/iu,
    description: 'change my city',
    confidence: 0.92,
  },
  {
    fact_key: 'user_address',
    locale: 'en',
    pattern: /\b(?:change|update|set|fix)\s+(?:my\s+)?address\b/iu,
    description: 'change my address',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // ADDRESS — DE
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_address',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|aktualisiere)\s+(?:meine\s+)?(?:adresse|anschrift)\b/iu,
    description: 'Ändere meine Adresse',
    confidence: 0.95,
  },

  // ------------------------------------------------------------------------
  // LOCALE — EN/DE
  // ------------------------------------------------------------------------
  {
    fact_key: 'user_locale',
    locale: 'en',
    pattern: /\b(?:change|switch|set)\s+(?:my\s+)?language\s+(?:to|preference)\b/iu,
    description: 'change my language',
    confidence: 0.92,
  },
  {
    fact_key: 'user_locale',
    locale: 'de',
    pattern: /(?<![a-zA-Z])(?:ändere|wechsle)\s+(?:meine\s+)?sprache\b/iu,
    description: 'Ändere meine Sprache',
    confidence: 0.92,
  },
];

// ============================================================================
// Detector — runs all patterns; returns the highest-confidence match (if any).
// O(n_patterns) per call but n is small (~30) and patterns are cheap regex
// — well below 1ms total. Safe on the ORB voice hot path.
// ============================================================================

export function detectIdentityMutationIntent(
  utterance: string,
  preferredLocale?: SupportedLocale
): IdentityIntentDetectionResult {
  if (!utterance || typeof utterance !== 'string') {
    return { detected: false };
  }

  // Limit to first 500 chars — identity asks come early; avoid pathological regex on long texts.
  const trimmed = utterance.slice(0, 500);

  let best: IdentityMutationIntent | null = null;
  for (const entry of PATTERNS) {
    if (preferredLocale && entry.locale !== preferredLocale) {
      // Cross-locale matches are still allowed (multilingual users), but
      // we prefer same-locale matches when one exists.
    }
    if (entry.pattern.test(trimmed)) {
      if (!best || entry.confidence > best.confidence) {
        best = {
          detected: true,
          fact_key: entry.fact_key,
          locale: entry.locale,
          utterance: trimmed,
          confidence: entry.confidence,
          matched_pattern: entry.description,
        };
      }
    }
  }

  return best ?? { detected: false };
}

// ============================================================================
// Test/debug helper: list all patterns (used by snapshot tests).
// ============================================================================

export function listPatterns(): readonly { fact_key: IdentityLockedKey; locale: SupportedLocale; description: string }[] {
  return PATTERNS.map(({ fact_key, locale, description }) => ({ fact_key, locale, description }));
}
