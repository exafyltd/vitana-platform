/**
 * VTID-04701: the session summary writer does not store a summary that names
 * a value the member forgot. Live suite B-FORG-01 on staging, 2026-09-28: the
 * forget session's own summary ("The user asked Vitana to forget that their
 * dog is named Bello") was written after the forget, and the next session
 * said "Du hast jedoch erwähnt, dass dein Haustier Bello heißt".
 */
import { hashFactValue } from '../../../src/services/memory/forgotten';

let summaryText = '';
let markerHashes: string[] = [];
let markerError: string | null = null;
const upserts: Array<Record<string, unknown>> = [];

jest.mock('../../../src/services/llm-router', () => ({
  callViaRouter: jest.fn(async () => ({ ok: true, text: summaryText, provider: 'test' })),
}));
jest.mock('../../../src/services/guide/guide-telemetry', () => ({ emitGuideTelemetry: jest.fn(async () => undefined) }));
jest.mock('../../../src/i18n/server-locale', () => ({ getUserLocale: jest.fn(async () => 'en') }));
jest.mock('../../../src/lib/supabase', () => ({
  getSupabase: () => ({
    from(table: string) {
      if (table === 'memory_fact_forgotten') {
        const chain: any = {
          select: () => chain,
          eq: () => chain,
          limit: async () => (markerError ? { data: null, error: { message: markerError } } : { data: markerHashes.map((value_hash) => ({ value_hash })), error: null }),
        };
        return chain;
      }
      if (table === 'user_session_summaries') {
        return { upsert: async (row: Record<string, unknown>) => (upserts.push(row), { error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { recordSessionSummary } from '../../../src/services/guide/session-summaries';

const input = {
  user_id: 'u1',
  session_id: 'live-fb052d91',
  channel: 'voice' as const,
  transcript_turns: [
    { role: 'user' as const, text: 'Vergiss bitte, dass mein Hund Bello heißt.' },
    { role: 'assistant' as const, text: 'Erledigt.' },
  ],
};

beforeEach(() => {
  upserts.length = 0;
  markerError = null;
  summaryText = 'The user asked Vitana to forget that their dog is named Bello.';
  markerHashes = [hashFactValue('Bello')];
});

describe('VTID-04701 recordSessionSummary and forgotten values', () => {
  it('does not store the live forget-session summary', async () => {
    const r = await recordSessionSummary(input);
    expect(r).toEqual({ success: false, error: 'names_forgotten_value' });
    expect(upserts).toHaveLength(0);
  });

  it('stores a summary that names no forgotten value', async () => {
    summaryText = 'The user talked about their morning run.';
    const r = await recordSessionSummary(input);
    expect(r.success).toBe(true);
    expect(upserts[0]).toEqual(expect.objectContaining({ summary: 'The user talked about their morning run.' }));
  });

  it('stores the summary when nothing was forgotten', async () => {
    markerHashes = [];
    expect((await recordSessionSummary(input)).success).toBe(true);
    expect(upserts).toHaveLength(1);
  });

  it('stores the summary when the marker read fails (logged, never loses every summary)', async () => {
    markerError = 'relation unavailable';
    expect((await recordSessionSummary(input)).success).toBe(true);
    expect(upserts).toHaveLength(1);
  });
});
