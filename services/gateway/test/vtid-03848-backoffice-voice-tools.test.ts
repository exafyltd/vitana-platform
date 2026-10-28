/** VTID-03848 — BackOffice voice tools go through the orchestrator with channel voice. */
const mockSubmit = jest.fn();
const mockResolve = jest.fn();
const mockListApprovals = jest.fn();
jest.mock('../src/services/backoffice/erp-access-resolver', () => ({ resolveAccess: (...a: any[]) => mockResolve(...a) }));
jest.mock('../src/services/backoffice/command-orchestrator', () => {
  const actual = jest.requireActual('../src/services/backoffice/command-orchestrator');
  return { ...actual, submitCommand: (...a: any[]) => mockSubmit(...a) };
});
const mockRecallCustomer = jest.fn();
jest.mock('../src/services/memory/customer', () => ({ recallCustomerMemory: (...a: any[]) => mockRecallCustomer(...a) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/services/backoffice/command-store', () => ({ getCommandStore: () => ({ listApprovals: (...a: any[]) => mockListApprovals(...a) }) }));

import { BACKOFFICE_TOOL_HANDLERS, BACKOFFICE_TOOL_NAMES, BACKOFFICE_TOOL_SCHEMAS, type BackOfficeToolContext } from '../src/services/backoffice-voice-tools';

const ctx = (over: Partial<BackOfficeToolContext> = {}): BackOfficeToolContext => ({
  tenantId: 't1', userId: 'u1', email: 'u@x', activeRole: 'backoffice', isExafyAdmin: false, surface: 'backoffice', sessionId: 's1', turnNumber: 3, ...over,
});
const access = (caps: string[], role = 'backoffice') => ({ role, is_exafy_admin: false, defaults: [], explicit: caps, capabilities: caps });

beforeEach(() => { mockSubmit.mockReset(); mockResolve.mockReset(); mockListApprovals.mockReset(); });

test('schemas and handlers agree; every schema has a name and parameters', () => {
  expect(BACKOFFICE_TOOL_SCHEMAS.map((s) => s.name).sort()).toEqual([...BACKOFFICE_TOOL_NAMES].sort());
  for (const s of BACKOFFICE_TOOL_SCHEMAS) expect(s.parameters.type).toBe('object');
});

test('every tool is denied off the backoffice surface and without identity', async () => {
  for (const name of BACKOFFICE_TOOL_NAMES) {
    expect(await BACKOFFICE_TOOL_HANDLERS[name](ctx({ surface: 'vitanaland' }), {})).toMatchObject({ success: false, error: 'backoffice_surface_required' });
    expect(await BACKOFFICE_TOOL_HANDLERS[name](ctx({ userId: '' }), {})).toMatchObject({ success: false, error: 'identity_required' });
  }
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('backoffice_command submits through the orchestrator as channel voice, unconfirmed, with a per-turn idempotency key', async () => {
  mockResolve.mockResolvedValue(access(['crm.view', 'crm.manage']));
  mockSubmit.mockResolvedValue({ http: 200, body: { ok: true, command: { command_id: 'c1', status: 'executed', tier: 'read', reason: null, receipt: { result: { leads: [] } } } } });
  const r = await BACKOFFICE_TOOL_HANDLERS.backoffice_command(ctx(), { type: 'crm.lead.list', payload: { limit: 5 } });
  expect(r.success).toBe(true);
  expect(JSON.parse(r.result)).toMatchObject({ status: 'executed', tier: 'read', command_id: 'c1', result: { leads: [] } });
  const [caller, acc, input] = mockSubmit.mock.calls[0];
  expect(caller).toMatchObject({ user_id: 'u1', tenant_id: 't1', active_role: 'backoffice', aal: null });
  expect(acc.capabilities).toEqual(['crm.view', 'crm.manage']);
  expect(input).toEqual({ type: 'crm.lead.list', payload: { limit: 5 }, idempotency_key: 'voice:s1:3:crm.lead.list', channel: 'voice', confirm: false });
});

test('a voice-refused Commit comes back with the reason and a next step, and never succeeds', async () => {
  mockResolve.mockResolvedValue(access(['sales.commit']));
  mockSubmit.mockResolvedValue({ http: 200, body: { ok: false, command: { command_id: 'c2', status: 'rejected', tier: 'commit', reason: 'voice_not_permitted' } } });
  const r = await BACKOFFICE_TOOL_HANDLERS.backoffice_command(ctx(), { type: 'sales.invoice.submit', payload: { sales_invoice_id: 'i' } });
  expect(r.success).toBe(false);
  expect(JSON.parse(r.result)).toMatchObject({ reason: 'voice_not_permitted', next_step: expect.stringContaining('screen') });
});

test('unknown type is refused before the orchestrator; explicit idempotency key is honoured', async () => {
  expect(await BACKOFFICE_TOOL_HANDLERS.backoffice_command(ctx(), { type: 'erp.nuke' })).toMatchObject({ success: false, error: 'unknown_command_type' });
  expect(mockSubmit).not.toHaveBeenCalled();
  mockResolve.mockResolvedValue(access(['crm.view']));
  mockSubmit.mockResolvedValue({ http: 200, body: { ok: true, command: { status: 'executed' } } });
  await BACKOFFICE_TOOL_HANDLERS.backoffice_command(ctx(), { type: 'crm.lead.list', idempotency_key: 'voice-explicit-0001' });
  expect(mockSubmit.mock.calls[0][2].idempotency_key).toBe('voice-explicit-0001');
});

test('list_commands filters to what the caller may run and marks voice-ok tiers', async () => {
  mockResolve.mockResolvedValue(access(['crm.view']));
  const r = await BACKOFFICE_TOOL_HANDLERS.backoffice_list_commands(ctx(), { domain: 'crm' });
  const body = JSON.parse(r.result);
  expect(body.voice_ceiling).toBe('draft');
  expect(body.commands.every((l: string) => l.startsWith('crm.'))).toBe(true);
  expect(body.commands.some((l: string) => l.includes('crm.lead.list — read (voice ok)'))).toBe(true);
  expect(body.commands.some((l: string) => l.includes('crm.lead.create'))).toBe(false); // needs crm.manage
});

test('pending_approvals is read-only and marks the caller\'s own requests', async () => {
  mockResolve.mockResolvedValue(access(['finance.view']));
  mockListApprovals.mockResolvedValue([{ id: 'a1', command_id: 'c1', approve_capability: 'finance.pay', requester_id: 'u1', reason: null, created_at: 'now' }]);
  const r = await BACKOFFICE_TOOL_HANDLERS.backoffice_pending_approvals(ctx(), { limit: 5 });
  const body = JSON.parse(r.result);
  expect(body.approvals[0]).toMatchObject({ approval_id: 'a1', mine: true });
  expect(body.read_only).toMatch(/only decided on the Approvals screen/);
  expect(mockListApprovals).toHaveBeenCalledWith('t1', { status: 'pending', limit: 5 });
  mockResolve.mockResolvedValue(access([]));
  expect(await BACKOFFICE_TOOL_HANDLERS.backoffice_pending_approvals(ctx(), {})).toMatchObject({ success: false, error: 'no_backoffice_capabilities' });
});

test('my_access reports capabilities and the voice ceiling', async () => {
  mockResolve.mockResolvedValue(access(['accounting.view'], 'admin'));
  expect(JSON.parse((await BACKOFFICE_TOOL_HANDLERS.backoffice_my_access(ctx(), {})).result)).toEqual({ role: 'admin', is_exafy_admin: false, capabilities: ['accounting.view'], voice_ceiling: 'draft' });
});

describe('VTID-04411 backoffice_customer_memory', () => {
  const recall = mockRecallCustomer;
  beforeEach(() => recall.mockReset());

  test('needs a customer and crm.view or sales.view', async () => {
    expect(await BACKOFFICE_TOOL_HANDLERS.backoffice_customer_memory(ctx(), {})).toMatchObject({ success: false, error: 'customer_required' });
    mockResolve.mockResolvedValue(access(['finance.view']));
    expect(await BACKOFFICE_TOOL_HANDLERS.backoffice_customer_memory(ctx(), { customer: 'Acme' })).toMatchObject({ success: false, error: expect.stringContaining('capability_required') });
    expect(recall).not.toHaveBeenCalled();
  });

  test('reads the tenant\'s customer memory and says so when nothing is recorded', async () => {
    mockResolve.mockResolvedValue(access(['crm.view']));
    recall.mockResolvedValue([{ id: 'a', content: 'crm.task.create — Acme', command_type: 'crm.task.create', customer_key: 'customer:C1', occurred_at: '2026-09-23' }]);
    const r = await BACKOFFICE_TOOL_HANDLERS.backoffice_customer_memory(ctx(), { customer: 'Acme', limit: 5 });
    expect(r.success).toBe(true);
    expect(JSON.parse(r.result)).toMatchObject({ customer: 'Acme', count: 1, entries: [{ when: '2026-09-23', what: 'crm.task.create — Acme' }] });
    expect(recall.mock.calls[0].slice(1)).toEqual(['t1', 'Acme', { limit: 5 }]);
    recall.mockResolvedValue([]);
    expect(JSON.parse((await BACKOFFICE_TOOL_HANDLERS.backoffice_customer_memory(ctx(), { customer: 'Nobody' })).result).note).toContain('Nothing recorded');
  });
});
