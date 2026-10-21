/** VTID-03848 — the orchestrator service, called the way the voice tool calls it, applies the voice ceiling end to end. */
import { submitCommand } from '../src/services/backoffice/command-orchestrator';
import { MemoryCommandStore, __setCommandStoreForTests } from '../src/services/backoffice/command-store';
import { __setErpBridgeClientForTests } from '../src/services/backoffice/erp-bridge-client';

jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: async () => ({ ok: true }) }));

const caller = { user_id: 'u1', email: 'u@x', is_exafy_admin: false, tenant_id: 't1', active_role: 'backoffice', aal: null };
const access = (caps: string[]) => ({ role: 'backoffice', is_exafy_admin: false, defaults: [], explicit: caps, capabilities: caps });
let store: MemoryCommandStore; const calls: any[] = [];

beforeEach(() => {
  store = new MemoryCommandStore(); __setCommandStoreForTests(store); calls.length = 0;
  __setErpBridgeClientForTests({ async execute(req) { calls.push(req); return { ok: true, status: 200, receipt: { status: 'executed', replayed: false, idempotency_key: req.idempotency_key, action: req.action, result: { status: 'ok' } } }; } });
});
afterEach(() => { __setCommandStoreForTests(null); __setErpBridgeClientForTests(null); });

test('voice: read executes, draft executes, commit and high are rejected voice_not_permitted and never reach the bridge', async () => {
  expect((await submitCommand(caller, access(['crm.view', 'crm.manage', 'sales.commit']), { type: 'crm.lead.list', payload: {}, idempotency_key: 'voice:s:1:a', channel: 'voice', confirm: false })).body).toMatchObject({ ok: true });
  expect((await submitCommand(caller, access(['crm.view', 'crm.manage', 'sales.commit']), { type: 'crm.lead.create', payload: { lead_name: 'x' }, idempotency_key: 'voice:s:2:a', channel: 'voice', confirm: false })).body).toMatchObject({ ok: true });
  const commit = await submitCommand(caller, access(['sales.commit']), { type: 'sales.invoice.submit', payload: {}, idempotency_key: 'voice:s:3:a', channel: 'voice', confirm: true });
  expect(commit.body).toMatchObject({ ok: false, command: { status: 'rejected', reason: 'voice_not_permitted' } });
  const high = await submitCommand(caller, access(['sales.commit']), { type: 'sales.invoice.cancel', payload: {}, idempotency_key: 'voice:s:4:a', channel: 'voice', confirm: true });
  expect(high.body).toMatchObject({ ok: false, command: { status: 'rejected', reason: 'voice_not_permitted' } });
  expect(calls.map((c) => c.action)).toEqual(['list-leads', 'add-lead']);
  expect(calls.every((c) => c.actor.channel === 'voice')).toBe(true);
  expect(store.audit.map((a) => a.event)).toEqual(['command.executed', 'command.executed', 'command.rejected', 'command.rejected']);
});
