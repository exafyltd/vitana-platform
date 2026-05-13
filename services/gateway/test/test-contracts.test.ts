/**
 * VTID-02954 (PR-L1): Test Contract Registry — unit tests for the
 * safety-critical paths.
 *
 * The allowlist resolver MUST reject unknown command_key. The /run
 * endpoint MUST never execute the database value as shell. The
 * dispatch kind gate MUST refuse non-sync_http until PR-L3 lands.
 */

import express from 'express';
import request from 'supertest';
import { resolveCommand, listAllowlistedKeys, COMMAND_ALLOWLIST } from '../src/services/test-contract-commands';

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  process.env.SUPABASE_URL = 'https://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
  process.env.GATEWAY_INTERNAL_BASE_URL = 'https://gateway.test';
});

afterEach(() => {
  global.fetch = ORIGINAL_FETCH;
  jest.resetModules();
});

// =============================================================================
// Allowlist resolver — the safety boundary.
// =============================================================================

describe('test-contract-commands resolveCommand', () => {
  it('returns null for an unknown command_key (NEVER fall through to exec)', () => {
    expect(resolveCommand('arbitrary; rm -rf /')).toBeNull();
    expect(resolveCommand('gateway.alive; rm -rf /')).toBeNull();
    expect(resolveCommand('')).toBeNull();
    expect(resolveCommand('GATEWAY.ALIVE')).toBeNull(); // case-sensitive
  });

  it('returns the typed dispatcher for an allowlisted key', () => {
    const cmd = resolveCommand('gateway.alive');
    expect(cmd).not.toBeNull();
    expect(cmd!.command_key).toBe('gateway.alive');
    expect(cmd!.contract_type).toBe('live_probe');
    expect(cmd!.dispatch).toBe('sync_http');
    expect(typeof cmd!.resolve).toBe('function');
  });

  it('exposes the 6 PR-L1 seed contracts + 5 M1 worker-runner entries', () => {
    const keys = listAllowlistedKeys().sort();
    expect(keys).toEqual([
      'canary_target.disarmed_health',
      'canary_target.status',
      'gateway.alive',
      'oasis.vtid_terminalize_validates_payload',
      'self_healing.active_route_mounted',
      // M1: worker-runner targets
      'worker_orchestrator.await_autopilot_requires_auth',
      'worker_runner.alive',
      'worker_runner.canary_target_health',
      'worker_runner.live',
      'worker_runner.metrics',
      'worker_runner.ready',
    ]);
  });

  it('every allowlisted command is sync_http in PR-L1 (no cloud_run_job / workflow_dispatch yet)', () => {
    for (const cmd of Object.values(COMMAND_ALLOWLIST)) {
      expect(cmd.dispatch).toBe('sync_http');
    }
  });

  it('every allowlisted command is a live_probe in PR-L1 (jest/typecheck/workflow_check land in PR-L3)', () => {
    for (const cmd of Object.values(COMMAND_ALLOWLIST)) {
      expect(cmd.contract_type).toBe('live_probe');
    }
  });
});

// =============================================================================
// sync_http dispatcher — validates contract assertion shapes.
// =============================================================================

describe('sync_http dispatcher (gateway.alive resolve)', () => {
  function mockFetch(impl: (url: string, init?: any) => Promise<Response>) {
    global.fetch = jest.fn().mockImplementation(impl) as unknown as typeof fetch;
  }

  it('passes when status=200 and json_must_contain matches', async () => {
    mockFetch(async (url) => {
      expect(url).toBe('https://gateway.test/alive');
      return new Response(JSON.stringify({ status: 'ok', service: 'gateway' }), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    });
    const cmd = resolveCommand('gateway.alive')!;
    const result = await cmd.resolve({
      status: 200,
      content_type_prefix: 'application/json',
      json_must_contain: { status: 'ok', service: 'gateway' },
    });
    expect(result.passed).toBe(true);
    expect(result.status_code).toBe(200);
    expect(result.failure_reason).toBeUndefined();
  });

  it('fails when status mismatches', async () => {
    mockFetch(async () => new Response('{}', { status: 500 }));
    const cmd = resolveCommand('gateway.alive')!;
    const result = await cmd.resolve({ status: 200 });
    expect(result.passed).toBe(false);
    expect(result.failure_reason).toContain('status_mismatch');
    expect(result.status_code).toBe(500);
  });

  it('fails when content_type mismatches', async () => {
    mockFetch(async () =>
      new Response('<html>Cannot GET /alive</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const cmd = resolveCommand('gateway.alive')!;
    const result = await cmd.resolve({ status: 200, content_type_prefix: 'application/json' });
    expect(result.passed).toBe(false);
    expect(result.failure_reason).toContain('content_type_mismatch');
  });

  it('fails when json_must_contain does not match', async () => {
    mockFetch(async () =>
      new Response(JSON.stringify({ status: 'degraded' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const cmd = resolveCommand('gateway.alive')!;
    const result = await cmd.resolve({
      status: 200,
      json_must_contain: { status: 'ok' },
    });
    expect(result.passed).toBe(false);
    expect(result.failure_reason).toContain('json_must_contain_mismatch');
  });

  it('accepts a list of acceptable status codes (e.g. 200|401 for "route mounted")', async () => {
    mockFetch(async () => new Response(JSON.stringify({}), { status: 401, headers: { 'content-type': 'application/json' } }));
    const cmd = resolveCommand('self_healing.active_route_mounted')!;
    const result = await cmd.resolve({ status: [200, 401], content_type_prefix: 'application/json' });
    expect(result.passed).toBe(true);
  });

  it('rejects text/html 404 — the canonical "route not deployed" signal', async () => {
    mockFetch(async () =>
      new Response('<!DOCTYPE html><html>Cannot GET /api/v1/canary-target/health</html>', {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );
    const cmd = resolveCommand('canary_target.disarmed_health')!;
    const result = await cmd.resolve({
      status: 200,
      content_type_prefix: 'application/json',
      json_must_contain: { ok: true },
    });
    expect(result.passed).toBe(false);
    expect(result.failure_reason).toContain('status_mismatch');
  });

  it('captures duration_ms and ran_at on every run', async () => {
    mockFetch(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    const cmd = resolveCommand('gateway.alive')!;
    const result = await cmd.resolve({ status: 200 });
    expect(typeof result.duration_ms).toBe('number');
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('handles fetch failures gracefully (timeout / network) — passed=false, no throw', async () => {
    mockFetch(async () => {
      throw new Error('connect ETIMEDOUT');
    });
    const cmd = resolveCommand('gateway.alive')!;
    const result = await cmd.resolve({ status: 200 });
    expect(result.passed).toBe(false);
    expect(result.failure_reason).toContain('fetch_failed');
    expect(result.failure_reason).toContain('ETIMEDOUT');
  });
});

// =============================================================================
// POST /:id/run endpoint — auth + allowlist gate + dispatch gate.
// =============================================================================

describe('POST /api/v1/test-contracts/:id/run', () => {
  // Build a minimal app that mounts ONLY the test-contracts router with a
  // mock auth middleware. We can't import the real auth-supabase-jwt
  // middleware in unit tests (it hits Supabase) — so we install a small
  // shim that mimics req.identity assignment.

  function buildApp(asAdmin: boolean = true): express.Express {
    jest.resetModules();
    process.env.SUPABASE_URL = 'https://supabase.test';
    process.env.SUPABASE_SERVICE_ROLE = 'svc-role';
    // Pre-mock the auth middleware module so the router picks it up.
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      requireAuth: (_req: any, _res: any, next: any) => next(),
      requireAuthWithTenant: (req: any, _res: any, next: any) => {
        req.identity = { exafy_admin: asAdmin, user_id: 'test-user-uuid' };
        next();
      },
    }));
    jest.doMock('../src/services/oasis-event-service', () => ({
      emitOasisEvent: jest.fn().mockResolvedValue(undefined),
    }));
    const router = require('../src/routes/test-contracts').default;
    const app = express();
    app.use(express.json());
    app.use('/api/v1', router);
    return app;
  }

  function mockSupabaseFetch(contractRow: any, captureUpdates: any[] = []) {
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      // SELECT test_contracts?id=eq.X
      if (typeof url === 'string' && url.includes('/rest/v1/test_contracts?id=eq.')) {
        if (!init?.method || init.method === 'GET') {
          return new Response(JSON.stringify(contractRow ? [contractRow] : []), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (init.method === 'PATCH') {
          captureUpdates.push(JSON.parse(init.body));
          return new Response('', { status: 204 });
        }
      }
      // The live_probe target (when allowlist resolver fires)
      if (typeof url === 'string' && url.endsWith('/alive')) {
        return new Response(JSON.stringify({ status: 'ok', service: 'gateway' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // OASIS event POST
      if (typeof url === 'string' && url.includes('/rest/v1/oasis_events')) {
        return new Response('{}', { status: 201 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
  }

  const VALID_UUID = '11111111-2222-3333-4444-555555555555';

  it('returns 400 for malformed id (rejects shell-injection-shaped paths)', async () => {
    const app = buildApp(true);
    mockSupabaseFetch(null);
    const res = await request(app).post('/api/v1/test-contracts/not-a-uuid/run');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid id format');
  });

  it('returns 403 when caller is not exafy_admin', async () => {
    const app = buildApp(false);
    mockSupabaseFetch(null);
    const res = await request(app).post(`/api/v1/test-contracts/${VALID_UUID}/run`);
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('admin access required');
  });

  it('returns 404 when the contract id is unknown', async () => {
    const app = buildApp(true);
    mockSupabaseFetch(null);
    const res = await request(app).post(`/api/v1/test-contracts/${VALID_UUID}/run`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('returns 400 COMMAND_KEY_NOT_ALLOWLISTED when contract.command_key is not in the allowlist (the safety gate)', async () => {
    const app = buildApp(true);
    mockSupabaseFetch({
      id: VALID_UUID,
      capability: 'rogue',
      command_key: 'rm -rf /', // intentionally a shell-shaped string
      status: 'unknown',
      expected_behavior: {},
    });
    const res = await request(app).post(`/api/v1/test-contracts/${VALID_UUID}/run`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('COMMAND_KEY_NOT_ALLOWLISTED');
  });

  it('runs sync_http and persists status=pass on success', async () => {
    const updates: any[] = [];
    const app = buildApp(true);
    mockSupabaseFetch(
      {
        id: VALID_UUID,
        capability: 'gateway_alive',
        command_key: 'gateway.alive',
        status: 'unknown',
        expected_behavior: {
          status: 200,
          content_type_prefix: 'application/json',
          json_must_contain: { status: 'ok' },
        },
      },
      updates,
    );
    const res = await request(app).post(`/api/v1/test-contracts/${VALID_UUID}/run`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result.passed).toBe(true);
    expect(res.body.new_status).toBe('pass');
    expect(res.body.previous_status).toBe('unknown');
    // The PATCH body to test_contracts must update status, last_run_at, last_status, last_failure_signature
    expect(updates.length).toBe(1);
    expect(updates[0].status).toBe('pass');
    expect(updates[0].last_failure_signature).toBeNull();
    expect(updates[0].last_status).toBe('unknown');
  });

  it('persists status=fail + last_failure_signature on probe failure', async () => {
    const updates: any[] = [];
    const app = buildApp(true);
    // Override the /alive mock to return 500
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: any) => {
      if (typeof url === 'string' && url.includes('/rest/v1/test_contracts?id=eq.')) {
        if (!init?.method || init.method === 'GET') {
          return new Response(
            JSON.stringify([
              {
                id: VALID_UUID,
                capability: 'gateway_alive',
                command_key: 'gateway.alive',
                status: 'pass',
                expected_behavior: { status: 200 },
              },
            ]),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (init.method === 'PATCH') {
          updates.push(JSON.parse(init.body));
          return new Response('', { status: 204 });
        }
      }
      if (typeof url === 'string' && url.endsWith('/alive')) {
        return new Response('boom', { status: 500 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const res = await request(app).post(`/api/v1/test-contracts/${VALID_UUID}/run`);
    expect(res.status).toBe(200);
    expect(res.body.result.passed).toBe(false);
    expect(res.body.new_status).toBe('fail');
    expect(updates[0].status).toBe('fail');
    expect(updates[0].last_failure_signature).toBe('gateway.alive:status_mismatch: got 500, expected 200');
    // Regression detection: last_status records the previous status so the
    // cockpit can show "regressed: pass→fail".
    expect(updates[0].last_status).toBe('pass');
  });
});
