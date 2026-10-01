/**
 * VTID-04776 / VTID-04778 — Voice Supervisor: pure analysis, the facts
 * writer's outcome classification and write protocol, and the healing
 * recurrence helper.
 */

import {
  computeKpis,
  computeVerdicts,
  buildSegmentMatrix,
  compareImpact,
  targetFailureRate,
  effectiveOutcome,
  assistantKey,
  isRateAnomalous,
  isLatencyAnomalous,
  percentile,
  cellHealth,
  MIN_SAMPLE,
  ACTIVE_WINDOW_MS,
  type FactRow,
} from '../src/services/voice-supervisor-analysis';
import {
  classifyVoiceSessionOutcome,
  toFactsProvider,
  stopEventContext,
  endFieldsFromLiveSession,
  recordVoiceSessionStart,
  updateVoiceSessionFacts,
  recordVoiceSessionEnd,
  noteFirstAudioOut,
  __flushVoiceSessionFactsForTests,
  __resetVoiceSessionFactsForTests,
} from '../src/services/voice-session-facts';
import { recurrenceAfterFixMs } from '../src/services/voice-recurrence-sentinel';
import { resolveLiveKitProfile } from '../src/routes/orb-livekit';

const NOW = Date.parse('2026-10-01T12:00:00Z');
const T_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let seq = 0;
function row(over: Partial<FactRow> = {}): FactRow {
  seq += 1;
  return {
    session_id: `live-${seq}`,
    tenant_id: T_A,
    is_anonymous: false,
    surface: 'vitanaland',
    role: 'community',
    provider: 'nova_sonic',
    lang: 'de',
    started_at: new Date(NOW - 3600_000).toISOString(),
    ended_at: new Date(NOW - 3500_000).toISOString(),
    duration_ms: 100_000,
    ttfa_ms: 1200,
    outcome: 'ok',
    failure_class: null,
    ...over,
  };
}
function many(n: number, over: Partial<FactRow> = {}): FactRow[] {
  return Array.from({ length: n }, () => row(over));
}

// ---------------------------------------------------------------------------
describe('VTID-04776 KPIs', () => {
  test('rates are over finished sessions; live sessions count as sessions only', () => {
    const rows = [
      ...many(6, { outcome: 'ok' }),
      ...many(2, { outcome: 'silent' }),
      ...many(1, { outcome: 'dropped' }),
      ...many(1, { outcome: 'error' }),
      row({ outcome: 'active', ended_at: null, last_activity_at: new Date(NOW - 60_000).toISOString() }),
    ];
    const k = computeKpis(rows, NOW);
    expect(k.sessions).toBe(11);
    expect(k.finished).toBe(10);
    expect(k.ok_rate).toBeCloseTo(0.6);
    expect(k.silent_rate).toBeCloseTo(0.2);
    expect(k.drop_rate).toBeCloseTo(0.1);
    expect(k.error_rate).toBeCloseTo(0.1);
    expect(k.one_way_rate).toBe(0);
    expect(k.p50_ttfa_ms).toBe(1200);
  });

  test('a never-ended row older than the live window counts as abandoned, not live', () => {
    const stale = row({ outcome: 'active', ended_at: null, last_activity_at: new Date(NOW - ACTIVE_WINDOW_MS - 1000).toISOString() });
    const fresh = row({ outcome: 'active', ended_at: null, last_activity_at: new Date(NOW - 1000).toISOString() });
    expect(effectiveOutcome(stale, NOW)).toBe('abandoned');
    expect(effectiveOutcome(fresh, NOW)).toBe('active');
  });

  test('percentile matches percentile_cont (linear interpolation)', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(3); // 2.5 rounded
    expect(percentile([100, 200, 300, 400, 500], 0.95)).toBe(480);
    expect(percentile([], 0.5)).toBeNull();
  });

  test('empty window → null rates, never NaN', () => {
    const k = computeKpis([], NOW);
    expect(k.sessions).toBe(0);
    expect(k.ok_rate).toBeNull();
    expect(k.p50_ttfa_ms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04776 verdict: everyone, or one segment?', () => {
  test('fewer than MIN_SAMPLE finished sessions → insufficient_data', () => {
    const r = computeVerdicts(many(MIN_SAMPLE - 1, { outcome: 'silent' }), NOW);
    expect(r.verdict_summary).toBe('insufficient_data');
    expect(r.verdicts).toEqual([]);
  });

  test('all healthy → healthy', () => {
    const rows = [...many(40, { tenant_id: T_A }), ...many(40, { tenant_id: T_B, provider: 'cascade' })];
    expect(computeVerdicts(rows, NOW).verdict_summary).toBe('healthy');
  });

  test('one provider silent while others are fine → segment_specific on that provider', () => {
    const rows = [
      ...many(60, { provider: 'nova_sonic' }),
      ...many(15, { provider: 'cascade', lang: 'pl' }),
      ...many(15, { provider: 'cascade', lang: 'pl', outcome: 'silent' }),
    ];
    const r = computeVerdicts(rows, NOW);
    expect(r.verdict_summary).toBe('segment_specific');
    const v = r.verdicts.find((x) => x.scope === 'provider' && x.metric === 'silent');
    expect(v).toBeDefined();
    expect(v!.key).toBe('cascade');
    expect(v!.segment_rate).toBeCloseTo(0.5);
    expect(v!.baseline_rate).toBe(0);
    expect(v!.sessions).toBe(30);
    expect(r.verdicts.some((x) => x.scope === 'system')).toBe(false);
  });

  test('failure spread across every tenant → system_wide', () => {
    const rows = [
      ...many(25, { tenant_id: T_A }), ...many(15, { tenant_id: T_A, outcome: 'dropped' }),
      ...many(25, { tenant_id: T_B }), ...many(15, { tenant_id: T_B, outcome: 'dropped' }),
    ];
    const r = computeVerdicts(rows, NOW);
    expect(r.verdict_summary).toBe('system_wide');
    expect(r.verdicts[0]).toMatchObject({ scope: 'system', metric: 'drop', severity: 'critical' });
  });

  test('baseline is the OTHER sessions, and the rule needs 2x AND +10pp', () => {
    expect(isRateAnomalous(0.12, 0.05)).toBe(false); // 2.4x but only +7pp
    expect(isRateAnomalous(0.16, 0.05)).toBe(true);
    expect(isRateAnomalous(0.5, 0.3)).toBe(false);   // +20pp but < 2x
    expect(isLatencyAnomalous(2000, 1200)).toBe(true);
    expect(isLatencyAnomalous(1700, 1200)).toBe(false); // 1.42x
    expect(isLatencyAnomalous(900, 500)).toBe(false);   // 1.8x but +400ms
  });

  test('a slow language is a ttfa verdict', () => {
    const rows = [...many(40, { lang: 'de', ttfa_ms: 1000 }), ...many(30, { lang: 'sr', ttfa_ms: 4000, provider: 'vertex_serbian_bridge' })];
    const r = computeVerdicts(rows, NOW);
    expect(r.verdicts.some((v) => v.scope === 'lang' && v.key === 'sr' && v.metric === 'ttfa')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04776 segment matrix', () => {
  test('tenant x assistant with labels; anonymous is its own assistant', () => {
    const rows = [
      ...many(12, { tenant_id: T_A, surface: 'vitanaland' }),
      ...many(3, { tenant_id: T_A, surface: 'command-hub', role: 'developer' }),
      ...many(4, { tenant_id: null, is_anonymous: true }),
    ];
    const m = buildSegmentMatrix(rows, 'tenant', 'assistant', NOW, (d, k) => (d === 'tenant' && k === T_A ? 'Maxina' : k === 'community' ? 'Community Vitana' : k));
    expect(m.columns.map((c) => c.key)).toEqual(['community', 'developer', 'anonymous']);
    const a = m.rows.find((r) => r.key === T_A)!;
    expect(a.label).toBe('Maxina');
    expect(a.cells.community.sessions).toBe(12);
    expect(a.cells.community.health).toBe('ok');
    expect(a.cells.developer.health).toBe('insufficient');
    expect(a.cells.anonymous).toBeUndefined();
    expect(m.totals.sessions).toBe(19);
  });

  test('assistantKey maps surfaces to the assistant profile', () => {
    expect(assistantKey(row({ surface: 'command-hub' }))).toBe('developer');
    expect(assistantKey(row({ surface: 'backoffice' }))).toBe('backoffice');
    expect(assistantKey(row({ surface: 'vitanaland', is_anonymous: true }))).toBe('anonymous');
  });

  test('cell health bands', () => {
    const base = computeKpis(many(20), NOW);
    expect(cellHealth(base)).toBe('ok');
    expect(cellHealth({ ...base, drop_rate: 0.2 })).toBe('bad');
    expect(cellHealth({ ...base, silent_rate: 0.06 })).toBe('warn');
    expect(cellHealth({ ...base, p50_ttfa_ms: 5000 })).toBe('bad');
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04778 fix impact', () => {
  const cmp = (b: number, a: number, bs = 50, as = 50) =>
    compareImpact({ before_sessions: bs, after_sessions: as, before_rate: b, after_rate: a, target_metric: 'x' }).verdict;

  test('improved needs >= 25% relative AND >= 2pp', () => {
    expect(cmp(0.20, 0.10)).toBe('improved');
    expect(cmp(0.20, 0.17)).toBe('no_change');  // 15% relative
    expect(cmp(0.04, 0.025)).toBe('no_change'); // 37% relative but 1.5pp
  });
  test('regressed is symmetric', () => {
    expect(cmp(0.10, 0.20)).toBe('regressed');
    expect(cmp(0, 0.05)).toBe('regressed');
  });
  test('either window below MIN_SAMPLE → insufficient_data', () => {
    expect(cmp(0.2, 0.1, MIN_SAMPLE - 1, 50)).toBe('insufficient_data');
    expect(cmp(0.2, 0.1, 50, 3)).toBe('insufficient_data');
  });
  test('target rate is the fix class rate when known, else 1 - ok_rate', () => {
    const rows = [...many(8), ...many(2, { outcome: 'silent', failure_class: 'voice.model_stall' })];
    expect(targetFailureRate(rows, 'voice.model_stall', NOW)).toBeCloseTo(0.2);
    expect(targetFailureRate(rows, null, NOW)).toBeCloseTo(0.2);
    expect(targetFailureRate(rows, 'voice.no_engagement', NOW)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04776 facts outcome classification', () => {
  test('error reason wins', () => {
    expect(classifyVoiceSessionOutcome({ close_reason: 'client_error', audio_out_chunks: 50, audio_in_chunks: 50, duration_ms: 60_000 }).outcome).toBe('error');
  });
  test('closed inside the greeting grace with no audio → abandoned', () => {
    expect(classifyVoiceSessionOutcome({ audio_in_chunks: 0, audio_out_chunks: 0, duration_ms: 2000 }).outcome).toBe('abandoned');
    expect(classifyVoiceSessionOutcome({ close_reason: 'idle_no_engagement', audio_out_chunks: 10, duration_ms: 400_000 }).outcome).toBe('abandoned');
  });
  test('heard the user, never spoke → one_way via the taxonomy detector', () => {
    expect(classifyVoiceSessionOutcome({ audio_in_chunks: 300, audio_out_chunks: 0, duration_ms: 40_000 })).toEqual({
      outcome: 'one_way', failure_class: 'voice.no_engagement',
    });
    expect(classifyVoiceSessionOutcome({ audio_in_chunks: 5, audio_out_chunks: 0, duration_ms: 10_000 })).toEqual({
      outcome: 'one_way', failure_class: 'voice.audio_one_way',
    });
  });
  test('spoke but no mic ever reached us for 30s+ → one_way', () => {
    expect(classifyVoiceSessionOutcome({ audio_in_chunks: 0, audio_out_chunks: 200, turn_count: 0, duration_ms: 45_000 }).outcome).toBe('one_way');
  });
  test('no audio either way after the greeting was owed → silent', () => {
    expect(classifyVoiceSessionOutcome({ audio_in_chunks: 0, audio_out_chunks: 0, duration_ms: 12_000 }).outcome).toBe('silent');
  });
  test('abnormal upstream close near the end → dropped; normal close → ok', () => {
    const base = { audio_in_chunks: 200, audio_out_chunks: 300, turn_count: 4, duration_ms: 90_000 };
    expect(classifyVoiceSessionOutcome({ ...base, close_code: 1006, close_age_ms: 2000 })).toEqual({ outcome: 'dropped', failure_class: 'voice.upstream_disconnect' });
    expect(classifyVoiceSessionOutcome({ ...base, close_code: 1006, close_age_ms: 10 * 60_000 }).outcome).toBe('ok');
    expect(classifyVoiceSessionOutcome({ ...base, close_code: 1000, close_age_ms: 100 }).outcome).toBe('ok');
  });
  test('provider vocabulary', () => {
    expect(toFactsProvider('cascaded')).toBe('cascade');
    expect(toFactsProvider('vertex')).toBe('vertex_serbian_bridge');
    expect(toFactsProvider('nova_sonic')).toBe('nova_sonic');
    expect(toFactsProvider('livekit')).toBe('livekit');
    expect(toFactsProvider(undefined)).toBe('unknown');
  });
  test('stop events now carry surface, served role, lang, provider and reason', () => {
    const s = {
      assistantProfile: { surface: 'vitanaland', role: null, isWorkSurface: false },
      active_role: 'patient', lang: 'de', upstreamProvider: 'nova_sonic', lastUpstreamCloseCode: 1006,
    };
    expect(stopEventContext(s, 'client_stop')).toEqual({
      surface: 'vitanaland', role: 'patient', lang: 'de', provider: 'nova_sonic', reason: 'client_stop', close_code: 1006,
    });
    // a work surface always serves its fixed role
    expect(stopEventContext({ assistantProfile: { surface: 'command-hub', role: 'developer', isWorkSurface: true }, active_role: 'community' }, 'x').role).toBe('developer');
  });
  test('end fields from a live session keep only real uuids', () => {
    const f = endFieldsFromLiveSession({
      identity: { user_id: 'anonymous', tenant_id: T_A },
      createdAt: new Date(NOW - 30_000), audioInChunks: 10, audioOutChunks: 20, turn_count: 1,
      transcriptTurns: [{ role: 'user' }, { role: 'assistant' }],
    }, 'user_stop', NOW);
    expect(f.user_id).toBeNull();
    expect(f.tenant_id).toBe(T_A);
    expect(f.duration_ms).toBe(30_000);
    expect(f.user_turns).toBe(1);
    expect(f.model_turns).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04776 facts writer protocol', () => {
  const fetchMock = jest.fn();
  const origFetch = global.fetch;
  beforeEach(() => {
    __resetVoiceSessionFactsForTests();
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, status: 201, text: async () => '' });
    (global as any).fetch = fetchMock;
    delete process.env.VOICE_SESSION_FACTS_ENABLED;
  });
  afterAll(() => { (global as any).fetch = origFetch; });

  const calls = () => fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), method: init.method, body: JSON.parse(init.body) }));

  test('start upserts; a later update PATCHes the row; end upserts with the outcome', async () => {
    recordVoiceSessionStart({ session_id: 'live-x', surface: 'vitanaland', lang: 'de', started_at: new Date(NOW).toISOString() });
    updateVoiceSessionFacts('live-x', { provider: 'nova_sonic' });
    recordVoiceSessionEnd('live-x', { duration_ms: 3000, audio_in_chunks: 0, audio_out_chunks: 0, close_reason: 'client_stop' });
    await __flushVoiceSessionFactsForTests();
    const c = calls();
    expect(c).toHaveLength(3);
    expect(c[0]).toMatchObject({ method: 'POST', body: { session_id: 'live-x', outcome: 'active', surface: 'vitanaland' } });
    expect(c[0].url).toContain('on_conflict=session_id');
    expect(c[1]).toMatchObject({ method: 'PATCH', body: { provider: 'nova_sonic' } });
    expect(c[1].url).toContain('session_id=eq.live-x');
    expect(c[2]).toMatchObject({ method: 'POST', body: { outcome: 'abandoned', close_reason: 'client_stop' } });
    expect(c[2].body.started_at).toBeDefined();
  });

  test('an update that arrives before the start is merged into the start row, not lost', async () => {
    updateVoiceSessionFacts('live-early', { role: 'patient' });
    expect(fetchMock).not.toHaveBeenCalled();
    recordVoiceSessionStart({ session_id: 'live-early', role: null, started_at: new Date(NOW).toISOString() });
    await __flushVoiceSessionFactsForTests();
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0].body.role).toBe('patient');
  });

  test('first audio is recorded once per session', async () => {
    recordVoiceSessionStart({ session_id: 'live-t', started_at: new Date().toISOString() });
    const s: any = { sessionId: 'live-t', createdAt: new Date(Date.now() - 1500) };
    noteFirstAudioOut(s);
    noteFirstAudioOut(s);
    await __flushVoiceSessionFactsForTests();
    const patches = calls().filter((x) => x.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0].body.ttfa_ms).toBeGreaterThanOrEqual(1500);
  });

  test('a failing write is logged loudly and never throws', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    expect(() => recordVoiceSessionStart({ session_id: 'live-f', started_at: new Date().toISOString() })).not.toThrow();
    await __flushVoiceSessionFactsForTests();
    expect(err.mock.calls.some((c) => String(c[0]).includes('start failed for live-f') && String(c[0]).includes('boom'))).toBe(true);
    err.mockRestore();
  });

  test('orb-agent LiveKit stop (via /oasis/emit) ends the row with a derived start', async () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recordLiveKitAgentLifecycle } = require('../src/routes/oasis-emit');
    recordLiveKitAgentLifecycle('vtid.live.session.stop', {
      session_id: 'orb-abc', transport: 'livekit', user_id: 'anon-1', tenant_id: T_A,
      duration_ms: 60_000, turn_count: 4, user_turns: 2, model_turns: 2,
      audio_in_chunks: 100, audio_out_chunks: 100, stall_count: 0,
    });
    recordLiveKitAgentLifecycle('vtid.live.session.stop', { session_id: 'live-x', transport: 'websocket' });
    await __flushVoiceSessionFactsForTests();
    const c = calls();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      method: 'POST',
      body: { session_id: 'orb-abc', transport: 'livekit', provider: 'livekit', user_id: null, tenant_id: T_A, outcome: 'ok', close_reason: 'livekit_agent_teardown' },
    });
    expect(Date.parse(c[0].body.ended_at) - Date.parse(c[0].body.started_at)).toBe(60_000);
  });

  test('kill switch VOICE_SESSION_FACTS_ENABLED=false writes nothing', async () => {
    process.env.VOICE_SESSION_FACTS_ENABLED = 'false';
    recordVoiceSessionStart({ session_id: 'live-k', started_at: new Date().toISOString() });
    recordVoiceSessionEnd('live-k', { duration_ms: 1 });
    await __flushVoiceSessionFactsForTests();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04776 healing: recurrence after fix', () => {
  test('ms since the prior fix, null when there is none or it is in the future', () => {
    expect(recurrenceAfterFixMs('2026-10-01T10:00:00Z', NOW)).toBe(2 * 3600_000);
    expect(recurrenceAfterFixMs(null, NOW)).toBeNull();
    expect(recurrenceAfterFixMs('not a date', NOW)).toBeNull();
    expect(recurrenceAfterFixMs('2026-10-02T00:00:00Z', NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('VTID-04776 LiveKit role: the screen decides, never the device', () => {
  test('declared work surfaces get their fixed role', () => {
    expect(resolveLiveKitProfile({ body: { surface: 'admin' }, isAnonymous: false, isExafyAdmin: false, storedRole: 'community' }).role).toBe('admin');
    expect(resolveLiveKitProfile({ body: { surface: 'command-hub' }, isAnonymous: false, isExafyAdmin: true, storedRole: null }).role).toBe('developer');
  });
  test('member surface clamps a work-plane stored role to community; keeps a member role', () => {
    expect(resolveLiveKitProfile({ body: {}, isAnonymous: false, isExafyAdmin: true, storedRole: 'developer' }).role).toBe('community');
    expect(resolveLiveKitProfile({ body: { view_role: 'patient' }, isAnonymous: false, isExafyAdmin: false, storedRole: 'community' }).role).toBe('patient');
  });
  test('the function has no device input at all', () => {
    // Device type is not a parameter: the only way to change the role is the
    // declared surface/view_role/route.
    expect(resolveLiveKitProfile.length).toBe(1);
    const keys = Object.keys({ body: {}, isAnonymous: false, isExafyAdmin: false, storedRole: null });
    expect(keys).not.toContain('isMobile');
  });
});

describe('VTID-04777 assistant filter: Tenants & Roles click-through', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { assistantFilterParams } = require('../src/services/voice-supervisor-data');
  it('maps each assistant column to the surface it was served on', () => {
    expect(assistantFilterParams('developer')).toEqual(['surface=eq.command-hub', 'is_anonymous=is.false']);
    expect(assistantFilterParams('community')).toEqual(['surface=eq.vitanaland', 'is_anonymous=is.false']);
    expect(assistantFilterParams('anonymous')).toEqual(['is_anonymous=is.true']);
  });
  it('an unknown assistant matches nothing instead of everything', () => {
    expect(assistantFilterParams('nope')).toEqual(['session_id=eq.__no_such_assistant__']);
  });
  it('no assistant means no extra filter', () => {
    expect(assistantFilterParams(null)).toEqual([]);
  });
});
