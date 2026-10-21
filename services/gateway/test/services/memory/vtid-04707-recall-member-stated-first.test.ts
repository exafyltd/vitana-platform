/**
 * VTID-04707: "Was weißt du über mich?" must lead with what the member told
 * Vitana. Live B-REC-06 (staging, 2026-09-28): the member had said the dog is
 * Bello and the favourite food is Lasagne; the reply named the display name
 * "E2E", the language, a life goal and matches — profile data — and neither
 * of the two things the member said. The backstop stayed silent because the
 * reply contained a stored value ("E2E", a profile fact).
 */
import { memberStatedFacts } from '../../../src/services/memory/recall-backstop';
import { maybeRunRecallBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const LIVE_REPLY =
  'Ich habe einige Informationen über dich gespeichert, die du mir mitgeteilt hast. Zum Beispiel weiß ich, dass dein Name E2E  ist, du Deutsch als bevorzugte Sprache nutzt und dein aktives Lebensziel darin besteht, einen Lebenspartner zu finden.';

const FACTS = [
  { fact_key: 'user_name', fact_value: 'E2E', provenance_source: 'system_profile' },
  { fact_key: 'preferred_language', fact_value: 'German', provenance_source: 'user_stated' },
  { fact_key: 'user_pet_name', fact_value: 'Bello', provenance_source: 'user_stated' },
  { fact_key: 'favorite_food', fact_value: 'Lasagne', provenance_source: 'user_stated_via_backstop' },
];

describe('VTID-04707 about-me recall leads with what the member said', () => {
  it('member-stated facts exclude system keys and profile basics', () => {
    expect(memberStatedFacts(FACTS).map((f) => f.fact_value)).toEqual(['Bello', 'Lasagne']);
  });

  it('the live B-REC-06 reply (profile data only) triggers the backstop with Bello and Lasagne first', async () => {
    const session = {
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
    } as any;
    const n = await maybeRunRecallBackstop({ deps: { emitDiag: jest.fn() } }, session, 'Was weißt du eigentlich alles über mich?', LIVE_REPLY, {
      listCurrentFacts: jest.fn(async () => FACTS),
    });
    expect(n).toBeGreaterThan(0);
    const note = session.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    const lines = note.split('\n').filter((l) => l.startsWith('- '));
    expect(lines[0]).toMatch(/Bello|Lasagne/);
    expect(lines[1]).toMatch(/Bello|Lasagne/);
  });

  it('stays silent when the reply already names something the member said', async () => {
    const session = {
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
    } as any;
    const n = await maybeRunRecallBackstop(
      { deps: { emitDiag: jest.fn() } },
      session,
      'Was weißt du über mich?',
      'Ich weiß, dass dein Hund Bello heißt und du gerne Lasagne isst.',
      { listCurrentFacts: jest.fn(async () => FACTS) },
    );
    expect(n).toBe(0);
  });
});
