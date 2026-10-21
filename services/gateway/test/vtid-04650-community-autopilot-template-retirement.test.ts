/**
 * VTID-04650 (Community Autopilot, plan §3): templates nobody accepts retire.
 */
process.env.NODE_ENV = 'test';

import {
  computeTemplateStats,
  selectRetiredTemplates,
  loadRetiredTemplates,
  RETIRE_MIN_SHOWN,
} from '../src/services/community-autopilot/template-stats';
import { rankCandidates } from '../src/services/community-autopilot/ranker';
import { runScanners, type MemberSnapshot } from '../src/services/community-autopilot/scanners';

const NOW = new Date('2026-09-24T05:10:00Z');
const rows = (template: string, status: string, n: number) =>
  Array.from({ length: n }, () => ({ source_ref: `scan_${template}`, status }));

describe('computeTemplateStats', () => {
  it('counts decided offers and acceptances; open and system-archived rows count for neither', () => {
    const s = computeTemplateStats([
      ...rows('diary_gap', 'rejected', 3),
      ...rows('diary_gap', 'activated', 1),
      ...rows('diary_gap', 'completed', 1),
      ...rows('diary_gap', 'snoozed', 1),
      ...rows('diary_gap', 'new', 50),
      ...rows('diary_gap', 'auto_archived', 50),
      { source_ref: 'auto_something', status: 'rejected' },
      { source_ref: null, status: 'rejected' },
    ]);
    expect([...s.keys()]).toEqual(['diary_gap']);
    const d = s.get('diary_gap')!;
    expect(d).toMatchObject({ shown: 6, accepted: 2, rejected: 3 });
    expect(d.acceptRate).toBeCloseTo(2 / 6);
  });
});

describe('selectRetiredTemplates', () => {
  it('retires a template with enough offers and no acceptance', () => {
    const s = computeTemplateStats(rows('media_first', 'rejected', RETIRE_MIN_SHOWN));
    expect(selectRetiredTemplates(s)).toEqual(new Set(['media_first']));
  });

  it('keeps a template that has not had a fair test yet', () => {
    const s = computeTemplateStats(rows('media_first', 'rejected', RETIRE_MIN_SHOWN - 1));
    expect(selectRetiredTemplates(s).size).toBe(0);
  });

  it('keeps a template members do take up', () => {
    const s = computeTemplateStats([...rows('event_rsvp', 'rejected', 30), ...rows('event_rsvp', 'activated', 2)]);
    expect(selectRetiredTemplates(s).size).toBe(0);
  });

  it('retires below 3% even with some acceptance', () => {
    const s = computeTemplateStats([...rows('discover_explore', 'rejected', 99), ...rows('discover_explore', 'completed', 1)]);
    expect(selectRetiredTemplates(s)).toEqual(new Set(['discover_explore']));
  });
});

describe('ranker honours retired templates', () => {
  const snap: MemberSnapshot = {
    userId: 'aaaa1111-1111-4111-8111-111111111111',
    now: NOW,
    index: { total: 62, pillars: { sleep: 70, nutrition: 65, exercise: 55, hydration: 40, mental: 72 } },
    lastDiaryAt: '2026-09-18T20:00:00Z',
    unreadFrom: null,
    freshMatch: null,
    upcomingEvent: null,
    postsLast14d: 0,
    videosEver: 0,
    usedFeatures: new Set(),
    inboxItem: null,
  } as MemberSnapshot;

  it('a retired template is never picked and the drop says why', () => {
    const cands = runScanners(snap);
    const target = cands[0].template;
    const r = rankCandidates({ candidates: cands, history: [], usedFeatures: new Set(), now: NOW, retiredTemplates: new Set([target]) });
    expect(r.picks.map((p) => p.template)).not.toContain(target);
    expect(r.dropped.find((d) => d.reason === 'template_retired')).toBeDefined();
  });

  it('without retirement the ranker behaves exactly as before', () => {
    const cands = runScanners(snap);
    const a = rankCandidates({ candidates: cands, history: [], usedFeatures: new Set(), now: NOW });
    const b = rankCandidates({ candidates: cands, history: [], usedFeatures: new Set(), now: NOW, retiredTemplates: new Set() });
    expect(b).toEqual(a);
  });
});

describe('loadRetiredTemplates', () => {
  const sbReturning = (result: { data?: any; error?: any }) => {
    const q: any = {};
    for (const m of ['from', 'select', 'eq', 'like', 'in', 'gte']) q[m] = jest.fn(() => q);
    q.limit = jest.fn(async () => result);
    return q;
  };

  afterEach(() => { delete process.env.COMMUNITY_AUTOPILOT_TEMPLATE_RETIREMENT; });

  it('reads scan rows of the last 60 days and retires from them', async () => {
    const sb = sbReturning({ data: rows('media_first', 'rejected', 30), error: null });
    const r = await loadRetiredTemplates(sb, NOW);
    expect(r.retired).toEqual(new Set(['media_first']));
    expect(sb.eq).toHaveBeenCalledWith('source_type', 'community');
  });

  it('fails open: a read error retires nothing', async () => {
    const sb = sbReturning({ data: null, error: { message: 'boom' } });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await loadRetiredTemplates(sb, NOW);
    expect(r.retired.size).toBe(0);
    warn.mockRestore();
  });

  it('kill switch: COMMUNITY_AUTOPILOT_TEMPLATE_RETIREMENT=false reads nothing', async () => {
    process.env.COMMUNITY_AUTOPILOT_TEMPLATE_RETIREMENT = 'false';
    const sb = sbReturning({ data: rows('media_first', 'rejected', 30), error: null });
    const r = await loadRetiredTemplates(sb, NOW);
    expect(r.retired.size).toBe(0);
    expect(sb.from).not.toHaveBeenCalled();
  });
});
