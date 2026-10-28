/**
 * VTID-04705: a question about the member phrased with "ich", not "mein".
 * Live B-PROF-03 on staging, 2026-09-28: "Wann habe ich Geburtstag?" (no
 * birthday stored) got "Ich überprüfe das für dich. einen Moment bitte." and
 * the turn ended — the recall backstop never ran, because the detector only
 * knew possessives.
 */
import { detectRecallQuestion, replyDeniesOrDefers } from '../../../src/services/memory/recall-backstop';
import { maybeRunRecallBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const LIVE_REPLY = 'Ich überprüfe das für dich.  einen Moment bitte.';

describe('VTID-04705 first-person recall questions', () => {
  it.each(['wann habe ich geburtstag', 'Wann habe ich Geburtstag?', 'Wo wohne ich?', 'Wie alt bin ich?', 'When was I born?', 'Where do I work?', 'Do I have any allergies?', 'Am I allergic to peanuts?', 'Bin ich allergisch?', 'Habe ich ein Haustier?'])(
    'a question about the member: %s',
    (q) => expect(detectRecallQuestion(q)).toBe(true),
  );

  it.each(['Wie geht es dir?', 'Was kann ich heute machen?', 'Ich habe Hunger.', 'Merk dir, ich habe am 9. September Geburtstag', 'Was ich dir sagen wollte, ich habe heute frei.', 'Ich bin müde.'])(
    'not a recall question: %s',
    (q) => expect(detectRecallQuestion(q)).toBe(false),
  );

  it('the live B-PROF-03 turn runs the backstop and offers the stored facts', async () => {
    expect(replyDeniesOrDefers(LIVE_REPLY)).toBe(true);
    const session = {
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
    } as any;
    const n = await maybeRunRecallBackstop({ deps: { emitDiag: jest.fn() } }, session, 'wann habe ich geburtstag', LIVE_REPLY, {
      listCurrentFacts: jest.fn(async () => [{ fact_key: 'user_pet_name', fact_value: 'Bello' }]),
    });
    expect(n).toBe(1);
    expect(session.upstreamClient.sendTextTurn).toHaveBeenCalledTimes(1);
  });
});
