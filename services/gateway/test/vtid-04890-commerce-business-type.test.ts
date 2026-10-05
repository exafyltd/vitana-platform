/**
 * VTID-04890 — a business registered without a type can get one, once.
 *
 * setMissingPartnerType (service) runs against an in-memory partner_organizations
 * row that records every write; the MCP update_business handler and status shape
 * run through the real /mcp route with the service functions spied on.
 */
import express from 'express';
import request from 'supertest';

const verifyAndExtractIdentity = jest.fn();
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  verifyAndExtractIdentity: (...a: unknown[]) => verifyAndExtractIdentity(...a),
  requireAuth: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));

import * as service from '../src/services/partner-onboarding-service';
import { PARTNER_TYPES } from '../src/services/partner-lifecycle';
import { COMMERCE_MCP_TOOLS, shapeStatus } from '../src/services/commerce-mcp';

const { setMissingPartnerType } = service;

// ---------------------------------------------------------------------------
// In-memory partner_organizations
// ---------------------------------------------------------------------------

type Row = Record<string, any>;

function fakeDb(org: Row, opts: { role?: string | null; concurrentType?: string } = {}) {
  const row: Row = { ...org };
  const writes: Array<{ table: string; values: Row; filters: Array<[string, string, unknown]> }> = [];
  const inserts: string[] = [];
  const s: any = {
    from(table: string) {
      const filters: Array<[string, string, unknown]> = [];
      let values: Row | null = null;
      const q: any = {
        select: () => q,
        eq: (c: string, v: unknown) => (filters.push(['eq', c, v]), q),
        is: (c: string, v: unknown) => (filters.push(['is', c, v]), q),
        order: () => q,
        limit: () => q,
        insert: () => (inserts.push(table), q),
        update: (v: Row) => ((values = v), q),
        maybeSingle: async () => {
          if (table === 'partner_organization_members') return { data: opts.role ? { role: opts.role } : null, error: null };
          if (table === 'partner_organizations') return { data: { ...row }, error: null };
          return { data: null, error: null };
        },
        then(resolve: (r: unknown) => void) {
          if (table === 'partner_organizations' && values) {
            writes.push({ table, values, filters: [...filters] });
            // A concurrent request set the type between our read and our write.
            if (opts.concurrentType) row.partner_type = opts.concurrentType;
            const match = filters.every(([op, c, v]) => (op === 'is' ? row[c] === v : row[c] === v));
            if (match) Object.assign(row, values);
            return resolve({ data: match ? [{ id: row.id }] : [], error: null });
          }
          return resolve({ data: [], error: null, count: 1 });
        },
      };
      return q;
    },
  };
  return { s, row, writes, inserts };
}

const DRAFT = {
  id: 'org-1',
  org_key: 'exafy',
  display_name: 'Exafy ltd',
  partner_type: null,
  commerce_vertical: 'general',
  lifecycle_state: 'draft',
  status: 'pending_review',
  trust_level: 0,
  legal_name: null,
  country: 'AE',
  vat_id: null,
  website: 'https://www.exafy.io/',
  owner_user_id: 'u-1',
  created_at: '2026-10-02T12:49:21Z',
};
const ADMIN = { userId: 'u-1', orgAdminChecked: true };

beforeEach(() => jest.clearAllMocks());

describe('setMissingPartnerType — draft with no type', () => {
  test('sets the type, only where the type is still null and the business still a draft', async () => {
    const { s, row, writes, inserts } = fakeDb(DRAFT);
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'service_provider', { source: 'commerce-mcp' });
    expect(r.status).toBe(200);
    expect(row.partner_type).toBe('service_provider');
    expect(writes).toHaveLength(1);
    expect(writes[0].values).toMatchObject({ partner_type: 'service_provider' });
    expect(writes[0].filters).toEqual(
      expect.arrayContaining([['eq', 'id', 'org-1'], ['is', 'partner_type', null], ['eq', 'lifecycle_state', 'draft']]),
    );
    expect(inserts).toEqual([]);
    expect(emitOasisEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'partner_org.partner_type_set', source: 'commerce-mcp', payload: { partner_organization_id: 'org-1', partner_type: 'service_provider' } }),
    );
    // The answer now carries a real checklist.
    expect((r.body as any).checklist).not.toBeNull();
  });
});

describe('setMissingPartnerType — a type already set is never changed', () => {
  test('a different type is refused, nothing written', async () => {
    const { s, row, writes } = fakeDb({ ...DRAFT, partner_type: 'lab', commerce_vertical: 'health' });
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'supplier_shop');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ ok: false, error: 'PARTNER_TYPE_ALREADY_SET', partner_type: 'lab' });
    expect(writes).toEqual([]);
    expect(row.partner_type).toBe('lab');
  });

  test('the same type again is a no-op, not an error', async () => {
    const { s, writes } = fakeDb({ ...DRAFT, partner_type: 'lab' });
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'lab');
    expect(r.status).toBe(200);
    expect(writes).toEqual([]);
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });

  test('a type set concurrently between read and write is not overwritten', async () => {
    const { s, row } = fakeDb(DRAFT, { concurrentType: 'lab' });
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'supplier_shop');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'PARTNER_TYPE_ALREADY_SET', partner_type: 'lab' });
    expect(row.partner_type).toBe('lab');
    expect(emitOasisEvent).not.toHaveBeenCalled();
  });
});

describe('setMissingPartnerType — only while the business is a draft', () => {
  // needs_action cannot hold a typeless business (submitForVerification refuses
  // PARTNER_TYPE_MISSING before draft -> submitted); asserted as defense in depth.
  test.each(['submitted', 'verifying', 'needs_action', 'live'])('%s with no type → PARTNER_TYPE_LOCKED, nothing written', async (state) => {
    const { s, writes } = fakeDb({ ...DRAFT, lifecycle_state: state });
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'lab');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ error: 'PARTNER_TYPE_LOCKED', lifecycle_state: state });
    expect(writes).toEqual([]);
  });

  test('live with a type → PARTNER_TYPE_LOCKED, nothing written', async () => {
    const { s, writes } = fakeDb({ ...DRAFT, lifecycle_state: 'live', partner_type: 'lab' });
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'supplier_shop');
    expect(r.body).toMatchObject({ error: 'PARTNER_TYPE_LOCKED' });
    expect(writes).toEqual([]);
  });
});

describe('setMissingPartnerType — input and permission', () => {
  test('an unknown type is refused before anything is read or written', async () => {
    const { s, writes } = fakeDb(DRAFT);
    const r = await setMissingPartnerType(s, ADMIN, 'org-1', 'pharmacy');
    expect(r.status).toBe(400);
    expect(writes).toEqual([]);
  });

  test('a member who is not org_admin is refused', async () => {
    const { s, writes } = fakeDb(DRAFT, { role: 'staff' });
    const r = await setMissingPartnerType(s, { userId: 'u-9' }, 'org-1', 'lab');
    expect(r.status).toBe(403);
    expect(writes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// What the assistant reads
// ---------------------------------------------------------------------------

describe('status of a business with no type', () => {
  test('names business_type as the missing and next step, with a hint', () => {
    const out = shapeStatus({ ok: true, organization: DRAFT, checklist: null }, 'https://portal.example');
    expect(out).toMatchObject({
      business_type: null,
      next_step: 'business_type',
      ready_to_submit: false,
      missing_to_submit: ['business_type'],
      steps: [],
      business_types: [...PARTNER_TYPES],
    });
    expect(out.hint).toMatch(/ask the supplier what kind of business/i);
    expect(out.hint).toMatch(/do not call create_business/i);
  });

  test('a typed business is unchanged: no hint, its own next step', () => {
    const checklist = { next_step: 'company', submit_ready: false, submit_missing: ['terms'], steps: [] };
    const out = shapeStatus({ ok: true, organization: { ...DRAFT, partner_type: 'lab' }, checklist }, 'https://portal.example');
    expect(out).toMatchObject({ next_step: 'company', missing_to_submit: ['terms'] });
    expect(out).not.toHaveProperty('hint');
    expect(out).not.toHaveProperty('business_types');
  });
});

describe('update_business schema', () => {
  test('exposes business_type with the partner vocabulary', () => {
    const tool = COMMERCE_MCP_TOOLS.find((t) => t.name === 'update_business')!;
    const props = (tool.inputSchema as any).properties;
    expect(props.business_type.enum).toEqual([...PARTNER_TYPES]);
    expect((tool.inputSchema as any).required).toEqual(['organization_id']);
  });
});

// ---------------------------------------------------------------------------
// The MCP handler
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../src/routes/commerce-mcp');
const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/mcp', routes.default);
  return a;
};
const call = (args: Record<string, unknown>) =>
  request(app())
    .post('/mcp')
    .set('Authorization', 'Bearer good')
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'update_business', arguments: args } });

describe('update_business handler', () => {
  const typedOrg = { ...DRAFT, partner_type: 'service_provider' };
  const checklist = { next_step: 'company', submit_ready: false, submit_missing: ['terms'], steps: [] };
  let spies: Record<string, jest.SpyInstance>;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    routes.resetMcpLimits();
    process.env.COMMERCE_MCP_ENABLED = 'true';
    process.env.SUPABASE_URL = 'https://proj.supabase.example';
    verifyAndExtractIdentity.mockResolvedValue({
      identity: { user_id: 'u-1', email: 'd@exafy.example', tenant_id: 't-1' },
      claims: { client_id: 'claude-ai' },
    });
    spies = {
      setMissingPartnerType: jest.spyOn(service, 'setMissingPartnerType').mockResolvedValue({ status: 200, body: { ok: true, organization: typedOrg, checklist } }),
      updateCompany: jest.spyOn(service, 'updateCompany').mockResolvedValue({ status: 200, body: { ok: true, organization: typedOrg, checklist } }),
      getOnboardingStatus: jest.spyOn(service, 'getOnboardingStatus').mockResolvedValue({ status: 200, body: { ok: true, organization: DRAFT, checklist: null } }),
      startOnboarding: jest.spyOn(service, 'startOnboarding'),
    };
  });
  // Restore only the spies: the module-level jest.fn mocks keep their implementations.
  afterEach(() => Object.values(spies).forEach((spy) => spy.mockRestore()));
  afterAll(() => {
    process.env = prevEnv;
  });

  test('business_type alone sets the type and returns the populated status — no new business', async () => {
    const res = await call({ organization_id: 'org-1', business_type: 'service_provider' });
    expect(res.body.result.isError).toBe(false);
    expect(spies.setMissingPartnerType).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: 'u-1' }), 'org-1', 'service_provider', { source: 'commerce-mcp' });
    expect(spies.updateCompany).not.toHaveBeenCalled();
    expect(spies.startOnboarding).not.toHaveBeenCalled();
    expect(res.body.result.structuredContent).toMatchObject({ business_type: 'service_provider', next_step: 'company' });
  });

  test('business_type with facts: type first, then the facts', async () => {
    await call({ organization_id: 'org-1', business_type: 'service_provider', legal_name: 'Exafy LTD' });
    expect(spies.setMissingPartnerType).toHaveBeenCalled();
    expect(spies.updateCompany).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'org-1', { legal_name: 'Exafy LTD' }, { source: 'commerce-mcp' });
    expect(spies.setMissingPartnerType.mock.invocationCallOrder[0]).toBeLessThan(spies.updateCompany.mock.invocationCallOrder[0]);
    expect(spies.startOnboarding).not.toHaveBeenCalled();
  });

  test('an invalid fact refuses the whole call before anything is written', async () => {
    const res = await call({ organization_id: 'org-1', business_type: 'service_provider', country: 'United Arab Emirates' });
    expect(res.body.result.structuredContent.error.code).toBe('invalid_input');
    expect(spies.setMissingPartnerType).not.toHaveBeenCalled();
    expect(spies.updateCompany).not.toHaveBeenCalled();
  });

  test('facts that void a passed verification need confirmation before the type is written', async () => {
    spies.getOnboardingStatus.mockResolvedValue({
      status: 200,
      body: { ok: true, organization: typedOrg, checklist: { ...checklist, steps: [{ key: 'verification', required: true, status: 'done' }] } },
    });
    const res = await call({ organization_id: 'org-1', business_type: 'service_provider', website: 'https://new.example' });
    expect(res.body.result.structuredContent.error.code).toBe('confirmation_required');
    expect(spies.setMissingPartnerType).not.toHaveBeenCalled();
    expect(spies.updateCompany).not.toHaveBeenCalled();
  });

  test('a refused type stops the facts too', async () => {
    spies.setMissingPartnerType.mockResolvedValue({ status: 409, body: { ok: false, error: 'PARTNER_TYPE_ALREADY_SET', partner_type: 'lab' } });
    const res = await call({ organization_id: 'org-1', business_type: 'service_provider', legal_name: 'Exafy LTD' });
    expect(res.body.result.structuredContent.error).toMatchObject({ code: 'conflict', message: 'PARTNER_TYPE_ALREADY_SET' });
    expect(spies.updateCompany).not.toHaveBeenCalled();
  });

  test('without business_type the existing path is unchanged', async () => {
    await call({ organization_id: 'org-1', legal_name: 'Exafy LTD' });
    expect(spies.setMissingPartnerType).not.toHaveBeenCalled();
    expect(spies.updateCompany).toHaveBeenCalled();
  });
});
