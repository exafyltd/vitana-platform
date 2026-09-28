/**
 * VTID-04690: remember_fact called with the value already stored.
 *
 * Live suite B-CONF-03 (staging, 2026-09-28, session live-3214787c): the
 * member said "Merk dir, Paul hat am siebten Mai Geburtstag". Nova called
 * remember_fact with the STORED value "May 5", got STATUS: already_known,
 * answered "das habe ich schon notiert – am 5. Mai", and later claimed it had
 * confirmed the 7th. Nothing was asked and nothing changed. When the tool
 * answers already_known, the gateway now checks the member's own words.
 */
import * as fs from 'fs';
import * as path from 'path';

import { buildRememberBackstopNote, REMEMBER_BACKSTOP_MARKER, type RememberBackstopDeps } from '../../../src/services/memory/remember-backstop';
import { createPendingConflictStore } from '../../../src/services/memory/remember-fact-tool';
import { maybeRunRememberBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

function deps(over: Partial<RememberBackstopDeps> = {}): RememberBackstopDeps & { write: jest.Mock } {
  return {
    readCurrentFact: jest.fn(async (_t: string, _u: string, k: string) => (k === 'paul_birthday' ? { fact_value: 'May 5', extracted_at: 'x' } : null)),
    readProfileValue: jest.fn(async () => null),
    listCurrentFacts: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5', extracted_at: 'x' }]),
    write: jest.fn(async () => ({ ok: true, fact_id: 'f1' })),
    extract: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 7', entity: 'disclosed' }]),
    pendingConflicts: createPendingConflictStore(),
    ...over,
  } as any;
}

const diag = jest.fn();
const ctx = { deps: { emitDiag: diag } };
function session(over: Record<string, unknown> = {}) {
  return {
    sessionId: 's1',
    active: true,
    upstreamProvider: 'nova_sonic',
    identity: { user_id: 'u1', tenant_id: 't1' },
    upstreamClient: { sendTextTurn: jest.fn(() => true) },
    rememberFactCalledThisTurn: true,
    rememberFactAlreadyKnownThisTurn: true,
    ...over,
  } as any;
}

describe('VTID-04690 the member said a different value than the one the model sent', () => {
  it('runs the rules on the member words, asks, and opens the conflict', async () => {
    const s = session();
    const d = deps();
    const r = await maybeRunRememberBackstop(ctx, s, 'merk dir paul hat am siebten mai geburtstag', d)!;
    expect(r.map((x) => x.status)).toEqual(['conflict']);
    expect(d.write).not.toHaveBeenCalled();
    const note = s.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    expect(note.startsWith(REMEMBER_BACKSTOP_MARKER)).toBe(true);
    expect(note).toMatch(/value that was already stored, not the value the member just said/);
    expect(note).toMatch(/paul_birthday: STATUS: conflict/);
    expect(s.openRememberConflicts).toHaveLength(1);
    expect(diag).toHaveBeenCalledWith(s, 'remember_backstop', expect.objectContaining({ trigger: 'stored_value_echoed' }));
    expect(s.rememberFactAlreadyKnownThisTurn).toBe(false);
  });

  it('then applies the confirmation the member gives on the next turn', async () => {
    const s = session();
    const d = deps();
    await maybeRunRememberBackstop(ctx, s, 'merk dir paul hat am siebten mai geburtstag', d);
    (d.extract as jest.Mock).mockResolvedValue([{ fact_key: 'paul_birthday', fact_value: '7. Mai', entity: 'disclosed' }]);
    const second = await maybeRunRememberBackstop(ctx, s, 'der siebte mai ist richtig', d)!;
    expect(second[0].status).toBe('saved');
    expect(d.write.mock.calls[0][0]).toEqual(expect.objectContaining({ fact_key: 'paul_birthday', fact_value: 'May 7' }));
  });

  it('says nothing when the member really repeated the stored value', async () => {
    const s = session();
    const d = deps({ extract: jest.fn(async () => [{ fact_key: 'paul_birthday', fact_value: 'May 5', entity: 'disclosed' }]) });
    const r = await maybeRunRememberBackstop(ctx, s, 'merk dir paul hat am fünften mai geburtstag', d)!;
    expect(r.map((x) => x.status)).toEqual(['already_known']);
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });

  it('stands down as before when the tool saved or asked', () => {
    const s = session({ rememberFactAlreadyKnownThisTurn: false });
    expect(maybeRunRememberBackstop(ctx, s, 'merk dir paul hat am siebten mai geburtstag', deps())).toBeNull();
  });

  it('the note is null for all-already_known results only in the echo case', () => {
    const known = [{ fact_key: 'k', status: 'already_known' } as any];
    expect(buildRememberBackstopNote(known, 'stored_value_echoed')).toBeNull();
    expect(buildRememberBackstopNote(known)).not.toBeNull();
  });

  it('the live handler records an already_known answer and clears it per utterance', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/orb/live/session/upstream-message-handler.ts'), 'utf8');
    expect(src).toMatch(/toolName === 'remember_fact' && \/\^STATUS: already_known\\b\//);
    expect(src).toMatch(/\(session as any\)\.rememberFactAlreadyKnownThisTurn = false;/);
  });
});
