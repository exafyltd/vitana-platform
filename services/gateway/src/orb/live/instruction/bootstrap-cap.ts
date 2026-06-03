/**
 * Bootstrap context hard cap — Phase A (ORB Memory Resilience, BOOTSTRAP-orb-bootstrap-cap).
 *
 * THE SAFETY NET. Heavy community users accumulate `memory_items` + `memory_facts`
 * until the post-login Vertex `system_instruction` exceeds the ~32 KB Vertex Live API
 * budget. When that happens Vertex silently fails setup → no TTS frames → "Vitana
 * won't talk". This module guarantees that the bootstrap-context contribution to the
 * instruction can never exceed a fixed character budget, regardless of how much a
 * user has accumulated.
 *
 * This is intentionally defensive, NOT optimal: it does not decide WHICH content is
 * most useful (that is Phase B — relevance-ranked retrieval). It only guarantees that
 * SOMETHING coherent fits. The top of the bootstrap (identity, role, recent activity —
 * per vitana-brain ordering) is preserved; older trailing content is dropped first.
 *
 * Pure + side-effect free so it can be unit-tested in isolation and reused by any
 * caller (Vertex path today; auditable for the LiveKit agent's own assembly later).
 */

/**
 * Maximum number of characters the bootstrap context may contribute to the Vertex
 * `system_instruction`. 12 KB leaves comfortable headroom under the ~32 KB Vertex
 * Live setup budget once the static prompt scaffold, tool catalog, navigator policy,
 * and conversation history are added.
 */
export const BOOTSTRAP_CONTEXT_MAX_CHARS = 12_000;

/**
 * Sentinel appended in place of trimmed content so the model (and any human reading
 * a captured instruction) knows truncation happened rather than silently believing
 * the context was complete.
 */
export const TRIM_SENTINEL = (omitted: number): string =>
  `\n[context trimmed: ${omitted} chars of older context omitted to fit budget]`;

export interface BootstrapCapResult {
  /** The (possibly trimmed) bootstrap text, guaranteed <= max + sentinel length. */
  text: string;
  /** Number of characters removed from the original. 0 when nothing was trimmed. */
  trimmedChars: number;
}

/**
 * Cap a bootstrap-context string to a maximum character budget.
 *
 * Trims from the BOTTOM (older / lower-priority content) and appends a sentinel so the
 * truncation is explicit. When the input is already within budget it is returned
 * unchanged with `trimmedChars === 0`.
 *
 * The wake-brief override sentinel (`<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>`) and the
 * identity/role/recent-activity preamble live at the TOP of the bootstrap, so keeping
 * the head preserves them.
 *
 * @param input The full bootstrap context (may be empty).
 * @param max   Character budget. Defaults to {@link BOOTSTRAP_CONTEXT_MAX_CHARS}.
 */
export function capBootstrapContext(
  input: string,
  max: number = BOOTSTRAP_CONTEXT_MAX_CHARS,
): BootstrapCapResult {
  if (!input || input.length <= max) {
    return { text: input ?? '', trimmedChars: 0 };
  }
  const trimmedChars = input.length - max;
  const text = input.slice(0, max) + TRIM_SENTINEL(trimmedChars);
  return { text, trimmedChars };
}
