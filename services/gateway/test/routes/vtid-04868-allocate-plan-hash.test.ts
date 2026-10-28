/**
 * VTID-04868 hardening — POST /api/v1/vtid/allocate and /allocate-internal
 * carry the approved plan hash alongside the sparring record id.
 *
 *   - no sparring_id            → the RPC body is byte-identical to today's
 *                                 3-arg call (a stray plan_hash is ignored);
 *   - sparring_id + plan_hash   → both forwarded as p_sparring_id/p_plan_hash;
 *   - sparring_id, no plan_hash → 400 plan_hash_required, no RPC call;
 *   - malformed values          → 400, no RPC call.
 *
 * The Supabase REST API is a jest-mocked global fetch; nothing leaves the
 * process.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../../src/middleware/ledger-write-auth', () => ({
  requireLedgerWriteAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../src/services/system-controls-service', () => ({
  isVtidAllocatorEnabled: jest.fn(async () => true),
  getSystemControl: jest.fn(async () => null),
}));
const emitOasisEvent = jest.fn(async () => ({ ok: true }));
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...a: unknown[]) => (emitOasisEvent as any)(...a),
}));

import { vtidRouter, parseSparringBinding } from '../../src/routes/vtid';

const SID = '11111111-2222-4333-8444-555555555555';
const HASH = 'ab'.repeat(32);
const SECRET = 'alloc-secret';

type Call = { url: string; init: { method?: string; body?: string } };
let calls: Call[] = [];

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/vtid', vtidRouter);
  return a;
}

const rpcCalls = () => calls.filter((c) => c.url.endsWith('/rest/v1/rpc/allocate_global_vtid'));

describe('VTID-04868 /vtid/allocate plan-hash binding', () => {
  const ENV = { ...process.env };
  const realFetch = (global as any).fetch;
  beforeEach(() => {
    calls = [];
    process.env.SUPABASE_URL = 'https://supabase.test.invalid';
    process.env.SUPABASE_SERVICE_ROLE = 'svc';
    process.env.VTID_ALLOC_SECRET = SECRET;
    (global as any).fetch = jest.fn(async (url: string, init: Call['init']) => {
      calls.push({ url, init });
      if (url.endsWith('/rest/v1/rpc/allocate_global_vtid')) {
        return { ok: true, status: 200, statusText: 'OK', json: async () => [{ vtid: 'VTID-05000', num: 5000, id: 'row-1' }], text: async () => '' };
      }
      return { ok: true, status: 204, statusText: 'No Content', json: async () => ({}), text: async () => '' };
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    process.env = { ...ENV };
    (global as any).fetch = realFetch;
    jest.restoreAllMocks();
  });

  const routes: Array<[string, Record<string, string>]> = [
    ['/api/v1/vtid/allocate', {}],
    ['/api/v1/vtid/allocate-internal', { 'X-VTID-Alloc-Secret': SECRET }],
  ];

  describe.each(routes)('%s', (route, headers) => {
    const defaultSource = route.endsWith('internal') ? 'automation' : 'api';

    it('without sparring_id sends the byte-identical 3-arg RPC body (plan_hash alone ignored)', async () => {
      for (const body of [{ source: 'claude-code', module: 'TASK' }, { source: 'claude-code', module: 'TASK', plan_hash: HASH }, { source: 'claude-code', module: 'TASK', plan_hash: 'junk' }]) {
        calls = [];
        const r = await request(app()).post(route).set(headers).send(body);
        expect(r.status).toBe(201);
        expect(rpcCalls()).toHaveLength(1);
        expect(rpcCalls()[0].init.body).toBe(JSON.stringify({ p_source: 'claude-code', p_layer: 'DEV', p_module: 'TASK' }));
      }
      calls = [];
      await request(app()).post(route).set(headers).send({});
      expect(rpcCalls()[0].init.body).toBe(JSON.stringify({ p_source: defaultSource, p_layer: 'DEV', p_module: 'TASK' }));
    });

    it('forwards sparring_id and plan_hash together', async () => {
      const r = await request(app()).post(route).set(headers).send({ source: 'claude-code', sparring_id: SID, plan_hash: HASH });
      expect(r.status).toBe(201);
      expect(JSON.parse(rpcCalls()[0].init.body!)).toEqual({
        p_source: 'claude-code',
        p_layer: 'DEV',
        p_module: 'TASK',
        p_sparring_id: SID,
        p_plan_hash: HASH,
      });
    });

    it('400 plan_hash_required when sparring_id comes without plan_hash — no RPC call', async () => {
      const r = await request(app()).post(route).set(headers).send({ source: 'claude-code', sparring_id: SID });
      expect(r.status).toBe(400);
      expect(r.body).toEqual(expect.objectContaining({ ok: false, error: 'plan_hash_required' }));
      expect(rpcCalls()).toHaveLength(0);
    });

    it('400 on a malformed sparring_id or plan_hash — no RPC call', async () => {
      const bad = await request(app()).post(route).set(headers).send({ sparring_id: 'nope', plan_hash: HASH });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toBe('invalid_sparring_id');
      const badHash = await request(app()).post(route).set(headers).send({ sparring_id: SID, plan_hash: HASH.toUpperCase() });
      expect(badHash.status).toBe(400);
      expect(badHash.body.error).toBe('invalid_plan_hash');
      expect(rpcCalls()).toHaveLength(0);
    });
  });

  it('parseSparringBinding contract', () => {
    expect(parseSparringBinding(undefined)).toEqual({ ok: true, sparringId: null, planHash: null, rpcArgs: {} });
    expect(parseSparringBinding({ plan_hash: HASH })).toEqual({ ok: true, sparringId: null, planHash: null, rpcArgs: {} });
    expect(parseSparringBinding({ sparring_id: SID, plan_hash: HASH })).toEqual({
      ok: true, sparringId: SID, planHash: HASH, rpcArgs: { p_sparring_id: SID, p_plan_hash: HASH },
    });
    expect(parseSparringBinding({ sparring_id: SID, plan_hash: '' })).toEqual(expect.objectContaining({ ok: false, error: 'plan_hash_required' }));
    expect(parseSparringBinding({ sparring_id: SID, plan_hash: 'a'.repeat(63) })).toEqual(expect.objectContaining({ ok: false, error: 'invalid_plan_hash' }));
  });
});
