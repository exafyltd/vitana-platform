/**
 * VTID-04419 (Plan v1 WS-1.7) — brain inspector read model, routes and UI.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  INSPECTOR_TOPICS,
  INSPECTOR_WINDOW_MS,
  inspectSession,
  isValidSessionId,
  isValidUserId,
  listRecentSessions,
  summarizeSessionEvents,
  type InspectorEventRow,
} from '../../../src/services/conversation/session-brain-inspector';

const SID = 'live-1985f53d-63bd-485d-9829-c135e32ab38c';
const T0 = Date.parse('2026-09-23T05:59:07.750Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();

function rows(): InspectorEventRow[] {
  return [
    { topic: 'orb.live.diag', created_at: at(650), metadata: { session_id: SID, stage: 'greeting_sent', wake_opener: 'conv_resume', register: 'resume', bucket: 'same_day', nba: 'log_water', nba_domain: 'hydration', current_route: '/home', lang: 'de' } },
    { topic: 'vtid.live.session.start', created_at: at(0), metadata: { session_id: SID, user_id: 'u-1', lang: 'de', transport: 'sse', origin: 'https://vitanaland.com', email: 'someone@example.com', user_agent: 'UA' } },
    { topic: 'orb.live.context.bootstrap', created_at: at(2500), metadata: { session_id: SID, builder: 'brain', brain_error: null, chars: 24000, latency_ms: 2400, reason: null } },
    { topic: 'orb.live.diag', created_at: at(400), metadata: { session_id: SID, stage: 'brain_context_built', chars_before: 18000, chars_after: 12000, packed: true, kept: ['identity_lock', 'wake_brief_override'], shortened: ['memory_items'], dropped: ['social_context'] } },
    { topic: 'orb.live.diag', created_at: at(420), metadata: { session_id: SID, stage: 'core_snapshot_used', chars: 9000, fresh_timed_out: true } },
    { topic: 'orb.live.diag', created_at: at(380), metadata: { session_id: SID, stage: 'tool_catalog_trimmed', bytes_before: 226803, bytes_after: 65521, dropped_count: 24, provider: 'nova_sonic' } },
    { topic: 'orb.live.diag', created_at: at(90_000), metadata: { session_id: SID, stage: 'context_rebuilt_on_reconnect', builder: 'brain', started_builder: 'brain', chars: 25000, brain_error: null } },
    { topic: 'orb.live.diag', created_at: at(95_000), metadata: { session_id: SID, stage: 'upstream_error', failure_kind: 'content_filter', code: 'nova_validation' } },
    { topic: 'voice.latency.measured', created_at: at(3000), metadata: { session_id: SID, turn: 0, phases: [
      { phase: 'context_awaited', offset_ms: 300, detail: { awaited_ms: 300, timed_out: true, context_source: 'snapshot' } },
      { phase: 'setup_sent', offset_ms: 320, detail: { context_chars: 9100, context_source: 'snapshot' } },
      { phase: 'audio_out_first_chunk', offset_ms: 2100 },
    ] } },
    { topic: 'voice.latency.measured', created_at: at(20_000), metadata: { session_id: SID, turn: 1, phases: [{ phase: 'setup_sent', offset_ms: 5, detail: { context_chars: 1 } }, { phase: 'audio_out_first_chunk', offset_ms: 12697 }] } },
    { topic: 'orb.live.diag', created_at: at(100_000), metadata: { session_id: SID, stage: 'watchdog_fired', reason: 'forwarding_no_ack' } },
    { topic: 'vtid.live.session.stop', created_at: at(120_000), metadata: { session_id: SID, reason: 'user_stop', turn_count: 4, duration_ms: 120000, audio_out_chunks: 300 } },
    { topic: 'conversation.session.finalized', created_at: at(121_000), metadata: { session_id: SID, reason: 'live_session_stop', memory_committed: true, summary_written: true, threads_written: 2 } },
  ];
}

describe('summarizeSessionEvents', () => {
  const s = summarizeSessionEvents(SID, rows());

  it('reads the session identity without the email or user agent', () => {
    expect(s.found).toBe(true);
    expect(s.started_at).toBe(at(0));
    expect(s.user).toEqual({ user_id: 'u-1', lang: 'de', transport: 'sse', origin: 'https://vitanaland.com' });
    expect(JSON.stringify(s)).not.toContain('someone@example.com');
    expect(JSON.stringify(s)).not.toContain('"UA"');
  });

  it('reports the context: builder, packing, gate, setup, snapshot and reconnect rebuilds', () => {
    expect(s.context.builder).toBe('brain');
    expect(s.context.bootstrap_chars).toBe(24000);
    expect(s.context.packing).toEqual({ chars_before: 18000, chars_after: 12000, packed: true, kept: ['identity_lock', 'wake_brief_override'], shortened: ['memory_items'], dropped: ['social_context'] });
    expect(s.context.gate).toEqual({ timed_out: true, context_source: 'snapshot', waited_ms: 300 });
    // Only the turn-0 establishment mark counts for setup.
    expect(s.context.setup_context_chars).toBe(9100);
    expect(s.context.setup_context_source).toBe('snapshot');
    expect(s.context.snapshot_used).toEqual({ chars: 9000, fresh_timed_out: true });
    expect(s.context.rebuilt_on_reconnect).toHaveLength(1);
    expect(s.context.rebuilt_on_reconnect[0].builder).toBe('brain');
  });

  it('reports the decision, tools, errors and outcome', () => {
    expect(s.decision).toEqual([{ at: at(650), wake_opener: 'conv_resume', register: 'resume', bucket: 'same_day', nba: 'log_water', nba_domain: 'hydration', current_route: '/home', lang: 'de' }]);
    expect(s.tools).toEqual({ bytes_before: 226803, bytes_after: 65521, dropped_count: 24, provider: 'nova_sonic' });
    expect(s.errors).toEqual([
      { at: at(95_000), stage: 'upstream_error', failure_kind: 'content_filter', code: 'nova_validation' },
      { at: at(100_000), stage: 'watchdog_fired', failure_kind: null, code: 'forwarding_no_ack' },
    ]);
    expect(s.outcome).toEqual({
      stopped: true, stop_reason: 'user_stop', turns: 4, duration_ms: 120000, audio_out_chunks: 300, first_audio_ms: 2100,
      turn_first_audio_ms: [{ turn: 1, ms: 12697 }],
      finalized: { reason: 'live_session_stop', memory_committed: true, summary_written: true, threads_written: 2 },
    });
  });

  it('builds an ordered timeline relative to the start', () => {
    expect(s.timeline[0]).toEqual({ t_ms: 0, topic: 'vtid.live.session.start', stage: null });
    const offsets = s.timeline.map((e) => e.t_ms);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);
    expect(s.events_read).toBe(rows().length);
  });

  it('a stop event without a reason still counts as stopped', () => {
    const r = summarizeSessionEvents(SID, [rows()[1], { topic: 'vtid.live.session.stop', created_at: at(5000), metadata: { session_id: SID, turn_count: 3 } }]);
    expect(r.outcome.stopped).toBe(true);
    expect(r.outcome.stop_reason).toBeNull();
  });

  it('an empty read is not found', () => {
    const e = summarizeSessionEvents(SID, []);
    expect(e.found).toBe(false);
    expect(e.decision).toEqual([]);
  });
});

describe('validation', () => {
  it('accepts session ids and UUIDs, rejects anything else', () => {
    expect(isValidSessionId(SID)).toBe(true);
    expect(isValidSessionId("x' or 1=1")).toBe(false);
    expect(isValidSessionId('a/b')).toBe(false);
    expect(isValidUserId('a27552a3-0257-4305-8ed0-351a80fd3701')).toBe(true);
    expect(isValidUserId('abc')).toBe(false);
  });
});

/** A fake PostgREST builder that records every filter. */
function fakeSb(results: Array<{ data: unknown; error: unknown }>) {
  const calls: Array<Array<[string, unknown[]]>> = [];
  let i = 0;
  const sb = {
    from(table: string) {
      const rec: Array<[string, unknown[]]> = [['from', [table]]];
      calls.push(rec);
      const result = results[i++] ?? { data: [], error: null };
      const b: any = {};
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'limit']) {
        b[m] = (...args: unknown[]) => { rec.push([m, args]); return b; };
      }
      b.then = (res: any, rej: any) => Promise.resolve(result).then(res, rej);
      return b;
    },
  };
  return { sb: sb as any, calls };
}

describe('bounded reads', () => {
  it('lists recent sessions from start events in a bounded window, optionally by user', async () => {
    const { sb, calls } = fakeSb([{ data: [rows()[1]], error: null }]);
    const r = await listRecentSessions(sb, { hours: 72, userId: 'a27552a3-0257-4305-8ed0-351a80fd3701', limit: 30, nowMs: T0 });
    expect(r.error).toBeNull();
    expect(r.sessions).toEqual([{ session_id: SID, started_at: at(0), user_id: 'u-1', lang: 'de', transport: 'sse', origin: 'https://vitanaland.com' }]);
    const c = calls[0];
    expect(c).toContainEqual(['eq', ['topic', 'vtid.live.session.start']]);
    expect(c.find(([m]) => m === 'gte')).toBeTruthy();
    expect(c).toContainEqual(['eq', ['metadata->>user_id', 'a27552a3-0257-4305-8ed0-351a80fd3701']]);
    expect(c).toContainEqual(['limit', [30]]);
  });

  it('inspects a session with a topic list and a time window, never an unbounded scan', async () => {
    const start = rows()[1];
    const { sb, calls } = fakeSb([{ data: [start], error: null }, { data: rows(), error: null }]);
    const r = await inspectSession(sb, SID, { nowMs: T0 + 10 * 60_000 });
    expect(r.error).toBeNull();
    expect(r.summary.found).toBe(true);
    const events = calls[1];
    expect(events).toContainEqual(['in', ['topic', [...INSPECTOR_TOPICS]]]);
    expect(events).toContainEqual(['eq', ['metadata->>session_id', SID]]);
    const gte = events.find(([m]) => m === 'gte')![1][1] as string;
    const lte = events.find(([m]) => m === 'lte')![1][1] as string;
    expect(Date.parse(gte)).toBe(T0 - 60_000);
    expect(Date.parse(lte) - Date.parse(gte)).toBeLessThanOrEqual(INSPECTOR_WINDOW_MS + 60_000);
  });

  it('reports not found without a second read when no start event exists', async () => {
    const { sb, calls } = fakeSb([{ data: [], error: null }]);
    const r = await inspectSession(sb, SID);
    expect(r.summary.found).toBe(false);
    expect(calls).toHaveLength(1);
  });
});

describe('source contracts', () => {
  const src = join(__dirname, '../../../src');
  const hub = readFileSync(join(src, 'routes/conversation-hub.ts'), 'utf8');
  const controller = readFileSync(join(src, 'orb/live/session/live-session-controller.ts'), 'utf8');
  const app = readFileSync(join(src, 'frontend/command-hub/app.js'), 'utf8');
  const css = readFileSync(join(src, 'frontend/command-hub/styles.css'), 'utf8');

  it('both inspector routes are admin-only and validate their input', () => {
    expect(hub).toMatch(/router\.get\('\/admin\/conversation\/sessions', \.\.\.adminOnly,/);
    expect(hub).toMatch(/router\.get\('\/admin\/conversation\/sessions\/:sessionId\/brain', \.\.\.adminOnly,/);
    expect(hub).toMatch(/isValidSessionId\(sessionId\)/);
    expect(hub).toMatch(/isValidUserId\(userId\)/);
  });

  it('the session-start bootstrap event names the builder', () => {
    expect(controller).toMatch(/builder: session\.contextBuilder \?\? null,/);
  });

  it('the inspector is mounted in the Simulator and Journey Context tabs', () => {
    expect(app).toMatch(/ui\.panel\.appendChild\(_convBrainInspector\(function \(\) \{ return userInput\.value; \}\)\);/);
    expect(app).toMatch(/c\.appendChild\(_convBrainInspector\(function \(\) \{ return jc\.userId; \}\)\);/);
    expect(app).toMatch(/'\/admin\/conversation\/sessions\/' \+ encodeURIComponent\(id\) \+ '\/brain'/);
  });

  it('the inspector code uses classes only (CSP) and its rules are top-level CSS', () => {
    const i = app.indexOf('function _convBrainChips(');
    const j = app.indexOf('function renderConversationSimulatorView(');
    const block = app.slice(i, j);
    expect(block).not.toMatch(/\.style\b|style\s*=|css:/);
    // Every .conv-brain rule sits at depth 0 except the ones inside the
    // inspector's own 480px media block.
    let depth = 0;
    let media = '';
    for (const line of css.split('\n')) {
      if (/^@media/.test(line)) media = line;
      if (depth === 0 && line.startsWith('.conv-brain')) media = '';
      if (line.includes('.conv-brain') && depth > 0) expect(media).toMatch(/max-width: 480px/);
      for (const ch of line) { if (ch === '{') depth++; else if (ch === '}') depth--; }
      if (depth === 0) media = '';
    }
    expect(css).toMatch(/^\.conv-brain \{/m);
  });
});
