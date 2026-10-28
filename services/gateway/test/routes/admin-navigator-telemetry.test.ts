/**
 * VTID-04846 — the Navigator admin API keeps only /telemetry, and telemetry
 * reads the registry navigator's events (kind / candidates, scores 0..1) as
 * well as the legacy consult's (confidence / top_picks, scores 0..100).
 */
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

import * as fs from 'fs';
import * as path from 'path';
import { aggregateNavigatorTelemetry } from '../../src/routes/admin-navigator';

const registry = (type: string, payload: Record<string, unknown>) => ({ type, payload: { resolver: 'registry-v2', ...payload } });

describe('Navigator telemetry (VTID-04846)', () => {
  it('counts opened screens, misses and near ties from registry events', () => {
    const t = aggregateNavigatorTelemetry([
      registry('orb.navigator.requested', { screen_id: 'INBOX.OVERVIEW' }),
      registry('orb.navigator.requested', { screen_id: 'INBOX.OVERVIEW' }),
      registry('orb.navigator.requested', { screen_id: 'WALLET.OVERVIEW' }),
      registry('orb.navigator.resolved', { kind: 'match', question: 'open my inbox', candidates: [{ screen_id: 'INBOX.OVERVIEW', score: 0.8 }] }),
      registry('orb.navigator.resolved', { kind: 'none', question: 'the purple thing', candidates: [] }),
      registry('orb.navigator.resolved', { kind: 'unavailable', question: 'open wallet' }),
      registry('orb.navigator.resolved', {
        kind: 'ambiguous', question: 'my orders',
        candidates: [{ screen_id: 'DISCOVER.ORDERS', score: 0.61 }, { screen_id: 'WALLET.OVERVIEW', score: 0.58 }],
      }),
      registry('orb.navigator.blocked', { error_kind: 'missing_param', attempted_screen_id: 'INBOX.CONVERSATION' }),
    ]);
    expect(t.event_count).toBe(8);
    expect(t.by_type).toEqual({ 'orb.navigator.requested': 3, 'orb.navigator.resolved': 4, 'orb.navigator.blocked': 1 });
    expect(t.top_screens).toEqual([{ screen_id: 'INBOX.OVERVIEW', count: 2 }, { screen_id: 'WALLET.OVERVIEW', count: 1 }]);
    expect(t.failed_utterances.map((f) => [f.utterance, f.confidence])).toEqual([['the purple thing', 'none'], ['open wallet', 'unavailable']]);
    expect(t.near_misses).toEqual([expect.objectContaining({ utterance: 'my orders', delta: 0.03 })]);
  });

  it('still reads legacy consult events in the same window', () => {
    const t = aggregateNavigatorTelemetry([
      { type: 'orb.navigator.consulted', payload: { question: 'x', confidence: 'low', top_picks: [{ screen_id: 'A', score: 50 }, { screen_id: 'B', score: 48 }] } },
    ]);
    expect(t.failed_utterances).toHaveLength(1);
    expect(t.near_misses).toEqual([expect.objectContaining({ delta: 2 })]);
    expect(t.top_screens.map((s) => s.screen_id)).toEqual(['A', 'B']);
  });

  it('serves telemetry only: the nav_catalog CRUD, simulator, coverage and reload routes are gone', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/routes/admin-navigator.ts'), 'utf8');
    expect(src.match(/router\.(get|post|patch|delete)\('([^']+)'/g)).toEqual(["router.get('/telemetry'"]);
  });
});
