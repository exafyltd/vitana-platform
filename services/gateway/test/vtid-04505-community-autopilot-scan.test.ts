/**
 * VTID-04505 (Community Autopilot CA-5): twice-daily scanners + ranker.
 */
process.env.NODE_ENV = 'test';

const mockExcluded = jest.fn(async () => new Set<string>());
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIds: () => mockExcluded(),
}));
jest.mock('../src/i18n/server-locale', () => ({
  bulkGetUserLocales: jest.fn(async (_sb: unknown, ids: string[]) => new Map(ids.map((id) => [id, 'de']))),
  getUserLocale: jest.fn(async () => 'de'),
}));

import {
  runScanners,
  scanDiaryGap,
  scanIndexPillar,
  scanReplyMessage,
  type MemberSnapshot,
} from '../src/services/community-autopilot/scanners';
import { rankCandidates, MAX_OPEN_PER_ROLE, type HistoryRow } from '../src/services/community-autopilot/ranker';
import { buildRow, isDue, runCommunityScan } from '../src/services/community-autopilot/scan-runner';
import { tt } from '../src/i18n/catalog';

const NOW = new Date('2026-09-24T05:10:00Z'); // 07:10 Europe/Berlin
const USER = 'aaaa1111-1111-4111-8111-111111111111';
const FRIEND = 'cccc3333-3333-4333-8333-333333333333';
const BOT = 'dddd4444-4444-4444-8444-444444444444';

const snap = (over: Partial<MemberSnapshot> = {}): MemberSnapshot => ({
  userId: USER,
  now: NOW,
  index: { total: 62, pillars: { sleep: 70, nutrition: 65, exercise: 55, hydration: 40, mental: 72 } },
  lastDiaryAt: '2026-09-18T20:00:00Z',
  unreadFrom: { userId: FRIEND, name: 'Ana', sentAt: '2026-09-23T10:00:00Z' },
  freshMatch: { userId: 'eeee5555-5555-4555-8555-555555555555', name: 'Marko' },
  upcomingEvent: { id: 'ev-1', title: 'Sunrise Yoga', startsAt: '2026-09-26T06:00:00Z' },
  postsLast14d: 0,
  videosEver: 0,
  usedFeatures: new Set(['diary', 'messenger', 'vitana_index']),
  inboxItem: null,
  ...over,
});

describe('scanners', () => {
  it('index: the weakest pillar gets a matching own-data action', () => {
    const c = scanIndexPillar(snap())!;
    expect(c.params.pillar).toBe('hydration');
    expect(c.action).toEqual({ kind: 'log_water', params: { amount_ml: 250 } });
  });

  it('index: nothing when every pillar is healthy', () => {
    expect(scanIndexPillar(snap({ index: { total: 80, pillars: { sleep: 80, hydration: 75 } } }))).toBeNull();
  });

  it('diary: opens the diary after 3 quiet days, never drafts it', () => {
    const c = scanDiaryGap(snap())!;
    expect(c.action).toEqual({ kind: 'open_screen', params: { route: '/diary' } });
    expect(scanDiaryGap(snap({ lastDiaryAt: '2026-09-23T20:00:00Z' }))).toBeNull();
  });

  it('messages: a reply draft to the person who wrote, only after 12 hours', () => {
    const c = scanReplyMessage(snap())!;
    expect(c.action.kind).toBe('send_chat_message');
    expect(c.action.params?.recipient_user_id).toBe(FRIEND);
    expect(scanReplyMessage(snap({ unreadFrom: { userId: FRIEND, name: 'Ana', sentAt: '2026-09-24T04:00:00Z' } }))).toBeNull();
  });

  it('every candidate carries a registry action kind', () => {
    const { ACTION_REGISTRY } = require('../src/services/community-autopilot/action-registry');
    for (const c of runScanners(snap({ inboxItem: { id: 'r1', title: 'Drink more', body: null } }))) {
      expect(ACTION_REGISTRY[c.action.kind]).toBeDefined();
    }
  });
});

describe('ranker', () => {
  const cands = () => runScanners(snap());

  it(`caps at ${MAX_OPEN_PER_ROLE}, one per category`, () => {
    const r = rankCandidates({ candidates: cands(), history: [], usedFeatures: new Set(), now: NOW });
    expect(r.picks).toHaveLength(3);
    expect(new Set(r.picks.map((p) => p.category)).size).toBe(3);
  });

  it('open rows use up slots and their categories', () => {
    const history: HistoryRow[] = [
      { fingerprint: 'x', template: 'reply_message', status: 'new', category: 'connect', updated_at: NOW.toISOString() },
      { fingerprint: 'y', template: 'index_pillar', status: 'new', category: 'health', updated_at: NOW.toISOString() },
    ];
    const r = rankCandidates({ candidates: cands(), history, usedFeatures: new Set(), now: NOW });
    expect(r.openSlots).toBe(1);
    expect(r.picks).toHaveLength(1);
    expect(['connect', 'health']).not.toContain(r.picks[0].category);
  });

  it('a template rejected twice in 30 days is suppressed', () => {
    const rej = (d: string): HistoryRow => ({ fingerprint: `old-${d}`, template: 'reply_message', status: 'rejected', updated_at: d });
    const r = rankCandidates({ candidates: cands(), history: [rej('2026-09-10T00:00:00Z'), rej('2026-09-20T00:00:00Z')], usedFeatures: new Set(), now: NOW });
    expect(r.picks.map((p) => p.template)).not.toContain('reply_message');
    expect(r.dropped).toContainEqual({ fingerprint: `reply_message:${FRIEND}`, reason: 'template_rejected_twice' });
  });

  it('the same target is not proposed again within 14 days', () => {
    const r = rankCandidates({
      candidates: cands(),
      history: [{ fingerprint: `reply_message:${FRIEND}`, template: 'reply_message', status: 'completed', updated_at: '2026-09-20T00:00:00Z' }],
      usedFeatures: new Set(), now: NOW,
    });
    expect(r.picks.map((p) => p.fingerprint)).not.toContain(`reply_message:${FRIEND}`);
  });

  it('a never-used feature gets the novelty bonus', () => {
    const { scanMediaFirst } = require('../src/services/community-autopilot/scanners');
    const c = scanMediaFirst(snap());
    const fresh = rankCandidates({ candidates: [c], history: [], usedFeatures: new Set(), now: NOW }).picks[0];
    const known = rankCandidates({ candidates: [c], history: [], usedFeatures: new Set(['media_hub']), now: NOW }).picks[0];
    expect(fresh.novelty).toBe(true);
    expect(known.novelty).toBe(false);
    expect(fresh.score).toBeGreaterThan(known.score);
  });
});

describe('runner', () => {
  it('is due only at local 07 and 17', () => {
    expect(isDue(NOW, 'Europe/Berlin')).toBe(true);
    expect(isDue(new Date('2026-09-24T15:05:00Z'), 'Europe/Berlin')).toBe(true);
    expect(isDue(new Date('2026-09-24T09:05:00Z'), 'Europe/Berlin')).toBe(false);
    expect(isDue(NOW, 'Not/AZone')).toBe(false);
  });

  it('rows are in the member\'s language with a typed action and an expiry', () => {
    const [c] = rankCandidates({ candidates: [scanIndexPillar(snap())!], history: [], usedFeatures: new Set(), now: NOW }).picks;
    const row = buildRow(USER, c, 'de', NOW, tt as any);
    expect(row.title).toBe('Stärke deine Hydration');
    expect(row.source_type).toBe('community');
    expect(row.source_ref).toBe('scan_index_pillar');
    expect(row.action.kind).toBe('log_water');
    expect(row.impact_score).toBeGreaterThanOrEqual(1);
    expect(row.impact_score).toBeLessThanOrEqual(10);
    expect(Date.parse(row.expires_at)).toBeGreaterThan(NOW.getTime());
  });

  function fakeSb(tables: Record<string, any[]>) {
    const inserted: any[] = [];
    const sb: any = {
      inserted,
      from(table: string) {
        let data = [...(tables[table] ?? [])];
        const q: any = {
          select: () => q, order: () => q, limit: () => q, gte: () => q, lte: () => q, not: () => q, is: () => q,
          eq: (c: string, v: any) => { data = data.filter((r) => r[c] === undefined || r[c] === v); return q; },
          in: (c: string, vs: any[]) => { data = data.filter((r) => r[c] === undefined || vs.includes(r[c])); return q; },
          insert: async (rows: any[]) => { inserted.push(...rows); return { error: null }; },
          then: (res: any, rej: any) => Promise.resolve({ data, error: null }).then(res, rej),
        };
        return q;
      },
    };
    return sb;
  }

  const tables = () => ({
    user_tenants: [{ user_id: USER, is_primary: true }, { user_id: BOT, is_primary: true }],
    vitana_index_scores: [{ user_id: USER, score_total: 60, score_sleep: 70, score_nutrition: 65, score_exercise: 55, score_hydration: 40, score_mental: 72 }],
    chat_messages: [{ receiver_id: USER, sender_id: BOT, created_at: '2026-09-22T10:00:00Z' }],
    profiles: [{ user_id: BOT, first_name: 'Bot' }],
  });

  it('writes nothing unless COMMUNITY_AUTOPILOT_SCAN_ENABLED is exactly true', async () => {
    delete process.env.COMMUNITY_AUTOPILOT_SCAN_ENABLED;
    const sb = fakeSb(tables());
    const out = await runCommunityScan(sb, { now: NOW });
    expect(out.dry_run).toBe(true);
    expect(sb.inserted).toHaveLength(0);
    expect(out.members_scanned).toBeGreaterThan(0);
  });

  it('never scans or targets a test/service account', async () => {
    process.env.COMMUNITY_AUTOPILOT_SCAN_ENABLED = 'true';
    mockExcluded.mockResolvedValue(new Set([BOT]));
    const sb = fakeSb(tables());
    const out = await runCommunityScan(sb, { now: NOW });
    expect(out.results.map((r) => r.user_id)).toEqual([USER]);
    expect(sb.inserted.length).toBeGreaterThan(0);
    for (const row of sb.inserted) {
      expect(row.user_id).toBe(USER);
      expect(JSON.stringify(row.action)).not.toContain(BOT);
    }
    delete process.env.COMMUNITY_AUTOPILOT_SCAN_ENABLED;
  });

  it('members outside 07/17 local are not scanned by the tick', async () => {
    const sb = fakeSb(tables());
    const out = await runCommunityScan(sb, { now: new Date('2026-09-24T09:05:00Z') });
    expect(out.members_due).toBe(0);
  });
});
