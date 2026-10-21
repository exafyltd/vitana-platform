/**
 * VTID-04523 (Community Autopilot): at most 3 open suggestions per role —
 * the pure cap helpers and the scan's retirement of older extras.
 * Route-level coverage (lineup, badge count, voice list) lives in
 * test/routes/autopilot-recommendations.test.ts, "VTID-04523 lineup cap".
 */
process.env.NODE_ENV = 'test';

import { capOpenLineup, selectExcessOpenRows } from '../src/services/community-autopilot/lineup-cap';
import { MAX_OPEN_PER_ROLE } from '../src/services/community-autopilot/ranker';
import { retireExcessOpenRows } from '../src/services/community-autopilot/scan-runner';

const NOW = new Date('2026-09-25T05:10:00Z');
const USER = 'aaaa1111-1111-4111-8111-111111111111';

describe('capOpenLineup', () => {
  it('keeps the first 3 open rows of a ranked list and every non-open row', () => {
    const ranked = [
      { id: 'a', status: 'new' }, { id: 'x', status: 'activated' }, { id: 'b', status: 'new' },
      { id: 'c', status: 'new' }, { id: 'd', status: 'new' }, { id: 'y', status: 'completed' }, { id: 'e', status: 'new' },
    ];
    const { kept, capped } = capOpenLineup(ranked);
    expect(kept.map((r) => r.id)).toEqual(['a', 'x', 'b', 'c', 'y']);
    expect(capped).toBe(2);
  });

  it('is a no-op at or under the cap', () => {
    const ranked = [{ id: 'a', status: 'new' }, { id: 'b', status: 'new' }, { id: 'c', status: 'new' }];
    expect(capOpenLineup(ranked)).toEqual({ kept: ranked, capped: 0 });
    expect(MAX_OPEN_PER_ROLE).toBe(3);
  });
});

describe('selectExcessOpenRows', () => {
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id, action: null, impact_score: 5, created_at: '2026-09-20T00:00:00Z', expires_at: null, ...over,
  });

  it('keeps typed-action rows first, then higher impact, then newer; retires the rest', () => {
    const rows = [
      row('legacy-hi', { impact_score: 9 }),
      row('typed-lo', { action: { kind: 'open_screen' }, impact_score: 2 }),
      row('legacy-new', { created_at: '2026-09-24T00:00:00Z' }),
      row('legacy-old', { created_at: '2026-09-01T00:00:00Z' }),
      row('legacy-lo', { impact_score: 1 }),
    ];
    expect(selectExcessOpenRows(rows, NOW).sort()).toEqual(['legacy-lo', 'legacy-old']);
  });

  it('ignores expired rows (they no longer show) and returns nothing at or under the cap', () => {
    const rows = [row('a'), row('b'), row('c'), row('gone', { expires_at: '2026-09-24T00:00:00Z' })];
    expect(selectExcessOpenRows(rows, NOW)).toEqual([]);
  });
});

describe('retireExcessOpenRows (scan)', () => {
  function fakeSb(open: any[], opts: { failUpdate?: boolean } = {}) {
    const calls: any = { select: [] as any[], update: null as any, updateIn: null as any, updateEq: [] as any[] };
    const sb: any = {
      calls,
      from(table: string) {
        expect(table).toBe('autopilot_recommendations');
        const q: any = {
          _mode: 'select',
          select: () => q, limit: () => q,
          eq: (c: string, v: any) => { (q._mode === 'update' ? calls.updateEq : calls.select).push([c, v]); return q; },
          in: (c: string, v: any[]) => { calls.updateIn = [c, v]; return q; },
          update: (patch: any) => { q._mode = 'update'; calls.update = patch; return q; },
          then: (res: any, rej: any) => Promise.resolve(
            q._mode === 'update' ? { error: opts.failUpdate ? { message: 'denied' } : null } : { data: open, error: null },
          ).then(res, rej),
        };
        return q;
      },
    };
    return sb;
  }
  const open = Array.from({ length: 5 }, (_, i) => ({
    id: `r${i}`, action: null, impact_score: 10 - i, created_at: '2026-09-20T00:00:00Z', expires_at: null,
  }));

  it('reads only this member\'s open community rows', async () => {
    const sb = fakeSb(open);
    await retireExcessOpenRows(sb, USER, NOW, true);
    expect(sb.calls.select).toEqual([['user_id', USER], ['status', 'new'], ['role_scope', 'community']]);
  });

  it('dry run: reports what would be retired and writes nothing', async () => {
    const sb = fakeSb(open);
    const ids = await retireExcessOpenRows(sb, USER, NOW, true);
    expect(ids.sort()).toEqual(['r3', 'r4']);
    expect(sb.calls.update).toBeNull();
  });

  it('live: auto-archives only rows still open (a row acted on meanwhile is never touched)', async () => {
    const sb = fakeSb(open);
    const ids = await retireExcessOpenRows(sb, USER, NOW, false);
    expect(ids.sort()).toEqual(['r3', 'r4']);
    expect(sb.calls.update).toMatchObject({ status: 'auto_archived' });
    expect(sb.calls.updateIn[0]).toBe('id');
    expect(sb.calls.updateIn[1].sort()).toEqual(['r3', 'r4']);
    expect(sb.calls.updateEq).toEqual([['status', 'new']]);
  });

  it('a failed update retires nothing and does not throw', async () => {
    const sb = fakeSb(open, { failUpdate: true });
    await expect(retireExcessOpenRows(sb, USER, NOW, false)).resolves.toEqual([]);
  });

  it('nothing to retire at or under the cap: no write', async () => {
    const sb = fakeSb(open.slice(0, 3));
    expect(await retireExcessOpenRows(sb, USER, NOW, false)).toEqual([]);
    expect(sb.calls.update).toBeNull();
  });
});
