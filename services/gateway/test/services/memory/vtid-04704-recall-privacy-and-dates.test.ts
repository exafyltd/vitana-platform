/**
 * VTID-04704: staging 2026-09-28 on 72e8e2f, no spouse fact stored. The
 * replies below are the model's own words from the failing runs:
 *   - "wie heißt meine frau" → a privacy refusal;
 *   - "erinnerst du dich an den geburtstag meiner frau" → an invented date.
 * The VTID-04692 recall backstop recognised neither.
 */
import {
  asksForDate,
  buildNothingStoredNote,
  extractDayMonths,
  replyCitesPrivacy,
  replyDeniesOrDefers,
  replyNamesUnstoredDate,
} from '../../../src/services/memory/recall-backstop';
import { REMEMBER_BACKSTOP_MARKER } from '../../../src/services/memory/remember-backstop';
import { maybeRunRecallBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const LIVE_PRIVACY_REFUSAL =
  'Tut mir leid, aber ich kann diese persönliche Information nicht preisgeben. Solche Daten können nur in deinem Profil bearbeitet werden. Möchtest du, dass ich dich zu deinen Profileinstellungen bringe?';
const LIVE_INVENTED_DATE = 'Ja, natürlich erinnere ich mich. Der Geburtstag deiner Frau ist am 23. April. Soll ich dich daran erinnern?';
const BIRTHDAY_Q = 'erinnerst du dich an den geburtstag meiner frau';
const NAME_Q = 'wie heißt meine frau';

const BASELINE = Array.from({ length: 10 }, (_, i) => ({ fact_key: `baseline_${i}`, fact_value: `Wert ${i}` }));
const WITH_SPOUSE = [{ fact_key: 'spouse_name', fact_value: 'Anna' }, { fact_key: 'spouse_birthday', fact_value: '12. März' }, ...BASELINE];

describe('VTID-04704 detection', () => {
  it('the live privacy refusal counts as a denial', () => {
    expect(replyCitesPrivacy(LIVE_PRIVACY_REFUSAL)).toBe(true);
    expect(replyDeniesOrDefers(LIVE_PRIVACY_REFUSAL)).toBe(true);
    expect(replyCitesPrivacy('Aus Datenschutzgründen kann ich das nicht sagen.')).toBe(true);
    expect(replyCitesPrivacy("I can't share personal information.")).toBe(true);
  });
  it('a plain answer does not cite privacy', () => {
    expect(replyCitesPrivacy('Deine Frau heißt Anna.')).toBe(false);
    expect(replyDeniesOrDefers('Deine Frau heißt Anna.')).toBe(false);
  });
  it('reads day and month in the forms members and facts use', () => {
    expect([...extractDayMonths('am 23. April')]).toEqual(['23-4']);
    expect([...extractDayMonths('12. März')]).toEqual(['12-3']);
    expect([...extractDayMonths('March 12th')]).toEqual(['12-3']);
    expect([...extractDayMonths('1985-03-12')]).toEqual(['12-3']);
    expect([...extractDayMonths('am 12.03.')]).toEqual(['12-3']);
    expect([...extractDayMonths('el 5 de mayo')]).toEqual(['5-5']);
    expect(extractDayMonths('Um 12 Uhr mit Maria in Mainz').size).toBe(0);
    expect(extractDayMonths('Deine Frau heißt Anna.').size).toBe(0);
  });
  it('a birthday question asks for a date; a name question does not', () => {
    expect(asksForDate(BIRTHDAY_Q)).toBe(true);
    expect(asksForDate('Wann ist unser Hochzeitstag?')).toBe(true);
    expect(asksForDate(NAME_Q)).toBe(false);
  });
  it('a date matches a stored fact whatever the format', () => {
    expect(replyNamesUnstoredDate('Ihr Geburtstag ist am 12. März.', WITH_SPOUSE)).toBe(false);
    expect(replyNamesUnstoredDate('Her birthday is March 12.', WITH_SPOUSE)).toBe(false);
    expect(replyNamesUnstoredDate(LIVE_INVENTED_DATE, WITH_SPOUSE)).toBe(true);
    expect(replyNamesUnstoredDate(LIVE_INVENTED_DATE, BASELINE)).toBe(true);
  });
  it('the nothing-stored note is intent, carries the marker, and forbids guessing and privacy', () => {
    for (const r of ['privacy_refusal', 'unstored_date'] as const) {
      const n = buildNothingStoredNote(r);
      expect(n.startsWith(REMEMBER_BACKSTOP_MARKER)).toBe(true);
      expect(n).toMatch(/Never guess, and never cite privacy/);
      expect(n).toMatch(/ask the member for it/);
    }
  });
});

describe('VTID-04704 live hook', () => {
  const diag = jest.fn();
  const ctx = { deps: { emitDiag: diag } };
  const session = () =>
    ({
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
    }) as any;
  const facts = (f: Array<{ fact_key: string; fact_value: string }>) => ({ listCurrentFacts: jest.fn(async () => f) });
  beforeEach(() => diag.mockClear());

  it('privacy refusal with the fact stored: the facts are offered, spouse first', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, NAME_Q, LIVE_PRIVACY_REFUSAL, facts(WITH_SPOUSE));
    const note = s.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    expect(note.split('\n')[1]).toBe('- spouse_name: Anna');
    expect(note).toMatch(/Never cite privacy/);
    expect(diag).toHaveBeenCalledWith(s, 'recall_backstop', expect.objectContaining({ trigger: 'privacy_refusal', injected: true }));
  });
  it('privacy refusal with nothing about the spouse stored: told to say so and ask', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, NAME_Q, LIVE_PRIVACY_REFUSAL, facts(BASELINE));
    expect(s.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/not stored yet and ask the member for it/);
  });
  it('privacy refusal with nothing stored at all: the nothing-stored note', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, NAME_Q, LIVE_PRIVACY_REFUSAL, facts([]));
    expect(s.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/refused on privacy grounds/);
  });
  it('an honest "not stored" with nothing stored stays silent (VTID-04692 unchanged)', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, NAME_Q, 'Leider habe ich den Namen deiner Frau nicht gespeichert. Wie heißt sie?', facts([]));
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });
  it('the live invented date with no spouse fact: corrected', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, BIRTHDAY_Q, LIVE_INVENTED_DATE, facts(BASELINE));
    expect(s.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/named a date that none of their stored facts carries/);
    expect(diag).toHaveBeenCalledWith(s, 'recall_backstop', expect.objectContaining({ trigger: 'unstored_date' }));
  });
  it('the live invented date with nothing stored: the nothing-stored note', async () => {
    const s = session();
    await maybeRunRecallBackstop(ctx, s, BIRTHDAY_Q, LIVE_INVENTED_DATE, facts([]));
    expect(s.upstreamClient.sendTextTurn.mock.calls[0][0]).toMatch(/the date was a guess/);
  });
  it('the right date from memory stays silent, in any format', async () => {
    for (const reply of ['Ja, deine Frau Anna hat am 12. März Geburtstag.', 'Her birthday is on March 12th.']) {
      const s = session();
      expect(await maybeRunRecallBackstop(ctx, s, BIRTHDAY_Q, reply, facts(WITH_SPOUSE))).toBe(0);
      expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
    }
  });
  it('a date in a reply to a non-date question is left alone', async () => {
    const s = session();
    expect(await maybeRunRecallBackstop(ctx, s, NAME_Q, 'Deine Frau heißt Anna, ihr habt am 3. Mai einen Termin.', facts(WITH_SPOUSE))).toBe(0);
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });
});
