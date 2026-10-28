/**
 * VTID-04701: a forgotten value must not come back through session
 * summaries or transcript turns. Live suite B-FORG-01 on staging,
 * 2026-09-28: `user_pet_name = Bello` was forgotten, then the forget
 * session's own summary read "The user asked Vitana to forget that their dog
 * is named Bello", and the next session said "Du hast jedoch erwähnt, dass
 * dein Haustier Bello heißt".
 */
import * as fs from 'fs';
import * as path from 'path';

import { hashFactValue, textNamesForgottenValue } from '../../../src/services/memory/forgotten';
import { buildForgetFactDeps } from '../../../src/services/orb-tools-shared';

const LIVE_SUMMARY = 'The user asked Vitana to forget that their dog is named Bello.';

describe('VTID-04701 textNamesForgottenValue', () => {
  const hashes = new Set([hashFactValue('Bello'), hashFactValue('New York')]);
  it('finds the live summary', () => expect(textNamesForgottenValue(LIVE_SUMMARY, hashes)).toBe(true));
  it('finds a multi-word value and ignores punctuation and case', () => {
    expect(textNamesForgottenValue('They moved to new york, last year.', hashes)).toBe(true);
  });
  it('a summary without the value is kept', () => {
    expect(textNamesForgottenValue('The user talked about their morning run.', hashes)).toBe(false);
    expect(textNamesForgottenValue(LIVE_SUMMARY, new Set())).toBe(false);
  });
});

function fakeSb() {
  const calls: Array<{ table: string; filters: Array<[string, string, string]> }> = [];
  const sb = {
    from(table: string) {
      const call = { table, filters: [] as Array<[string, string, string]> };
      calls.push(call);
      const chain: any = {
        delete: () => chain,
        eq: (c: string, v: string) => (call.filters.push(['eq', c, v]), chain),
        ilike: (c: string, v: string) => (call.filters.push(['ilike', c, v]), chain),
        select: async () => ({ data: [{ id: `${table}-1` }], error: null }),
      };
      return chain;
    },
  };
  return { sb: sb as any, calls };
}

describe('VTID-04701 forget deletes everywhere the value is stored', () => {
  it('memory_items, transcript turns and session summaries that carry the value', async () => {
    const { sb, calls } = fakeSb();
    const deps = await buildForgetFactDeps(sb);
    const n = await deps.deleteItemsMentioning('t1', 'u1', 'Bello');
    expect(n).toBe(3);
    expect(calls.map((c) => c.table)).toEqual(['memory_items', 'memory_transcript_turns', 'user_session_summaries']);
    expect(calls[1].filters).toContainEqual(['ilike', 'content', '%Bello%']);
    expect(calls[2].filters).toContainEqual(['ilike', 'summary', '%Bello%']);
    expect(calls[2].filters).toContainEqual(['eq', 'user_id', 'u1']);
  });
});

describe('VTID-04701 summary writer', () => {
  it('does not store a summary that names a forgotten value', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../../src/services/guide/session-summaries.ts'), 'utf8');
    const guard = src.indexOf('textNamesForgottenValue(summary, hashes)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(src.indexOf('repo.upsertSessionSummary(supabase'));
  });
});
