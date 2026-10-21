/**
 * VTID-04684: forgetting a stored fact by voice.
 *
 * Live suite B-FORG-01 (staging, 2026-09-26): "vergiss bitte, dass mein Hund
 * Bello heißt" → Nova said the name was deleted, called no tool, and
 * user_pet_name=Bello stayed current. Pins: the forget intent is recognised
 * (and "vergiss nicht" is not), the fact the member means is found by the
 * value they name or by its key words, every step of the forget runs, the
 * backstop runs only when the model skipped the tool, and forget_fact is
 * declared, dispatched and ranked beside remember_fact.
 */
import * as fs from 'fs';
import * as path from 'path';

import { detectForgetIntent } from '../../../src/services/memory/memory-intent';
import {
  matchFactsToForget,
  runForgetFact,
  formatForgetFactResult,
  type ForgetFactDeps,
  type ForgettableFact,
} from '../../../src/services/memory/forget-fact';
import { maybeRunForgetBackstop } from '../../../src/orb/live/session/remember-backstop-hook';

const f = (id: string, fact_key: string, fact_value: string): ForgettableFact => ({
  id, fact_key, fact_value, extracted_at: '2026-09-26T10:00:00Z',
});

const STORED = [
  f('1', 'user_pet_name', 'Bello'),
  f('2', 'user_favorite_food', 'Lasagne'),
  f('3', 'paul_birthday', 'May 5'),
  f('4', 'preferred_language', 'German'),
  f('5', 'user_name', 'E2E'),
];

function deps(facts = STORED): ForgetFactDeps & { forgotten: string[]; items: string[]; refreshed: number } {
  const d: any = {
    forgotten: [] as string[],
    items: [] as string[],
    refreshed: 0,
    async listCurrentFacts() { return facts; },
    async forgetFact(_t: string, _u: string, id: string) { d.forgotten.push(id); return { ok: true }; },
    async deleteItemsMentioning(_t: string, _u: string, value: string) { d.items.push(value); return 2; },
    refreshSnapshot() { d.refreshed++; },
  };
  return d;
}

describe('VTID-04684 detectForgetIntent', () => {
  it.each([
    'vergiss bitte dass mein hund bello heißt',
    'Vergiss meinen Hund',
    'lösch bitte aus deinem Gedächtnis, dass ich Lasagne mag',
    'forget that my dog is called Bello',
    'please delete what you know about my birthday',
    'olvida que mi perro se llama Bello',
    'zaboravi da mi se pas zove Bello',
  ])('recognises "%s"', (t) => expect(detectForgetIntent(t)).toBe(true));

  it.each([
    'vergiss das nicht, mein Hund heißt Bello',
    'vergiss nicht mein Termin ist morgen',
    "don't forget my dentist appointment",
    'no olvides mi cita',
    'ne zaboravi moj rođendan',
    'mein Hund heißt Bello',
    'lösch den Post von gestern',
    '',
  ])('does not treat "%s" as a forget request', (t) => expect(detectForgetIntent(t)).toBe(false));
});

describe('VTID-04684 matchFactsToForget', () => {
  it('finds the fact by the value the member names', () => {
    const r = matchFactsToForget('vergiss bitte dass mein hund bello heißt', STORED);
    expect(r.matches.map((m) => m.fact_key)).toEqual(['user_pet_name']);
    expect(r.ambiguous).toBe(false);
  });

  it('finds the fact by its key words across languages', () => {
    const r = matchFactsToForget('vergiss mein lieblingsessen', STORED);
    expect(r.matches.map((m) => m.fact_key)).toEqual(['user_favorite_food']);
  });

  it('never matches a system or profile key', () => {
    expect(matchFactsToForget('forget that I speak German', STORED).matches).toEqual([]);
    expect(matchFactsToForget('vergiss meinen namen E2E', STORED).matches).toEqual([]);
  });

  it('reports ambiguity when two keys fit equally', () => {
    const r = matchFactsToForget('vergiss den geburtstag', [f('a', 'paul_birthday', 'May 5'), f('b', 'anna_birthday', 'Nov 4')]);
    // "geburtstag" → birthday alone never covers "paul_birthday" (needs paul too): nothing matches.
    expect(r.matches).toEqual([]);
    const r2 = matchFactsToForget('vergiss paul und anna geburtstag', [f('a', 'paul_birthday', 'May 5'), f('b', 'anna_birthday', 'Nov 4')]);
    expect(r2.ambiguous).toBe(true);
  });
});

describe('VTID-04684 runForgetFact', () => {
  it('forgets the key, removes the transcript lines carrying it, and rebuilds the snapshot', async () => {
    const d = deps();
    const r = await runForgetFact({ tenant_id: 't', user_id: 'u', request: 'vergiss dass mein hund bello heißt' }, d);
    expect(r.status).toBe('forgotten');
    expect(r.forgotten).toEqual([{ fact_key: 'user_pet_name', fact_value: 'Bello' }]);
    expect(d.forgotten).toEqual(['1']);
    expect(d.items).toEqual(['Bello']);
    expect(r.transcript_lines_removed).toBe(2);
    expect(d.refreshed).toBe(1);
    expect(formatForgetFactResult(r)).toMatch(/^STATUS: forgotten\./);
  });

  it('says not_found and deletes nothing when nothing matches', async () => {
    const d = deps();
    const r = await runForgetFact({ tenant_id: 't', user_id: 'u', request: 'vergiss meine katze' }, d);
    expect(r.status).toBe('not_found');
    expect(d.forgotten).toEqual([]);
    expect(r.instruction).toMatch(/do not claim you deleted anything/);
  });

  it('asks instead of guessing when more than one key fits', async () => {
    const d = deps([f('a', 'paul_birthday', 'May 5'), f('b', 'anna_birthday', 'Nov 4')]);
    const r = await runForgetFact({ tenant_id: 't', user_id: 'u', request: 'vergiss paul und anna geburtstag' }, d);
    expect(r.status).toBe('ambiguous');
    expect(d.forgotten).toEqual([]);
  });

  it('reports a failed forget honestly', async () => {
    const d = deps();
    d.forgetFact = async () => ({ ok: false, error: 'db down' });
    const r = await runForgetFact({ tenant_id: 't', user_id: 'u', request: 'forget that my dog is Bello' }, d);
    expect(r.status).toBe('failed');
    expect(r.instruction).toMatch(/do not say it is forgotten/);
  });
});

describe('VTID-04684 forget backstop', () => {
  const ctx = { deps: { emitDiag: jest.fn() } };
  const session = (over: any = {}) => ({
    sessionId: 's1', active: true, upstreamProvider: 'nova_sonic',
    identity: { user_id: 'u', tenant_id: 't' },
    upstreamClient: { sendTextTurn: jest.fn().mockReturnValue(true) },
    ...over,
  });

  it('runs the forget and tells the model the real outcome when the tool was skipped', async () => {
    const s = session();
    const d = deps();
    const r = await maybeRunForgetBackstop(ctx, s, 'vergiss bitte dass mein hund bello heißt', d);
    expect(r?.status).toBe('forgotten');
    expect(d.forgotten).toEqual(['1']);
    expect(s.upstreamClient.sendTextTurn).toHaveBeenCalledTimes(1);
    const note = s.upstreamClient.sendTextTurn.mock.calls[0][0] as string;
    expect(note).toContain('STATUS: forgotten');
    expect(note.startsWith('[memory-check]')).toBe(true);
  });

  it('stands down when the model called forget_fact this turn', () => {
    const s = session({ forgetFactCalledThisTurn: true });
    expect(maybeRunForgetBackstop(ctx, s, 'vergiss meinen hund', deps())).toBeNull();
    expect(s.forgetFactCalledThisTurn).toBe(false);
  });

  it('does nothing for an ordinary statement', async () => {
    const s = session();
    const d = deps();
    const r = await maybeRunForgetBackstop(ctx, s, 'mein hund heißt bello', d);
    expect(r).toBeNull();
    expect(d.forgotten).toEqual([]);
    expect(s.upstreamClient.sendTextTurn).not.toHaveBeenCalled();
  });

  it('is Nova only', () => {
    expect(maybeRunForgetBackstop(ctx, session({ upstreamProvider: 'vertex' }), 'vergiss meinen hund', deps())).toBeNull();
  });
});

describe('VTID-04684 forget_fact is wired', () => {
  const src = (p: string) => fs.readFileSync(path.join(__dirname, '../../../src', p), 'utf8');
  it('is in the catalog and dispatched, runs through the backstop, and the prompt forbids an unbacked claim', () => {
    expect(src('orb/live/tools/live-tool-catalog.ts')).toMatch(/name: 'forget_fact'/);
    // Not in the Nova priority list: the budget is full (ranking it there
    // pushed get_lab_results off /health). It stays reachable via find_tool /
    // use_tool, and the backstop runs the forget whether or not the model calls it.
    expect(src('orb/live/tools/vertex-tool-catalog-budget.ts')).not.toMatch(/'forget_fact'/);
    expect(src('services/orb-tools-shared.ts')).toMatch(/forget_fact: tool_forget_fact,/);
    expect(src('orb/live/instruction/live-system-instruction.ts')).toMatch(/never claim it is forgotten until a forget STATUS says forgotten/);
    expect(src('orb/live/session/upstream-message-handler.ts')).toMatch(/maybeRunForgetBackstop\(ctx, session, userText\)/);
  });
});
