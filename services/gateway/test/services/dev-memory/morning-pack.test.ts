// VTID-04408 — developer morning pack.
const calls: string[] = [];
let responses: Record<string, any> = {};
jest.mock('../../../src/services/dev-autopilot-execute', () => ({
  getSupabase: () => ({ url: 'http://x', key: 'k' }),
  supa: async (_s: any, path: string) => {
    calls.push(path);
    const key = Object.keys(responses).find((k) => path.includes(k));
    return key ? responses[key] : { ok: true, data: [] };
  },
}));

import { buildMorningPack, renderMorningPack, PACK_TEXT_MAX_CHARS } from '../../../src/services/dev-memory/morning-pack';

const USER = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-09-23T07:00:00Z');
beforeEach(() => { calls.length = 0; responses = {}; });

describe('buildMorningPack', () => {
  it('filters handoffs to the author, knowledge to repo-wide rows, VTIDs to in-progress', async () => {
    responses['category=eq.handoff'] = { ok: true, data: [{ id: 'h', category: 'handoff', title: 'Handoff: Fix CI', content: 'Next: merge #3606', vtid: null, importance: 60, author_user_id: USER, created_at: '2026-09-22T18:00:00Z' }] };
    responses['category=in.('] = { ok: true, data: [{ id: 'k', category: 'gotcha', title: 'tsc heap', content: 'use 3072', vtid: 'VTID-04009', importance: 70, author_user_id: null, created_at: '2026-09-21T00:00:00Z' }] };
    responses['vtid_ledger?'] = { ok: true, data: [{ vtid: 'VTID-04407', title: 'Handoffs', status: 'in_progress', updated_at: '2026-09-23T06:00:00Z' }] };
    const r = await buildMorningPack({ authorUserId: USER, now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [h, k, v] = calls;
    expect(h).toContain(`author_user_id=eq.${USER}`);
    expect(h).toContain('superseded_by=is.null');
    expect(k).toContain('repo=eq.vitana-platform');
    expect(k).toContain('author_user_id=is.null');
    expect(k).toContain('category=in.(decision,incident,gotcha,convention)');
    expect(v).toContain('status=eq.in_progress');
    expect(v).toContain('is_terminal=is.false');
    expect(r.pack.text).toContain('Next: merge #3606');
    expect(r.pack.text).toContain('[gotcha] VTID-04009 tsc heap');
    expect(r.pack.text).toContain('VTID-04407 — Handoffs');
    expect(r.pack.unavailable).toEqual([]);
  });

  it('without an author reads every handoff', async () => {
    await buildMorningPack({ now });
    expect(calls[0]).not.toContain('author_user_id=eq.');
  });

  it('fails open per section and says so', async () => {
    responses['vtid_ledger?'] = { ok: false, error: '500: boom' };
    const r = await buildMorningPack({ now });
    expect(r.ok && r.pack.unavailable).toEqual(['vtids: 500: boom']);
    expect(r.ok && r.pack.text).toContain('(unavailable: vtids: 500: boom)');
  });
});

describe('renderMorningPack', () => {
  it('caps the rendered text', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, category: 'handoff', title: `T${i}`, content: 'z'.repeat(700), vtid: null, importance: 50, author_user_id: null, created_at: '2026-09-22T00:00:00Z' }));
    const text = renderMorningPack({ generated_at: now.toISOString(), repo: 'vitana-platform', author_user_id: null, handoffs: many, knowledge: [], open_vtids: [], unavailable: [] });
    expect(text.length).toBeLessThanOrEqual(PACK_TEXT_MAX_CHARS);
    expect(text).toContain('[clipped]');
  });
});
