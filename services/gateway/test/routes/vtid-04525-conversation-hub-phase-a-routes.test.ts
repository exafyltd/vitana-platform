/**
 * VTID-04525 (Conversation hub Phase A) — the three new read routes, their
 * auth, and the B2 instruction-budget diag end to end (emit site → session
 * inspector).
 */
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Auth mock with the real contract: no bearer → 401, non-admin → 403.
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: 'u1', exafy_admin: h === 'Bearer admin' };
    next();
  },
  requireExafyAdmin: (req: any, res: any, next: any) => {
    if (!req.identity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    if (!req.identity.exafy_admin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    next();
  },
}));

// A tiny PostgREST stand-in: answers by topic (+ stage filter), records calls.
const calls: Array<Record<string, unknown>> = [];
let rowsByTopic: Record<string, Array<{ created_at: string; metadata: Record<string, unknown> }>> = {};
function fakeSupabase() {
  return {
    from: (_t: string) => {
      const q: Record<string, unknown> = {};
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => { q[k] = v; return chain; },
        gte: () => chain,
        in: (k: string, v: unknown) => { q[k] = v; return chain; },
        order: () => chain,
        limit: () => { calls.push({ ...q }); return Promise.resolve({ data: pick(q), error: null }); },
        range: (from: number, to: number) => {
          calls.push({ ...q, from, to });
          return Promise.resolve({ data: pick(q).slice(from, to + 1), error: null });
        },
      };
      return chain;
    },
  };
}
function pick(q: Record<string, unknown>) {
  const rows = rowsByTopic[String(q.topic)] ?? [];
  const stages = q['metadata->>stage'] as string[] | undefined;
  const env = q['metadata->>env'] as string | undefined;
  return rows.filter((r) => (!stages || stages.includes(String(r.metadata.stage))) && (!env || r.metadata.env === env));
}
let supabaseOn = true;
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => (supabaseOn ? fakeSupabase() : null) }));

// eslint-disable-next-line import/first
import conversationHubRouter from '../../src/routes/conversation-hub';

const app = express();
app.use('/api/v1', conversationHubRouter);
const admin = (path: string) => request(app).get(path).set('Authorization', 'Bearer admin');

const PATHS = ['/api/v1/admin/conversation/system', '/api/v1/admin/conversation/system/history', '/api/v1/admin/conversation/aggregates'];

describe('VTID-04525 — Phase A routes', () => {
  beforeEach(() => {
    calls.length = 0;
    supabaseOn = true;
    rowsByTopic = {};
  });

  test.each(PATHS)('%s → 401 signed out, 403 for a non-admin', async (p) => {
    expect((await request(app).get(p)).status).toBe(401);
    expect((await request(app).get(p).set('Authorization', 'Bearer member')).status).toBe(403);
  });

  test('GET /system returns the snapshot built from the live code', async () => {
    const res = await admin('/api/v1/admin/conversation/system');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(d.tools.sessions.length).toBeGreaterThan(5);
    expect(d.tools.items.length).toBeGreaterThan(100);
    expect(d.opening.providers.length).toBeGreaterThan(5);
    expect(d.flags.find((f: any) => f.name === 'BRAIN_SCORED_OPENING')).toBeTruthy();
  });

  test('GET /system/history reads this stack only and returns diffs, not the full lists', async () => {
    rowsByTopic['conversation.system.snapshot'] = [
      { created_at: '2026-09-25T01:00:00Z', metadata: { env: 'production', fingerprint: 'aaa', commit: 'c1', counts: { tools: 5 }, diff: { tools_added: ['x'] }, tool_names: ['x'] } },
      { created_at: '2026-09-24T01:00:00Z', metadata: { env: 'staging', fingerprint: 'bbb', commit: 'c0', counts: { tools: 4 }, diff: null, tool_names: ['y'] } },
    ];
    const res = await admin('/api/v1/admin/conversation/system/history');
    expect(res.status).toBe(200);
    expect(res.body.data.env).toBe('production');
    expect(res.body.data.snapshots).toEqual([
      { recorded_at: '2026-09-25T01:00:00Z', fingerprint: 'aaa', commit: 'c1', counts: { tools: 5 }, diff: { tools_added: ['x'] } },
    ]);
  });

  test('GET /aggregates summarizes tools, guards and openings over the window', async () => {
    rowsByTopic['orb.live.tool.executed'] = [
      { created_at: '2026-09-25T01:00:00Z', metadata: { tool_name: 'navigate', success: true, elapsed_ms: 100, env: 'staging' } },
      { created_at: '2026-09-25T01:01:00Z', metadata: { tool_name: 'navigate', success: false, elapsed_ms: 300, env: 'production' } },
      { created_at: '2026-09-25T01:02:00Z', metadata: { tool_name: 'search_memory', success: true, elapsed_ms: 50, env: 'staging' } },
    ];
    rowsByTopic['orb.live.diag'] = [
      { created_at: '2026-09-25T01:00:00Z', metadata: { stage: 'tool_loop_guard', dropped_tools: ['find_community_member'], opening_turn: true } },
      { created_at: '2026-09-25T01:00:00Z', metadata: { stage: 'backend_data_speech_suppressed', kind: 'uuid' } },
      { created_at: '2026-09-25T01:00:00Z', metadata: { stage: 'instruction_budget', trimmed: true, trimmed_sections: ['bootstrap'], total_bytes_before: 40000 } },
      { created_at: '2026-09-25T01:00:00Z', metadata: { stage: 'instruction_budget', trimmed: false, trimmed_sections: [], total_bytes_before: 20000 } },
      { created_at: '2026-09-25T01:00:00Z', metadata: { stage: 'greeting_sent', wake_opener: 'override_v2', candidate_provider: 'journey_guide', candidate_spoken: true } },
      { created_at: '2026-09-25T01:00:00Z', metadata: { stage: 'usage_totals' } },
    ];
    const res = await admin('/api/v1/admin/conversation/aggregates?hours=48');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.window_hours).toBe(48);
    expect(d.tools.total_calls).toBe(3);
    expect(d.tools.tools[0]).toMatchObject({ tool: 'navigate', calls: 2, failures: 1, failure_rate: 0.5, by_env: { staging: 1, production: 1 } });
    expect(d.guards.counts.tool_loop_guard).toBe(1);
    expect(d.guards.loop_guard_opening).toBe(1);
    expect(d.guards.backend_data_kinds).toEqual({ uuid: 1 });
    expect(d.guards.instruction_budget).toMatchObject({ setups: 2, trimmed: 1, trimmed_rate: 0.5, trimmed_sections: { bootstrap: 1 } });
    expect(d.openings).toMatchObject({ greetings: 1, by_wake_opener: { override_v2: 1 }, by_winner: [{ provider: 'journey_guide', wins: 1, spoken: 1 }] });
    // Diag reads are stage-filtered on the server, never the whole diag topic.
    const diagCalls = calls.filter((c) => c.topic === 'orb.live.diag');
    expect(diagCalls.length).toBeGreaterThan(0);
    for (const c of diagCalls) expect(Array.isArray(c['metadata->>stage'])).toBe(true);
  });

  test('GET /aggregates clamps the window and 503s without a database', async () => {
    const res = await admin('/api/v1/admin/conversation/aggregates?hours=99999');
    expect(res.body.data.window_hours).toBe(24 * 14);
    supabaseOn = false;
    expect((await admin('/api/v1/admin/conversation/aggregates')).status).toBe(503);
  });
});

describe('VTID-04525 B2 — instruction_budget diag', () => {
  test('the setup path emits it on every setup, sizes only', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/orb-live.ts'), 'utf8');
    expect(src).toContain("emitDiag(session, 'instruction_budget', instructionBudgetDiagPayload(budgetResult, INSTRUCTION_TOTAL_BYTE_BUDGET))");
  });

  test('payload builder carries byte accounting and section kinds, never text', () => {
    const { instructionBudgetDiagPayload, enforceInstructionBudget } = require('../../src/orb/live/instruction/instruction-budget');
    const r = enforceInstructionBudget([
      { kind: 'scaffold', text: 'S'.repeat(100) },
      { kind: 'bootstrap', text: 'B'.repeat(200) },
    ], 150);
    const p = instructionBudgetDiagPayload(r, 150);
    expect(p).toMatchObject({ budget_bytes: 150, total_bytes_before: 300, trimmed: true, trimmed_sections: ['bootstrap'] });
    expect(JSON.stringify(p)).not.toContain('BBBB');
    expect(p.section_bytes).toEqual({ scaffold: 100, bootstrap: 200 });
  });

  test('the session inspector summarizes it (latest setup wins, setups counted)', () => {
    const { summarizeSessionEvents } = require('../../src/services/conversation/session-brain-inspector');
    const SID = 'live-11111111-1111-1111-1111-111111111111';
    const row = (at: string, m: Record<string, unknown>) => ({ topic: 'orb.live.diag', created_at: at, metadata: { session_id: SID, stage: 'instruction_budget', ...m } });
    const s = summarizeSessionEvents(SID, [
      row('2026-09-25T01:00:00Z', { budget_bytes: 30720, total_bytes_before: 40000, total_bytes_after: 29000, trimmed_sections: ['bootstrap'], still_over_budget: false, section_bytes: { bootstrap: 15000 } }),
      row('2026-09-25T01:00:05Z', { budget_bytes: 30720, total_bytes_before: 20000, total_bytes_after: 20000, trimmed_sections: [], still_over_budget: false, section_bytes: { bootstrap: 5000 } }),
    ]);
    expect(s.context.instruction_budget).toEqual({
      budget_bytes: 30720, total_bytes_before: 20000, total_bytes_after: 20000, trimmed_sections: [], still_over_budget: false, section_bytes: { bootstrap: 5000 }, setups: 2,
    });
  });
});
