/**
 * VTID-04202 — `autopilot_reject_execution`'s `reason` argument is optional
 * (omitting it entirely still rejects, `reason: null` on the row) but an
 * EXPLICITLY-passed empty/whitespace-only string is refused before the
 * execution row is touched — it is never what the caller meant, and
 * letting it through silently recorded exactly the same `reason: null` as
 * omitting the argument, with no signal that something was wrong.
 */

jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock('../src/services/dev-autopilot-execute', () => {
  const actual = jest.requireActual('../src/services/dev-autopilot-execute');
  return { ...actual, getSupabase: jest.fn(() => null), supa: jest.fn() };
});

import { setThreadAuth, clearThreadAuth } from '../src/services/operator-execute-authz';
import { executeRejectExecution } from '../src/services/operator-approval-tools';

const S = { url: 'https://supa.test', key: 'k' };
const EXEC_A = '4f7d5ea4-1111-4222-8333-444444444444';
const ADMIN = 't-admin-04202';

beforeEach(() => {
  setThreadAuth(ADMIN, { user_id: 'u-admin', exafy_admin: true });
});

afterEach(() => {
  clearThreadAuth(ADMIN);
});

describe('VTID-04202 executeRejectExecution — reason validation', () => {
  it('refuses an empty-string reason with a clear error, and does not call reject()', async () => {
    const reject = jest.fn(async () => ({ ok: true, branch_deleted: true }));
    const r = await executeRejectExecution({ execution_id: EXEC_A, reason: '' }, ADMIN, { s: S, reject });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/needs an actual reason/);
    expect(reject).not.toHaveBeenCalled();
  });

  it('refuses a whitespace-only reason the same way', async () => {
    const reject = jest.fn(async () => ({ ok: true, branch_deleted: true }));
    const r = await executeRejectExecution({ execution_id: EXEC_A, reason: '   \n\t  ' }, ADMIN, { s: S, reject });
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/needs an actual reason/);
    expect(reject).not.toHaveBeenCalled();
  });

  it('an omitted reason is unaffected — still rejects, still records reason: null', async () => {
    const reject = jest.fn(async () => ({ ok: true, branch_deleted: false }));
    const r = await executeRejectExecution({ execution_id: EXEC_A }, ADMIN, { s: S, reject });
    expect(r.ok).toBe(true);
    expect(reject).toHaveBeenCalledWith(EXEC_A, 'operator-chat:u-admin', undefined);
    expect((r.data as { reason: unknown }).reason).toBeNull();
  });

  it('a real, non-empty reason still rejects exactly as before', async () => {
    const reject = jest.fn(async () => ({ ok: true, branch_deleted: true }));
    const r = await executeRejectExecution({ execution_id: EXEC_A, reason: 'wrong approach' }, ADMIN, { s: S, reject });
    expect(r.ok).toBe(true);
    expect(reject).toHaveBeenCalledWith(EXEC_A, 'operator-chat:u-admin', 'wrong approach');
  });
});
