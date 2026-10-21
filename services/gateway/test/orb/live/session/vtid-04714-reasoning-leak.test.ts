/**
 * VTID-04714: live B-CONF-05 (staging 7045c16, pass 7). The member corrected
 * Paul's birthday; Nova spoke its own reasoning ("Der Benutzer hat gesagt … In
 * den strukturierten Fakten steht … Dafür gibt es die Funktion remember_fact")
 * and the member heard the start of it, then nothing. The guard now mutes on
 * the reasoning itself, and a muted turn gets a real answer unless a memory
 * backstop already answered.
 */
import { detectBackendDataLeak } from '../../../../src/orb/live/session/opening-turn-guard';
import { buildMutedLeakNote, maybeRecoverFromMutedLeak } from '../../../../src/orb/live/session/muted-leak-recovery';

const LIVE_REPLY =
  'Okay, ich muss die neue Information über Pauls Geburtstag aufnehmen. Der Benutzer hat gesagt: "nein eigentlich hat paul am siebten mai geburtstag".';

describe('VTID-04714 reasoning leak', () => {
  it('the live reply is caught at "Der Benutzer hat gesagt", before any key', () => {
    expect(detectBackendDataLeak(LIVE_REPLY)).toBe('reasoning');
  });

  it.each([
    'Zuerst überprüfe ich die Benutzerkontext: In den strukturierten Fakten steht der Geburtstag.',
    'Dafür gibt es die Funktion remember fact.',
    'Jetzt rufe ich die Funktion auf.',
    'The user said his brother was born in May.',
    "I'll call the function now.",
  ])('reasoning: %s', (t) => expect(detectBackendDataLeak(t)).not.toBeNull());

  it.each([
    'Ich habe bisher den 5. Mai als Pauls Geburtstag gespeichert. Du hast gerade den 7. Mai genannt. Welcher stimmt?',
    'Die Nutzer der Community treffen sich am Freitag.',
    'Das ist eine tolle Funktion der App.',
    'Your brother Paul was born on May 5.',
  ])('normal speech is not flagged: %s', (t) => expect(detectBackendDataLeak(t)).toBeNull());
});

describe('VTID-04714 recovery after a muted reply', () => {
  const session = () =>
    ({ active: true, upstreamClient: { sendTextTurn: jest.fn(() => true) }, backstopNoteSentAt: 0 }) as any;

  it('asks for an answer when no backstop answered', async () => {
    const s = session();
    const diag = jest.fn();
    await expect(maybeRecoverFromMutedLeak({ deps: { emitDiag: diag } }, s, 'reasoning', Date.now(), [0, undefined])).resolves.toBe('sent');
    expect(s.upstreamClient.sendTextTurn).toHaveBeenCalledWith(buildMutedLeakNote(), true);
    expect(diag).toHaveBeenCalledWith(s, 'muted_leak_recovery', { kind: 'reasoning', outcome: 'sent' });
  });

  it('stays silent when a backstop already told Nova the outcome', async () => {
    const s = session();
    const since = Date.now();
    const backstop = new Promise((r) => setTimeout(() => { s.backstopNoteSentAt = Date.now(); r(1); }, 10));
    await expect(maybeRecoverFromMutedLeak({ deps: { emitDiag: jest.fn() } }, s, 'reasoning', since, [backstop])).resolves.toBe('backstop_answered');
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });

  it('does nothing once the session ended', async () => {
    const s = session();
    s.active = false;
    await expect(maybeRecoverFromMutedLeak({ deps: { emitDiag: jest.fn() } }, s, 'json', Date.now(), [])).resolves.toBe('inactive');
  });

  it('a hung backstop does not block the answer past the wait', async () => {
    const s = session();
    const never = new Promise(() => {});
    await expect(maybeRecoverFromMutedLeak({ deps: { emitDiag: jest.fn() } }, s, 'reasoning', Date.now(), [never], 20)).resolves.toBe('sent');
  });

  it('the note states intent and asks before changing a stored value', () => {
    const note = buildMutedLeakNote();
    expect(note).toMatch(/did not hear your previous reply/);
    expect(note).toMatch(/ask which one is right before changing/);
  });
});
