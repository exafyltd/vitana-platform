/**
 * VTID-04697: the reply claims to remember, no tool ran.
 *
 * Live suite B-CONF-02 (staging, 2026-09-28, session live-2d23ce8e): the
 * member said "Mein Bruder Paul hat übrigens am siebten Mai Geburtstag" with
 * paul_birthday = May 5 stored. No "merk dir", so the request detector stayed
 * quiet; Nova answered "Danke für die Info! Ich merke mir den Geburtstag
 * deines Bruders Paul am siebten Mai." and called no tool. Nothing was saved
 * and the conflict was never raised.
 */
import * as fs from 'fs';
import * as path from 'path';

import { detectRememberClaim, REMEMBER_BACKSTOP_MARKER } from '../../../src/services/memory/remember-backstop';
import { createPendingConflictStore } from '../../../src/services/memory/remember-fact-tool';
import { maybeRunRememberBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const LIVE_REPLY =
  'Danke für die Info! Ich merke mir den Geburtstag deines Bruders Paul am siebten Mai. Möchtest du, dass ich dich daran erinnere?';

describe('VTID-04697 detectRememberClaim', () => {
  it.each([
    LIVE_REPLY,
    'Alles klar, das habe ich notiert.',
    'Okay, ist gespeichert.',
    "Got it, I'll remember that.",
    "I've noted that your brother's birthday is May 7.",
    // VTID-04699: pass 4 on staging 5e30d7b — words between verb and participle.
    'Vielen Dank für die Information. Ich habe den Geburtstag von Paul am siebten Mai notiert.',
    'Ich habe dein Geburtsdatum notiert: 9 September 1969.',
    // Two turns glued together without a space.
    'Möchtest du, dass ich dich erinnere?Ich habe es gespeichert.',
    "I have saved your brother's birthday.",
  ])(
    'a save claim: %s',
    (r) => expect(detectRememberClaim(r)).toBe(true),
  );
  it.each([
    'Das kann ich leider nicht speichern.',
    "I can't save that, it belongs in your profile.",
    'Wann hat Paul Geburtstag?',
    'Möchtest du, dass ich dich daran erinnere?',
    'Soll ich das für dich notieren?',
    'Hast du das schon notiert?',
    'Das wird in deinem Profil gespeichert, damit alle Teile es nutzen.',
    'Ich habe das leider nicht gespeichert.',
    '',
  ])('not a save claim: %s', (r) => expect(detectRememberClaim(r)).toBe(false));
});

describe('VTID-04697 live hook', () => {
  const diag = jest.fn();
  const ctx = { deps: { emitDiag: diag } };
  const session = (over: Record<string, unknown> = {}) =>
    ({
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
      ...over,
    }) as any;
  const deps = () =>
    ({
      readCurrentFact: jest.fn(async (_t: string, _u: string, k: string) => (k === 'paul_birthday' ? { fact_value: 'May 5', extracted_at: 'x' } : null)),
      readProfileValue: jest.fn(async () => null),
      listCurrentFacts: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5', extracted_at: 'x' }]),
      write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
      extract: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 7', entity: 'disclosed' }]),
      pendingConflicts: createPendingConflictStore(),
    }) as any;
  const UTTERANCE = 'mein bruder paul hat übrigens am siebten mai geburtstag';

  it('runs the rules on the live B-CONF-02 turn: conflict, nothing written, marked note', async () => {
    const s = session();
    const d = deps();
    const r = await maybeRunRememberBackstop(ctx, s, UTTERANCE, d, LIVE_REPLY)!;
    expect(r.map((x) => x.status)).toEqual(['conflict']);
    expect(d.write).not.toHaveBeenCalled();
    const note = s.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    expect(note.startsWith(REMEMBER_BACKSTOP_MARKER)).toBe(true);
    expect(note).toMatch(/did not call remember_fact, so nothing was saved/);
    expect(s.openRememberConflicts).toHaveLength(1);
    expect(diag).toHaveBeenCalledWith(s, 'remember_backstop', expect.objectContaining({ trigger: 'claimed_without_call' }));
  });

  it('stands down when remember_fact ran, when the reply claims nothing, or off Nova', () => {
    expect(maybeRunRememberBackstop(ctx, session({ rememberFactCalledThisTurn: true }), UTTERANCE, deps(), LIVE_REPLY)).toBeNull();
    expect(maybeRunRememberBackstop(ctx, session(), UTTERANCE, deps(), 'Wie schön, feiert ihr zusammen?')).toBeNull();
    expect(maybeRunRememberBackstop(ctx, session({ upstreamProvider: 'vertex' }), UTTERANCE, deps(), LIVE_REPLY)).toBeNull();
  });

  it('is wired at turn_complete with the reply transcript', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/orb/live/session/upstream-message-handler.ts'), 'utf8');
    expect(src).toMatch(/maybeRunRememberBackstop\(ctx, session, userText, undefined, session\.outputTranscriptBuffer \|\| ''\)/);
  });
});
