/**
 * VTID-04847 — the Commerce MCP endpoint: off by default, OAuth discovery,
 * token required, MCP protocol (initialize / tools/list / tools/call),
 * confirmation gates, permission errors, structured errors and the audit
 * event per call. The Commerce services are faked here; their own rules are
 * pinned by the partner-onboarding route suites.
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
// VTID-04968: the client allow-list is pinned in vtid-04968-delegation-guard.test.ts.
const checkMcpClient = jest.fn();
jest.mock('../src/services/mcp-client-allowlist', () => ({ checkMcpClient: (...a: unknown[]) => checkMcpClient(...a) }));
const emitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (...a: unknown[]) => emitOasisEvent(...a) }));

const svc = {
  listMyOrgs: jest.fn(),
  getOnboardingStatus: jest.fn(),
  startOnboarding: jest.fn(),
  updateCompany: jest.fn(),
  submitForVerification: jest.fn(),
  listCatalogue: jest.fn(),
  updateProduct: jest.fn(),
};
jest.mock('../src/services/partner-onboarding-service', () => {
  const actual = jest.requireActual('../src/services/partner-onboarding-service');
  return {
    ...actual,
    listMyOrgs: (...a: unknown[]) => svc.listMyOrgs(...a),
    getOnboardingStatus: (...a: unknown[]) => svc.getOnboardingStatus(...a),
    startOnboarding: (...a: unknown[]) => svc.startOnboarding(...a),
    updateCompany: (...a: unknown[]) => svc.updateCompany(...a),
    submitForVerification: (...a: unknown[]) => svc.submitForVerification(...a),
    listCatalogue: (...a: unknown[]) => svc.listCatalogue(...a),
    updateProduct: (...a: unknown[]) => svc.updateProduct(...a),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../src/routes/commerce-mcp');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/mcp', routes.default);
  a.use('/.well-known', routes.wellKnownRouter);
  return a;
}

const ORG = { id: 'org-1', display_name: 'Kräuterhaus', partner_type: 'supplier_shop', lifecycle_state: 'draft', country: 'DE', website: 'https://kraeuter.example' };
const CHECKLIST = {
  next_step: 'company',
  submit_ready: false,
  submit_missing: ['terms'],
  steps: [
    { key: 'company', required: true, status: 'in_progress', missing: ['vat_id'] },
    { key: 'terms', required: true, status: 'todo' },
    { key: 'verification', required: true, status: 'todo' },
  ],
};
const okStatus = (extra: Record<string, unknown> = {}) => ({ status: 200, body: { ok: true, organization: ORG, checklist: CHECKLIST, ...extra } });

const rpc = (method: string, params?: Record<string, unknown>, id: number | undefined = 1) =>
  ({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, ...(params ? { params } : {}) });
const call = (name: string, args: Record<string, unknown> = {}) => rpc('tools/call', { name, arguments: args });
const authed = (body: unknown) => request(app()).post('/mcp').set('Authorization', 'Bearer good').send(body as object);

const prevEnv = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  checkMcpClient.mockResolvedValue({ ok: true, clientId: 'claude-ai', clientName: 'Claude', delegated: true });
  routes.resetMcpLimits();
  process.env.COMMERCE_MCP_ENABLED = 'true';
  process.env.SUPABASE_URL = 'https://proj.supabase.example';
  delete process.env.COMMERCE_MCP_PUBLIC_URL;
  delete process.env.COMMERCE_PORTAL_URL;
  verifyAndExtractIdentity.mockImplementation(async (t: string) =>
    t === 'good'
      ? { identity: { user_id: 'u-1', email: 'ann@kraeuter.example', tenant_id: 't-1', exafy_admin: true }, claims: { client_id: 'claude-ai' } }
      : null,
  );
});
afterAll(() => {
  process.env = prevEnv;
});

describe('switch and discovery', () => {
  test('off by default: /mcp and the metadata answer 404', async () => {
    delete process.env.COMMERCE_MCP_ENABLED;
    expect((await authed(rpc('ping'))).status).toBe(404);
    expect((await request(app()).get('/.well-known/oauth-protected-resource')).status).toBe(404);
  });

  test('protected-resource metadata names this endpoint and Supabase Auth', async () => {
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const res = await request(app()).get(path).set('Host', 'gateway.vitanaland.com');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        resource: 'https://gateway.vitanaland.com/mcp',
        authorization_servers: ['https://proj.supabase.example/auth/v1'],
        scopes_supported: ['email', 'profile'],
        bearer_methods_supported: ['header'],
        resource_documentation: 'https://vitanaland.com/commerce',
      });
      // VTID-04882: never `openid` — it makes Supabase mint an ID token (HS256 cannot sign it).
      expect(res.body.scopes_supported).toEqual(['email', 'profile']);
      expect(res.body.scopes_supported).not.toContain('openid');
    }
  });

  test('staging links point at the staging app', () => {
    expect(routes.portalUrlFor('https://preview-aws-gateway.vitanaland.com')).toBe('https://preview-aws.vitanaland.com');
  });
});

describe('sign-in', () => {
  test('no token → 401 with the metadata link', async () => {
    const res = await request(app()).post('/mcp').set('Host', 'gateway.vitanaland.com').send(rpc('initialize'));
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://gateway.vitanaland.com/.well-known/oauth-protected-resource/mcp"',
    );
    // VTID-04882: the challenge names the scopes to request, without `openid`.
    expect(res.headers['www-authenticate']).toContain('scope="email profile"');
    expect(res.headers['www-authenticate']).not.toMatch(/openid/);
  });

  test('an invalid or expired token → 401', async () => {
    const res = await request(app()).post('/mcp').set('Authorization', 'Bearer stale').send(rpc('initialize'));
    expect(res.status).toBe(401);
  });

  test('the user is never an exafy_admin over MCP, whatever the token says', async () => {
    svc.listMyOrgs.mockResolvedValue({ status: 200, body: { ok: true, organizations: [] } });
    await authed(call('get_onboarding_status'));
    expect(svc.listMyOrgs.mock.calls[0][1]).toEqual({ userId: 'u-1', email: 'ann@kraeuter.example', tenantId: 't-1', exafyAdmin: false });
  });
});

describe('MCP protocol', () => {
  test('initialize negotiates the version and declares tools', async () => {
    const res = await authed(rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x', version: '1' } }));
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'vitanaland-commerce' },
    });
    expect(res.body.result.instructions).toContain('get_onboarding_status');
    const unknown = await authed(rpc('initialize', { protocolVersion: '1999-01-01' }));
    expect(unknown.body.result.protocolVersion).toBe('2025-06-18');
  });

  test('notifications get 202 and no body; ping answers', async () => {
    expect((await authed(rpc('notifications/initialized', undefined, undefined))).status).toBe(202);
    expect((await authed(rpc('ping'))).body).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  test('tools/list names the onboarding tools; accepting terms is not one', async () => {
    const res = await authed(rpc('tools/list'));
    const names = res.body.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual([
      'get_onboarding_status', 'create_business', 'update_business', 'add_product', 'list_products', 'update_product', 'check_verification', 'connect_store', 'submit_for_verification',
    ]);
    expect(names.join(' ')).not.toMatch(/terms/);
  });

  test('unknown method and unknown tool are JSON-RPC errors; GET is 405', async () => {
    expect((await authed(rpc('resources/list'))).body.error.code).toBe(-32601);
    expect((await authed(call('drop_table'))).body.error.code).toBe(-32602);
    expect((await request(app()).get('/mcp')).status).toBe(405);
  });

  test('a batch answers each request', async () => {
    const res = await authed([rpc('ping', undefined, 1), rpc('notifications/initialized', undefined, undefined), rpc('ping', undefined, 2)]);
    expect(res.body.map((r: { id: number }) => r.id)).toEqual([1, 2]);
  });
});

describe('tools', () => {
  test('create_business goes through the onboarding service as the signed-in user', async () => {
    svc.startOnboarding.mockResolvedValue({ status: 201, body: { ok: true, organization: ORG, checklist: CHECKLIST, created: true } });
    const res = await authed(call('create_business', { name: 'Kräuterhaus', business_type: 'supplier_shop' }));
    expect(svc.startOnboarding).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: 'u-1', email: 'ann@kraeuter.example' }),
      { display_name: 'Kräuterhaus', partner_type: 'supplier_shop' },
      { source: 'commerce-mcp' },
    );
    const out = res.body.result;
    expect(out.isError).toBe(false);
    expect(out.structuredContent).toMatchObject({ organization_id: 'org-1', state: 'draft', next_step: 'company', created: true });
    const terms = out.structuredContent.steps.find((s: { step: string }) => s.step === 'terms');
    expect(terms).toMatchObject({ done_on_vitanaland: true, link: expect.stringMatching(/\/commerce\?org=org-1$/) });
  });

  test('mapping without a connection points at a complete offering, never at connect_store (VTID-04953)', async () => {
    const withMapping = (mapping: Record<string, unknown>) => ({
      ...CHECKLIST,
      next_step: 'mapping',
      steps: [
        { key: 'company', required: true, status: 'done' },
        { key: 'mapping', required: true, ...mapping },
        { key: 'tracking_test', required: false, status: 'not_required' },
        { key: 'billing_mandate', required: false, status: 'not_required' },
      ],
    });
    svc.getOnboardingStatus.mockResolvedValueOnce(okStatus({
      checklist: withMapping({ status: 'todo', missing: ['complete_offering'], detail: { source: 'catalogue', complete_offerings: 0 } }),
    }));
    let out = (await authed(call('get_onboarding_status', { organization_id: 'org-1' }))).body.result.structuredContent;
    expect(out.next_action).toMatchObject({ step: 'mapping', tool: 'add_product' });
    expect(out.next_action.tool).not.toBe('connect_store');
    const mapping = out.steps.find((s: { step: string }) => s.step === 'mapping');
    expect(mapping.how).toMatch(/complete offering/);
    // Not-required steps are not "done on Vitanaland".
    for (const k of ['tracking_test', 'billing_mandate']) {
      const st = out.steps.find((s: { step: string }) => s.step === k);
      expect(st).toMatchObject({ status: 'not_required' });
      expect(st.done_on_vitanaland).toBeUndefined();
    }

    // With a store connection the connections path still applies.
    svc.getOnboardingStatus.mockResolvedValueOnce(okStatus({
      checklist: withMapping({ status: 'in_progress', detail: { source: 'connections' } }),
    }));
    out = (await authed(call('get_onboarding_status', { organization_id: 'org-1' }))).body.result.structuredContent;
    expect(out.next_action).toMatchObject({ step: 'mapping', tool: 'connect_store' });
    expect(out.steps.find((s: { step: string }) => s.step === 'mapping').how).toBeUndefined();
  });

  test('get_onboarding_status passes on the reviewer\'s request and an admin approval (VTID-04933)', async () => {
    const steps = (verification: Record<string, unknown>) => ({
      ...CHECKLIST,
      steps: [CHECKLIST.steps[0], CHECKLIST.steps[1], { key: 'verification', required: true, ...verification }],
    });
    svc.getOnboardingStatus.mockResolvedValueOnce(okStatus({
      checklist: steps({ status: 'todo', detail: { review_note: { reason: 'Please add a service description.', requested_by: 'admin-1' } } }),
    }));
    let res = await authed(call('get_onboarding_status', { organization_id: 'org-1' }));
    let v = res.body.result.structuredContent.steps.find((s: { step: string }) => s.step === 'verification');
    expect(v).toMatchObject({ status: 'todo', review_note: 'Please add a service description.' });
    expect(v.approved_by_vitanaland).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain('admin-1');

    svc.getOnboardingStatus.mockResolvedValueOnce(okStatus({
      checklist: steps({ status: 'done', detail: { method: 'admin_approval', level: 1, approved_by: 'admin-1' } }),
    }));
    res = await authed(call('get_onboarding_status', { organization_id: 'org-1' }));
    v = res.body.result.structuredContent.steps.find((s: { step: string }) => s.step === 'verification');
    expect(v).toMatchObject({ status: 'done', approved_by_vitanaland: true });
    expect(JSON.stringify(v)).not.toContain('admin-1');
  });

  test('submit_for_verification needs the supplier to confirm', async () => {
    const res = await authed(call('submit_for_verification', { organization_id: 'org-1' }));
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.structuredContent.error.code).toBe('confirmation_required');
    expect(svc.submitForVerification).not.toHaveBeenCalled();

    svc.submitForVerification.mockResolvedValue(okStatus({ transitions: [{ from: 'draft', to: 'submitted' }], open_steps: [] }));
    const ok = await authed(call('submit_for_verification', { organization_id: 'org-1', confirmed: true }));
    expect(ok.body.result.isError).toBe(false);
    expect(ok.body.result.structuredContent.transitions).toEqual([{ from: 'draft', to: 'submitted' }]);
  });

  test('a company change that voids a passed verification needs confirmation', async () => {
    svc.getOnboardingStatus.mockResolvedValue({
      status: 200,
      body: { ok: true, organization: ORG, checklist: { ...CHECKLIST, steps: [{ key: 'verification', required: true, status: 'done' }] } },
    });
    const res = await authed(call('update_business', { organization_id: 'org-1', website: 'https://new.example' }));
    expect(res.body.result.structuredContent.error.code).toBe('confirmation_required');
    expect(svc.updateCompany).not.toHaveBeenCalled();

    svc.updateCompany.mockResolvedValue(okStatus());
    await authed(call('update_business', { organization_id: 'org-1', website: 'https://new.example', confirmed: true }));
    expect(svc.updateCompany).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'org-1', { website: 'https://new.example' }, { source: 'commerce-mcp' });
  });

  test('a legal-name change before verification needs no confirmation', async () => {
    svc.getOnboardingStatus.mockResolvedValue(okStatus());
    svc.updateCompany.mockResolvedValue(okStatus());
    const res = await authed(call('update_business', { organization_id: 'org-1', legal_name: 'Kräuterhaus GmbH' }));
    expect(res.body.result.isError).toBe(false);
  });

  test('service refusals become structured errors', async () => {
    svc.getOnboardingStatus.mockResolvedValue({ status: 403, body: { ok: false, error: 'NOT_ORG_ADMIN', message: 'no' } });
    const res = await authed(call('get_onboarding_status', { organization_id: 'org-2' }));
    expect(res.body.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'forbidden', message: 'NOT_ORG_ADMIN' } } });

    svc.submitForVerification.mockResolvedValue({ status: 409, body: { ok: false, error: 'SUBMIT_PREREQUISITES_MISSING', missing: ['terms'], checklist: {} } });
    const r2 = await authed(call('submit_for_verification', { organization_id: 'org-1', confirmed: true }));
    expect(r2.body.result.structuredContent.error).toEqual({ code: 'prerequisites_missing', message: 'SUBMIT_PREREQUISITES_MISSING', details: { missing: ['terms'] } });
  });

  test('list_products returns plain prices and whether they are live', async () => {
    svc.listCatalogue.mockResolvedValue({
      status: 200,
      body: { ok: true, products: [{ id: 'p1', title: 'Tee', price_cents: 490, currency: 'EUR', images: [], affiliate_url: 'https://k.example/t', is_active: false, attributes: { kind: 'product' } }] },
    });
    const res = await authed(call('list_products', { organization_id: 'org-1' }));
    expect(res.body.result.structuredContent.products[0]).toMatchObject({ product_id: 'p1', price: 4.9, live: false, kind: 'product' });
  });

  test('update_product maps plain fields onto the product patch', async () => {
    svc.updateProduct.mockResolvedValue({ status: 200, body: { ok: true, product: { id: 'p1', price_cents: 990 } } });
    await authed(call('update_product', { organization_id: 'org-1', product_id: 'p1', price: 9.9, url: 'https://k.example/p' }));
    expect(svc.updateProduct).toHaveBeenCalledWith(expect.anything(), expect.anything(), 'org-1', 'p1', { price_cents: 990, affiliate_url: 'https://k.example/p' });
  });

  test('add_product needs the company country first', async () => {
    svc.getOnboardingStatus.mockResolvedValue({ status: 200, body: { ok: true, organization: { ...ORG, country: null }, checklist: CHECKLIST } });
    const res = await authed(call('add_product', { organization_id: 'org-1', title: 'Tee', price: 4.9 }));
    expect(res.body.result.structuredContent.error.code).toBe('prerequisites_missing');
  });
});

describe('audit and limits', () => {
  test('every tool call is audited with field names, never values', async () => {
    svc.getOnboardingStatus.mockResolvedValue(okStatus());
    svc.updateCompany.mockResolvedValue(okStatus());
    await authed(call('update_business', { organization_id: 'org-1', vat_id: 'DE123456789' }));
    const evt = emitOasisEvent.mock.calls.find((c) => c[0].type === 'commerce.mcp.tool_called')![0];
    expect(evt).toMatchObject({
      vtid: 'VTID-04847',
      actor_id: 'u-1',
      actor_role: 'agent',
      payload: { tool: 'update_business', organization_id: 'org-1', client_id: 'claude-ai', outcome: 'ok', fields: ['vat_id'] },
    });
    expect(JSON.stringify(evt)).not.toContain('DE123456789');
  });

  test('a per-user budget answers 429', async () => {
    for (let i = 0; i < 120; i++) expect(routes.allowMcpCall('u-9', 1000)).toBe(true);
    expect(routes.allowMcpCall('u-9', 1000)).toBe(false);
    expect(routes.allowMcpCall('u-9', 62_000)).toBe(true);
  });
});

describe('VTID-04968 client approval', () => {
  it('refuses a client that is not approved, audits it, and runs no tool', async () => {
    checkMcpClient.mockResolvedValue({ ok: false, reason: 'client_not_approved' });
    const res = await authed(call('get_onboarding_status'));
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('CLIENT_NOT_APPROVED');
    expect(svc.listMyOrgs).not.toHaveBeenCalled();
    expect(emitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'commerce.mcp.client_refused', payload: expect.objectContaining({ reason: 'client_not_approved' }) }));
  });
});
