/**
 * VTID-04712: live B-SELF-02 (staging 7045c16, pass 7). The member had saved
 * "I'm allergic to penicillin"; in the next session "Worauf bin ich
 * allergisch?" got "Ich kann dir dabei helfen, deine Allergien zu überprüfen.
 * Lass mich kurz in deinen Aufzeichnungen nachsehen." and the turn ended.
 * The recall backstop never ran: "worauf" was no question word, and
 * "lass mich … nachsehen" was no deferral.
 */
import { detectRecallQuestion, replyDeniesOrDefers } from '../../../src/services/memory/recall-backstop';
import { maybeRunRecallBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const LIVE_REPLY =
  'Ich kann dir dabei helfen, deine Allergien zu überprüfen. Lass mich kurz in deinen Aufzeichnungen nachsehen.';

describe('VTID-04712 wo-compound questions and "lass mich nachsehen"', () => {
  it.each(['Worauf bin ich allergisch?', 'Wovon habe ich dir erzählt?', 'Warum bin ich müde?', 'Womit arbeite ich?'])(
    'a question about the member: %s',
    (q) => expect(detectRecallQuestion(q)).toBe(true),
  );

  it.each(['Worauf wartest du?', 'Ich bin allergisch gegen Nüsse.'])('not a question about the member: %s', (q) =>
    expect(detectRecallQuestion(q)).toBe(false),
  );

  it.each([LIVE_REPLY, 'Lass mich mal nachschauen.', 'Let me quickly check your records.', 'Daj da pogledam.'])(
    'a deferral: %s',
    (r) => expect(replyDeniesOrDefers(r)).toBe(true),
  );

  it('an answer is not a deferral', () => {
    expect(replyDeniesOrDefers('Du bist gegen Penicillin allergisch.')).toBe(false);
  });

  it('the live turn runs the backstop and offers the allergy fact', async () => {
    const session = {
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
    } as any;
    const n = await maybeRunRecallBackstop({ deps: { emitDiag: jest.fn() } }, session, 'Worauf bin ich allergisch?', LIVE_REPLY, {
      listCurrentFacts: jest.fn(async () => [{ fact_key: 'user_allergy', fact_value: 'penicillin', provenance_source: 'user_stated' }]),
    });
    expect(n).toBe(1);
    expect(session.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/penicillin/);
  });
});
