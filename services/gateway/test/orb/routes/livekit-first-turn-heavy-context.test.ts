/**
 * BOOTSTRAP-ORB-RCV-DOUBLEGREET — heavy-context survival of the LiveKit
 * first-turn suppression directive (Codex P2 fix).
 *
 * THE BUG this locks against:
 *   The LiveKit route (orb-livekit.ts) re-renders system_instruction for the
 *   first turn with a "## FIRST TURN — DO NOT SPEAK FIRST" directive so the
 *   model stays silent and the Python agent's session.say() owns turn-1.
 *
 *   Originally that directive was appended to the END of the bootstrap context
 *   that is passed into buildLiveSystemInstruction(). Inside the builder the
 *   bootstrap is run through capBootstrapContext() (BOOTSTRAP_CONTEXT_MAX_CHARS
 *   = 12 KB) which PRESERVES THE HEAD and TRIMS THE TAIL. So for an
 *   authenticated user whose bootstrapContext + behavioral rule exceeds 12 KB,
 *   the directive was sliced off the final system_instruction — while the
 *   earlier generic non-reconnect GREETING RULES still said "you MUST speak
 *   first with a warm, brief greeting" → the LLM produced an opener IN ADDITION
 *   to session.say() → the dragan3 double-greeting returned for heavy users.
 *
 * THE FIX (asserted here):
 *   - The sentinel marker lives at the HEAD of the bootstrap (survives the cap,
 *     so stripBrainOpenerSections + wakeBriefOverrideActive detection keep
 *     firing).
 *   - The "DO NOT SPEAK FIRST" directive is appended to the RETURNED
 *     system_instruction, OUTSIDE the bootstrap region the cap can trim — so it
 *     can never be trimmed away regardless of bootstrap size.
 *
 * This is a behavioral test: it drives buildLiveSystemInstruction() with the
 * exact composition the route uses and proves the directive survives a
 * 12 KB-busting bootstrap, while the OLD (tail-append) composition does not.
 */

import { buildLiveSystemInstruction } from '../../../src/orb/live/instruction/live-system-instruction';
import { BOOTSTRAP_CONTEXT_MAX_CHARS } from '../../../src/orb/live/instruction/bootstrap-cap';
import { VERTEX_WAKE_BRIEF_OVERRIDE_MARKER } from '../../../src/orb/live/instruction/wake-brief-marker';

// Mirrors the literal injected by orb-livekit.ts at the wake-brief re-render.
// Kept in sync via the source-text assertions in
// livekit-first-turn-single-source.test.ts.
const FIRST_TURN_SUPPRESSION_DIRECTIVE = `

## FIRST TURN — DO NOT SPEAK FIRST (LiveKit transport — BOOTSTRAP-ORB-RCV-DOUBLEGREET)

The client app plays the opening line for this session before you receive
control. You MUST NOT produce an opening utterance, greeting, or
proactive offer on your first turn — the user has already heard it.
Do NOT introduce yourself, do NOT list features, do NOT ask "How can I
help?", and do NOT repeat or paraphrase any greeting. Remain silent and
WAIT for the user to speak. Only then respond normally.

This block OVERRIDES every other greeting rule in this prompt for the
first turn only. Subsequent turns follow the normal conversation flow.`;

/** A bootstrap context large enough to blow past the 12 KB cap on its own,
 * the way a heavy authenticated user (lots of memory_items + memory_facts)
 * accumulates. Repeats a distinctive line so we can also assert the cap fired. */
function makeHeavyBootstrap(): string {
  const filler =
    '=== USER CONTEXT PROFILE ===\nThe user has a long accumulated memory history. ';
  const line = filler.repeat(40); // ~3.4 KB per chunk
  let out = '';
  while (out.length <= BOOTSTRAP_CONTEXT_MAX_CHARS + 8_000) {
    out += line + '\n';
  }
  return out;
}

describe('BOOTSTRAP-ORB-RCV-DOUBLEGREET heavy-context first-turn suppression survival', () => {
  const heavyBootstrap = makeHeavyBootstrap();

  beforeAll(() => {
    // Sanity: the bootstrap really does exceed the cap, otherwise the test
    // would pass vacuously (nothing trimmed).
    expect(heavyBootstrap.length).toBeGreaterThan(BOOTSTRAP_CONTEXT_MAX_CHARS);
  });

  it('FIXED composition: directive survives a >12 KB bootstrap (appended post-cap)', () => {
    // Reproduce the route's FIXED composition: marker at the HEAD of the
    // bootstrap, then append the directive to the RETURNED instruction.
    const augmentedContext =
      `${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}\n\n${heavyBootstrap}\n\nBEHAVIORAL_RULE_PLACEHOLDER`;

    let instruction = buildLiveSystemInstruction(
      'en',
      'friendly, calm, empathetic',
      augmentedContext,
      'COM',
      undefined,
      undefined,
      false, // isReconnect — non-reconnect LiveKit turn
      null,
      null,
      null,
      undefined,
      '@tester',
      true, // omitGreetingPolicy — LiveKit
    );
    instruction += FIRST_TURN_SUPPRESSION_DIRECTIVE;

    // The cap DID fire (heavy user) — proven by the trim sentinel.
    expect(instruction).toMatch(/context trimmed: \d+ chars of older context omitted/);

    // The load-bearing directive is STILL present in the final instruction.
    expect(instruction).toMatch(/DO NOT SPEAK FIRST/);
    expect(instruction).toMatch(/MUST NOT produce an opening utterance/);
    expect(instruction).toMatch(/WAIT for the user to speak/);

    // And it sits at the very END (recency primacy over the generic
    // "you MUST speak first" GREETING RULES higher up).
    expect(instruction.trimEnd().endsWith(
      'Subsequent turns follow the normal conversation flow.',
    )).toBe(true);
  });

  it('marker at the HEAD survives the cap so brain-opener stripping still fires', () => {
    const augmentedContext =
      `${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}\n\n${heavyBootstrap}`;

    const instruction = buildLiveSystemInstruction(
      'en',
      'friendly, calm, empathetic',
      augmentedContext,
      'COM',
      undefined,
      undefined,
      false,
      null,
      null,
      null,
      undefined,
      '@tester',
      true,
    );

    // Marker must survive — it drives stripBrainOpenerSections() +
    // wakeBriefOverrideActive detection in live-system-instruction.ts.
    expect(instruction).toContain(VERTEX_WAKE_BRIEF_OVERRIDE_MARKER);
  });

  it('REGRESSION GUARD: old tail-append composition would drop the directive', () => {
    // This proves the bug was real: appending the directive to the END of the
    // bootstrap (the pre-fix composition) gets it trimmed by the cap for a
    // heavy user, so it never reaches the final instruction.
    const oldStyleBootstrap =
      `${heavyBootstrap}\n\nBEHAVIORAL_RULE_PLACEHOLDER${FIRST_TURN_SUPPRESSION_DIRECTIVE}`;

    const instruction = buildLiveSystemInstruction(
      'en',
      'friendly, calm, empathetic',
      oldStyleBootstrap,
      'COM',
      undefined,
      undefined,
      false,
      null,
      null,
      null,
      undefined,
      '@tester',
      true,
    );

    // The cap fired and the tail (where the directive lived) was trimmed away.
    expect(instruction).toMatch(/context trimmed: \d+ chars of older context omitted/);
    expect(instruction).not.toMatch(/DO NOT SPEAK FIRST/);
  });

  it('non-reconnect omitGreetingPolicy build does NOT order the model to speak first', () => {
    // The generic GREETING RULES say "you MUST speak first" on a non-reconnect
    // turn. With the directive appended post-cap, the LAST word on the first
    // turn is "stay silent / WAIT for the user" — that is what the model obeys.
    const augmentedContext =
      `${VERTEX_WAKE_BRIEF_OVERRIDE_MARKER}\n\n${heavyBootstrap}`;
    let instruction = buildLiveSystemInstruction(
      'en',
      'friendly, calm, empathetic',
      augmentedContext,
      'COM',
      undefined,
      undefined,
      false,
      null,
      null,
      null,
      undefined,
      '@tester',
      true,
    );
    instruction += FIRST_TURN_SUPPRESSION_DIRECTIVE;

    const speakFirstIdx = instruction.lastIndexOf('MUST speak first');
    const silenceIdx = instruction.lastIndexOf('WAIT for the user to speak');
    // The silence directive must come AFTER any "speak first" instruction so it
    // wins on recency for the first turn.
    expect(silenceIdx).toBeGreaterThan(-1);
    if (speakFirstIdx > -1) {
      expect(silenceIdx).toBeGreaterThan(speakFirstIdx);
    }
  });
});
