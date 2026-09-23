/** VTID-04411 — an executed BackOffice command leaves a customer memory episode; a rejected one does not. */
const mockRecord = jest.fn();
jest.mock('../src/services/memory/customer', () => ({ recordCustomerEpisode: (...a: any[]) => mockRecord(...a) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({ fake: true }) }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: async () => ({ ok: true }) }));

import { submitCommand } from '../src/services/backoffice/command-orchestrator';
import { MemoryCommandStore, __setCommandStoreForTests } from '../src/services/backoffice/command-store';
import { __setErpBridgeClientForTests } from '../src/services/backoffice/erp-bridge-client';

const caller = { user_id: 'u1', email: 'u@x', is_exafy_admin: false, tenant_id: 't1', active_role: 'backoffice', aal: null };
const access = (caps: string[]) => ({ role: 'backoffice', is_exafy_admin: false, defaults: [], explicit: caps, capabilities: caps });
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  mockRecord.mockReset().mockResolvedValue({ status: 'written', id: 'mi' });
  __setCommandStoreForTests(new MemoryCommandStore());
  __setErpBridgeClientForTests({ async execute(req) { return { ok: true, status: 200, receipt: { status: 'executed', replayed: false, idempotency_key: req.idempotency_key, action: req.action, result: { id: 'LEAD-1' } } }; } });
});
afterEach(() => { __setCommandStoreForTests(null); __setErpBridgeClientForTests(null); });

test('executed command → one customer episode with the persisted row', async () => {
  await submitCommand(caller, access(['crm.view', 'crm.manage']), { type: 'crm.lead.create', payload: { lead_name: 'Jane' }, idempotency_key: 'web:k:0001', channel: 'web', confirm: false });
  await flush();
  expect(mockRecord).toHaveBeenCalledTimes(1);
  const [sb, row] = mockRecord.mock.calls[0];
  expect(sb).toEqual({ fake: true });
  expect(row).toMatchObject({ type: 'crm.lead.create', status: 'executed', tenant_id: 't1', requester_id: 'u1' });
});

test('a rejected command writes nothing, and a failing memory write never changes the result', async () => {
  const r = await submitCommand(caller, access(['sales.commit']), { type: 'sales.invoice.submit', payload: {}, idempotency_key: 'voice:s:3:a', channel: 'voice', confirm: true });
  await flush();
  expect(r.body).toMatchObject({ ok: false });
  expect(mockRecord).not.toHaveBeenCalled();

  mockRecord.mockRejectedValue(new Error('db down'));
  const ok = await submitCommand(caller, access(['crm.view', 'crm.manage']), { type: 'crm.lead.create', payload: { lead_name: 'Jane' }, idempotency_key: 'web:k:0002', channel: 'web', confirm: false });
  await flush();
  expect(ok.body).toMatchObject({ ok: true });
});
