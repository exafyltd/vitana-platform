/**
 * VTID-05150 — tenant provisioning routes on routes/admin-tenants.ts:
 *   POST  /                  provision_tenant RPC
 *   PATCH /:id               brand pack / open_signup (provisioned tenants only)
 *   PUT   /:id/assets/:kind  logo | favicon | og_image (png/jpeg/webp, ≤1 MB)
 *   GET   /:id/readiness     readiness checks
 * All exafy_admin only. DB through a mocked service-role client, storage
 * through a mocked fetch, OASIS through a mocked emitter.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type Resp = { data?: any; error?: any; count?: number };

const createChain = (table: string) => {
  const queue: Resp[] = [];
  let fallback: Resp = { data: null, error: null };
  const chain: any = { table };
  for (const m of ['select', 'order', 'eq', 'in', 'ilike', 'single', 'maybeSingle', 'update', 'not', 'contains', 'limit']) {
    chain[m] = jest.fn(() => chain);
  }
  chain.then = (resolve: (v: any) => any) => Promise.resolve(queue.length ? queue.shift() : fallback).then(resolve);
  chain.mockResolvedValue = (v: Resp) => { fallback = v; return chain; };
  chain.mockResolvedValueOnce = (v: Resp) => { queue.push(v); return chain; };
  chain.reset = () => { queue.length = 0; fallback = { data: null, error: null }; };
  return chain;
};

const tableChains: Record<string, any> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain(table));
const mockRpc = jest.fn();
const mockSupabase = { from: jest.fn((t: string) => chainFor(t)), rpc: mockRpc };
const mockGetSupabase = jest.fn(() => mockSupabase as any);
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockGetSupabase() }));

const mockGetUser = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn(() => ({ auth: { getUser: mockGetUser } })),
}));

const mockEmit = jest.fn(async (_e: any) => ({ ok: true }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: (e: any) => mockEmit(e) }));

import router from '../src/routes/admin-tenants';

const app = express();
app.use(express.json());
app.use('/', router);
// Stand-in for the per-tenant sub-routers index.ts mounts AFTER adminTenantsRouter.
app.use('/:tenantId/invitations', (_req, res) => res.status(299).json({ reached: 'sub-router' }));

const fetchMock = global.fetch as unknown as jest.Mock;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const EXAFY = 'aaaaaaaa-0000-4000-8000-000000000001';
const NEW_T = 'cccccccc-0000-4000-8000-000000000001';
const MAXINA = '2e7528b8-472a-4356-88da-0280d4639cce';
const ALKALMA = '73cc592f-84ec-457a-b0f7-25a082d7e011';
const TOKEN = 'f'.repeat(64);

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 1, 2, 3, 4]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0]);
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00\x00', 'latin1');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');

function asExafy() {
  mockGetUser.mockResolvedValue({ data: { user: { id: EXAFY, email: 'ops@exafy.io', app_metadata: { exafy_admin: true } } }, error: null });
}
function asPlainAdmin() {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'u2', email: 'a@x.io', app_metadata: { exafy_admin: false } } }, error: null });
}
function asInvalid() {
  mockGetUser.mockResolvedValue({ data: { user: null }, error: { message: 'bad jwt' } });
}

const BASELINE = ['chat_mention', 'post_like', 'reminder_due'];
const controls = (tenantId: string, types: string[]) => types.map((type) => ({ tenant_id: tenantId, type, source_key: '' }));

const provisionedSettings = (over: Record<string, unknown> = {}) => ({
  tenant_id: NEW_T,
  profile: {},
  branding: {},
  feature_flags: { jev: { enabled: true, planes: ['internal', 'system_autopilot', 'member'], monthly_budget_usd: 10 } },
  domains: {},
  display_name: 'Well Circle',
  brand: {
    colors: { accent: '#112233', bg: '#FFFFFF', fg: '#000000' },
    logo_path: 'wellcircle/logo.png',
    favicon_path: 'wellcircle/favicon.png',
  },
  legal_entity_line: 'Exafy LTD',
  support_email: 'help@wellcircle.io',
  sender_name: 'Well Circle',
  sender_email: 'noreply@wellcircle.io',
  default_locale: 'de',
  enabled_locales: ['de', 'en'],
  timezone: 'Europe/Berlin',
  currency: 'EUR',
  landing: { cta: 'invite_only' },
  persona_facts: { community_name: 'Well Circle' },
  provisioned_at: '2026-10-14T10:00:00Z',
  provisioned_by: EXAFY,
  ...over,
});

const NEW_TENANT = { tenant_id: NEW_T, name: 'Well Circle', slug: 'wellcircle', is_active: true, open_signup: false, is_default: false, is_platform: false };
const ALL_TENANTS = [
  { tenant_id: MAXINA, slug: 'maxina', is_active: true, is_default: true, is_platform: false },
  { tenant_id: ALKALMA, slug: 'alkalma', is_active: true, is_default: false, is_platform: false },
  NEW_TENANT,
];

/** Wire every table a readiness run reads to an all-green provisioned tenant. */
function wireReadiness(opts: {
  settings?: any;
  tenant?: any;
  storage?: string[] | null;
  newControls?: string[];
  newPolicies?: string[];
  autopilot?: number;
  bot?: boolean;
  acceptedAdmin?: boolean;
  adminMember?: boolean;
} = {}) {
  const tenant = opts.tenant ?? NEW_TENANT;
  chainFor('tenants').mockResolvedValue({ data: ALL_TENANTS, error: null });
  chainFor('tenants').mockResolvedValueOnce({ data: tenant, error: null }); // resolveTenant by id
  chainFor('tenant_settings').mockResolvedValue({ data: opts.settings === undefined ? provisionedSettings() : opts.settings, error: null });
  chainFor('notification_type_controls').mockResolvedValue({
    data: [
      ...controls(MAXINA, [...BASELINE, 'live_room_invite']),
      ...controls(ALKALMA, BASELINE),
      ...controls(tenant.tenant_id, opts.newControls ?? BASELINE),
    ],
    error: null,
  });
  const policies = (opts.newPolicies ?? ['chatgpt', 'claude']).map((p) => ({ tenant_id: tenant.tenant_id, provider: p }));
  chainFor('ai_provider_policies').mockResolvedValue({
    data: [{ tenant_id: MAXINA, provider: 'chatgpt' }, { tenant_id: MAXINA, provider: 'claude' }, ...policies],
    error: null,
  });
  chainFor('tenant_autopilot_settings').mockResolvedValue({ data: null, error: null, count: opts.autopilot ?? 1 });
  chainFor('chat_groups').mockResolvedValue({ data: [{ id: 'g1' }], error: null });
  chainFor('chat_group_members').mockResolvedValue({ data: opts.bot === false ? [] : [{ group_id: 'g1' }], error: null });
  chainFor('tenant_invitations').mockResolvedValue({ data: opts.acceptedAdmin === false ? [] : [{ id: 'inv1' }], error: null });
  chainFor('user_tenants').mockResolvedValue({ data: opts.adminMember ? [{ user_id: 'x' }] : [], error: null });
  const objects = opts.storage === undefined ? ['logo.png', 'favicon.png'] : opts.storage;
  fetchMock.mockImplementation(async (url: string) => {
    if (String(url).includes('/storage/v1/object/list/tenant-assets')) {
      return objects === null
        ? { ok: false, status: 500, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => objects.map((name) => ({ name })) };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const c of Object.values(tableChains)) c.reset();
  mockGetSupabase.mockReturnValue(mockSupabase as any);
  fetchMock.mockReset();
  asInvalid();
  delete process.env.FRONTEND_URL;
});

const validBody = {
  slug: 'wellcircle',
  name: 'Well Circle',
  admin_email: 'admin@wellcircle.io',
  all_members_group_name: 'Alle zusammen',
};

const rpcOk = (created: boolean, reused = false) => ({
  data: {
    tenant_id: NEW_T,
    slug: 'wellcircle',
    created,
    invitation: { id: 'inv-1', token: TOKEN, expires_at: '2026-10-21T00:00:00Z', reused },
    ensured: { notification_controls: 16, ai_policies: 2, autopilot_settings: 1, system_group: 1 },
  },
  error: null,
});

// ---------------------------------------------------------------------------
// Auth on every new route
// ---------------------------------------------------------------------------

describe('VTID-05150 auth gate on the four new routes', () => {
  const calls: Array<[string, (r: request.SuperTest<request.Test>) => request.Test]> = [
    ['POST /', (r) => r.post('/').send(validBody)],
    ['PATCH /:id', (r) => r.patch(`/${NEW_T}`).send({ display_name: 'X' })],
    ['PUT /:id/assets/logo', (r) => r.put(`/${NEW_T}/assets/logo`).set('Content-Type', 'image/png').send(PNG)],
    ['GET /:id/readiness', (r) => r.get(`/${NEW_T}/readiness`)],
  ];

  it.each(calls)('%s without a token → 401 UNAUTHENTICATED, no DB call', async (_n, call) => {
    const res = await call(request(app) as any);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'UNAUTHENTICATED' });
    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(calls)('%s with an invalid token → 401 INVALID_TOKEN', async (_n, call) => {
    const res = await call(request(app) as any).set('Authorization', 'Bearer bad');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('INVALID_TOKEN');
  });

  it.each(calls)('%s as a non-exafy admin → 403 FORBIDDEN, no DB call', async (_n, call) => {
    asPlainAdmin();
    const res = await call(request(app) as any).set('Authorization', 'Bearer t');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /
// ---------------------------------------------------------------------------

describe('POST / — provision', () => {
  beforeEach(() => asExafy());
  const post = (body: unknown) => request(app).post('/').set('Authorization', 'Bearer t').send(body as object);

  it.each([
    ['bad slug', { ...validBody, slug: 'Well_Circle' }],
    ['double hyphen', { ...validBody, slug: 'x--y' }],
    ['too short', { ...validBody, slug: 'ab' }],
    ['bad email', { ...validBody, admin_email: 'nope' }],
    ['bad currency', { ...validBody, currency: 'eur' }],
    ['unknown key', { ...validBody, is_default: true }],
    ['budget over 500', { ...validBody, jev_monthly_budget_usd: 501 }],
    ['missing group name', { ...validBody, all_members_group_name: undefined }],
  ])('%s → 400 VALIDATION_FAILED, no RPC', async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION_FAILED');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it.each(['maxina', 'alkalma', 'admin', 'earthlinks', 'settings', 'api'])('reserved slug %s → 400 RESERVED_SLUG before any RPC', async (slug) => {
    const res = await post({ ...validBody, slug });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('RESERVED_SLUG');
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('201 on create: passes the caller as p_invited_by, returns the accept path, OASIS without token/email', async () => {
    mockRpc.mockResolvedValue(rpcOk(true));
    const res = await post({ ...validBody, jev_monthly_budget_usd: 25, timezone: 'Europe/Vienna' });
    expect(res.status).toBe(201);
    expect(mockRpc).toHaveBeenCalledWith('provision_tenant', expect.objectContaining({
      p_slug: 'wellcircle',
      p_name: 'Well Circle',
      p_admin_email: 'admin@wellcircle.io',
      p_invited_by: EXAFY,
      p_all_members_group_name: 'Alle zusammen',
      p_jev_monthly_budget_usd: 25,
      p_timezone: 'Europe/Vienna',
      p_currency: 'EUR',
      p_enabled_locales: null,
    }));
    expect(res.body).toMatchObject({
      ok: true,
      tenant_id: NEW_T,
      created: true,
      invitation: { id: 'inv-1', reused: false, accept_path: `/admin/invitations/accept/${TOKEN}` },
      ensured: { notification_controls: 16 },
    });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    const ev = mockEmit.mock.calls[0][0];
    expect(ev).toMatchObject({ vtid: 'VTID-05150', type: 'tenant.provisioned', source: 'gateway/admin-tenants', actor_id: EXAFY });
    expect(ev.payload).toMatchObject({ tenant_id: NEW_T, slug: 'wellcircle', created: true, invitation_id: 'inv-1' });
    const serialized = JSON.stringify(ev);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain('admin@wellcircle.io');
  });

  it('200 on an idempotent re-run (created:false, invitation reused)', async () => {
    mockRpc.mockResolvedValue(rpcOk(false, true));
    const res = await post(validBody);
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.invitation.reused).toBe(true);
  });

  it.each([
    ['SLUG_TAKEN', 409],
    ['NO_DEFAULT_TENANT', 409],
    ['NO_NOTIFICATION_BASELINE', 409],
    ['RESERVED_SLUG', 400],
    ['INVALID_SLUG', 400],
    ['INVALID_ADMIN_EMAIL', 400],
    ['SERVICE_ACCOUNT_EMAIL', 400],
    ['NOT_EXAFY_ADMIN', 403],
    ['INVALID_TIMEZONE: Mars/Olympus', 400],
    ['INVALID_LOCALE: xx is not in supported_locales', 400],
  ])('RPC error %s → %i with the code word', async (message, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '22023', message } });
    const res = await post(validBody);
    expect(res.status).toBe(status);
    expect(res.body.error).toBe(message.split(/[:\s]/)[0]);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('a CHECK violation → 400 INVALID_PARAMS', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: '23514', message: 'new row violates check constraint' } });
    const res = await post(validBody);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PARAMS');
  });

  it('function not migrated yet → 503 PROVISIONING_UNAVAILABLE (fails closed)', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.provision_tenant' } });
    const res = await post(validBody);
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('PROVISIONING_UNAVAILABLE');
  });

  it('an unknown DB error → 500 without leaking the message', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'secret internals' } });
    const res = await post(validBody);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// PATCH /:id
// ---------------------------------------------------------------------------

describe('PATCH /:id — brand pack', () => {
  beforeEach(() => asExafy());
  const patch = (body: unknown, id = NEW_T) => request(app).patch(`/${id}`).set('Authorization', 'Bearer t').send(body as object);

  it.each([
    ['slug is not patchable', { slug: 'other' }],
    ['name is not patchable', { name: 'Other' }],
    ['is_active is not patchable', { is_active: false }],
    ['unknown persona key', { persona_facts: { greeting: 'Hi there' } }],
    ['201-char fact', { persona_facts: { story_facts: ['x'.repeat(201)] } }],
    ['9 facts', { persona_facts: { tone: Array(9).fill('warm') } }],
    ['bad support email', { support_email: 'nope' }],
    ['bad currency', { currency: 'Euro' }],
    ['bad color', { brand: { colors: { accent: 'red', bg: '#FFFFFF', fg: '#000000' } } }],
    ['asset path via PATCH', { brand: { logo_path: 'wellcircle/logo.png' } }],
    ['empty body', {}],
    ['short override reason', { open_signup: true, override_reason: 'because' }],
  ])('%s → 400, no write', async (_n, body) => {
    const res = await patch(body);
    expect(res.status).toBe(400);
    expect(chainFor('tenant_settings').update).not.toHaveBeenCalled();
    expect(chainFor('tenants').update).not.toHaveBeenCalled();
  });

  it('legacy tenant (provisioned_at NULL) → 409 LEGACY_TENANT_READ_ONLY and no update call', async () => {
    chainFor('tenants').mockResolvedValueOnce({ data: { tenant_id: MAXINA, slug: 'maxina' }, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: { ...provisionedSettings({ tenant_id: MAXINA }), provisioned_at: null }, error: null });
    const res = await patch({ display_name: 'Changed' }, MAXINA);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('LEGACY_TENANT_READ_ONLY');
    expect(chainFor('tenant_settings').update).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('migration not applied (no provisioned_at column) → 503 PROVISIONING_UNAVAILABLE', async () => {
    chainFor('tenants').mockResolvedValueOnce({ data: NEW_TENANT, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: { tenant_id: NEW_T, profile: {} }, error: null });
    const res = await patch({ display_name: 'X' });
    expect(res.status).toBe(503);
  });

  it('writes only the named columns, keeps asset paths in brand, emits field names only', async () => {
    chainFor('tenants').mockResolvedValueOnce({ data: NEW_TENANT, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: provisionedSettings(), error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: provisionedSettings({ legal_entity_line: 'Well Circle GmbH' }), error: null });
    const res = await patch({
      legal_entity_line: 'Well Circle GmbH',
      brand: { colors: { accent: '#ABCDEF', bg: '#FFFFFF', fg: '#000000' } },
      persona_facts: { community_name: 'Well Circle', tone: ['warm', 'calm'] },
    });
    expect(res.status).toBe(200);
    const upd = chainFor('tenant_settings').update as jest.Mock;
    expect(upd).toHaveBeenCalledTimes(1);
    const payload = upd.mock.calls[0][0];
    expect(Object.keys(payload).sort()).toEqual(['brand', 'legal_entity_line', 'persona_facts', 'updated_at', 'updated_by']);
    expect(payload.brand).toEqual({
      colors: { accent: '#ABCDEF', bg: '#FFFFFF', fg: '#000000' },
      logo_path: 'wellcircle/logo.png',
      favicon_path: 'wellcircle/favicon.png',
    });
    expect(payload.updated_by).toBe(EXAFY);
    expect(chainFor('tenants').update).not.toHaveBeenCalled();
    const ev = mockEmit.mock.calls[0][0];
    expect(ev.type).toBe('tenant.brand_pack.updated');
    expect(ev.payload.fields).toEqual(['brand', 'legal_entity_line', 'persona_facts']);
    expect(JSON.stringify(ev.payload)).not.toContain('Well Circle GmbH');
  });

  it('a trigger refusal (bad timezone) → 400 INVALID_TIMEZONE', async () => {
    chainFor('tenants').mockResolvedValueOnce({ data: NEW_TENANT, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: provisionedSettings(), error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: null, error: { code: '22023', message: 'INVALID_TIMEZONE: Mars/Olympus' } });
    const res = await patch({ timezone: 'Mars/Olympus' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_TIMEZONE');
  });

  it('open_signup:true when readiness is not green → 409 TENANT_NOT_READY naming the failing checks, nothing written', async () => {
    wireReadiness({ settings: provisionedSettings({ support_email: null }) });
    const res = await patch({ open_signup: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('TENANT_NOT_READY');
    expect(res.body.failing).toContain('support_email');
    expect(chainFor('tenants').update).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('open_signup:true with an override_reason is allowed and the reason is recorded in OASIS', async () => {
    wireReadiness({ settings: provisionedSettings({ support_email: null }) });
    const reason = 'Owner approved opening before support mailbox exists';
    const res = await patch({ open_signup: true, override_reason: reason });
    expect(res.status).toBe(200);
    expect(chainFor('tenants').update).toHaveBeenCalledWith(expect.objectContaining({ open_signup: true }));
    const ev = mockEmit.mock.calls[0][0];
    expect(ev.payload).toMatchObject({ open_signup: true, readiness_ready: false, override_reason: reason, fields: ['open_signup'] });
  });

  it('open_signup:true when readiness is all green → 200', async () => {
    process.env.FRONTEND_URL = 'https://staging.example.test';
    wireReadiness();
    const res = await patch({ open_signup: true });
    expect(res.status).toBe(200);
    expect(mockEmit.mock.calls[0][0].payload).toMatchObject({ readiness_ready: true });
    expect(mockEmit.mock.calls[0][0].payload.override_reason).toBeUndefined();
  });

  it('open_signup:false is always allowed (no readiness run)', async () => {
    chainFor('tenants').mockResolvedValueOnce({ data: NEW_TENANT, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: provisionedSettings(), error: null });
    chainFor('tenants').mockResolvedValueOnce({ data: { tenant_id: NEW_T, open_signup: false }, error: null });
    const res = await patch({ open_signup: false });
    expect(res.status).toBe(200);
    expect(chainFor('notification_type_controls').select).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PUT /:id/assets/:kind
// ---------------------------------------------------------------------------

describe('PUT /:id/assets/:kind', () => {
  beforeEach(() => asExafy());
  const put = (kind: string, type: string, body: Buffer) =>
    request(app).put(`/${NEW_T}/assets/${kind}`).set('Authorization', 'Bearer t').set('Content-Type', type).send(body);

  function wireTenant(settings: any = provisionedSettings()) {
    chainFor('tenants').mockResolvedValueOnce({ data: NEW_TENANT, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: settings, error: null });
    chainFor('tenant_settings').mockResolvedValueOnce({ data: settings, error: null });
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}), text: async () => '' });
  }

  it.each([
    ['SVG', 'image/svg+xml', SVG],
    ['GIF bytes declared as gif', 'image/gif', GIF],
    ['GIF bytes declared as png', 'image/png', GIF],
    ['JPEG bytes declared as png (mislabelled)', 'image/png', JPEG],
    ['text', 'text/plain', Buffer.from('hello world, not an image')],
  ])('%s → 415, nothing stored', async (_n, type, body) => {
    wireTenant();
    const res = await put('logo', type, body);
    expect(res.status).toBe(415);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(chainFor('tenant_settings').update).not.toHaveBeenCalled();
  });

  it('over 1 MB → 413, nothing stored', async () => {
    wireTenant();
    const big = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
    const res = await put('logo', 'image/png', big);
    expect(res.status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unknown kind → 400', async () => {
    const res = await put('banner', 'image/png', PNG);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_ASSET_KIND');
  });

  it('legacy tenant → 409 LEGACY_TENANT_READ_ONLY, nothing stored', async () => {
    wireTenant({ ...provisionedSettings(), provisioned_at: null });
    const res = await put('logo', 'image/png', PNG);
    expect(res.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('png → stored at tenant-assets/<slug>/logo.png (upsert), brand.logo_path set, OASIS', async () => {
    wireTenant(provisionedSettings({ brand: { colors: { accent: '#112233', bg: '#FFFFFF', fg: '#000000' } } }));
    const res = await put('logo', 'image/png', PNG);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, path: 'wellcircle/logo.png', mime_type: 'image/png' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:54321/storage/v1/object/tenant-assets/wellcircle/logo.png');
    expect(init.method).toBe('POST');
    expect(init.headers['x-upsert']).toBe('true');
    expect(init.headers['Content-Type']).toBe('image/png');
    const payload = (chainFor('tenant_settings').update as jest.Mock).mock.calls[0][0];
    expect(payload.brand).toEqual({ colors: { accent: '#112233', bg: '#FFFFFF', fg: '#000000' }, logo_path: 'wellcircle/logo.png' });
    expect(mockEmit.mock.calls[0][0]).toMatchObject({ type: 'tenant.asset.uploaded', payload: { kind: 'logo', mime_type: 'image/png' } });
  });

  it('jpeg favicon → favicon.jpg', async () => {
    wireTenant();
    const res = await put('favicon', 'image/jpeg', JPEG);
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('wellcircle/favicon.jpg');
  });

  it('storage failure → 503 and brand not updated', async () => {
    wireTenant();
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const res = await put('logo', 'image/png', PNG);
    expect(res.status).toBe(503);
    expect(chainFor('tenant_settings').update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// GET /:id/readiness
// ---------------------------------------------------------------------------

describe('GET /:id/readiness', () => {
  beforeEach(() => {
    asExafy();
    process.env.FRONTEND_URL = 'https://staging.example.test';
  });
  const get = (id = NEW_T) => request(app).get(`/${id}/readiness`).set('Authorization', 'Bearer t');
  const failing = (body: any) => body.checks.filter((c: any) => !c.ok && !c.informational).map((c: any) => c.key);

  it('all green for a complete provisioned tenant; no email in the body', async () => {
    wireReadiness();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(failing(res.body)).toEqual([]);
    expect(res.body.checks.find((c: any) => c.key === 'path_url').detail).toBe('https://staging.example.test/wellcircle');
    expect(res.body.checks.map((c: any) => c.key)).toEqual([
      'slug_valid_not_reserved', 'path_url', 'brand_colors', 'assets_present', 'legal_entity_line', 'support_email',
      'sender', 'locales_timezone_currency', 'persona_facts.community_name', 'instance_data', 'first_admin', 'open_signup',
    ]);
    expect(JSON.stringify(res.body)).not.toMatch(/@/);
  });

  it('the primary domain wins over FRONTEND_URL', async () => {
    wireReadiness({ settings: provisionedSettings({ domains: { primary_domain: 'wellcircle.example' } }) });
    const res = await get();
    expect(res.body.checks.find((c: any) => c.key === 'path_url').detail).toBe('https://wellcircle.example/wellcircle');
  });

  it.each<[string, Parameters<typeof wireReadiness>[0], string]>([
    ['no host', { settings: provisionedSettings() }, 'path_url'],
    ['colors missing', { settings: provisionedSettings({ brand: { logo_path: 'wellcircle/logo.png', favicon_path: 'wellcircle/favicon.png' } }) }, 'brand_colors'],
    ['logo object missing in storage', { storage: ['favicon.png'] }, 'assets_present'],
    ['storage listing fails', { storage: null }, 'assets_present'],
    ['legal line missing', { settings: provisionedSettings({ legal_entity_line: null }) }, 'legal_entity_line'],
    ['support email missing', { settings: provisionedSettings({ support_email: '' }) }, 'support_email'],
    ['sender missing', { settings: provisionedSettings({ sender_email: null }) }, 'sender'],
    ['default locale not enabled', { settings: provisionedSettings({ default_locale: 'fr' }) }, 'locales_timezone_currency'],
    ['community name missing', { settings: provisionedSettings({ persona_facts: {} }) }, 'persona_facts.community_name'],
    ['a baseline control missing', { newControls: ['chat_mention', 'post_like'] }, 'instance_data'],
    ['an AI policy missing', { newPolicies: ['chatgpt'] }, 'instance_data'],
    ['no autopilot row', { autopilot: 0 }, 'instance_data'],
    ['no bot in the system group', { bot: false }, 'instance_data'],
    ['jev off', { settings: provisionedSettings({ feature_flags: {} }) }, 'instance_data'],
    ['no admin yet', { acceptedAdmin: false }, 'first_admin'],
  ])('%s → only its own check fails', async (name, opts, key) => {
    if (name === 'no host') delete process.env.FRONTEND_URL;
    wireReadiness(opts);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    expect(failing(res.body)).toEqual([key]);
  });

  it('first_admin is also satisfied by an admin membership', async () => {
    wireReadiness({ acceptedAdmin: false, adminMember: true });
    const res = await get();
    expect(failing(res.body)).toEqual([]);
  });

  it('a legacy tenant is readable (read-only), marked legacy, its reserved slug is not a failure', async () => {
    const maxina = { tenant_id: MAXINA, slug: 'maxina', is_active: true, open_signup: true, is_default: true };
    wireReadiness({ tenant: maxina, settings: { ...provisionedSettings({ tenant_id: MAXINA }), provisioned_at: null } });
    const res = await get(MAXINA);
    expect(res.status).toBe(200);
    expect(res.body.legacy).toBe(true);
    expect(res.body.checks.find((c: any) => c.key === 'slug_valid_not_reserved').ok).toBe(true);
    expect(chainFor('tenant_settings').update).not.toHaveBeenCalled();
  });

  it('before the migration → schema_missing, not ready', async () => {
    wireReadiness({ settings: { tenant_id: NEW_T, profile: {}, feature_flags: {} } });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.schema_missing).toBe(true);
    expect(res.body.ready).toBe(false);
  });

  it('unknown tenant → 404', async () => {
    chainFor('tenants').mockResolvedValue({ data: null, error: { message: 'no rows' } });
    const res = await get('nope');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Route pin: the /:id routes never capture the per-tenant sub-routers
// ---------------------------------------------------------------------------

describe('route shadowing pin', () => {
  it.each(['get', 'post', 'patch', 'put', 'delete'] as const)('%s /x/invitations reaches the sub-router, not admin-tenants', async (method) => {
    asExafy();
    const res = await (request(app) as any)[method]('/x/invitations').set('Authorization', 'Bearer t');
    expect(res.status).toBe(299);
    expect(res.body.reached).toBe('sub-router');
    expect(mockGetUser).not.toHaveBeenCalled();
  });

  it('PATCH /x/settings is not matched by PATCH /:id', async () => {
    const res = await request(app).patch('/x/settings').send({});
    expect(res.status).toBe(404);
    expect(mockGetUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Operator scripts (ESM, run in a child node process)
// ---------------------------------------------------------------------------

describe('VTID-05150 operator scripts', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const REPO = path.join(__dirname, '../../..');
  const esm = (code: string) =>
    JSON.parse(execFileSync('node', ['--input-type=module', '-e', code], { encoding: 'utf8', cwd: REPO }));

  it('setup-tenant-assets-bucket: creates when missing, keeps a matching public bucket, refuses a private/different one', () => {
    const r = esm(`
      import { planBucketSetup, BUCKET_CONFIG } from './scripts/supabase/setup-tenant-assets-bucket.mjs';
      const same = { public: true, file_size_limit: 1048576, allowed_mime_types: ['image/webp','image/png','image/jpeg'] };
      console.log(JSON.stringify({
        cfg: BUCKET_CONFIG,
        missing: planBucketSetup(404, null).action,
        same: planBucketSetup(200, same).action,
        priv: planBucketSetup(200, { ...same, public: false }).action,
        gif: planBucketSetup(200, { ...same, allowed_mime_types: [...same.allowed_mime_types, 'image/gif'] }).action,
        err: planBucketSetup(500, null).action,
      }));`);
    expect(r.cfg).toEqual({ id: 'tenant-assets', name: 'tenant-assets', public: true, file_size_limit: 1048576, allowed_mime_types: ['image/png', 'image/jpeg', 'image/webp'] });
    expect(r).toMatchObject({ missing: 'create', same: 'none', priv: 'refuse', gif: 'refuse', err: 'error' });
  });

  it('provision-tenant CLI: requires --gateway and --pack (no default host), picks only png/jpeg/webp assets', () => {
    const r = esm(`
      import fs from 'fs'; import os from 'os'; import path from 'path';
      import { parseArgs, findAssets } from './scripts/tenants/provision-tenant.mjs';
      const err = (f) => { try { f(); return null; } catch (e) { return e.message; } };
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05150-assets-'));
      for (const n of ['logo.png', 'favicon.JPG', 'og_image.webp', 'notes.txt']) fs.writeFileSync(path.join(dir, n), '');
      const ok = findAssets(dir).map((a) => a.kind + ':' + a.type).sort();
      fs.writeFileSync(path.join(dir, 'logo.svg'), '');
      const svg = err(() => findAssets(dir));
      console.log(JSON.stringify({
        noGateway: err(() => parseArgs(['--pack', 'p.json'])),
        noPack: err(() => parseArgs(['--gateway', 'https://gw.example'])),
        parsed: parseArgs(['--gateway', 'https://gw.example', '--pack', 'p.json', '--readiness-only']),
        ok, svg,
      }));`);
    expect(r.noGateway).toMatch(/--gateway/);
    expect(r.noPack).toMatch(/--pack/);
    expect(r.parsed).toEqual({ gateway: 'https://gw.example', pack: 'p.json', readinessOnly: true });
    expect(r.ok).toEqual(['favicon:image/jpeg', 'logo:image/png', 'og_image:image/webp']);
    expect(r.svg).toMatch(/only png, jpg\/jpeg, webp/);
  });
});
