/**
 * VTID-03913: Atomic claim for POST /api/v1/specs/:vtid/generate
 *
 * Found while watching operator-planner (VTID-03902) run on staging: with
 * multiple ECS task replicas each running their own in-process planner
 * loop, two concurrent callers could both "claim" the same vtid (the old
 * claim step was an unconditional PATCH) and both proceed to generate a
 * spec — the loser raced get_next_spec_version/the oasis_specs insert and
 * got spec_insert_failed, permanently stuck since this route never
 * auto-retries a row with spec_last_error set.
 *
 * These tests pin the fix: the claim PATCH is now a compare-and-swap
 * (`spec_status=not.eq.generating` + `Prefer: return=representation`) — a
 * losing caller gets a 409 `already_generating` and never touches the LLM,
 * the version RPC, or the ledger; a winning caller proceeds exactly as
 * before.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import express from 'express';
import request from 'supertest';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../src/services/claude-text-client', () => ({
  callClaudeText: jest.fn().mockResolvedValue('x'.repeat(300)),
  CLAUDE_SONNET_4_6: 'eu.anthropic.claude-sonnet-4-6',
}));

jest.mock('../src/services/spec-quality-agent', () => ({
  runFullQualityCheck: jest.fn(),
}));

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('VTID-03913: POST /specs/:vtid/generate — atomic claim', () => {
  const mockFetch = jest.fn();

  beforeEach(() => {
    jest.resetModules();
    mockFetch.mockReset();
    global.fetch = mockFetch as any;
  });

  function buildApp() {
    // Require after resetModules/mock setup so the router picks up the mocks.
    const { specsRouter } = require('../src/routes/specs');
    const app = express();
    app.use(express.json());
    app.use('/api/v1/specs', specsRouter);
    return app;
  }

  test('claims via a conditional UPDATE, not an unconditional PATCH', async () => {
    const patchUrls: string[] = [];
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/vtid_ledger?vtid=eq.VTID-99001') && !init?.method) {
        return Promise.resolve(jsonResp([{ vtid: 'VTID-99001', title: 'Test task', summary: '' }]));
      }
      if (url.includes('/vtid_ledger') && init?.method === 'PATCH') {
        patchUrls.push(url);
        return Promise.resolve(jsonResp([{ vtid: 'VTID-99001', spec_status: 'generating' }]));
      }
      if (url.includes('/rpc/get_next_spec_version')) {
        return Promise.resolve(jsonResp(1));
      }
      if (url.includes('/oasis_specs')) {
        return Promise.resolve(jsonResp([{ id: 'spec-1', version: 1 }]));
      }
      return Promise.resolve(jsonResp({}, 404));
    });

    const app = buildApp();
    const res = await request(app).post('/api/v1/specs/VTID-99001/generate').send({});

    expect(res.status).toBe(201);
    expect(patchUrls.length).toBeGreaterThanOrEqual(1);
    // The FIRST vtid_ledger PATCH is the claim — it must be conditional.
    expect(patchUrls[0]).toContain('spec_status=not.eq.generating');
  });

  test('a losing concurrent caller gets 409 and never reaches the LLM/version/insert steps', async () => {
    let versionCalled = false;
    let insertCalled = false;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/vtid_ledger?vtid=eq.VTID-99002') && !init?.method) {
        return Promise.resolve(jsonResp([{ vtid: 'VTID-99002', title: 'Test task', summary: '' }]));
      }
      if (url.includes('/vtid_ledger') && init?.method === 'PATCH') {
        // Compare-and-swap lost: another caller already flipped spec_status
        // to 'generating', so the conditional filter matched zero rows.
        return Promise.resolve(jsonResp([]));
      }
      if (url.includes('/rpc/get_next_spec_version')) {
        versionCalled = true;
        return Promise.resolve(jsonResp(1));
      }
      if (url.includes('/oasis_specs')) {
        insertCalled = true;
        return Promise.resolve(jsonResp([{ id: 'spec-1', version: 1 }]));
      }
      return Promise.resolve(jsonResp({}, 404));
    });

    const app = buildApp();
    const res = await request(app).post('/api/v1/specs/VTID-99002/generate').send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, error: 'already_generating', vtid: 'VTID-99002' });
    expect(versionCalled).toBe(false);
    expect(insertCalled).toBe(false);
  });

  test('a losing caller does not touch spec_last_error or reset the ledger', async () => {
    let ledgerWriteCount = 0;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/vtid_ledger?vtid=eq.VTID-99003') && !init?.method) {
        return Promise.resolve(jsonResp([{ vtid: 'VTID-99003', title: 'Test task', summary: '' }]));
      }
      if (url.includes('/vtid_ledger') && init?.method === 'PATCH') {
        ledgerWriteCount++;
        return Promise.resolve(jsonResp([]));
      }
      return Promise.resolve(jsonResp({}, 404));
    });

    const app = buildApp();
    await request(app).post('/api/v1/specs/VTID-99003/generate').send({});

    // Exactly the one (failed) claim attempt — no follow-up write resetting
    // spec_status/spec_last_error the way the old insert-failure path did.
    expect(ledgerWriteCount).toBe(1);
  });
});
