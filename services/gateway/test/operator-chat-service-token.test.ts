/**
 * Operator Chat approve and reject carry the gateway service token (VTID-05528).
 *
 * executeDevApproveItem and executeDevRejectItem call this gateway's
 * /api/v1/approvals/:id/approve and /reject routes. Both routes are behind
 * requireServiceOrAdmin, which accepts the GATEWAY_SERVICE_TOKEN or an
 * exafy_admin JWT, never the Supabase service key. These tests drive both
 * tools through the real executeTool dispatcher and pin the request headers.
 */

const SVC = 'gateway-service-token-05528';
const SUPABASE_KEY = 'supabase-service-role-05528';

jest.mock('../src/services/oasis-event-service', () => ({
  __esModule: true,
  default: new Proxy({}, { get: () => jest.fn(async () => ({ ok: true })) }),
  emitOasisEvent: jest.fn(async () => ({ ok: true })),
  recommendationSyncEvents: new Proxy({}, { get: () => jest.fn() }),
}));

type Executor = (toolName: string, args: Record<string, unknown>, threadId: string) => Promise<{ ok: boolean }>;
let executeTool: Executor;
// gemini-operator sends its approvals calls through node-fetch, which the setup file mocks.
let nodeFetch: jest.Mock;

const ENV0 = { ...process.env };
beforeAll(() => {
  process.env.GATEWAY_SERVICE_TOKEN = SVC;
  process.env.SUPABASE_URL = 'https://example.supabase.test';
  process.env.SUPABASE_SERVICE_ROLE = SUPABASE_KEY;
  // gemini-operator reads SUPABASE_SERVICE_ROLE once, when it loads, so it is loaded after the key is set.
  executeTool = require('../src/services/gemini-operator').executeTool;
  nodeFetch = require('node-fetch');
});
afterAll(() => {
  process.env = ENV0;
});
beforeEach(() => {
  nodeFetch.mockReset();
  nodeFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
});

const APPROVAL = 'appr_VTID-01234_abc';

describe.each([
  { tool: 'dev_approve_item', args: { approval_id: APPROVAL }, route: `/api/v1/approvals/${APPROVAL}/approve` },
  { tool: 'dev_reject_item', args: { approval_id: APPROVAL, reason: 'not ready' }, route: `/api/v1/approvals/${APPROVAL}/reject` },
])('$tool (Operator Chat to the approvals route)', ({ tool, args, route }) => {
  it('sends the gateway service token and never the Supabase service key', async () => {
    const out = await executeTool(tool, args, 'thread-05528');

    expect(nodeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = nodeFetch.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toContain(route);
    expect(init.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SVC}` });
    expect(JSON.stringify(init)).not.toContain(SUPABASE_KEY);
    expect(out.ok).toBe(true);
  });
});
