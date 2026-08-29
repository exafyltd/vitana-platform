/**
 * VTID-03795 — a guided-topic session must not ship the generic GUIDED JOURNEY
 * scaffold block.
 *
 * WHY (measured, not theorised). VTID-03787's `nova_instruction_debug_dump`
 * diag stage was used to pull the LITERAL Nova system-instruction text for a
 * real blocked guided session and a real succeeding ordinary session on
 * staging, then every dumped session over 7 days was bucketed by size against
 * its `nova_validation` outcome:
 *
 *   >= 32,768 bytes : 2 sessions, 2 BLOCKED (100%)   [33,766 / 33,778]
 *   <  32,768 bytes : 37 sessions, 5 blocked (13.5%) [max clean 32,431]
 *
 * — a clean gap, with no sample between 32,431 (clean) and 33,766 (blocked),
 * and the 13.5% matching the known ambient block rate. The two measured
 * sessions:
 *
 *   GUIDED (blocked) 34,206 UTF-8 bytes  → +1,438 over ~32,768
 *   ORDINARY (clean) 31,594 UTF-8 bytes  → -1,174 under
 *
 * `enforceInstructionBudget` cannot rescue this. It may only drop
 * `bootstrap`/`history`/`specialist`; BOTH dumps already carried
 * "[bootstrap context omitted...]", i.e. it had already trimmed everything it
 * is allowed to, and its own contract then returns the still-over-budget text
 * as-is ("best-effort send / fail-open"). So the payload ships and is refused.
 *
 * The generic GUIDED JOURNEY block measured 3,847 bytes — larger than the
 * 3,486 needed to bring the guided session under the guard's own 30,720-byte
 * budget. It is also, in this branch specifically, WRONG rather than merely
 * redundant: it instructs the model to call narrate_guided_session and speak
 * the returned script "word for word", while the guided-topic block in the
 * same prompt says the lesson was ALREADY narrated as audio and must NOT be
 * repeated. A tapped My Journey topic is additionally scoped to that ONE topic
 * (the block ends by calling end_guided_topic_teaching rather than drifting
 * into general conversation), so coaching the model to offer other sessions
 * also fights the intended scope.
 *
 * These tests pin: the block is suppressed for guided-topic sessions and
 * fully intact for every other session (no collateral damage), the
 * replacement keeps narrate_guided_session reachable, the contradictory
 * "word for word" directive is gone, and the detector cannot silently rot if
 * someone renames a heading.
 */

import { buildLiveSystemInstruction } from '../../../../src/orb/live/instruction/live-system-instruction';
import {
  buildGuidedTopicNarrationBlock,
  containsGuidedTopicNarrationBlock,
  GUIDED_TOPIC_NARRATION_BLOCK_HEADINGS,
} from '../../../../src/orb/live/instruction/guided-topic-narration-prompt';
import type { GuidedTopicNarrationContent } from '../../../../src/services/assistant-continuation/providers/guided-topic-narration';

/** The line that directly contradicts the guided-topic block. */
const CONTRADICTORY_DIRECTIVE = 'PLAYING A SESSION = SPEAKING ITS SCRIPT ALOUD';
/** Header of the full generic block. */
const FULL_BLOCK_HEADER = 'GUIDED JOURNEY — A COHERENT THROUGH-LINE';
const IDENTITY_LOCK = '=== IDENTITY LOCK ===';

const BASE_CONTENT: GuidedTopicNarrationContent = {
  topic_id: 'T001',
  topic_title: 'Vitanaland',
  voice_script: 'Vitanaland ist deine Langlebigkeits-Community.',
  explanation: { whatItIs: 'Eine Community', userBenefit: 'Du lernst', whenToUse: 'Täglich', tryThis: 'Schau rein' },
  practice_target: 'community',
  source: 'published',
};

function build(bootstrapContext: string): string {
  return buildLiveSystemInstruction(
    'de', 'conversational', bootstrapContext, 'community', '', '', false, null, '/', [], undefined, '@x',
  );
}

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

describe('VTID-03795: containsGuidedTopicNarrationBlock', () => {
  it('is false for empty / null / undefined / unrelated text', () => {
    expect(containsGuidedTopicNarrationBlock('')).toBe(false);
    expect(containsGuidedTopicNarrationBlock(null)).toBe(false);
    expect(containsGuidedTopicNarrationBlock(undefined)).toBe(false);
    expect(containsGuidedTopicNarrationBlock('some ordinary bootstrap context')).toBe(false);
  });

  // Drift guard — the detector matches on prose headings, so a rename in the
  // builder would silently turn it into a permanent no-op and quietly restore
  // the over-budget payload. Same failure shape VTID-03696 (workflow paths:
  // desynced for 30+ runs) and VTID-03706 (duplicated gate literals) both had
  // to add a parity test for.
  it('detects EVERY branch buildGuidedTopicNarrationBlock can emit (heading drift guard)', () => {
    const narrated: GuidedTopicNarrationContent = {
      ...BASE_CONTENT,
      narrationAudio: { audioB64: 'YQ==', sampleRateHz: 16000 },
    };
    const branches = [
      buildGuidedTopicNarrationBlock(narrated, 'de'),      // post-narration, German
      buildGuidedTopicNarrationBlock(narrated, 'en'),      // post-narration, English
      buildGuidedTopicNarrationBlock(BASE_CONTENT, 'de'),  // legacy teach, German
      buildGuidedTopicNarrationBlock(BASE_CONTENT, 'en'),  // legacy teach, English
    ];
    for (const branch of branches) {
      expect(containsGuidedTopicNarrationBlock(branch)).toBe(true);
    }
    // And every declared heading is actually used by some branch — a stale
    // entry is as misleading as a missing one.
    for (const heading of GUIDED_TOPIC_NARRATION_BLOCK_HEADINGS) {
      expect(branches.some((b) => b.includes(heading))).toBe(true);
    }
  });
});

describe('VTID-03795: GUIDED JOURNEY scaffold suppression', () => {
  const guidedBootstrap = buildGuidedTopicNarrationBlock(
    { ...BASE_CONTENT, narrationAudio: { audioB64: 'YQ==', sampleRateHz: 16000 } },
    'de',
  );
  // Same bootstrap payload, heading neutralised, so the ONLY difference
  // between the two builds is this VTID's own branch — not bootstrap size.
  const ordinaryBootstrap = guidedBootstrap.replace('## GUIDE-MODUS (NACH DER LEKTION)', '## SOMETHING ELSE');

  it('drops the generic block (and its contradictory directive) on a guided-topic session', () => {
    const out = build(guidedBootstrap);
    expect(out).not.toContain(FULL_BLOCK_HEADER);
    expect(out).not.toContain(CONTRADICTORY_DIRECTIVE);
  });

  it('keeps narrate_guided_session reachable — capability is scoped, not removed', () => {
    const out = build(guidedBootstrap);
    expect(out).toContain('narrate_guided_session');
    expect(out).toContain('scoped to the ONE topic');
  });

  // The no-collateral-damage assertion. Every non-guided session must be
  // byte-for-byte what it was before this VTID.
  it('leaves the FULL block completely intact on a non-guided session', () => {
    const out = build(ordinaryBootstrap);
    expect(out).toContain(FULL_BLOCK_HEADER);
    expect(out).toContain(CONTRADICTORY_DIRECTIVE);
    expect(out).toContain('narrate_guided_session with session_number');
    expect(out).toContain('narrate_guided_session with topic_query');
  });

  it('leaves the rest of the prompt untouched in BOTH cases', () => {
    for (const out of [build(guidedBootstrap), build(ordinaryBootstrap)]) {
      expect(out).toContain(IDENTITY_LOCK);
      expect(out).toContain('PROACTIVE LEADERSHIP');
      expect(out).toContain('GREETING RULES (CRITICAL)');
      expect(out).toContain('VITANA NAVIGATOR');
    }
  });

  // The measurement this VTID exists for: the guided session must shed more
  // than the 1,438 bytes that took the real blocked session over ~32,768.
  it('sheds enough bytes to clear the measured overage (>= 3,000)', () => {
    const saved = bytes(build(ordinaryBootstrap)) - bytes(build(guidedBootstrap));
    expect(saved).toBeGreaterThanOrEqual(3_000);
  });
});
