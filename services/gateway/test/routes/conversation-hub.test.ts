/**
 * Command Hub — Conversation section backend (roadmap Step 4, read-only).
 *
 * Exercises the route wiring + the code-derived config read model + the guards,
 * with auth stubbed and the DB unconfigured. The Simulator's decision logic is
 * covered at the unit level by the conversation/* suites; here we assert the
 * endpoint shapes and that nothing speaks/mutates.
 */

// Stub admin auth so the router mounts pass-through in the test.
jest.mock('../../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireExafyAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Force "DB not configured" so DB-backed endpoints take their 503 branch.
jest.mock('../../src/lib/supabase', () => ({ getSupabase: () => null }));

import express from 'express';
import request from 'supertest';
import conversationHubRouter from '../../src/routes/conversation-hub';

function makeApp() {
  const app = express();
  app.use('/api/v1', conversationHubRouter);
  return app;
}

describe('conversation-hub (read-only Command Hub Conversation API)', () => {
  const app = makeApp();

  test('GET /config returns the code-derived defaults (registers, NBA table, screen map)', async () => {
    const res = await request(app).get('/api/v1/admin/conversation/config');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const d = res.body.data;
    expect(d.source).toBe('global_defaults');
    // 5 registers, recency-first ladder.
    expect(d.registers.map((r: { register: string }) => r.register)).toEqual([
      'first_time', 'daily_briefing', 'continue', 'quick_resume', 'same_day',
    ]);
    // NBA table is band-sorted desc and carries the executing tool.
    expect(Array.isArray(d.next_best_actions)).toBe(true);
    expect(d.next_best_actions.length).toBeGreaterThan(0);
    const bands = d.next_best_actions.map((a: { band: number }) => a.band);
    expect([...bands]).toEqual([...bands].sort((a: number, b: number) => b - a));
    // Screen-completion map covers every surface; matches suppresses review_matches.
    const matches = d.screen_completion.find((s: { surface: string }) => s.surface === 'matches');
    expect(matches.completion_key).toBe('complete_matches');
    expect(matches.suppresses_redirect).toBe('review_matches');
  });

  test('GET /preview without user_id → 400', async () => {
    const res = await request(app).get('/api/v1/admin/conversation/preview');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('GET /preview with user_id but no DB → 503 (never speaks)', async () => {
    const res = await request(app).get('/api/v1/admin/conversation/preview?user_id=u1');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  test('GET /decisions and /tool-failures → 503 when DB unconfigured', async () => {
    const a = await request(app).get('/api/v1/admin/conversation/decisions');
    const b = await request(app).get('/api/v1/admin/conversation/tool-failures');
    expect(a.status).toBe(503);
    expect(b.status).toBe(503);
  });
});
