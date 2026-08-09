/**
 * Tests for src/routes/tenant-specialists.ts (VTID-02655/02659/02660 —
 * Phase 2 tenancy & RBAC).
 *
 * Focus: auth gate (ensureTenantAdmin), tenant isolation — every DB read
 * and write must be scoped to the :tenantId from the URL, and objects
 * owned by another tenant must be invisible (404), never leaked.
 *
 * The router builds its own service-role client via createClient() from
 * @supabase/supabase-js, so we mock that module boundary.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Per-table thenable query-chain mock (shared across getServiceClient() calls)
const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: (v: any) => any) => {
      const value = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(value).then(resolve);
    }),
    mockResolvedValue(v: any) {
      defaultData = v;
      return chain;
    },
    mockResolvedValueOnce(v: any) {
      responseQueue.push(v);
      return chain;
    },
    mockReset() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());

const mockClient = { from: jest.fn((table: string) => chainFor(table)) };

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => mockClient),
}));

const mockClearTenantPersonaCache = jest.fn();
jest.mock('../../src/services/persona-registry', () => ({
  clearTenantPersonaCache: (...args: unknown[]) => mockClearTenantPersonaCache(...args),
}));

// Dynamically imported inside handlers — keep it inert
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

import router from '../../src/routes/tenant-specialists';

const app = express();
app.use(express.json());
app.use('/', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Unsigned JWT whose payload carries the given sub (the route only decodes). */
function tokenFor(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString('base64');
  return `header.${payload}.sig`;
}

const TENANT_A = 'tenant-a';
const ADMIN_A = tokenFor('admin-user-a');

function mockPersonaFound(id = 'persona-1') {
  chainFor('agent_personas').mockResolvedValue({
    data: { id, key: 'coach', display_name: 'Coach', role: 'specialist', voice_id: 'v', status: 'active', handles_kinds: [], handoff_keywords: [], greeting_templates: {} },
    error: null,
  });
}

describe('tenant-specialists routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const chain of Object.values(tableChains)) chain.mockReset();
  });

  // --- Auth gate ----------------------------------------------------------

  it('GET overrides without a token → 401 UNAUTHENTICATED', async () => {
    const res = await request(app).get(`/${TENANT_A}/specialists/coach/overrides`);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('GET overrides with an undecodable token → 401 INVALID_TOKEN', async () => {
    const res = await request(app)
      .get(`/${TENANT_A}/specialists/coach/overrides`)
      .set('Authorization', 'Bearer not-a-jwt');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'INVALID_TOKEN' });
    expect(mockClient.from).not.toHaveBeenCalled();
  });

  it('PUT overrides without a token → 401 (writes are gated too)', async () => {
    const res = await request(app)
      .put(`/${TENANT_A}/specialists/coach/overrides`)
      .send({ enabled: false });
    expect(res.status).toBe(401);
    expect(chainFor('agent_personas_tenant_overrides').upsert).not.toHaveBeenCalled();
  });

  // --- GET overrides ------------------------------------------------------

  it('GET overrides → 404 PERSONA_NOT_FOUND for an unknown specialist key', async () => {
    chainFor('agent_personas').mockResolvedValue({ data: null, error: null });
    const res = await request(app)
      .get(`/${TENANT_A}/specialists/ghost/overrides`)
      .set('Authorization', `Bearer ${ADMIN_A}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('PERSONA_NOT_FOUND');
  });

  it('GET overrides scopes every overlay query to the URL tenant and defaults the overlay', async () => {
    mockPersonaFound('persona-1');
    chainFor('agent_personas_tenant_overrides').mockResolvedValue({ data: null, error: null });
    chainFor('agent_kb_bindings_tenant').mockResolvedValue({ data: [], error: null });
    chainFor('agent_routing_keywords_tenant').mockResolvedValue({ data: [], error: null });
    chainFor('agent_third_party_connections').mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .get(`/${TENANT_A}/specialists/coach/overrides`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // No overlay row → platform default surfaced
    expect(res.body.overlay).toEqual({
      enabled: true,
      intake_schema_extras: {},
      custom_greeting_templates: {},
      notes: null,
    });
    // TENANT ISOLATION: each tenant-overlay table is filtered by tenant_id
    expect(chainFor('agent_personas_tenant_overrides').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('agent_kb_bindings_tenant').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('agent_routing_keywords_tenant').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(chainFor('agent_third_party_connections').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  // --- PUT overrides ------------------------------------------------------

  it('PUT overrides rejects invalid bodies → 400 VALIDATION_FAILED', async () => {
    const res = await request(app)
      .put(`/${TENANT_A}/specialists/coach/overrides`)
      .set('Authorization', `Bearer ${ADMIN_A}`)
      .send({ enabled: 'yes-please' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
  });

  it('PUT overrides upserts a row stamped with the URL tenant_id, audits, and busts the tenant cache', async () => {
    mockPersonaFound('persona-1');
    const overrides = chainFor('agent_personas_tenant_overrides');
    // existing row (enabled) then the upserted row
    overrides.mockResolvedValueOnce({ data: { enabled: true, intake_schema_extras: {}, custom_greeting_templates: {}, notes: null }, error: null });
    overrides.mockResolvedValueOnce({ data: { tenant_id: TENANT_A, persona_id: 'persona-1', enabled: false }, error: null });

    const res = await request(app)
      .put(`/${TENANT_A}/specialists/coach/overrides`)
      .set('Authorization', `Bearer ${ADMIN_A}`)
      .send({ enabled: false });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.overlay).toEqual({ tenant_id: TENANT_A, persona_id: 'persona-1', enabled: false });

    // The write itself carries the tenant scope — no cross-tenant write possible
    expect(overrides.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_A,
        persona_id: 'persona-1',
        enabled: false,
        updated_by: 'admin-user-a',
      }),
      { onConflict: 'tenant_id,persona_id' },
    );
    // enabled true→false is audited as a disable, under the tenant
    expect(chainFor('agent_audit_log').insert).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: TENANT_A,
        persona_id: 'persona-1',
        actor_user_id: 'admin-user-a',
        action: 'tenant_persona_disable',
      }),
    );
    // Only tenant A's cache is invalidated
    expect(mockClearTenantPersonaCache).toHaveBeenCalledWith(TENANT_A);
  });

  // --- PUT keywords -------------------------------------------------------

  it('PUT keywords normalizes keywords, scopes delete+insert to the tenant', async () => {
    mockPersonaFound('persona-1');
    const kw = chainFor('agent_routing_keywords_tenant');
    kw.mockResolvedValue({ data: [], error: null });

    const res = await request(app)
      .put(`/${TENANT_A}/specialists/coach/keywords`)
      .set('Authorization', `Bearer ${ADMIN_A}`)
      .send({ keywords: [{ keyword: '  Sleep Coach  ' }, { keyword: 'JETLAG', weight: 3 }] });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // Replace-set delete is tenant-scoped
    expect(kw.delete).toHaveBeenCalled();
    expect(kw.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    // Inserted rows are trimmed + lowercased, default weight 1.0, tenant-stamped
    expect(kw.insert).toHaveBeenCalledWith([
      expect.objectContaining({ tenant_id: TENANT_A, persona_id: 'persona-1', keyword: 'sleep coach', weight: 1.0, enabled: true, added_by: 'admin-user-a' }),
      expect.objectContaining({ tenant_id: TENANT_A, persona_id: 'persona-1', keyword: 'jetlag', weight: 3, enabled: true, added_by: 'admin-user-a' }),
    ]);
  });

  // --- Connections: cross-tenant delete is a 404 --------------------------

  it('DELETE a connection owned by another tenant → 404, and nothing is deleted', async () => {
    // The ownership lookup filters by BOTH connection id AND tenant_id, so a
    // tenant-B connection is simply not found for tenant A.
    const conns = chainFor('agent_third_party_connections');
    conns.mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .delete(`/${TENANT_A}/specialists/coach/connections/conn-owned-by-tenant-b`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'NOT_FOUND' });
    expect(conns.eq).toHaveBeenCalledWith('id', 'conn-owned-by-tenant-b');
    expect(conns.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    expect(conns.delete).not.toHaveBeenCalled();
    expect(chainFor('agent_audit_log').insert).not.toHaveBeenCalled();
  });

  it('POST connections inserts a draft connection stamped with the URL tenant', async () => {
    mockPersonaFound('persona-1');
    const conns = chainFor('agent_third_party_connections');
    conns.mockResolvedValueOnce({
      data: { id: 'conn-1', tenant_id: TENANT_A, persona_id: 'persona-1', provider: 'calendly', status: 'draft' },
      error: null,
    });

    const res = await request(app)
      .post(`/${TENANT_A}/specialists/coach/connections`)
      .set('Authorization', `Bearer ${ADMIN_A}`)
      .send({ provider: 'calendly' });

    expect(res.status).toBe(201);
    expect(res.body.connection.id).toBe('conn-1');
    expect(conns.insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_A, persona_id: 'persona-1', provider: 'calendly', status: 'draft', created_by: 'admin-user-a' }),
    );
  });

  // --- Audit log ----------------------------------------------------------

  it('GET /:tenantId/audit only reads rows for that tenant', async () => {
    const audit = chainFor('agent_audit_log');
    audit.mockResolvedValue({ data: [{ id: 'a1', action: 'tenant_kb_bind' }], error: null });

    const res = await request(app)
      .get(`/${TENANT_A}/audit`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.audit).toEqual([{ id: 'a1', action: 'tenant_kb_bind' }]);
    expect(audit.eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  // --- Tickets: tenant isolation via loadTicketIfTenantOwned --------------

  it("GET a ticket whose owner is NOT a member of the tenant → 404 (tenant A cannot see tenant B's ticket)", async () => {
    chainFor('feedback_tickets').mockResolvedValueOnce({
      data: { id: 'tk-1', user_id: 'user-of-tenant-b', status: 'new' },
      error: null,
    });
    // Membership check for (ticket owner, tenant A) comes back empty
    chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .get(`/${TENANT_A}/tickets/tk-1`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ ok: false, error: 'NOT_FOUND_OR_NOT_IN_TENANT' });
    expect(chainFor('user_tenants').eq).toHaveBeenCalledWith('user_id', 'user-of-tenant-b');
    expect(chainFor('user_tenants').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
  });

  it('POST reject on a cross-tenant ticket → 404 and the ticket is never updated', async () => {
    chainFor('feedback_tickets').mockResolvedValueOnce({
      data: { id: 'tk-2', user_id: 'user-of-tenant-b', status: 'new' },
      error: null,
    });
    chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post(`/${TENANT_A}/tickets/tk-2/reject`)
      .set('Authorization', `Bearer ${ADMIN_A}`)
      .send({ reason: 'nope' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND_OR_NOT_IN_TENANT');
    expect(chainFor('feedback_tickets').update).not.toHaveBeenCalled();
  });

  it('GET a ticket owned by a tenant member succeeds and includes handoffs', async () => {
    chainFor('feedback_tickets').mockResolvedValueOnce({
      data: { id: 'tk-3', user_id: 'member-1', status: 'triaged', linked_finding_id: null },
      error: null,
    });
    chainFor('user_tenants').mockResolvedValueOnce({ data: { user_id: 'member-1' }, error: null });
    chainFor('feedback_handoff_events').mockResolvedValue({
      data: [{ id: 'h1', from_agent: 'sage', to_agent: 'devon' }],
      error: null,
    });

    const res = await request(app)
      .get(`/${TENANT_A}/tickets/tk-3`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.ticket.id).toBe('tk-3');
    expect(res.body.handoffs).toHaveLength(1);
    expect(res.body.execution).toBeNull();
  });

  // --- Approve-all: customer must belong to the tenant --------------------

  it('approve-all → 404 CUSTOMER_NOT_FOUND for an unknown vitana_id', async () => {
    chainFor('app_users').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post(`/${TENANT_A}/customers/VIT-404/approve-all`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CUSTOMER_NOT_FOUND');
  });

  it("approve-all refuses to act on a customer outside the tenant → 404 CUSTOMER_NOT_IN_TENANT", async () => {
    chainFor('app_users').mockResolvedValueOnce({ data: { user_id: 'cust-of-tenant-b' }, error: null });
    chainFor('user_tenants').mockResolvedValueOnce({ data: null, error: null });

    const res = await request(app)
      .post(`/${TENANT_A}/customers/VIT-B/approve-all`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('CUSTOMER_NOT_IN_TENANT');
    // Membership was checked against the URL tenant
    expect(chainFor('user_tenants').eq).toHaveBeenCalledWith('tenant_id', TENANT_A);
    // No ticket was touched
    expect(chainFor('feedback_tickets').update).not.toHaveBeenCalled();
  });

  it('approve-all advances a spec_ready ticket to in_progress with an optimistic lock', async () => {
    chainFor('app_users').mockResolvedValueOnce({ data: { user_id: 'cust-1' }, error: null });
    chainFor('user_tenants').mockResolvedValueOnce({ data: { user_id: 'cust-1' }, error: null });
    const tickets = chainFor('feedback_tickets');
    // Actionable tickets query
    tickets.mockResolvedValueOnce({
      data: [{ id: 'tk-9', ticket_number: 'T-9', kind: 'bug', status: 'spec_ready', vitana_id: 'VIT-1', resolver_agent: null }],
      error: null,
    });
    // The status-guarded update
    tickets.mockResolvedValueOnce({
      data: { id: 'tk-9', ticket_number: 'T-9', kind: 'bug', status: 'in_progress', vitana_id: 'VIT-1', resolver_agent: null },
      error: null,
    });

    const res = await request(app)
      .post(`/${TENANT_A}/customers/VIT-1/approve-all`)
      .set('Authorization', `Bearer ${ADMIN_A}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      approved: 1,
      sent: 0,
      skipped: 0,
      total: 1,
      results: [{ ticket_number: 'T-9', from: 'spec_ready', to: 'in_progress' }],
    });
    expect(tickets.update).toHaveBeenCalledWith({ status: 'in_progress' });
    // Optimistic lock: update only applies while still spec_ready
    expect(tickets.eq).toHaveBeenCalledWith('status', 'spec_ready');
    // Batch is audited under the tenant
    expect(chainFor('agent_audit_log').insert).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: TENANT_A, actor_user_id: 'admin-user-a' }),
    );
  });
});
