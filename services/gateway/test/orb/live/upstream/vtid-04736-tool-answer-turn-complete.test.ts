/**
 * VTID-04736: the answer to a tool result must complete its own turn.
 *
 * Production live-cbda9130 (2026-09-29): the member asked what Vitana had
 * stored about them; Nova called search_memory and spoke a filler line
 * around the call. The filler's END_TURN completed the turn, Nova's answer
 * arrived as a new ASSISTANT turn — and because an ASSISTANT block never
 * re-armed the turn latch (VTID-03592), the answer's END_TURN was swallowed.
 * isModelSpeaking stayed true and the 20s audio-stall watchdog killed and
 * reconnected the session.
 */

import { NovaOutputNormalizer } from '../../../../src/orb/live/upstream/nova-sonic-protocol';

function block(n: NovaOutputNormalizer, id: string, type: string, role: string, stage?: 'SPECULATIVE' | 'FINAL') {
  n.normalize({
    event: {
      contentStart: {
        contentId: id,
        type,
        role,
        ...(stage ? { additionalModelFields: JSON.stringify({ generationStage: stage }) } : {}),
      },
    },
  });
  return n.normalize({ event: { contentEnd: { contentId: id, type, stopReason: 'END_TURN' } } })
    .filter((e) => e.kind === 'turnComplete').length;
}

/** A spoken assistant turn in Nova's staged shape: SPECULATIVE text, FINAL text, audio. */
function spokenTurn(n: NovaOutputNormalizer, prefix: string): number {
  return block(n, `${prefix}-spec`, 'TEXT', 'ASSISTANT', 'SPECULATIVE')
    + block(n, `${prefix}-final`, 'TEXT', 'ASSISTANT', 'FINAL')
    + block(n, `${prefix}-audio`, 'AUDIO', 'ASSISTANT');
}

describe('VTID-04736: answer after a tool result completes its own turn', () => {
  it('filler line, tool result, answer: two turnCompletes (the live failure)', () => {
    const n = new NovaOutputNormalizer();
    n.normalize({ event: { contentStart: { contentId: 't1', type: 'TOOL', role: 'TOOL' } } });
    // Filler speech starts before the result is sent …
    n.normalize({
      event: {
        contentStart: {
          contentId: 'f-spec', type: 'TEXT', role: 'ASSISTANT',
          additionalModelFields: JSON.stringify({ generationStage: 'SPECULATIVE' }),
        },
      },
    });
    n.noteToolResultSent();
    // … and completes after it.
    const filler = n.normalize({ event: { contentEnd: { contentId: 'f-spec', type: 'TEXT', stopReason: 'END_TURN' } } })
      .filter((e) => e.kind === 'turnComplete').length
      + block(n, 'f-final', 'TEXT', 'ASSISTANT', 'FINAL')
      + block(n, 'f-audio', 'AUDIO', 'ASSISTANT');
    expect(filler).toBe(1);

    expect(spokenTurn(n, 'answer')).toBe(1);
  });

  it('without a tool result, a second assistant block stays part of the same turn (VTID-03592 unchanged)', () => {
    const n = new NovaOutputNormalizer();
    expect(spokenTurn(n, 'a') + spokenTurn(n, 'b')).toBe(1);
  });

  it('answer without a filler line: exactly one turnComplete', () => {
    const n = new NovaOutputNormalizer();
    n.normalize({ event: { contentStart: { contentId: 't1', type: 'TOOL', role: 'TOOL' } } });
    n.noteToolResultSent();
    expect(spokenTurn(n, 'answer')).toBe(1);
  });

  it('the FINAL tail of a filler after the result does not open a new turn', () => {
    const n = new NovaOutputNormalizer();
    n.normalize({ event: { contentStart: { contentId: 't1', type: 'TOOL', role: 'TOOL' } } });
    expect(block(n, 'f-spec', 'TEXT', 'ASSISTANT', 'SPECULATIVE')).toBe(1);
    n.noteToolResultSent();
    expect(block(n, 'f-final', 'TEXT', 'ASSISTANT', 'FINAL')).toBe(0);
    expect(block(n, 'f-audio', 'AUDIO', 'ASSISTANT')).toBe(0);
    expect(spokenTurn(n, 'answer')).toBe(1);
  });

  it('re-arms once per tool result, not for every later assistant turn', () => {
    const n = new NovaOutputNormalizer();
    n.noteToolResultSent();
    expect(spokenTurn(n, 'answer')).toBe(1);
    expect(spokenTurn(n, 'extra')).toBe(0);
  });
});
