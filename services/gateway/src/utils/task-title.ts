/**
 * VTID Task Title Rules
 *
 * Format: "Area: Short description"
 * Examples: "ORB: Fix audio dropout", "Gateway: Add rate limiting"
 *
 * Rules:
 *  1. Area prefix required (one of SYSTEM_AREAS)
 *  2. Colon separator
 *  3. 8–60 characters total
 *  4. At least 2 words after the colon
 */

export const SYSTEM_AREAS = [
  'ORB',
  'Gateway',
  'Command Hub',
  'Pipeline',
  'Operator',
  'Auth',
  'Governance',
  'OASIS',
  'Memory',
  'Agents',
  'Infra',
  'Frontend',
] as const;

export type SystemArea = (typeof SYSTEM_AREAS)[number];

export const TITLE_MIN_LENGTH = 8;
export const TITLE_MAX_LENGTH = 60;

// Pre-build a lowercase lookup map for case-insensitive matching
const AREA_LOOKUP: Record<string, SystemArea> = {};
for (const area of SYSTEM_AREAS) {
  AREA_LOOKUP[area.toLowerCase()] = area;
}

/**
 * Validate a task title against the title rules.
 */
export function validateTaskTitle(title: string): { ok: boolean; error?: string } {
  const trimmed = (title || '').trim();

  if (trimmed.length < TITLE_MIN_LENGTH) {
    return { ok: false, error: `Title too short (min ${TITLE_MIN_LENGTH} chars). Use format: "Area: Short description"` };
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    return { ok: false, error: `Title too long (max ${TITLE_MAX_LENGTH} chars)` };
  }

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) {
    return { ok: false, error: `Title must start with a system area followed by colon. Example: "Gateway: Add rate limiting". Areas: ${SYSTEM_AREAS.join(', ')}` };
  }

  const rawArea = trimmed.slice(0, colonIdx).trim();
  const matched = AREA_LOOKUP[rawArea.toLowerCase()];
  if (!matched) {
    return { ok: false, error: `Unknown area "${rawArea}". Use one of: ${SYSTEM_AREAS.join(', ')}` };
  }

  const description = trimmed.slice(colonIdx + 1).trim();
  if (!description) {
    return { ok: false, error: 'Description after colon cannot be empty' };
  }

  const wordCount = description.split(/\s+/).filter(Boolean).length;
  if (wordCount < 2) {
    return { ok: false, error: 'Description needs at least 2 words. Example: "Fix audio dropout"' };
  }

  return { ok: true };
}

/**
 * Normalize a title: trim whitespace, fix area casing to canonical form.
 */
export function normalizeTaskTitle(title: string): string {
  const trimmed = (title || '').trim();
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx === -1) return trimmed;

  const rawArea = trimmed.slice(0, colonIdx).trim();
  const matched = AREA_LOOKUP[rawArea.toLowerCase()];
  if (!matched) return trimmed;

  const description = trimmed.slice(colonIdx + 1).trim();
  return `${matched}: ${description}`;
}

/**
 * Extract the system area from a valid title (returns null if not matched).
 */
export function extractArea(title: string): SystemArea | null {
  const colonIdx = (title || '').indexOf(':');
  if (colonIdx === -1) return null;
  const rawArea = title.slice(0, colonIdx).trim();
  return AREA_LOOKUP[rawArea.toLowerCase()] || null;
}

/**
 * Build a title from area + description, truncating if needed.
 */
export function buildTitle(area: SystemArea, description: string): string {
  const desc = (description || '').trim();
  const full = `${area}: ${desc}`;
  if (full.length <= TITLE_MAX_LENGTH) return full;
  // Truncate at word boundary
  const maxDesc = TITLE_MAX_LENGTH - area.length - 2; // "Area: " = area.length + 2
  const truncated = desc.slice(0, maxDesc);
  const lastSpace = truncated.lastIndexOf(' ');
  if (lastSpace > maxDesc * 0.6) {
    return `${area}: ${truncated.slice(0, lastSpace)}`;
  }
  return `${area}: ${truncated}`;
}

/**
 * Guess a system area from free text (keywords in description).
 * Used by Operator and Email paths to auto-detect area when user doesn't provide one.
 */
export function guessAreaFromText(text: string): SystemArea {
  const lower = (text || '').toLowerCase();

  const keywords: [RegExp, SystemArea][] = [
    [/\b(orb|voice|audio|microphone|speak|listen|gemini.?live)\b/, 'ORB'],
    [/\b(auth|login|logout|token|session|password|jwt|provision)\b/, 'Auth'],
    [/\b(command.?hub|board|task.?modal|dashboard|card)\b/, 'Command Hub'],
    [/\b(pipeline|autopilot|lifecycle|funnel|scheduling)\b/, 'Pipeline'],
    [/\b(operator|console|gemini.?operator)\b/, 'Operator'],
    [/\b(governance|rule|violation|evaluation)\b/, 'Governance'],
    [/\b(oasis|event|ledger|spec)\b/, 'OASIS'],
    [/\b(memory|knowledge|embedding|recall|indexer)\b/, 'Memory'],
    [/\b(agent|conductor|validator|crew)\b/, 'Agents'],
    [/\b(infra|deploy|cloud.?run|ci.?cd|docker|github.?action)\b/, 'Infra'],
    [/\b(frontend|lovable|mobile|app|ui|css|component|page)\b/, 'Frontend'],
    [/\b(gateway|api|route|endpoint|middleware|cors)\b/, 'Gateway'],
  ];

  for (const [pattern, area] of keywords) {
    if (pattern.test(lower)) return area;
  }

  return 'Gateway'; // safest default — most tasks touch the gateway
}
