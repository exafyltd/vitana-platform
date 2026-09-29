/**
 * VTID-04747: two shapes VTID-04736 did not cover, both from production
 * session live-11ec418b (2026-09-29). Each left the display on "Vitana
 * spricht" while she was silent, until the 20 s audio-stall watchdog killed
 * and reconnected the session.
 *
 * 1. 13:55:32: remember_fact failed validation in 5 ms, so the filler's own
 *    SPECULATIVE block came after the result. Covered by the soft turn end
 *    (test/orb/live/session/vtid-04747-soft-turn-end.test.ts).
 * 2. 13:57:40: the remember backstop sent Nova a text note after the turn
 *    had completed. Nothing re-armed the latch for its answer (13:57:43).
 */

import { NovaOutputNormalizer } from '../../../../src/orb/live/upstream/nova-sonic-protocol';

function start(n: NovaOutputNormalizer, id: string, type: string, role: string, stage?: 'SPECULATIVE' | 'FINAL') {
  n.normalize({
    event: {
      contentStart: {
        contentId: id, type, role,
        ...(stage ? { additionalModelFields: JSON.stringify({ generationStage: stage }) } : {}),
      },
    },
  });
}
function end(n: NovaOutputNormalizer, id: string, type: string): number {
  return n.normalize({ event: { contentEnd: { contentId: id, type, stopReason: 'END_TURN' } } })
    .filter((e) => e.kind === 'turnComplete').length;
}
function block(n: NovaOutputNormalizer, id: string, type: string, role: string, stage?: 'SPECULATIVE' | 'FINAL'): number {
  start(n, id, type, role, stage);
  return end(n, id, type);
}
function spokenTurn(n: NovaOutputNormalizer, p: string): number {
  return block(n, `${p}-spec`, 'TEXT', 'ASSISTANT', 'SPECULATIVE')
    + block(n, `${p}-final`, 'TEXT', 'ASSISTANT', 'FINAL')
    + block(n, `${p}-audio`, 'AUDIO', 'ASSISTANT');
}

describe('VTID-04747: every answer to a client send completes its own turn', () => {
  it('text note after a completed turn: its answer completes (live 13:57)', () => {
    const n = new NovaOutputNormalizer();
    expect(spokenTurn(n, 'reply')).toBe(1);
    n.noteClientTurnSent(); // remember backstop note
    expect(spokenTurn(n, 'answer-to-note')).toBe(1);
  });

  it('a send never splits one staged turn into two (VTID-03592 holds)', () => {
    const n = new NovaOutputNormalizer();
    expect(block(n, 's', 'TEXT', 'ASSISTANT', 'SPECULATIVE')).toBe(1);
    n.noteClientTurnSent();
    expect(block(n, 'f', 'TEXT', 'ASSISTANT', 'FINAL')).toBe(0);
    expect(block(n, 'a', 'AUDIO', 'ASSISTANT')).toBe(0);
  });

  it('re-arms once per send', () => {
    const n = new NovaOutputNormalizer();
    expect(spokenTurn(n, 'reply')).toBe(1);
    n.noteClientTurnSent();
    expect(spokenTurn(n, 'answer')).toBe(1);
    expect(spokenTurn(n, 'extra')).toBe(0);
  });
});
