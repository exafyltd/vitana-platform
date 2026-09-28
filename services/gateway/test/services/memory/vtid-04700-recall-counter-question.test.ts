/**
 * VTID-04700: the voice model answered a question about a stored fact with a
 * counter-question instead of the answer. Live suite B-REC-05 on staging,
 * 2026-09-28, with `paul_birthday = May 5` stored — the reply below is the
 * model's own words.
 */
import { detectRecallQuestion, replyDeniesOrDefers } from '../../../src/services/memory/recall-backstop';
import { maybeRunRecallBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const LIVE_REPLY =
  'Ich kann dir dabei helfen, den Geburtstag von Paul zu finden, aber ich brauche ein paar Informationen. ' +
  'Kannst du mir sagen, ob Paul ein Mitglied der Maxina-Community ist oder ob er in deinen persönlichen Kontakten gespeichert ist? ' +
  'Wenn er ein Community-Mitglied ist, kann ich sein Profil öffnen, um sein Geburtsdatum zu überprüfen. ' +
  'Bitte lass mich wissen, wie ich dir am besten helfen kann!';

describe('VTID-04700 counter-question instead of the answer', () => {
  it('the live B-REC-05 question and reply trigger the backstop', () => {
    expect(detectRecallQuestion('wann hat mein bruder paul geburtstag')).toBe(true);
    expect(replyDeniesOrDefers(LIVE_REPLY)).toBe(true);
  });

  it.each([
    'Ich brauche noch mehr Details, um dir zu helfen.',
    'Kannst du mir bitte sagen, welchen Paul du meinst?',
    'I need some more information about Paul first.',
    'Can you tell me which Paul you mean?',
    'Necesito más información sobre Paul.',
  ])('counts as a deferral: %s', (r) => expect(replyDeniesOrDefers(r)).toBe(true));

  // Live B-TIME-02: the appointment was a stored fact, the calendar search
  // found nothing, and this was the whole reply.
  it.each([
    'Ich überprüfe deinen Kalender, um den genauen Zeitpunkt deines Zahnarzttermins zu finden.',
    'Ich schaue mal nach.',
    "I'm checking your calendar now.",
    'Voy a revisar tu calendario.',
  ])('a promise to look counts as a deferral: %s', (r) => {
    expect(detectRecallQuestion('Wann ist mein Zahnarzttermin?')).toBe(true);
    expect(replyDeniesOrDefers(r)).toBe(true);
  });

  it.each(['Paul hat am fünften Mai Geburtstag.', 'Your brother Paul celebrates on May 5.', 'Dein Zahnarzttermin ist nächsten Dienstag um zehn.'])(
    'a real answer is still not a deferral: %s',
    (r) => expect(replyDeniesOrDefers(r)).toBe(false),
  );

  it('injects the stored facts after the live reply', async () => {
    const diag = jest.fn();
    const session = {
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
    } as any;
    const n = await maybeRunRecallBackstop({ deps: { emitDiag: diag } }, session, 'wann hat mein bruder paul geburtstag', LIVE_REPLY, {
      listCurrentFacts: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5' }]),
    });
    expect(n).toBe(1);
    expect(session.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/paul_birthday: May 5/);
  });
});
