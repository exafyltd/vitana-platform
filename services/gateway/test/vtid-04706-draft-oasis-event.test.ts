/**
 * VTID-04706: POST /:id/draft must emit an OASIS event after a successful
 * ensureRecommendationDraft() call.
 */

import request from 'supertest';
import express from 'express';

// --- mock emitOasisEvent BEFORE importing the router ---
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

// --- mock optionalAuth so identity is injected without a real JWT ---
jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  optionalAuth: (req: any, _res: any, next: any) => {
    req.identity = { user_id: 'user-abc-123', email: 'test@example.com', exafy_admin: false };
    next();
  },
  AuthenticatedRequest: {},
}));

// --- mock heavy service imports that the router pulls in at module level ---
jest.mock('../src/services/recommendation-engine', () => ({
  generateRecommendations: jest.fn(),
  generatePersonalRecommendations: jest.fn(),
  regenerateCommunityRecommendations: jest.fn(),
}));
jest.mock('../src/services/notification-service', () => ({
  notifyUserAsync: jest.fn(),
  notifyUsersAsync: jest.fn(),
}));
jest.mock('../src/services/wave-defaults', () => ({
  DEFAULT_WAVE_CONFIG: {},
  buildTemplateToWaveMap: jest.fn(() => ({})),
}));
jest.mock('../src/services/recommendation-engine/pillar-impact', () => ({
  derivePillarImpact: jest.fn(() => null),
}));
jest.mock('../src/services/recommendation-engine/alignment-evaluator', () => ({
  evaluateRecAlignment: jest.fn(() => ({
    topic: 'autopilot.alignment.served',
    status: 'info',
    message: 'ok',
    pillar_impact: null,
    economic_axis: null,
    autonomy_level: null,
  })),
}));
jest.mock('../src/i18n/catalog', () => ({
  tt: jest.fn((k: string) => k),
  GATEWAY_DEFAULT_LOCALE: 'en',
}));
jest.mock('../src/i18n/server-locale', () => ({
  getUserLocale: jest.fn(async () => 'en'),
}));
jest.mock('../src/services/autopilot-executable-source-types', () => ({
  isManuallyBridgeableSourceType: jest.fn(() => false),
}));
jest.mock('../src/services/calendar-producers', () => ({
  completeCalendarEntriesForSource: jest.fn(),
}));
jest.mock('../src/services/community-autopilot/lineup-role', () => ({
  resolveLineupRole: jest.fn(),
}));
jest.mock('../src/services/community-autopilot/action-registry', () => ({
  parseAction: jest.fn((a: any) => a),
  checkActionPolicy: jest.fn(),
  defaultActionForTemplate: jest.fn(),
  executeRecommendationAction: jest.fn(),
}));
jest.mock('../src/services/community-autopilot/lineup-cap', () => ({
  capOpenLineup: jest.fn(),
}));
jest.mock('../src/services/recommendation-quality/listing', () => ({
  applyDeveloperQualityListing: jest.fn((rows: any[]) => rows),
}));
jest.mock('../src/services/recommendation-quality/acceptance', () => ({
  buildDismissRecord: jest.fn(),
  DISMISS_REASON_CODES: [],
  isDismissReasonCode: jest.fn(() => false),
}));
jest.mock('../src/services/community-autopilot/ranker', () => ({
  MAX_OPEN_PER_ROLE: 5,
}));
jest.mock('../src/services/community-autopilot/drafts', () => ({
  DRAFTABLE_KINDS: new Set(['post_public', 'send_message']),
  currentDraft: jest.fn((action: any) => action?.draft_text ?? null),
  generateDraft: jest.fn(),
  sanitizeDraft: jest.fn((_kind: string, text: string) => text),
  withDraft: jest.fn((action: any, text: string) => ({ ...action, draft_text: text })),
}));
jest.mock('../src/routes/autopilot-recommendations-repository', () => ({
  fetchPrimaryTenantId: jest.fn(),
}));

// --- mock global fetch used by the handler to load the recommendation row ---
const REC_ID = 'rec-0000-1111-2222-3333';
const USER_ID = 'user-abc-123';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// Import router AFTER all mocks are in place
import autopilotRecommendationsRouter from '../src/routes/autopilot-recommendations';

const app = express();
app.use(express.json());
app.use('/api/v1/autopilot/recommendations', autopilotRecommendationsRouter);

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeRecRow(overrides: Record<string, any> = {}) {
  return {
    id: REC_ID,
    title: 'Test recommendation',
    summary: 'A test summary',
    source_type: 'community',
    user_id: USER_ID,
    status: 'new',
    action: { kind: 'post_public', draft_text: null },
    ...overrides,
  };
}

function mockFetchRec(row: any) {
  // First fetch call: load the recommendation row
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => [row],
  });
  // Second fetch call: the PATCH inside ensureRecommendationDraft
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
}

// ─── tests ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE = 'fake-service-role-key';
});

describe('POST /api/v1/autopilot/recommendations/:id/draft — OASIS event (VTID-04706)', () => {
  it('emits autopilot.recommendation.draft_updated with correct payload on success (generated)', async () => {
    const { generateDraft } = require('../src/services/community-autopilot/drafts');
    (generateDraft as jest.Mock).mockResolvedValueOnce({ ok: true, text: 'My generated draft' });

    mockFetchRec(makeRecRow());

    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/draft`)
      .send({ regenerate: true });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.recommendation_id).toBe(REC_ID);

    // The OASIS event must have been emitted exactly once
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);

    const [eventArg] = mockEmitOasisEvent.mock.calls[0];
    expect(eventArg.type).toBe('autopilot.recommendation.draft_updated');
    expect(eventArg.source).toBe('autopilot-recommendations');
    expect(eventArg.status).toBe('info');
    expect(eventArg.payload).toMatchObject({
      recommendation_id: REC_ID,
      user_id: USER_ID,
      kind: 'post_public',
      generated: true,
      channel: 'app',
    });
  });

  it('emits the event with generated=false when a user-supplied text is saved', async () => {
    mockFetchRec(makeRecRow());

    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/draft`)
      .send({ text: 'My own draft text' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    const [eventArg] = mockEmitOasisEvent.mock.calls[0];
    expect(eventArg.type).toBe('autopilot.recommendation.draft_updated');
    expect(eventArg.payload.generated).toBe(false);
    expect(eventArg.payload.user_id).toBe(USER_ID);
    expect(eventArg.payload.channel).toBe('app');
  });

  it('does NOT emit an OASIS event when the recommendation is not found (404)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] }); // empty rows → 404

    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/draft`)
      .send({ regenerate: true });

    expect(res.status).toBe(404);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('does NOT emit an OASIS event when the recommendation belongs to another user (403)', async () => {
    mockFetchRec(makeRecRow({ user_id: 'someone-else' }));

    const res = await request(app)
      .post(`/api/v1/autopilot/recommendations/${REC_ID}/draft`)
      .send({ regenerate: true });

    expect(res.status).toBe(403);
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });
});
