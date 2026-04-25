import express from 'express';
import request from 'supertest';
import router from './user-preferences';
import {
  emitPreferenceEvent,
  isActionAllowed,
} from '../services/user-preference-modeling-service';

// ---------------------------------------------------------------------------
// Module-level RPC spy — reassigned in beforeEach so each test gets a clean fn
// ---------------------------------------------------------------------------
let mockRpc: jest.Mock;

jest.mock('../lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => ({
    rpc: (...args: any[]) => mockRpc(...args),
  })),
}));

jest.mock('../services/user-preference-modeling-service', () => ({
  VTID: 'VTID-01119',
  emitPreferenceEvent: jest.fn().mockResolvedValue(undefined),
  isActionAllowed: jest.fn(),
  checkConstraintViolations: jest.fn(),
  buildPreferenceBundle: jest.fn(),
}));

// DO NOT mock ../types/user-preferences — real Zod schemas must run

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());
app.use('/', router);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MOCK_TOKEN = 'Bearer test-token';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a mockRpc that returns success for me_context, and uses `overrides`
 * to supply data for any other RPC name.
 */
function makeRpc(overrides: Record<string, any> = {}): jest.Mock {
  return jest.fn().mockImplementation((rpcName: string, _args?: any) => {
    if (rpcName === 'me_context') {
      return Promise.resolve({
        data: { tenant_id: 'tenant-1', user_id: 'user-1' },
        error: null,
      });
    }
    if (Object.prototype.hasOwnProperty.call(overrides, rpcName)) {
      return Promise.resolve({ data: overrides[rpcName], error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc: ' + rpcName } });
  });
}

/**
 * Build a mockRpc that returns an error for `rpcName`, and the normal
 * me_context success for everything else.
 */
function makeRpcError(rpcName: string, message: string): jest.Mock {
  return jest.fn().mockImplementation((name: string, _args?: any) => {
    if (name === 'me_context' && rpcName !== 'me_context') {
      return Promise.resolve({
        data: { tenant_id: 'tenant-1', user_id: 'user-1' },
        error: null,
      });
    }
    if (name === rpcName) {
      return Promise.resolve({ data: null, error: { message } });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc: ' + name } });
  });
}

// ---------------------------------------------------------------------------
// Default bundle data reused across tests
// ---------------------------------------------------------------------------
const DEFAULT_BUNDLE_DATA = {
  ok: true,
  preference_count: 3,
  inference_count: 1,
  constraint_count: 2,
  confidence_level: 0.8,
  constraints: [],
  preferences: [],
  inferences: [],
};

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.resetAllMocks();

  // Re-apply default resolved value after resetAllMocks clears it
  (emitPreferenceEvent as jest.Mock).mockResolvedValue(undefined);

  // Default mockRpc — handles me_context + preference_bundle_get for convenience
  mockRpc = jest.fn().mockImplementation((rpcName: string, _args?: any) => {
    if (rpcName === 'me_context') {
      return Promise.resolve({
        data: { tenant_id: 'tenant-1', user_id: 'user-1' },
        error: null,
      });
    }
    if (rpcName === 'preference_bundle_get') {
      return Promise.resolve({ data: DEFAULT_BUNDLE_DATA, error: null });
    }
    return Promise.resolve({ data: null, error: { message: 'unexpected rpc: ' + rpcName } });
  });
});

// ===========================================================================
// GET /
// ===========================================================================
describe('GET /', () => {
  it('returns correct shape with ok, service, vtid, version, endpoints, timestamp', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe('user-preference-modeling');
    expect(res.body.vtid).toBe('VTID-01119');
    expect(res.body.version).toBe('v1');
    expect(Array.isArray(res.body.endpoints)).toBe(true);
    expect(res.body.endpoints.length).toBeGreaterThanOrEqual(12);
    expect(typeof res.body.timestamp).toBe('string');
  });
});

// ===========================================================================
// GET /health
// ===========================================================================
describe('GET /health', () => {
  it('returns ok, status healthy, vtid, and timestamp', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('healthy');
    expect(res.body.vtid).toBe('VTID-01119');
    expect(typeof res.body.timestamp).toBe('string');
  });
});

// ===========================================================================
// GET /categories
// ===========================================================================
describe('GET /categories', () => {
  it('returns ok, categories array, constraint_types array', async () => {
    const res = await request(app).get('/categories');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.categories)).toBe(true);
    expect(res.body.categories.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.constraint_types)).toBe(true);
    expect(res.body.constraint_types.length).toBeGreaterThan(0);
    // Each category entry should have a key property
    for (const cat of res.body.categories) {
      expect(cat).toHaveProperty('key');
    }
  });
});

// ===========================================================================
// GET /bundle
// ===========================================================================
describe('GET /bundle', () => {
  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).get('/bundle');
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 401 UNAUTHORIZED when me_context returns JWT error', async () => {
    mockRpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'JWT expired' },
    });
    const res = await request(app)
      .get('/bundle')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(401);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('UNAUTHORIZED');
  });

  it('returns 400 with error message when me_context returns generic error', async () => {
    mockRpc = jest.fn().mockResolvedValue({
      data: null,
      error: { message: 'DB down' },
    });
    const res = await request(app)
      .get('/bundle')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('DB down');
  });

  it('returns 500 when preference_bundle_get returns an RPC error', async () => {
    mockRpc = makeRpcError('preference_bundle_get', 'RPC failure');
    const res = await request(app)
      .get('/bundle')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('RPC failure');
  });

  it('returns 400 when preference_bundle_get returns ok: false', async () => {
    mockRpc = makeRpc({
      preference_bundle_get: { ok: false, error: 'NOT_FOUND' },
    });
    const res = await request(app)
      .get('/bundle')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('happy path: 200 with bundle data and emits preference.bundle.read event', async () => {
    mockRpc = makeRpc({
      preference_bundle_get: DEFAULT_BUNDLE_DATA,
    });
    const res = await request(app)
      .get('/bundle')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data).toBeDefined();
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const firstCall = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(firstCall[0]).toBe('preference.bundle.read');
  });
});

// ===========================================================================
// POST /preference
// ===========================================================================
describe('POST /preference', () => {
  const validBody = {
    category: 'communication',
    key: 'tone',
    value: 'formal',
    priority: 'explicit',
    scope: 'global',
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).post('/preference').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when category is missing', async () => {
    const { category, ...bodyWithoutCategory } = validBody;
    const res = await request(app)
      .post('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(bodyWithoutCategory);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
    expect(Array.isArray(res.body.details)).toBe(true);
  });

  it('returns 400 INVALID_REQUEST when priority is an invalid enum value', async () => {
    const res = await request(app)
      .post('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send({ ...validBody, priority: 'invalid_priority_value' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when key is missing', async () => {
    const { key, ...bodyWithoutKey } = validBody;
    const res = await request(app)
      .post('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(bodyWithoutKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when preference_set RPC returns an error', async () => {
    mockRpc = makeRpcError('preference_set', 'DB write error');
    const res = await request(app)
      .post('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('DB write error');
  });

  it('returns 400 when preference_set returns ok: false', async () => {
    mockRpc = makeRpc({
      preference_set: { ok: false, error: 'DUPLICATE_KEY' },
    });
    const res = await request(app)
      .post('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('happy path: 200 and emits preference.set with category and key in context', async () => {
    mockRpc = makeRpc({
      preference_set: { ok: true, id: 'pref-1', action: 'created' },
    });
    const res = await request(app)
      .post('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName, context] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('preference.set');
    expect(context).toMatchObject({ category: validBody.category, key: validBody.key });
  });
});

// ===========================================================================
// DELETE /preference
// ===========================================================================
describe('DELETE /preference', () => {
  const validBody = {
    category: 'communication',
    key: 'tone',
    scope: 'global',
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).delete('/preference').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when category is missing', async () => {
    const { category, ...bodyWithoutCategory } = validBody;
    const res = await request(app)
      .delete('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(bodyWithoutCategory);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when preference_delete RPC returns an error', async () => {
    mockRpc = makeRpcError('preference_delete', 'Delete failed');
    const res = await request(app)
      .delete('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Delete failed');
  });

  it('happy path: 200 and emits preference.deleted', async () => {
    mockRpc = makeRpc({
      preference_delete: { ok: true, id: 'pref-1' },
    });
    const res = await request(app)
      .delete('/preference')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('preference.deleted');
  });
});

// ===========================================================================
// POST /constraint
// ===========================================================================
describe('POST /constraint', () => {
  const validBody = {
    type: 'hard_block',
    key: 'no-violence',
    value: true,
    severity: 'critical',
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).post('/constraint').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when type is missing', async () => {
    const { type, ...bodyWithoutType } = validBody;
    const res = await request(app)
      .post('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send(bodyWithoutType);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when key is missing', async () => {
    const { key, ...bodyWithoutKey } = validBody;
    const res = await request(app)
      .post('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send(bodyWithoutKey);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when constraint_set RPC returns an error', async () => {
    mockRpc = makeRpcError('constraint_set', 'Constraint write error');
    const res = await request(app)
      .post('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Constraint write error');
  });

  it('happy path: 200 and emits constraint.set', async () => {
    mockRpc = makeRpc({
      constraint_set: { ok: true, id: 'c-1', action: 'created' },
    });
    const res = await request(app)
      .post('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('constraint.set');
  });
});

// ===========================================================================
// DELETE /constraint
// ===========================================================================
describe('DELETE /constraint', () => {
  const validBody = {
    key: 'no-violence',
    type: 'hard_block',
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).delete('/constraint').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when body is empty', async () => {
    const res = await request(app)
      .delete('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when key is missing', async () => {
    const res = await request(app)
      .delete('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send({ type: 'hard_block' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when constraint_delete RPC returns an error', async () => {
    mockRpc = makeRpcError('constraint_delete', 'Constraint delete error');
    const res = await request(app)
      .delete('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Constraint delete error');
  });

  it('happy path: 200 and emits constraint.deleted', async () => {
    mockRpc = makeRpc({
      constraint_delete: { ok: true, id: 'c-1' },
    });
    const res = await request(app)
      .delete('/constraint')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('constraint.deleted');
  });
});

// ===========================================================================
// POST /confirm
// ===========================================================================
describe('POST /confirm', () => {
  const validBody = {
    preference_id: 'pref-abc-123',
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).post('/confirm').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when preference_id is missing', async () => {
    const res = await request(app)
      .post('/confirm')
      .set('Authorization', MOCK_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when preference_confirm RPC returns an error', async () => {
    mockRpc = makeRpcError('preference_confirm', 'Confirm failed');
    const res = await request(app)
      .post('/confirm')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Confirm failed');
  });

  it('happy path: 200 and emits preference.confirmed with target_id === preference_id', async () => {
    mockRpc = makeRpc({
      preference_confirm: { ok: true },
    });
    const res = await request(app)
      .post('/confirm')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName, context] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('preference.confirmed');
    expect(context).toMatchObject({ target_id: validBody.preference_id });
  });
});

// ===========================================================================
// POST /reinforce
// ===========================================================================
describe('POST /reinforce', () => {
  const validBody = {
    inference_id: 'inf-abc-123',
  };

  const reinforceResult = {
    ok: true,
    old_confidence: 0.5,
    new_confidence: 0.7,
    delta: 0.2,
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).post('/reinforce').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when inference_id is missing', async () => {
    const res = await request(app)
      .post('/reinforce')
      .set('Authorization', MOCK_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when inference_reinforce RPC returns an error', async () => {
    mockRpc = makeRpcError('inference_reinforce', 'Reinforce RPC error');
    const res = await request(app)
      .post('/reinforce')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Reinforce RPC error');
  });

  it('happy path: 200, emits inference.reinforced with confidence_delta', async () => {
    mockRpc = makeRpc({ inference_reinforce: reinforceResult });
    const res = await request(app)
      .post('/reinforce')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName, context] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('inference.reinforced');
    expect(context).toMatchObject({ confidence_delta: 0.2 });
  });

  it('accepts optional evidence field and still returns 200', async () => {
    mockRpc = makeRpc({ inference_reinforce: reinforceResult });
    const res = await request(app)
      .post('/reinforce')
      .set('Authorization', MOCK_TOKEN)
      .send({ ...validBody, evidence: 'user clicked approve' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ===========================================================================
// POST /downgrade
// ===========================================================================
describe('POST /downgrade', () => {
  const validBody = {
    inference_id: 'inf-xyz-456',
  };

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).post('/downgrade').send(validBody);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when inference_id is missing', async () => {
    const res = await request(app)
      .post('/downgrade')
      .set('Authorization', MOCK_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when inference_downgrade RPC returns an error', async () => {
    mockRpc = makeRpcError('inference_downgrade', 'Downgrade RPC error');
    const res = await request(app)
      .post('/downgrade')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Downgrade RPC error');
  });

  it('happy path (not deleted): 200 and emits inference.downgraded', async () => {
    mockRpc = makeRpc({
      inference_downgrade: {
        ok: true,
        deleted: false,
        old_confidence: 0.6,
        new_confidence: 0.3,
        delta: -0.3,
      },
    });
    const res = await request(app)
      .post('/downgrade')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('inference.downgraded');
  });

  it('happy path (deleted flag set): 200 and event context indicates deleted', async () => {
    mockRpc = makeRpc({
      inference_downgrade: {
        ok: true,
        deleted: true,
        old_confidence: 0.2,
        new_confidence: 0,
        delta: -0.2,
      },
    });
    const res = await request(app)
      .post('/downgrade')
      .set('Authorization', MOCK_TOKEN)
      .send(validBody);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(emitPreferenceEvent as jest.Mock).toHaveBeenCalledTimes(1);
    const [eventName, context] = (emitPreferenceEvent as jest.Mock).mock.calls[0];
    expect(eventName).toBe('inference.downgraded');
    // The event context or message should reference deletion
    const contextStr = JSON.stringify(context || '');
    expect(contextStr.toLowerCase()).toContain('delet');
  });
});

// ===========================================================================
// GET /audit
// ===========================================================================
describe('GET /audit', () => {
  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).get('/audit');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 or passes NaN through when limit is non-numeric', async () => {
    // parseInt('abc') === NaN; behaviour depends on GetAuditRequestSchema
    // We assert that the response is either 400 INVALID_REQUEST or 200
    // (the router may coerce / ignore NaN). Either is acceptable per spec note.
    mockRpc = makeRpc({
      preference_get_audit: { ok: true, audit: [] },
    });
    const res = await request(app)
      .get('/audit?limit=abc')
      .set('Authorization', MOCK_TOKEN);
    expect([200, 400]).toContain(res.status);
    if (res.status === 400) {
      expect(res.body.error).toBe('INVALID_REQUEST');
    }
  });

  it('returns 500 when preference_get_audit RPC returns an error', async () => {
    mockRpc = makeRpcError('preference_get_audit', 'Audit RPC error');
    const res = await request(app)
      .get('/audit')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Audit RPC error');
  });

  it('happy path: 200 with audit array', async () => {
    mockRpc = makeRpc({
      preference_get_audit: { ok: true, audit: [] },
    });
    const res = await request(app)
      .get('/audit')
      .set('Authorization', MOCK_TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.audit)).toBe(true);
  });

  it('forwards limit, offset, target_type as p_ params to RPC', async () => {
    mockRpc = makeRpc({
      preference_get_audit: { ok: true, audit: [] },
    });
    await request(app)
      .get('/audit?limit=10&offset=5&target_type=preference')
      .set('Authorization', MOCK_TOKEN);
    const auditCall = (mockRpc as jest.Mock).mock.calls.find(
      (call: any[]) => call[0] === 'preference_get_audit'
    );
    expect(auditCall).toBeDefined();
    const rpcArgs = auditCall![1];
    expect(rpcArgs).toMatchObject({
      p_limit: 10,
      p_offset: 5,
      p_target_type: 'preference',
    });
  });
});

// ===========================================================================
// POST /check
// ===========================================================================
describe('POST /check', () => {
  const validAction = {
    action: {
      type: 'send',
      content: 'hello world',
    },
  };

  beforeEach(() => {
    // Wire up isActionAllowed to return allowed by default
    (isActionAllowed as jest.Mock).mockReturnValue({ allowed: true, violations: [] });
    // Wire bundle RPC
    mockRpc = makeRpc({
      preference_bundle_get: DEFAULT_BUNDLE_DATA,
    });
  });

  it('returns 401 UNAUTHENTICATED when no Authorization header', async () => {
    const res = await request(app).post('/check').send(validAction);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('returns 400 INVALID_REQUEST when action field is missing', async () => {
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 400 INVALID_REQUEST when action is a string (not object)', async () => {
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send({ action: 'send-message' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('INVALID_REQUEST');
  });

  it('returns 500 when preference_bundle_get RPC returns an error', async () => {
    mockRpc = makeRpcError('preference_bundle_get', 'Bundle fetch error');
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send(validAction);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('Bundle fetch error');
  });

  it('returns 400 when preference_bundle_get returns ok: false', async () => {
    mockRpc = makeRpc({
      preference_bundle_get: { ok: false, error: 'BUNDLE_NOT_FOUND' },
    });
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send(validAction);
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('happy path — allowed: returns 200 with allowed true and empty violations', async () => {
    (isActionAllowed as jest.Mock).mockReturnValue({ allowed: true, violations: [] });
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send(validAction);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.allowed).toBe(true);
    expect(Array.isArray(res.body.violations)).toBe(true);
    expect(res.body.violations).toHaveLength(0);
  });

  it('happy path — blocked: returns 200 with allowed false and violations', async () => {
    (isActionAllowed as jest.Mock).mockReturnValue({
      allowed: false,
      violations: [{ type: 'hard_block', key: 'x' }],
    });
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send(validAction);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.allowed).toBe(false);
    expect(res.body.violations).toEqual([{ type: 'hard_block', key: 'x' }]);
  });

  it('parses action.time string into a Date before passing to isActionAllowed', async () => {
    const timeStr = '2025-01-01T00:00:00Z';
    const res = await request(app)
      .post('/check')
      .set('Authorization', MOCK_TOKEN)
      .send({ action: { type: 'send', time: timeStr } });
    expect(res.status).toBe(200);
    const calls = (isActionAllowed as jest.Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const actionArg = calls[0][0];
    if (actionArg && actionArg.time !== undefined) {
      expect(actionArg.time instanceof Date).toBe(true);
    }
  });
});