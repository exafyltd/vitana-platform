/**
 * VTID-04591 — "remember this" works when the voice model does not call
 * remember_fact. Measured on staging 2026-09-25: Nova called the tool in 1 of
 * 5 sessions and otherwise answered from guesses ("ich kann Informationen über
 * andere Personen nicht speichern").
 */
import {
  detectRememberIntent,
  buildRememberBackstopNote,
  runRememberBackstop,
  runConflictAnswerBackstop,
  REMEMBER_BACKSTOP_MARKER,
  type RememberBackstopDeps,
} from '../../src/services/memory/remember-backstop';
import { createPendingConflictStore } from '../../src/services/memory/remember-fact-tool';
import { maybeRunRememberBackstop } from '../../src/orb/live/session/remember-backstop-hook';

function deps(over: Partial<RememberBackstopDeps> = {}): RememberBackstopDeps & { write: jest.Mock } {
  return {
    readCurrentFact: jest.fn(async () => null),
    readProfileValue: jest.fn(async () => null),
    listCurrentFacts: jest.fn(async () => []),
    write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
    extract: jest.fn(async () => []),
    pendingConflicts: createPendingConflictStore(),
    ...over,
  } as any;
}
const base = { tenant_id: 't1', user_id: 'u1' };

describe('remember intent', () => {
  it.each([
    'merk dir bittemein geburtstag ist der neunte september',
    'und merk dir mein bruder paul hat am fünften mai geburtstag',
    'Vergiss nicht, dass meine Frau Anna heißt',
    'please remember that my dog is called Bello',
    "don't forget my sister's birthday is in March",
    'recuerda que mi hermano se llama Paul',
    'zapamti da mi je brat Paul',
  ])('detects %s', (t) => expect(detectRememberIntent(t)).toBe(true));

  it.each([
    'mein bruder paul hat am fünften mai geburtstag',
    'wie ist das wetter heute',
    'I remembered nothing', // "remembered" is not a request
    `${REMEMBER_BACKSTOP_MARKER} System result ... remember_fact`,
  ])('ignores %s', (t) => expect(detectRememberIntent(t)).toBe(false));
});

describe('backstop runs remember_fact rules', () => {
  it('a sibling birthday is saved, and the note carries STATUS: saved', async () => {
    const d = deps();
    const r = await runRememberBackstop(
      { ...base, utterance: 'merk dir: Paul hat am 5. Mai Geburtstag' },
      { ...d, extract: async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5', entity: 'disclosed' }] },
    );
    expect(r.map((x) => x.status)).toEqual(['saved']);
    expect(d.write.mock.calls[0][0].entity).toBe('disclosed');
    const note = buildRememberBackstopNote(r)!;
    expect(note.startsWith(REMEMBER_BACKSTOP_MARKER)).toBe(true);
    expect(note).toMatch(/STATUS: saved/);
    expect(note).toMatch(/correct it/);
  });

  it("the member's own birthday is profile_owned and never written", async () => {
    const d = deps();
    const r = await runRememberBackstop(
      { ...base, utterance: 'merk dir, mein Geburtstag ist der 9. September 1969' },
      { ...d, extract: async () => [{ fact_key: 'user_birthday', fact_value: '1969-09-09', entity: 'self' }] },
    );
    expect(r[0].status).toBe('profile_owned');
    expect(d.write).not.toHaveBeenCalled();
  });

  it('a different stored value is a conflict and nothing is written', async () => {
    const d = deps({
      listCurrentFacts: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5th', extracted_at: 'x' }]),
    });
    const r = await runRememberBackstop(
      { ...base, utterance: 'merk dir, Paul hat am siebten Mai Geburtstag' },
      { ...d, extract: async () => [{ fact_key: 'brother_paul_birthday', fact_value: 'May 7', entity: 'disclosed' }] },
    );
    expect(r[0].status).toBe('conflict');
    expect(r[0].stored_value).toBe('May 5th');
    expect(d.write).not.toHaveBeenCalled();
  });

  it('no extracted fact means no note', () => {
    expect(buildRememberBackstopNote([])).toBeNull();
  });

  it("the member's answer to the conflict question is applied only when it names one of the two values", async () => {
    const d = deps({ readCurrentFact: jest.fn(async () => ({ fact_value: 'May 5th', extracted_at: 'x' })) });
    const conflict = { fact_key: 'paul_birthday', stored_value: 'May 5th', new_value: 'May 7', about: 'other' as const };
    // The conflict was reported first, as it is in a live session.
    await runRememberBackstop(
      { ...base, utterance: 'merk dir' },
      { ...d, extract: async () => [{ fact_key: 'paul_birthday', fact_value: 'May 7', entity: 'disclosed' }] },
    );
    const none = await runConflictAnswerBackstop(
      { ...base, utterance: 'keine Ahnung', conflict },
      { ...d, extract: async () => [] },
    );
    expect(none).toEqual([]);
    const r = await runConflictAnswerBackstop(
      { ...base, utterance: 'der siebte ist richtig', conflict },
      { ...d, extract: async () => [{ fact_key: 'paul_birthday', fact_value: '7. Mai', entity: 'disclosed' }] },
    );
    expect(r[0].status).toBe('saved');
    expect(d.write.mock.calls[0][0].fact_value).toBe('May 7');
  });
});

describe('session hook', () => {
  const diag = jest.fn();
  const ctx = { deps: { emitDiag: diag } };
  function session(over: Record<string, unknown> = {}) {
    return {
      sessionId: 's1',
      active: true,
      upstreamProvider: 'nova_sonic',
      identity: { user_id: 'u1', tenant_id: 't1' },
      upstreamClient: { sendTextTurn: jest.fn(() => true) },
      ...over,
    } as any;
  }

  it('stands down when the model called remember_fact this turn', () => {
    const s = session({ rememberFactCalledThisTurn: true });
    expect(maybeRunRememberBackstop(ctx, s, 'merk dir, Paul hat am 5. Mai Geburtstag', deps())).toBeNull();
    expect(s.rememberFactCalledThisTurn).toBe(false);
  });

  it('does nothing for an ordinary turn, or off Nova', () => {
    expect(maybeRunRememberBackstop(ctx, session(), 'wie spät ist es', deps())).toBeNull();
    expect(maybeRunRememberBackstop(ctx, session({ upstreamProvider: 'vertex' }), 'merk dir das', deps())).toBeNull();
  });

  it('runs the rules and hands the model the result as a marked text turn', async () => {
    const s = session();
    const d = deps({ extract: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5', entity: 'disclosed' }]) });
    const r = await maybeRunRememberBackstop(ctx, s, 'und merk dir mein bruder paul hat am fünften mai geburtstag', d)!;
    expect(r[0].status).toBe('saved');
    const sent = s.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    expect(sent.startsWith(REMEMBER_BACKSTOP_MARKER)).toBe(true);
    expect(sent).toMatch(/paul_birthday: STATUS: saved/);
    expect(diag).toHaveBeenCalledWith(s, 'remember_backstop', expect.objectContaining({ injected: true }));
  });

  it('a backstop conflict is remembered, and the next turn answering it is applied', async () => {
    const s = session();
    const d = deps({
      listCurrentFacts: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5th', extracted_at: 'x' }]),
      readCurrentFact: jest.fn(async (_t: string, _u: string, k: string) => (k === 'paul_birthday' ? { fact_value: 'May 5th', extracted_at: 'x' } : null)),
      extract: jest.fn(async () => [{ fact_key: 'brother_paul_birthday', fact_value: 'May 7', entity: 'disclosed' }]),
    });
    const first = await maybeRunRememberBackstop(ctx, s, 'merk dir, Paul hat am siebten Mai Geburtstag', d)!;
    expect(first[0].status).toBe('conflict');
    expect(s.openRememberConflicts).toHaveLength(1);
    expect(d.write).not.toHaveBeenCalled();

    (d.extract as jest.Mock).mockResolvedValue([{ fact_key: 'paul_birthday', fact_value: '7. Mai', entity: 'disclosed' }]);
    const second = await maybeRunRememberBackstop(ctx, s, 'der siebte Mai ist richtig', d)!;
    expect(second[0].status).toBe('saved');
    expect(d.write.mock.calls[0][0]).toEqual(expect.objectContaining({ fact_key: 'paul_birthday', fact_value: 'May 7' }));
    expect(s.openRememberConflicts).toHaveLength(0);
  });
});
