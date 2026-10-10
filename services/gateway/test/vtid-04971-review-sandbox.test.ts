/**
 * VTID-04971 — the OpenAI reviewer sandbox: a supplier owned by a registered
 * test/service account can run the whole MCP flow, but its submission stops
 * (no state change, so no review-queue entry and no go-live), no shop
 * connection is created, and the Command Hub review list never shows it.
 */
const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));

const loadOrg = jest.fn();
const loadChecklist = jest.fn();
jest.mock('../src/routes/partner-onboarding', () => ({
  ...jest.requireActual('../src/routes/partner-onboarding'),
  loadOrg: (...a: unknown[]) => loadOrg(...a),
  loadChecklist: (...a: unknown[]) => loadChecklist(...a),
}));

import * as fs from 'fs';
import * as path from 'path';
import { SANDBOX_SUBMIT_NOTE, isSandboxAccount } from '../src/services/sandbox-accounts';
import { submitForVerification } from '../src/services/partner-onboarding-service';
import { shapeStatus } from '../src/services/commerce-mcp';
import { listForReview } from '../src/services/partner-review';

/** A Supabase fake: the two allowlists hold `registered`; other tables are empty. */
function fakeDb(registered: string[], opts: { fail?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    from: (table: string) => {
      calls.push(table);
      let uid: string | null = null;
      const q: any = {
        select: () => q,
        eq: (_c: string, v: string) => ((uid = v), q),
        limit: () => q,
        then: (res: any, rej: any) =>
          Promise.resolve(
            opts.fail
              ? { data: null, error: { message: 'down' } }
              : { data: table === 'service_bot_accounts' && uid && registered.includes(uid) ? [{ user_id: uid }] : [], error: null },
          ).then(res, rej),
      };
      return q;
    },
  } as any;
}

const ORG = { id: 'org-1', owner_user_id: 'owner-1', partner_type: 'supplier_shop', lifecycle_state: 'draft', display_name: 'Sandbox GmbH', country: 'DE' };
const READY = { submit_ready: true, submit_missing: [], steps: [], verification_level_required: 1, next_step: null, complete: true };

beforeEach(() => {
  jest.clearAllMocks();
  loadOrg.mockResolvedValue({ org: ORG, error: null });
  loadChecklist.mockResolvedValue({ checklist: READY, error: null });
});

describe('isSandboxAccount', () => {
  it('is true for a registered account and false for anyone else', async () => {
    expect(await isSandboxAccount(fakeDb(['owner-1']), 'owner-1')).toBe(true);
    expect(await isSandboxAccount(fakeDb(['owner-1']), 'someone-else')).toBe(false);
    expect(await isSandboxAccount(fakeDb(['owner-1']), null)).toBe(false);
  });
  it('a lookup error means the normal flow, never a stuck real supplier', async () => {
    expect(await isSandboxAccount(fakeDb(['owner-1'], { fail: true }), 'owner-1')).toBe(false);
    expect(await isSandboxAccount({ from: () => { throw new Error('boom'); } } as any, 'owner-1')).toBe(false);
  });
});

describe('submit_for_verification for a sandbox supplier', () => {
  const caller = { userId: 'owner-1', orgAdminChecked: true };

  it('records the request, changes nothing, and says so', async () => {
    const db = fakeDb(['owner-1']);
    const r = await submitForVerification(db, caller, 'org-1', { source: 'commerce-mcp' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, sandbox: true, transitions: [] });
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'partner_org.sandbox_submitted', vtid: 'VTID-04971' }));
    // No lifecycle write: nothing touched partner_organizations.
    expect(db.calls).not.toContain('partner_organizations');
    expect(emitOasisEvent.mock.calls.some((c) => c[0].type === 'partner_org.lifecycle_changed')).toBe(false);
  });
  it('still refuses when the prerequisites are missing (terms stay a human step)', async () => {
    loadChecklist.mockResolvedValue({ checklist: { ...READY, submit_ready: false, submit_missing: ['terms'] }, error: null });
    const r = await submitForVerification(fakeDb(['owner-1']), caller, 'org-1');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'SUBMIT_PREREQUISITES_MISSING' });
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
  it('a real supplier is not affected by the sandbox path', async () => {
    const db = fakeDb(['someone-else']);
    // The normal path goes on to the lifecycle write, which this fake does not serve: it must get past the sandbox check.
    await submitForVerification(db, caller, 'org-1').catch(() => undefined);
    expect(emitOasisEvent.mock.calls.some((c) => c[0].type === 'partner_org.sandbox_submitted')).toBe(false);
  });
});

describe('what the assistant reads', () => {
  it('a sandbox status carries the note, platform-written and outside supplier_data', () => {
    const out: any = shapeStatus({ organization: { id: 'org-1', partner_type: 'supplier_shop' }, checklist: null, sandbox: true }, 'https://vitanaland.com');
    expect(out.sandbox).toBe(true);
    expect(out.sandbox_note).toBe(SANDBOX_SUBMIT_NOTE);
    expect(out.supplier_data.name).toBeNull();
  });
  it('a normal status has no sandbox fields', () => {
    const out: any = shapeStatus({ organization: { id: 'org-1', partner_type: 'supplier_shop' }, checklist: null }, 'https://vitanaland.com');
    expect(out.sandbox).toBeUndefined();
  });
});

describe('Command Hub review list', () => {
  it('leaves sandbox suppliers out and keeps the owner id off the wire', async () => {
    const rows = [
      { id: 'org-a', owner_user_id: 'owner-1', lifecycle_state: 'needs_action' },
      { id: 'org-b', owner_user_id: 'owner-2', lifecycle_state: 'needs_action' },
    ];
    const db: any = {
      from: (table: string) => {
        let uid: string | null = null;
        const q: any = {
          select: () => q,
          in: () => q,
          order: () => q,
          eq: (_c: string, v: string) => ((uid = v), q),
          limit: () => q,
          then: (res: any, rej: any) => Promise.resolve(
            table === 'partner_organizations' ? { data: rows, error: null }
              : table === 'service_bot_accounts' ? { data: [{ user_id: 'owner-1' }], error: null }
                : { data: [], error: null, count: 0 },
          ).then(res, rej),
        };
        return q;
      },
    };
    loadOrg.mockResolvedValue({ org: null, error: null });
    const r: any = await listForReview(db);
    expect(r.body.organizations.map((o: any) => o.id)).toEqual(['org-b']);
    expect(JSON.stringify(r.body)).not.toContain('owner-');
  });
});

describe('connect_store and wiring pins', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
  it('connect_store creates no connection for a sandbox supplier', () => {
    const src = read('src/services/commerce-mcp.ts');
    const at = src.indexOf('async function connectStore');
    const body = src.slice(at, src.indexOf('const PRODUCT_PATCH_KEYS'));
    expect(body.indexOf('if (sandbox) {')).toBeGreaterThan(-1);
    expect(body.indexOf('if (sandbox) {')).toBeLessThan(body.indexOf('await startConnection('));
  });
  it('the sandbox event is a declared OASIS event type', () => {
    expect(read('src/types/cicd.ts')).toContain("'partner_org.sandbox_submitted'");
  });
});
