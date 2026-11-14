/**
 * VTID-05207 — POST /api/v1/community/new-member/:userId/greeting-suggestion
 * (routes/new-member-greeting.ts), plan Part B, task C1.
 *
 *   - authenticated member only, per-viewer rate limited;
 *   - returns { suggestion, language } composed in the SENDER's locale;
 *   - NEVER sends a DM (suggest only) — a composition failure answers 503.
 *
 * The composer itself is mocked here; its logic is covered by
 * vtid-05207-greeting-suggestion.test.ts.
 */
import request from 'supertest';
import express from 'express';

let mockSb: any;
jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn(() => mockSb) }));
jest.mock('../src/lib/supabase', () => ({ getSupabase: () => mockSb }));
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'viewer-1', tenant_id: 'tenant-1', vitana_id: 'viewer' };
    return next();
  },
  requireTenant: (_req: any, _res: any, next: any) => next(),
}));
const mockExcluded = jest.fn();
jest.mock('../src/lib/excluded-test-service-accounts', () => ({
  fetchExcludedTestServiceAccountIdsStrict: (...a: any[]) => mockExcluded(...a),
}));
const mockProfile = jest.fn();
jest.mock('../src/services/new-member-greeting-guard', () => {
  const actual = jest.requireActual('../src/services/new-member-greeting-guard');
  return { ...actual, fetchNewMemberProfile: (...a: any[]) => mockProfile(...a) };
});
jest.mock('../src/i18n/server-locale', () => ({ getUserLocale: jest.fn().mockResolvedValue('de') }));
jest.mock('../src/routes/new-member-greeting-repository', () => ({ resolveFirstName: jest.fn().mockResolvedValue('Anna') }));
jest.mock('../src/services/new-member-greeting-suggestion', () => {
  const actual = jest.requireActual('../src/services/new-member-greeting-suggestion');
  return { ...actual, composeGreetingSuggestion: jest.fn() };
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const greetingRouter = require('../src/routes/new-member-greeting').default;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { composeGreetingSuggestion: composeMock } = require('../src/services/new-member-greeting-suggestion');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getUserLocale } = require('../src/i18n/server-locale');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const repoMock = require('../src/routes/new-member-greeting-repository');

const NEWCOMER = '11111111-2222-3333-4444-555555555555';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/v1', greetingRouter);
  return app;
}

describe('POST /api/v1/community/new-member/:userId/greeting-suggestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSb = {};
    getUserLocale.mockResolvedValue('de');
    composeMock.mockResolvedValue({ ok: true, suggestion: 'Hey Anna! 👋', language: 'de' });
    mockExcluded.mockResolvedValue({ ok: true, ids: new Set<string>() });
    mockProfile.mockResolvedValue({ community_intro_opt_in: true, created_at: new Date(Date.now() - 2 * 24 * 3_600_000).toISOString() });
  });

  describe('privacy: only a greetable newcomer may be suggested for', () => {
    const REFUSED = { ok: false, error: 'greeting_not_allowed' };
    async function expectRefused() {
      const res = await request(makeApp()).post(`/api/v1/community/new-member/${NEWCOMER}/greeting-suggestion`).send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual(REFUSED);
      expect(composeMock).not.toHaveBeenCalled();
      expect(repoMock.resolveFirstName).not.toHaveBeenCalled();
    }
    it('refuses a target who has not opted in', async () => {
      mockProfile.mockResolvedValue({ community_intro_opt_in: false, created_at: new Date().toISOString() });
      await expectRefused();
    });
    it('refuses a target who joined more than 7 days ago', async () => {
      mockProfile.mockResolvedValue({ community_intro_opt_in: true, created_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString() });
      await expectRefused();
    });
    it('refuses a missing profile', async () => {
      mockProfile.mockResolvedValue(null);
      await expectRefused();
    });
    it('refuses a test/service account target', async () => {
      mockExcluded.mockResolvedValue({ ok: true, ids: new Set([NEWCOMER]) });
      await expectRefused();
    });
    it('refuses when the viewer is a test/service account', async () => {
      mockExcluded.mockResolvedValue({ ok: true, ids: new Set(['viewer-1']) });
      await expectRefused();
    });
    it('refuses when the exclusion lookup fails', async () => {
      mockExcluded.mockResolvedValue({ ok: false });
      await expectRefused();
    });
    it('refuses when the profile lookup throws', async () => {
      mockProfile.mockRejectedValue(new Error('boom'));
      await expectRefused();
    });
    it('still suggests for a greetable newcomer', async () => {
      const res = await request(makeApp()).post(`/api/v1/community/new-member/${NEWCOMER}/greeting-suggestion`).send({});
      expect(res.status).toBe(200);
      expect(repoMock.resolveFirstName).toHaveBeenCalled();
    });
  });

  it('returns { suggestion, language } composed in the sender locale, honouring the avoid list', async () => {
    const res = await request(makeApp())
      .post(`/api/v1/community/new-member/${NEWCOMER}/greeting-suggestion`)
      .send({ avoid: ['Hi Anna!'] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, suggestion: 'Hey Anna! 👋', language: 'de' });
    const input = composeMock.mock.calls[0][0];
    expect(input).toEqual(expect.objectContaining({ firstName: 'Anna', senderLocale: 'de', avoid: ['Hi Anna!'] }));
  });

  it('rejects an invalid user id without calling the composer', async () => {
    const res = await request(makeApp()).post('/api/v1/community/new-member/not-a-uuid/greeting-suggestion').send({});
    expect(res.status).toBe(400);
    expect(composeMock).not.toHaveBeenCalled();
  });

  it('rejects greeting yourself', async () => {
    const res = await request(makeApp()).post('/api/v1/community/new-member/viewer-1/greeting-suggestion').send({});
    expect(res.status).toBe(400);
  });

  it('answers 503 when composition fails, and never sends a DM', async () => {
    composeMock.mockResolvedValue({ ok: false, error: 'router_failed' });
    const res = await request(makeApp()).post(`/api/v1/community/new-member/${NEWCOMER}/greeting-suggestion`).send({});
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'suggestion_unavailable' });
  });
});
