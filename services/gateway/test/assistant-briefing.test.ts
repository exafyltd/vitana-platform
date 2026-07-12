/**
 * VTID-ASSISTANT-ROLES — /api/v1/assistant/briefing route tests.
 *
 * Covers auth (401 unauthenticated, 403 wrong role), the developer
 * happy path (envelope + rendered block), and the error path (builder
 * failure → 500, never a crash). requireTenantAdmin's own contract is
 * covered by its middleware tests; here we pin that the admin route is
 * mounted behind it.
 */

import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    const identity = (global as any).__testIdentity;
    if (!identity) {
      return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    }
    req.identity = identity;
    next();
  },
}));

jest.mock('../src/middleware/require-tenant-admin', () => ({
  requireTenantAdmin: (req: any, res: any, next: any) => {
    const gate = (global as any).__tenantAdminGate;
    if (gate === 'deny') {
      return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
    }
    req.identity = (global as any).__testIdentity;
    next();
  },
}));

jest.mock('../src/lib/supabase', () => ({
  getSupabase: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: { active_role: (global as any).__activeRole ?? 'community' } }),
          }),
        }),
      }),
    }),
  }),
}));

const FAKE_ENVELOPE = {
  ok: true,
  role: 'developer',
  generated_at: '2026-07-12T00:00:00.000Z',
  status: { headline: 'Platform is green — no critical items.', items: [] },
  since_last_session: { since: null, items: [] },
  attention: { items: [] },
  next_step: null,
  degraded_sources: [],
};

jest.mock('../src/services/assistant-briefing/developer-briefing-service', () => ({
  buildDeveloperBriefing: jest.fn(async () => {
    if ((global as any).__briefingThrows) throw new Error('upstream exploded');
    return FAKE_ENVELOPE;
  }),
  renderDeveloperBriefingBlock: jest.fn(() => '## CURRENT BRIEFING (DEVELOPER — generated at session start)'),
}));

jest.mock('../src/services/assistant-briefing/admin-briefing-service', () => ({
  buildAdminBriefing: jest.fn(async (tenantId: string) => ({ ...FAKE_ENVELOPE, role: 'admin', tenant_id: tenantId })),
  renderAdminBriefingBlock: jest.fn(() => '## CURRENT BRIEFING (ADMIN — tenant-scoped, generated at session start)'),
}));

import assistantBriefingRouter from '../src/routes/assistant-briefing';

function makeApp() {
  const app = express();
  app.use('/api/v1/assistant/briefing', assistantBriefingRouter);
  return app;
}

describe('GET /api/v1/assistant/briefing/developer', () => {
  beforeEach(() => {
    (global as any).__testIdentity = null;
    (global as any).__activeRole = 'community';
    (global as any).__briefingThrows = false;
    (global as any).__tenantAdminGate = 'allow';
  });

  it('401s without authentication', async () => {
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/developer');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
  });

  it('403s for an authenticated community user', async () => {
    (global as any).__testIdentity = { user_id: 'u1', tenant_id: 't1', exafy_admin: false };
    (global as any).__activeRole = 'community';
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/developer');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('developer_role_required');
  });

  it('returns the envelope + rendered block for a developer', async () => {
    (global as any).__testIdentity = { user_id: 'u1', tenant_id: 't1', exafy_admin: false };
    (global as any).__activeRole = 'developer';
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/developer');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role).toBe('developer');
    expect(res.body.status.headline).toContain('green');
    expect(res.body.rendered).toContain('## CURRENT BRIEFING');
  });

  it('allows exafy_admin without a tenant role lookup', async () => {
    (global as any).__testIdentity = { user_id: 'u1', tenant_id: null, exafy_admin: true };
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/developer');
    expect(res.status).toBe(200);
  });

  it('500s cleanly when the briefing builder fails', async () => {
    (global as any).__testIdentity = { user_id: 'u1', tenant_id: 't1', exafy_admin: true };
    (global as any).__briefingThrows = true;
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/developer');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('briefing_failed');
  });
});

describe('GET /api/v1/assistant/briefing/admin/:tenantId', () => {
  beforeEach(() => {
    (global as any).__testIdentity = { user_id: 'u1', tenant_id: 't1', exafy_admin: false };
    (global as any).__tenantAdminGate = 'allow';
  });

  it('is mounted behind requireTenantAdmin (403 when the gate denies)', async () => {
    (global as any).__tenantAdminGate = 'deny';
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/admin/t1');
    expect(res.status).toBe(403);
  });

  it('returns the tenant-scoped envelope when the gate allows', async () => {
    const res = await request(makeApp()).get('/api/v1/assistant/briefing/admin/t1');
    expect(res.status).toBe(200);
    expect(res.body.role).toBe('admin');
    expect(res.body.tenant_id).toBe('t1');
    expect(res.body.rendered).toContain('ADMIN — tenant-scoped');
  });
});
