/**
 * VTID-05063 — the gateway's own calls to its ledger READ routes send the
 * service token explicitly, per call site (opt-in, as VTID-04727 did for the
 * writes). `gatewayApiCall` itself stays credential-free by default, so no
 * other self-call (or a model-chosen path) silently gains the service token.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../src/services/orb-tools-shared';

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
}));

import {
  dev_discover_tasks,
  dev_get_vtid_projection,
  dev_get_allocator_status,
  dev_get_work_order,
} from '../src/services/orb-tools/vtid-lifecycle-tools';
import {
  gatewayApiCall,
  dev_list_pending_approvals,
  dev_count_approvals,
} from '../src/services/orb-tools/developer-tools';
import { executeTaskStateQuery } from '../src/services/task-state-query-service';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };

/** Minimal Supabase stub: every query on vtid_ledger resolves to one non-terminal row. */
function makeSb(): SupabaseClient {
  const resp = { data: [{ vtid: 'VTID-00001', status: 'in_progress', is_terminal: false }], error: null };
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'in', 'limit', 'order']) chain[m] = () => chain;
  chain.then = (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) => Promise.resolve(resp).then(onOk, onErr);
  return { from: () => chain } as unknown as SupabaseClient;
}

const realFetch = global.fetch;
let fetchFn: jest.Mock;
beforeEach(() => {
  fetchFn = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ ok: true, pending: [], data: [], items: [], pending_count: 0, enabled: true }),
  });
  global.fetch = fetchFn as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.GATEWAY_SERVICE_TOKEN;
});

function headersOf(call: unknown[]): Record<string, string> {
  return ((call[1] as { headers?: Record<string, string> } | undefined)?.headers ?? {}) as Record<string, string>;
}

function callTo(fragment: string): unknown[] {
  const call = fetchFn.mock.calls.find((c) => String(c[0]).includes(fragment));
  expect(call).toBeDefined();
  return call as unknown[];
}

const CALL_SITES: Array<[string, () => Promise<unknown>, string]> = [
  ['dev_discover_tasks', () => dev_discover_tasks({}, DEV_ID, makeSb()), '/api/v1/oasis/tasks/discover'],
  ['dev_get_vtid_projection', () => dev_get_vtid_projection({}, DEV_ID, makeSb()), '/api/v1/vtid/projection'],
  ['dev_get_allocator_status', () => dev_get_allocator_status({}, DEV_ID, makeSb()), '/api/v1/vtid/allocator/status'],
  ['dev_get_work_order', () => dev_get_work_order({ vtid: 'VTID-00001' }, DEV_ID, makeSb()), '/api/v1/oasis/tasks/VTID-00001'],
  ['dev_list_pending_approvals', () => dev_list_pending_approvals({}, DEV_ID, makeSb()), '/api/v1/approvals/pending'],
  ['dev_count_approvals', () => dev_count_approvals({}, DEV_ID, makeSb()), '/api/v1/approvals/count'],
];

describe('VTID-05063 voice developer tools: ledger reads carry the service token', () => {
  it.each(CALL_SITES)('%s sends Authorization: Bearer <GATEWAY_SERVICE_TOKEN>', async (_name, invoke, fragment) => {
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    await invoke();
    expect(headersOf(callTo(fragment)).Authorization).toBe('Bearer svc-token');
  });

  it.each(CALL_SITES)('%s sends no bearer when the token is unset', async (_name, invoke, fragment) => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    await invoke();
    expect(headersOf(callTo(fragment)).Authorization).toBeUndefined();
  });
});

describe('VTID-05063 gatewayApiCall stays opt-in', () => {
  it('sends no Authorization when the caller passes no headers, even with the token set', async () => {
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    await gatewayApiCall('/api/v1/oasis/tasks?limit=1');
    expect(headersOf(fetchFn.mock.calls[0])).toEqual({ 'Content-Type': 'application/json' });
  });
});

describe('VTID-05063 task-state-query-service (ORB "what are my tasks")', () => {
  it('sends the service token on GET /api/v1/oasis/tasks/discover', async () => {
    process.env.GATEWAY_SERVICE_TOKEN = 'svc-token';
    await executeTaskStateQuery();
    const h = headersOf(callTo('/api/v1/oasis/tasks/discover'));
    expect(h.Authorization).toBe('Bearer svc-token');
    expect(h['X-Actor']).toBe('orb-router');
  });

  it('sends no bearer when the token is unset', async () => {
    delete process.env.GATEWAY_SERVICE_TOKEN;
    await executeTaskStateQuery();
    expect(headersOf(callTo('/api/v1/oasis/tasks/discover')).Authorization).toBeUndefined();
  });
});
