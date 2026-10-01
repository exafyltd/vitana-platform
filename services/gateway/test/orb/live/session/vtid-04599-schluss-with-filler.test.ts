/**
 * VTID-04599 — follow-up to VTID-04592. A bare "Schluss" already closed the
 * conversation on its own; "jetzt ist Schluss" or "ok, Schluss" still needed
 * Vitana to agree, so a refusal left the member stuck. "Schluss" with only
 * filler words around it is now unambiguous too. "Schluss" carrying content
 * ("zum Schluss noch eine Frage", "mach Schluss mit dem Thema") is not.
 */
import {
  detectUnambiguousUserStop,
  shouldEndConversationAfterTurn,
} from '../../../../src/orb/live/session/end-conversation-intent';

const REFUSAL = 'Ich verstehe, aber ich bin hier, um dir zu helfen.';

describe('VTID-04599 — "Schluss" with filler closes even when Vitana refuses', () => {
  it.each([
    'jetzt ist schluss',
    'Jetzt ist Schluss!',
    'ok, schluss',
    'Okay Schluss.',
    'so, schluss jetzt',
    'Schluss für heute',
    'und damit schluss',
    'gut, dann ist schluss',
    'Schluss jetzt bitte',
    // the VTID-04592 phrases still close
    'geh jetzt',
    'schalte ab',
    'schluss',
  ])('closes on "%s"', (u) => {
    expect(detectUnambiguousUserStop(u)).toBe(true);
    expect(shouldEndConversationAfterTurn(u, REFUSAL)).toBe(true);
  });

  it.each([
    'zum schluss noch eine frage',
    'mach schluss mit dem thema',
    'was ist der schlussstrich unter dem thema',
    'ist schluss mit dem training für heute ok',
    'ich habe schluss gemacht mit ihm',
    'hör auf',
  ])('does not close on its own for "%s"', (u) => {
    expect(detectUnambiguousUserStop(u)).toBe(false);
    expect(shouldEndConversationAfterTurn(u, REFUSAL)).toBe(false);
  });
});
