/**
 * Tests for src/routes/memory-governance.ts (VTID-01099).
 *
 * Auth model here is DIFFERENT from the JWT-middleware routes: every
 * handler pulls the raw Bearer token off the request itself and hands it
 * to createUserSupabaseClient(token), which authenticates to Supabase AS
 * THAT USER (RLS context) — there is no service-role client and no
 * decoded-identity object anywhere in this file. Tenant/user isolation is
 * therefore delegated entirely to (a) forwarding the caller's own token
 * un-substituted into createUserSupabaseClient, and (b) the RPC's own
 * `data.ok`/`data.error` verdict (e.g. RLS or the RPC itself refusing to
 * touch another user's row) being relayed back as a 400/404, never
 * silently overridden. Both are asserted below.
 */
import request from 'supertest';
import express from 'express';

const mockRpc = jest.fn();
const mockCreateUserSupabaseClient = jest.fn(() => ({ rpc: mockRpc }));

jest.mock('../../src/lib/supabase-user', () => ({
  createUserSupabaseClient: (...args: unknown[]) => mockCreateUserSupabaseClient(...args),
}));

const mockEmitOasisEvent = jest.fn();
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

import router from '../../src/routes/memory-governance';

const app = express();
app.use(express.json());
app.use('/', router);

const ENTITY_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  jest.clearAllMocks();
  mockEmitOasisEvent.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Shared: unauthenticated access is refused on every route, before any
// Supabase client is even constructed.
// ---------------------------------------------------------------------------

describe('unauthenticated access (no Authorization header)', () => {
  const cases: Array<[string, string, object | undefined]> = [
    ['get', '/settings', undefined],
    ['post', '/settings/visibility', { domain: 'diary', visibility: 'private' }],
    ['post', '/lock', { entity_type: 'diary', entity_id: ENTITY_ID }],
    ['post', '/unlock', { entity_type: 'diary', entity_id: ENTITY_ID }],
    ['delete', '/entity', { entity_type: 'diary', entity_id: ENTITY_ID }],
    ['get', '/locks', undefined],
    ['post', '/export', { domains: ['diary'] }],
    ['get', `/export/${ENTITY_ID}`, undefined],
  ];

  it.each(cases)('%s %s returns 401 UNAUTHENTICATED and never touches Supabase', async (method, path, body) => {
    const res = await (request(app) as any)[method](path).send(body);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockCreateUserSupabaseClient).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /settings
// ---------------------------------------------------------------------------

describe('GET /settings', () => {
  it('forwards the caller\'s exact bearer token to createUserSupabaseClient (RLS scoping)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, visibility: {}, locks: {}, deletions_count: 0, exports: [] }, error: null });
    const res = await request(app).get('/settings').set('Authorization', 'Bearer user-A-token');
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_get_settings');
  });

  it('never substitutes a different (e.g. service-role) credential for the caller\'s own token', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, visibility: {}, locks: {}, deletions_count: 0, exports: [] }, error: null });
    await request(app).get('/settings').set('Authorization', 'Bearer user-B-token');
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-B-token');
    expect(mockCreateUserSupabaseClient).not.toHaveBeenCalledWith(expect.stringMatching(/service.?role/i));
  });

  it('returns 503 when the governance RPC is not deployed yet', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'function memory_get_settings() does not exist' } });
    const res = await request(app).get('/settings').set('Authorization', 'Bearer t');
    expect(res.status).toBe(503);
  });

  it('returns 502 on a generic RPC error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'connection reset' } });
    const res = await request(app).get('/settings').set('Authorization', 'Bearer t');
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('connection reset');
  });

  it('returns 400 when the RPC itself reports ok:false (e.g. RLS/ownership refusal)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'NOT_YOUR_SETTINGS' }, error: null });
    const res = await request(app).get('/settings').set('Authorization', 'Bearer t');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_YOUR_SETTINGS');
  });
});

// ---------------------------------------------------------------------------
// POST /settings/visibility
// ---------------------------------------------------------------------------

describe('POST /settings/visibility', () => {
  it('rejects an invalid domain before calling the RPC', async () => {
    const res = await request(app)
      .post('/settings/visibility')
      .set('Authorization', 'Bearer t')
      .send({ domain: 'not_a_real_domain', visibility: 'private' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects an invalid visibility level before calling the RPC', async () => {
    const res = await request(app)
      .post('/settings/visibility')
      .set('Authorization', 'Bearer t')
      .send({ domain: 'diary', visibility: 'everyone' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('calls memory_set_visibility with the exact validated params, under the caller\'s own token', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, id: 'v1', domain: 'diary', visibility: 'connections' }, error: null });
    const res = await request(app)
      .post('/settings/visibility')
      .set('Authorization', 'Bearer user-A-token')
      .send({ domain: 'diary', visibility: 'connections' });
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_set_visibility', {
      p_domain: 'diary',
      p_visibility: 'connections',
      p_custom_rules: null,
    });
  });

  it('emits a memory.visibility.updated OASIS event on success', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, id: 'v1', domain: 'diary', visibility: 'private' }, error: null });
    await request(app).post('/settings/visibility').set('Authorization', 'Bearer t').send({ domain: 'diary', visibility: 'private' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'memory.visibility.updated', status: 'success' }),
    );
  });

  it('returns 400 when the RPC reports ok:false (denied by RLS/ownership)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'FORBIDDEN_DOMAIN' }, error: null });
    const res = await request(app)
      .post('/settings/visibility')
      .set('Authorization', 'Bearer t')
      .send({ domain: 'diary', visibility: 'private' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('FORBIDDEN_DOMAIN');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /lock, POST /unlock
// ---------------------------------------------------------------------------

describe('POST /lock', () => {
  it('rejects a non-UUID entity_id before calling the RPC', async () => {
    const res = await request(app)
      .post('/lock')
      .set('Authorization', 'Bearer t')
      .send({ entity_type: 'diary', entity_id: 'not-a-uuid' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects an invalid entity_type before calling the RPC', async () => {
    const res = await request(app)
      .post('/lock')
      .set('Authorization', 'Bearer t')
      .send({ entity_type: 'not_a_real_type', entity_id: ENTITY_ID });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('locks the exact entity under the caller\'s own token, and emits memory.locked', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, id: 'l1', entity_type: 'diary', entity_id: ENTITY_ID, locked: true }, error: null });
    const res = await request(app)
      .post('/lock')
      .set('Authorization', 'Bearer user-A-token')
      .send({ entity_type: 'diary', entity_id: ENTITY_ID, reason: 'sensitive' });
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_lock_entity', {
      p_entity_type: 'diary',
      p_entity_id: ENTITY_ID,
      p_reason: 'sensitive',
    });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.locked' }));
  });

  it('rejects locking an entity that does not belong to the caller (RPC ok:false, no event emitted)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'NOT_FOUND_OR_NOT_OWNED' }, error: null });
    const res = await request(app)
      .post('/lock')
      .set('Authorization', 'Bearer other-users-token')
      .send({ entity_type: 'diary', entity_id: ENTITY_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('NOT_FOUND_OR_NOT_OWNED');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('POST /unlock', () => {
  it('unlocks the exact entity and emits memory.unlocked', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, entity_type: 'diary', entity_id: ENTITY_ID, unlocked: true }, error: null });
    const res = await request(app)
      .post('/unlock')
      .set('Authorization', 'Bearer t')
      .send({ entity_type: 'diary', entity_id: ENTITY_ID });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('memory_unlock_entity', { p_entity_type: 'diary', p_entity_id: ENTITY_ID });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.unlocked' }));
  });

  it('rejects a non-UUID entity_id before calling the RPC', async () => {
    const res = await request(app)
      .post('/unlock')
      .set('Authorization', 'Bearer t')
      .send({ entity_type: 'diary', entity_id: 'bad' });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DELETE /entity
// ---------------------------------------------------------------------------

describe('DELETE /entity', () => {
  it('rejects an invalid body before calling the RPC', async () => {
    const res = await request(app)
      .delete('/entity')
      .set('Authorization', 'Bearer t')
      .send({ entity_type: 'diary' }); // missing entity_id
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('soft-deletes the exact entity under the caller\'s own token, and emits memory.deleted', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, id: 'd1', entity_type: 'garden_node', entity_id: ENTITY_ID, deleted: true, cascade: 2 }, error: null });
    const res = await request(app)
      .delete('/entity')
      .set('Authorization', 'Bearer user-A-token')
      .send({ entity_type: 'garden_node', entity_id: ENTITY_ID });
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_delete_entity', { p_entity_type: 'garden_node', p_entity_id: ENTITY_ID });
    expect(res.body.cascade).toBe(2);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.deleted' }));
  });

  it('refuses to delete an entity that does not belong to the caller (RPC ok:false)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'NOT_FOUND_OR_NOT_OWNED' }, error: null });
    const res = await request(app)
      .delete('/entity')
      .set('Authorization', 'Bearer someone-elses-token')
      .send({ entity_type: 'garden_node', entity_id: ENTITY_ID });
    expect(res.status).toBe(400);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /locks
// ---------------------------------------------------------------------------

describe('GET /locks', () => {
  it('rejects an invalid entity_type query param before calling the RPC', async () => {
    const res = await request(app).get('/locks?entity_type=not_real').set('Authorization', 'Bearer t');
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('scopes the RPC call to the caller\'s own token and passes the entity_type filter', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, locks: [{ id: 'l1' }] }, error: null });
    const res = await request(app)
      .get('/locks?entity_type=diary')
      .set('Authorization', 'Bearer user-A-token');
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_get_locked_entities', { p_entity_type: 'diary' });
    expect(res.body.locks).toEqual([{ id: 'l1' }]);
  });

  it('passes null entity_type when no filter is given', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, locks: [] }, error: null });
    await request(app).get('/locks').set('Authorization', 'Bearer t');
    expect(mockRpc).toHaveBeenCalledWith('memory_get_locked_entities', { p_entity_type: null });
  });

  it('two different callers each get only their own token forwarded (no shared client reuse leaking identity)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, locks: [] }, error: null });
    await request(app).get('/locks').set('Authorization', 'Bearer token-user-A');
    await request(app).get('/locks').set('Authorization', 'Bearer token-user-B');
    expect(mockCreateUserSupabaseClient.mock.calls[0][0]).toBe('token-user-A');
    expect(mockCreateUserSupabaseClient.mock.calls[1][0]).toBe('token-user-B');
  });
});

// ---------------------------------------------------------------------------
// POST /export, GET /export/:id
// ---------------------------------------------------------------------------

describe('POST /export', () => {
  it('rejects an empty domains array before calling the RPC', async () => {
    const res = await request(app).post('/export').set('Authorization', 'Bearer t').send({ domains: [] });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('rejects an invalid domain before calling the RPC', async () => {
    const res = await request(app).post('/export').set('Authorization', 'Bearer t').send({ domains: ['not_a_real_domain'] });
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('defaults format to json and requests the export under the caller\'s own token', async () => {
    mockRpc.mockResolvedValue({ data: { ok: true, id: 'exp-1', domains: ['diary'], format: 'json', status: 'pending' }, error: null });
    const res = await request(app)
      .post('/export')
      .set('Authorization', 'Bearer user-A-token')
      .send({ domains: ['diary'] });
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_request_export', { p_domains: ['diary'], p_format: 'json' });
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'memory.export.requested' }));
  });
});

describe('GET /export/:id', () => {
  it('rejects a non-UUID export id before calling the RPC', async () => {
    const res = await request(app).get('/export/not-a-uuid').set('Authorization', 'Bearer t');
    expect(res.status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('returns 404 when the RPC reports NOT_FOUND (e.g. another user\'s export id)', async () => {
    mockRpc.mockResolvedValue({ data: { ok: false, error: 'NOT_FOUND' }, error: null });
    const res = await request(app).get(`/export/${ENTITY_ID}`).set('Authorization', 'Bearer someone-elses-token');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns the export status under the caller\'s own token on success', async () => {
    mockRpc.mockResolvedValue({
      data: { ok: true, id: ENTITY_ID, domains: ['diary'], format: 'json', status: 'ready', file_url: 'https://x/y', created_at: '2026-07-01T00:00:00.000Z', expires_at: '2026-08-01T00:00:00.000Z' },
      error: null,
    });
    const res = await request(app).get(`/export/${ENTITY_ID}`).set('Authorization', 'Bearer user-A-token');
    expect(res.status).toBe(200);
    expect(mockCreateUserSupabaseClient).toHaveBeenCalledWith('user-A-token');
    expect(mockRpc).toHaveBeenCalledWith('memory_get_export_status', { p_export_id: ENTITY_ID });
    expect(res.body.file_url).toBe('https://x/y');
  });
});
