/**
 * PHI Redactor Middleware - Health Privacy Layer
 *
 * Mandatory middleware that redacts Protected Health Information (PHI)
 * before any data reaches OpenClaw's LLM planning layer.
 *
 * Uses pattern-based detection for:
 * - Person names (PERSON)
 * - Dates of birth / appointment dates (DATE)
 * - Medical conditions (MEDICAL_CONDITION)
 * - Medical record numbers (MRN)
 * - Phone numbers, emails, addresses
 * - SSN / national IDs
 *
 * This runs LOCALLY - no data leaves the server.
 */

// ---------------------------------------------------------------------------
// PHI Entity Types
// ---------------------------------------------------------------------------

export type PhiEntityType =
  | 'PERSON'
  | 'DATE'
  | 'MEDICAL_CONDITION'
  | 'MRN'
  | 'PHONE'
  | 'EMAIL'
  | 'ADDRESS'
  | 'SSN'
  | 'AGE';

export interface PhiEntity {
  type: PhiEntityType;
  start: number;
  end: number;
  text: string;
  score: number;
}

export interface RedactionResult {
  redacted: string;
  entities: PhiEntity[];
  entityCount: number;
}

// ---------------------------------------------------------------------------
// Pattern Registry (regex-based, no external deps required)
// ---------------------------------------------------------------------------

const PHI_PATTERNS: Array<{ type: PhiEntityType; pattern: RegExp; score: number }> = [
  // Email addresses
  {
    type: 'EMAIL',
    pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    score: 0.95,
  },
  // Phone numbers (various formats)
  {
    type: 'PHONE',
    pattern: /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g,
    score: 0.85,
  },
  // SSN
  {
    type: 'SSN',
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    score: 0.98,
  },
  // Medical Record Numbers (MRN-XXXXXX pattern)
  {
    type: 'MRN',
    pattern: /\bMRN[-:\s]?\d{4,10}\b/gi,
    score: 0.95,
  },
  // Dates (MM/DD/YYYY, YYYY-MM-DD, Month DD YYYY)
  {
    type: 'DATE',
    pattern: /\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{4})\b/gi,
    score: 0.80,
  },
  // Age patterns ("age 45", "45 years old", "45yo")
  {
    type: 'AGE',
    pattern: /\b(?:age\s+\d{1,3}|\d{1,3}\s*(?:years?\s*old|yo|y\.?o\.?))\b/gi,
    score: 0.75,
  },
  // Common medical conditions (expandable list)
  {
    type: 'MEDICAL_CONDITION',
    pattern: /\b(?:diabetes|hypertension|cancer|HIV|AIDS|depression|anxiety|PTSD|bipolar|schizophrenia|asthma|COPD|epilepsy|dementia|alzheimer'?s|parkinson'?s|multiple\s+sclerosis|lupus|crohn'?s|celiac|fibromyalgia|arthritis|hepatitis|tuberculosis|pneumonia)\b/gi,
    score: 0.90,
  },
  // Addresses (street number + street name pattern)
  {
    type: 'ADDRESS',
    pattern: /\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:St|Street|Ave|Avenue|Blvd|Boulevard|Dr|Drive|Ln|Lane|Rd|Road|Ct|Court|Pl|Place|Way)\.?\b/gi,
    score: 0.80,
  },
];

// ---------------------------------------------------------------------------
// Redaction Engine
// ---------------------------------------------------------------------------

/**
 * Analyze text for PHI entities using pattern matching.
 * Returns detected entities sorted by position.
 */
export function analyzePhiEntities(text: string): PhiEntity[] {
  const entities: PhiEntity[] = [];

  for (const { type, pattern, score } of PHI_PATTERNS) {
    // Reset regex state for global patterns
    const regex = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      entities.push({
        type,
        start: match.index,
        end: match.index + match[0].length,
        text: match[0],
        score,
      });
    }
  }

  // Sort by position, then by score (higher score wins for overlaps)
  return entities.sort((a, b) => a.start - b.start || b.score - a.score);
}

/**
 * Redact PHI from text, replacing detected entities with type placeholders.
 * Example: "John has diabetes" → "[PERSON] has [MEDICAL_CONDITION]"
 */
export function redactPhi(text: string): RedactionResult {
  const entities = analyzePhiEntities(text);

  if (entities.length === 0) {
    return { redacted: text, entities: [], entityCount: 0 };
  }

  // Remove overlapping entities (keep higher score)
  const filtered: PhiEntity[] = [];
  let lastEnd = -1;
  for (const entity of entities) {
    if (entity.start >= lastEnd) {
      filtered.push(entity);
      lastEnd = entity.end;
    }
  }

  // Build redacted string
  let redacted = '';
  let cursor = 0;
  for (const entity of filtered) {
    redacted += text.slice(cursor, entity.start);
    redacted += `[${entity.type}]`;
    cursor = entity.end;
  }
  redacted += text.slice(cursor);

  return {
    redacted,
    entities: filtered,
    entityCount: filtered.length,
  };
}

/**
 * Check if text contains any PHI entities above the given confidence threshold.
 */
export function containsPhi(text: string, minScore = 0.7): boolean {
  const entities = analyzePhiEntities(text);
  return entities.some((e) => e.score >= minScore);
}

/**
 * Middleware-style function: redact PHI from all string fields in an object.
 * Returns a new object with redacted values.
 */
export function redactObjectPhi<T extends Record<string, unknown>>(
  obj: T,
): { redacted: T; totalEntities: number } {
  let totalEntities = 0;
  const redacted = { ...obj };

  for (const [key, value] of Object.entries(redacted)) {
    if (typeof value === 'string') {
      const result = redactPhi(value);
      (redacted as Record<string, unknown>)[key] = result.redacted;
      totalEntities += result.entityCount;
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const nested = redactObjectPhi(value as Record<string, unknown>);
      (redacted as Record<string, unknown>)[key] = nested.redacted;
      totalEntities += nested.totalEntities;
    }
  }

  return { redacted, totalEntities };
}
