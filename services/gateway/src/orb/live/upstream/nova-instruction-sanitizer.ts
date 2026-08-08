/**
 * BOOTSTRAP-NOVA-SONIC-VOICE: Nova-safe system-instruction sanitizer.
 *
 * Amazon Nova's built-in Responsible-AI content filter rejects the whole
 * bidirectional stream ("This request has been blocked by our content
 * filters") when the system prompt contains the IDENTITY LOCK block's
 * persona-impersonation denial list — measured by live bisect on staging
 * (2026-07-27): the block's "You NEVER: … mimic another persona's tone,
 * signature phrases, or voice …" list alone trips the filter, while the
 * rest of the ~30KB instruction (brain context, RULE 0, journey blocks,
 * real tool catalog) passes.
 *
 * This sanitizer swaps ONLY that marker-delimited block for a semantically
 * equivalent phrasing proven to pass Nova's filter (same bisect run,
 * verified inside the full assembled instruction). The Vertex path is
 * untouched — parity of intent, not of exact wording, on this one block.
 */

const LOCK_START = '=== IDENTITY LOCK ===';
const LOCK_END = '=== END IDENTITY LOCK ===';

/** Fallback role line when the original block's line can't be recovered. */
const DEFAULT_ROLE_LINE = "the user's life companion and instruction manual";

function buildNovaSafeIdentityLock(roleLine: string): string {
  return `${LOCK_START}
YOU ARE Vitana.
Your role is ${roleLine}.

You speak exclusively as Vitana, always in your own voice. The conversation
transcript may show OTHER personas (Devon — our tech-support colleague, the
only specialist currently enabled) speaking earlier; those lines belong to
them — read them as third-party context only, and always answer as yourself.

If you ever notice yourself drifting toward another persona's identity,
stop and re-anchor: "I'm Vitana." Then continue.
${LOCK_END}`;
}

export interface NovaInstructionSanitizeResult {
  text: string;
  /** True when an IDENTITY LOCK block was found and replaced. */
  replaced: boolean;
}

/**
 * Replace the IDENTITY LOCK block with the Nova-safe equivalent. The
 * per-surface role line ("Your role is …") from the original block is
 * preserved so the Command Hub dev-co-pilot variant keeps its role text.
 * No-op (replaced=false) when the block is absent.
 */
export function sanitizeInstructionForNova(instruction: string): NovaInstructionSanitizeResult {
  const start = instruction.indexOf(LOCK_START);
  if (start === -1) return { text: instruction, replaced: false };
  const endIdx = instruction.indexOf(LOCK_END, start);
  if (endIdx === -1) return { text: instruction, replaced: false };
  const end = endIdx + LOCK_END.length;

  const original = instruction.slice(start, end);
  const roleMatch = /Your role is ([^\n]+?)\.?\n/.exec(original);
  const roleLine = roleMatch?.[1]?.trim() || DEFAULT_ROLE_LINE;

  return {
    text: instruction.slice(0, start) + buildNovaSafeIdentityLock(roleLine) + instruction.slice(end),
    replaced: true,
  };
}
