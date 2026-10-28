/**
 * VTID-05167 — Life Timeline P1: timeline catalog + projector.
 *
 * - The catalog is well formed, every pillar is a real Vitana Index pillar
 *   (lib/vitana-pillars.ts), and the migration's activity_catalog seed is
 *   byte-identical to what the generator renders from the JSON.
 * - Internal telemetry (orb.livekit.next_action.*, orb.navigator.*, …) is
 *   `system` and the projector never writes it to user_activity_log, whether it
 *   arrives through projectOasisEventToTimeline or writeTimelineRow.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  resolveVitanaId: jest.fn(async () => null),
}));

import {
  classifyActivityType,
  getTimelineCatalog,
  isTimelineProjectable,
  TIMELINE_TIERS,
} from '../src/services/timeline/catalog';
import { projectOasisEventToTimeline, writeTimelineRow } from '../src/services/timeline-projector';
import { PILLAR_KEYS } from '../src/lib/vitana-pillars';

const REPO = path.resolve(__dirname, '../../..');
const MIGRATION = path.join(REPO, 'supabase/migrations/20261014130000_vtid_05167_activity_tiers.sql');
const ACTIVITY_TYPE_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;

describe('VTID-05167 timeline catalog', () => {
  const catalog = getTimelineCatalog();

  it('has unique, well-formed entries', () => {
    const seen = new Set<string>();
    for (const e of catalog.entries) {
      expect(seen.has(e.type)).toBe(false);
      seen.add(e.type);
      expect(TIMELINE_TIERS).toContain(e.tier);
      expect(catalog.categories).toContain(e.category);
      expect(['exact', 'prefix']).toContain(e.match);
      expect(['standard', 'special_category']).toContain(e.sensitivity);
      expect(e.summary_key).toMatch(/^timeline\.summary\.[a-z0-9_]+$/);
      expect(e.topic).toMatch(/^[a-z0-9_]+$/);
      if (e.match === 'exact') expect(e.type).toMatch(ACTIVITY_TYPE_RE);
      else expect(e.type.endsWith('.')).toBe(true);
    }
  });

  it('uses only the Vitana Index pillars, and pillar categories carry their pillar', () => {
    expect([...catalog.pillars].sort()).toEqual([...PILLAR_KEYS].sort());
    for (const e of catalog.entries) {
      if (e.pillar !== null) expect(PILLAR_KEYS).toContain(e.pillar);
      if (e.secondary_pillar !== null) expect(PILLAR_KEYS).toContain(e.secondary_pillar);
      if ((PILLAR_KEYS as readonly string[]).includes(e.category)) expect(e.pillar).toBe(e.category);
    }
    // Every pillar has at least one moment a member can see.
    for (const p of PILLAR_KEYS) {
      expect(catalog.entries.some((e) => e.pillar === p && e.tier === 'moment')).toBe(true);
    }
  });

  it('classifies exact before prefix, longest prefix first, unknown as silent', () => {
    expect(classifyActivityType('community.event.join').topic).toBe('event_rsvp');
    expect(classifyActivityType('community.event.view').tier).toBe('silent');
    expect(classifyActivityType('orb.turn.received').tier).toBe('silent');
    expect(classifyActivityType('orb.livekit.next_action.candidate').tier).toBe('system');
    expect(classifyActivityType('orb.navigator.requested').tier).toBe('system');
    expect(classifyActivityType('memory.identity.write_attempted').tier).toBe('system');
    expect(classifyActivityType('health.log.water')).toMatchObject({ tier: 'moment', pillar: 'hydration' });
    expect(classifyActivityType('diary.create')).toMatchObject({ tier: 'moment', secondary_pillar: 'mental' });
    expect(classifyActivityType('page.view')).toMatchObject({ tier: 'silent', category: 'app_usage' });
    const unknown = classifyActivityType('brand.new_thing');
    expect(unknown).toMatchObject({ tier: 'silent', topic: 'unknown', matched: null });
  });

  it('every activity type members actually had in the last 120 days (2026-10-13) is classified deliberately', () => {
    // Read-only production count, recorded in docs/validation/VTID-05167/acceptance.md.
    const observed: Record<string, string> = {
      'orb.livekit.next_action.candidate': 'system',
      'page.view': 'silent',
      'auth.login': 'silent',
      'orb.session.identity.resolved': 'system',
      'orb.session.continuity.persisted': 'system',
      'orb.livekit.next_action.suppressed': 'system',
      'orb.session.audio_ready.acked': 'system',
      'orb.session.profile.resolved': 'system',
      'discover.view': 'silent',
      'orb.livekit.next_action.suggested': 'system',
      'community.follow': 'moment',
      'auth.signup': 'moment',
      'memory.identity.write_attempted': 'system',
      'orb.live.audio_blocked': 'system',
      'community.message.send': 'digest',
      'community.unfollow': 'silent',
      'orb.live.audio_blocked.recovered': 'system',
      'calendar.create': 'moment',
      'orb.session.start': 'silent',
      'orb.search_events.auto_nav': 'system',
      'community.search.member': 'silent',
      'community.search': 'silent',
    };
    for (const [type, tier] of Object.entries(observed)) {
      const c = classifyActivityType(type);
      expect({ type, tier: c.tier }).toEqual({ type, tier });
      expect(c.matched).not.toBeNull();
    }
  });

  it('the migration seed is exactly what the generator renders from the JSON', () => {
    const expected = execFileSync(process.execPath, [path.join(REPO, 'scripts/timeline/generate-activity-catalog-seed.mjs')], {
      encoding: 'utf8',
    }).trim();
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    const m = sql.match(/-- BEGIN GENERATED activity_catalog seed[^\n]*\n([\s\S]*?)\n-- END GENERATED activity_catalog seed/);
    expect(m).not.toBeNull();
    expect(m![1].trim()).toBe(expected);
  });

  it('the migration tier/pillar checks match the catalog', () => {
    const sql = fs.readFileSync(MIGRATION, 'utf8');
    expect(sql).toContain(`tier IN (${TIMELINE_TIERS.map((t) => `'${t}'`).join(',')})`);
    expect(sql).toContain(`pillar IN (${PILLAR_KEYS.map((p) => `'${p}'`).join(',')})`);
  });
});

describe('VTID-05167 projector never writes system telemetry', () => {
  const realFetch = global.fetch;
  const fetchMock = jest.fn(async () => ({ ok: true, status: 201, text: async () => '' }) as unknown as Response);

  beforeAll(() => {
    process.env.SUPABASE_URL = 'https://example.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = realFetch;
  });
  beforeEach(() => fetchMock.mockClear());

  const activityInserts = () =>
    fetchMock.mock.calls.filter((c) => String((c as unknown[])[0]).endsWith('/rest/v1/user_activity_log'));

  it.each([
    'orb.livekit.next_action.candidate',
    'orb.livekit.next_action.suppressed',
    'orb.livekit.next_action.suggested',
    'orb.navigator.requested',
    'orb.session.identity.resolved',
    'vtid.live.audio_blocked',
  ])('drops %s', async (topic) => {
    await projectOasisEventToTimeline({
      topic,
      actor_id: '0adc6ff6-acb0-4dca-99d0-29521aaaaaaa',
      event_id: 'e1',
      status: 'info',
      message: topic,
      payload: { source: 'life_compass_alignment', status: 'skipped', winner: false },
    });
    expect(isTimelineProjectable(topic.replace('vtid.live.', 'orb.'))).toBe(false);
    expect(activityInserts()).toHaveLength(0);
  });

  it('still projects a member moment (diary.create)', async () => {
    await projectOasisEventToTimeline({ topic: 'diary.create', actor_id: 'u1', event_id: 'e2' });
    expect(activityInserts()).toHaveLength(1);
  });

  it('writeTimelineRow refuses a system type from a direct caller', async () => {
    await writeTimelineRow({ user_id: 'u1', activity_type: 'orb.livekit.next_action.candidate', source: 'test' });
    expect(activityInserts()).toHaveLength(0);
  });
});
