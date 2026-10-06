/**
 * VTID-04838 — the AI setup routes: signed-in only, off unless
 * COMMERCE_AI_SETUP_ENABLED=true, status for the portal, and input checks
 * before anything is read or written.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (req.headers.authorization !== 'Bearer owner-1') return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = { user_id: 'owner-1', email: 'ann@acme.example', exafy_admin: false };
    return next();
  },
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => ({}) }));
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));
jest.mock('../src/services/oasis-event-service', () => ({ emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }) }));
jest.mock('../src/services/email/partner-invite-email', () => {
  const actual = jest.requireActual('../src/services/email/partner-invite-email');
  return { ...actual, sendPartnerInviteEmail: jest.fn().mockResolvedValue({ sent: false, status: 'disabled' }) };
});

const draftFromWebsite = jest.fn();
const applySetupDraft = jest.fn();
jest.mock('../src/services/commerce-ai-setup', () => {
  const actual = jest.requireActual('../src/services/commerce-ai-setup');
  return {
    ...actual,
    draftFromWebsite: (...a: unknown[]) => draftFromWebsite(...a),
    applySetupDraft: (...a: unknown[]) => applySetupDraft(...a),
  };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const routes = require('../src/routes/commerce-ai-setup');

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/v1/commerce/ai-setup', routes.default);
  return a;
}

const AUTH = { Authorization: 'Bearer owner-1' };
const APPLY = {
  setup_key: 'ai-setup:key-0001',
  website: 'https://kraeuter.example/',
  business: { display_name: 'Kräuterhaus', category: 'supplements_nutrition', country: 'de' },
  products: [{ title: 'Tee', price_cents: 490, currency: 'eur' }],
};

const saved = process.env.COMMERCE_AI_SETUP_ENABLED;
beforeEach(() => {
  jest.clearAllMocks();
  routes.resetDraftLimits();
  process.env.COMMERCE_AI_SETUP_ENABLED = 'true';
});
afterAll(() => {
  if (saved === undefined) delete process.env.COMMERCE_AI_SETUP_ENABLED;
  else process.env.COMMERCE_AI_SETUP_ENABLED = saved;
});

describe('access and switch', () => {
  it('every endpoint is signed-in only', async () => {
    expect((await request(app()).get('/api/v1/commerce/ai-setup/status')).status).toBe(401);
    expect((await request(app()).post('/api/v1/commerce/ai-setup/draft').send({ website: 'x.example' })).status).toBe(401);
    expect((await request(app()).post('/api/v1/commerce/ai-setup/apply').send(APPLY)).status).toBe(401);
  });

  it('status reports the switch; draft and apply are 404 AI_SETUP_DISABLED while it is off', async () => {
    process.env.COMMERCE_AI_SETUP_ENABLED = 'false';
    const s = await request(app()).get('/api/v1/commerce/ai-setup/status').set(AUTH);
    expect(s.body).toEqual({ ok: true, enabled: false });
    const d = await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'kraeuter.example' });
    expect(d.status).toBe(404);
    expect(d.body.error).toBe('AI_SETUP_DISABLED');
    const a = await request(app()).post('/api/v1/commerce/ai-setup/apply').set(AUTH).send(APPLY);
    expect(a.status).toBe(404);
    expect(draftFromWebsite).not.toHaveBeenCalled();
    expect(applySetupDraft).not.toHaveBeenCalled();

    process.env.COMMERCE_AI_SETUP_ENABLED = 'true';
    expect((await request(app()).get('/api/v1/commerce/ai-setup/status').set(AUTH)).body).toEqual({ ok: true, enabled: true });
  });
});

describe('draft', () => {
  it('refuses a bad URL before reading anything', async () => {
    const r = await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'not a site' });
    expect(r.status).toBe(400);
    expect(draftFromWebsite).not.toHaveBeenCalled();
  });

  it("returns the draft, in the member's language", async () => {
    draftFromWebsite.mockResolvedValue({ ok: true, draft: { website: 'https://kraeuter.example/' } });
    const r = await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'kraeuter.example' });
    expect(r.status).toBe(200);
    expect(r.body.draft.website).toBe('https://kraeuter.example/');
    expect(draftFromWebsite).toHaveBeenCalledWith('kraeuter.example', 'de');
  });

  it('maps unreachable sites and model outages to distinct statuses', async () => {
    draftFromWebsite.mockResolvedValueOnce({ ok: false, error: 'site_unreachable' });
    expect((await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'kraeuter.example' })).status).toBe(422);
    draftFromWebsite.mockResolvedValueOnce({ ok: false, error: 'llm_unavailable' });
    expect((await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'kraeuter.example' })).status).toBe(502);
  });

  it('is rate-limited per member', async () => {
    draftFromWebsite.mockResolvedValue({ ok: true, draft: {} });
    for (let i = 0; i < 10; i += 1) {
      await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'kraeuter.example' });
    }
    const r = await request(app()).post('/api/v1/commerce/ai-setup/draft').set(AUTH).send({ website: 'kraeuter.example' });
    expect(r.status).toBe(429);
  });
});

describe('apply', () => {
  it('validates the confirmed draft and normalizes codes before applying', async () => {
    applySetupDraft.mockResolvedValue({ ok: true, organization: { id: 'org-1', display_name: 'Kräuterhaus' }, created_org: true, products_added: 1, products_replayed: 0, product_errors: [] });
    const r = await request(app()).post('/api/v1/commerce/ai-setup/apply').set(AUTH).send(APPLY);
    expect(r.status).toBe(201);
    const [, caller, input] = applySetupDraft.mock.calls[0];
    expect(caller).toBe('owner-1');
    expect(input.business.country).toBe('DE');
    expect(input.products[0].currency).toBe('EUR');
  });

  it('refuses a product without a price, an unknown category, or a bad setup key — before writing', async () => {
    const noPrice = { ...APPLY, products: [{ title: 'Tee', currency: 'EUR' }] };
    expect((await request(app()).post('/api/v1/commerce/ai-setup/apply').set(AUTH).send(noPrice)).status).toBe(400);
    const badCategory = { ...APPLY, business: { ...APPLY.business, category: 'weapons' } };
    expect((await request(app()).post('/api/v1/commerce/ai-setup/apply').set(AUTH).send(badCategory)).status).toBe(400);
    const badKey = { ...APPLY, setup_key: 'x y' };
    const r = await request(app()).post('/api/v1/commerce/ai-setup/apply').set(AUTH).send(badKey);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_setup_key');
    expect(applySetupDraft).not.toHaveBeenCalled();
  });

  it('a replay answers 200, not 201', async () => {
    applySetupDraft.mockResolvedValue({ ok: true, organization: { id: 'org-1', display_name: 'K' }, created_org: false, products_added: 0, products_replayed: 1, product_errors: [] });
    expect((await request(app()).post('/api/v1/commerce/ai-setup/apply').set(AUTH).send(APPLY)).status).toBe(200);
  });
});
