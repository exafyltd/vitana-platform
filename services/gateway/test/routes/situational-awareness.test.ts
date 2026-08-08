/**
 * Tests for src/routes/situational-awareness.ts (D32)
 *
 * Mounted at /api/v1/situational:
 *   POST /compute   POST /quick   POST /score   POST /override
 *   GET  /debug     GET  /config  GET  /health  GET  /tags   POST /validate
 *
 * The router itself mounts no auth middleware (mountRouterSync only tracks
 * route ownership for governance, it does not attach auth) — every endpoint
 * here is reachable unauthenticated by design, so these tests focus on
 * request validation, response shaping, and error handling rather than auth.
 */
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockComputeSituationalAwareness = jest.fn();
const mockScoreActions = jest.fn();
const mockOverrideSituation = jest.fn();
const mockVerifyBundleIntegrity = jest.fn();

jest.mock('../../src/services/d32-situational-awareness-engine', () => ({
  computeSituationalAwareness: (...args: any[]) => mockComputeSituationalAwareness(...args),
  scoreActions: (...args: any[]) => mockScoreActions(...args),
  overrideSituation: (...args: any[]) => mockOverrideSituation(...args),
  verifyBundleIntegrity: (...args: any[]) => mockVerifyBundleIntegrity(...args),
  VTID: 'VTID-01126',
  ENGINE_VERSION: 'd32-v1.0.0',
  DEFAULT_SITUATIONAL_CONFIG: { confidence_threshold: 50 },
}));

const mockEmitOasisEvent = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

import router from '../../src/routes/situational-awareness';

const app = express();
app.use(express.json());
app.use('/api/v1/situational', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';

function makeBundle(overrides: Partial<any> = {}) {
  return {
    bundle_id: 'bundle-1',
    bundle_hash: 'hash-abc',
    computed_at: '2026-07-28T10:00:00.000Z',
    computation_duration_ms: 12,
    situation_vector: {
      overall_confidence: 82,
      time_context: { time_window: 'morning', is_late_night: false },
      availability_context: { availability_level: 'free' },
      readiness_context: { energy_level: 'high' },
      constraint_flags: [{ type: 'safety', active: false }],
    },
    action_envelope: {
      active_tags: ['now_ok', 'commerce_ok'],
      allowed_actions: ['a1', 'a2'],
      blocked_actions: [],
    },
    user_id: USER_ID,
    tenant_id: TENANT_ID,
    sources: {
      context_bundle_used: false,
      intent_bundle_used: false,
      signal_bundle_used: false,
      preference_bundle_used: false,
      calendar_used: false,
      location_used: false,
    },
    metadata: { engine_version: 'd32-v1.0.0' },
    ...overrides,
  };
}

describe('Situational Awareness Routes (D32)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEmitOasisEvent.mockResolvedValue(undefined);
  });

  // --- POST /compute ---

  describe('POST /api/v1/situational/compute', () => {
    it('computes a bundle and returns a summary on the happy path', async () => {
      const bundle = makeBundle();
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle });

      const res = await request(app)
        .post('/api/v1/situational/compute')
        .send({ user_id: USER_ID, tenant_id: TENANT_ID, current_message: 'hi' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.bundle).toEqual(bundle);
      expect(res.body.summary).toEqual({
        bundle_id: 'bundle-1',
        confidence: 82,
        time_window: 'morning',
        availability: 'free',
        energy: 'high',
        active_tags: ['now_ok', 'commerce_ok'],
        allowed_action_count: 2,
        blocked_action_count: 0,
      });
      expect(mockComputeSituationalAwareness).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: USER_ID, tenant_id: TENANT_ID }),
      );
    });

    it('returns 400 with a details string when user_id is not a UUID', async () => {
      const res = await request(app)
        .post('/api/v1/situational/compute')
        .send({ user_id: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.details).toContain('user_id');
      expect(mockComputeSituationalAwareness).not.toHaveBeenCalled();
    });

    it('defaults user_id/tenant_id when omitted', async () => {
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle: makeBundle() });

      await request(app).post('/api/v1/situational/compute').send({});

      expect(mockComputeSituationalAwareness).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: '00000000-0000-0000-0000-000000000099',
          tenant_id: '00000000-0000-0000-0000-000000000001',
        }),
      );
    });

    it('returns 500 when the engine reports failure', async () => {
      mockComputeSituationalAwareness.mockResolvedValue({ ok: false, error: 'engine exploded' });

      const res = await request(app).post('/api/v1/situational/compute').send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('engine exploded');
    });

    it('returns 500 and emits an OASIS error event when the engine throws', async () => {
      mockComputeSituationalAwareness.mockRejectedValue(new Error('boom'));

      const res = await request(app).post('/api/v1/situational/compute').send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Situational awareness computation failed');
      expect(res.body.message).toBe('boom');
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'error', vtid: 'VTID-01126' }),
      );
    });
  });

  // --- POST /quick ---

  describe('POST /api/v1/situational/quick', () => {
    it('returns a minimal situation summary on the happy path', async () => {
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle: makeBundle() });

      const res = await request(app)
        .post('/api/v1/situational/quick')
        .send({ user_id: USER_ID, timezone: 'Europe/Berlin' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        time_window: 'morning',
        is_late_night: false,
        availability: 'free',
        energy: 'high',
        active_tags: ['now_ok', 'commerce_ok'],
        confidence: 82,
        bundle_id: 'bundle-1',
      });
      expect(mockComputeSituationalAwareness).toHaveBeenCalledWith({
        user_id: USER_ID,
        tenant_id: '00000000-0000-0000-0000-000000000001',
        timezone: 'Europe/Berlin',
      });
    });

    it('returns 400 for an invalid tenant_id', async () => {
      const res = await request(app)
        .post('/api/v1/situational/quick')
        .send({ tenant_id: 'not-a-uuid' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
    });

    it('returns 500 when no bundle is produced', async () => {
      mockComputeSituationalAwareness.mockResolvedValue({ ok: false, error: 'no bundle' });

      const res = await request(app).post('/api/v1/situational/quick').send({});

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('no bundle');
    });

    it('returns 500 when the engine throws', async () => {
      mockComputeSituationalAwareness.mockRejectedValue(new Error('quick boom'));

      const res = await request(app).post('/api/v1/situational/quick').send({});

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('quick boom');
    });
  });

  // --- POST /score ---

  describe('POST /api/v1/situational/score', () => {
    const validBody = {
      actions: [{ action: 'suggest_walk', action_type: 'recommendation', domain: 'health' }],
      situational_input: { user_id: USER_ID },
    };

    it('scores actions on the happy path', async () => {
      mockScoreActions.mockResolvedValue({
        ok: true,
        scored_actions: [{ action: 'suggest_walk', appropriateness: 'ok' }],
        situation_vector: {
          overall_confidence: 75,
          time_context: { time_window: 'afternoon' },
          readiness_context: { energy_level: 'moderate' },
        },
      });

      const res = await request(app).post('/api/v1/situational/score').send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.scored_actions).toEqual([{ action: 'suggest_walk', appropriateness: 'ok' }]);
      expect(res.body.situation_summary).toEqual({
        confidence: 75,
        time_window: 'afternoon',
        energy: 'moderate',
      });
      expect(mockScoreActions).toHaveBeenCalledWith(
        validBody.actions,
        expect.objectContaining({ user_id: USER_ID }),
      );
    });

    it('omits situation_summary when the engine does not return a vector', async () => {
      mockScoreActions.mockResolvedValue({ ok: true, scored_actions: [] });

      const res = await request(app).post('/api/v1/situational/score').send(validBody);

      expect(res.status).toBe(200);
      expect(res.body.situation_summary).toBeUndefined();
    });

    it('returns 400 when actions[] is empty', async () => {
      const res = await request(app)
        .post('/api/v1/situational/score')
        .send({ actions: [], situational_input: { user_id: USER_ID } });

      expect(res.status).toBe(400);
      expect(mockScoreActions).not.toHaveBeenCalled();
    });

    it('returns 400 when situational_input is missing', async () => {
      const res = await request(app)
        .post('/api/v1/situational/score')
        .send({ actions: [{ action: 'x', action_type: 'y' }] });

      expect(res.status).toBe(400);
    });

    it('returns 500 when scoring fails', async () => {
      mockScoreActions.mockResolvedValue({ ok: false, error: 'scoring engine down' });

      const res = await request(app).post('/api/v1/situational/score').send(validBody);

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('scoring engine down');
    });

    it('returns 500 when scoreActions throws', async () => {
      mockScoreActions.mockRejectedValue(new Error('score boom'));

      const res = await request(app).post('/api/v1/situational/score').send(validBody);

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('score boom');
    });
  });

  // --- POST /override ---

  describe('POST /api/v1/situational/override', () => {
    it('overrides the situation on the happy path', async () => {
      mockOverrideSituation.mockResolvedValue({
        ok: true,
        message: 'Situation updated',
        updated_vector: {
          availability_context: { availability_level: 'busy' },
          readiness_context: { energy_level: 'low' },
          constraint_flags: [{ type: 'quiet_mode', active: true }, { type: 'safety', active: false }],
          overall_confidence: 100,
        },
      });

      const res = await request(app)
        .post('/api/v1/situational/override')
        .send({ user_id: USER_ID, overrides: { availability_level: 'busy' } });

      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Situation updated');
      expect(res.body.updated_vector).toEqual({
        availability: 'busy',
        energy: 'low',
        constraint_count: 1,
        overall_confidence: 100,
      });
      expect(mockOverrideSituation).toHaveBeenCalledWith(
        USER_ID,
        '00000000-0000-0000-0000-000000000001',
        { availability_level: 'busy' },
      );
    });

    it('returns 400 when user_id is missing', async () => {
      const res = await request(app)
        .post('/api/v1/situational/override')
        .send({ overrides: { availability_level: 'free' } });

      expect(res.status).toBe(400);
      expect(mockOverrideSituation).not.toHaveBeenCalled();
    });

    it('returns 400 when overrides is missing', async () => {
      const res = await request(app)
        .post('/api/v1/situational/override')
        .send({ user_id: USER_ID });

      expect(res.status).toBe(400);
    });

    it('returns 500 when the override fails', async () => {
      mockOverrideSituation.mockResolvedValue({ ok: false, error: 'override rejected' });

      const res = await request(app)
        .post('/api/v1/situational/override')
        .send({ user_id: USER_ID, overrides: { clear_constraints: true } });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('override rejected');
    });

    it('returns 500 when overrideSituation throws', async () => {
      mockOverrideSituation.mockRejectedValue(new Error('override boom'));

      const res = await request(app)
        .post('/api/v1/situational/override')
        .send({ user_id: USER_ID, overrides: {} });

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('override boom');
    });
  });

  // --- GET /debug ---

  describe('GET /api/v1/situational/debug', () => {
    it('returns 404 with no cached decision for an unknown user', async () => {
      const res = await request(app).get('/api/v1/situational/debug').query({ user_id: '99999999-9999-4999-8999-999999999999' });

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('No situational decision found for user');
    });

    it('returns the cached bundle after a prior /compute call for the same user', async () => {
      const bundle = makeBundle();
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle });
      mockVerifyBundleIntegrity.mockReturnValue(true);

      await request(app).post('/api/v1/situational/compute').send({ user_id: USER_ID });

      const res = await request(app).get('/api/v1/situational/debug').query({ user_id: USER_ID });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.user_id).toBe(USER_ID);
      expect(res.body.integrity_verified).toBe(true);
      expect(res.body.bundle_summary).toEqual({
        bundle_id: 'bundle-1',
        bundle_hash: 'hash-abc',
        computed_at: '2026-07-28T10:00:00.000Z',
        duration_ms: 12,
      });
      expect(res.body.situation_vector).toEqual(bundle.situation_vector);
      expect(res.body.action_envelope).toEqual(bundle.action_envelope);
      expect(mockVerifyBundleIntegrity).toHaveBeenCalledWith(bundle);
    });

    it('reports integrity_verified:false when verification fails', async () => {
      const bundle = makeBundle();
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle });
      mockVerifyBundleIntegrity.mockReturnValue(false);

      await request(app).post('/api/v1/situational/compute').send({ user_id: USER_ID });
      const res = await request(app).get('/api/v1/situational/debug').query({ user_id: USER_ID });

      expect(res.status).toBe(200);
      expect(res.body.integrity_verified).toBe(false);
    });
  });

  // --- GET /config ---

  describe('GET /api/v1/situational/config', () => {
    it('returns engine config and all six time windows', async () => {
      const res = await request(app).get('/api/v1/situational/config');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.vtid).toBe('VTID-01126');
      expect(res.body.version).toBe('d32-v1.0.0');
      expect(res.body.config).toEqual({ confidence_threshold: 50 });
      expect(res.body.time_windows).toHaveLength(6);
      expect(res.body.time_windows).toEqual(
        expect.arrayContaining([
          { window: 'morning', start_hour: 8, end_hour: 12, default_energy: 'high', default_readiness: 'ready_for_action' },
          { window: 'night', start_hour: 0, end_hour: 5, default_energy: 'depleted', default_readiness: 'resting' },
        ]),
      );
      expect(res.body.available_tags).toContain('commerce_ok');
      expect(res.body.available_constraints).toContain('safety');
    });
  });

  // --- GET /health ---

  describe('GET /api/v1/situational/health', () => {
    it('returns health/capabilities metadata', async () => {
      const res = await request(app).get('/api/v1/situational/health');

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe('ok');
      expect(res.body.service).toBe('situational-awareness');
      expect(res.body.stack_position).toBe('D32');
      expect(res.body.capabilities).toEqual({
        situational_awareness: true,
        action_scoring: true,
        user_override: true,
        debug: true,
      });
    });
  });

  // --- GET /tags ---

  describe('GET /api/v1/situational/tags', () => {
    it('returns all 12 situation tags', async () => {
      const res = await request(app).get('/api/v1/situational/tags');

      expect(res.status).toBe(200);
      expect(res.body.count).toBe(12);
      expect(res.body.tags).toHaveLength(12);
      expect(res.body.tags.map((t: any) => t.tag)).toContain('quiet_hours');
      expect(res.body.categories).toEqual([
        'timing', 'interaction', 'decision', 'mode', 'engagement', 'commerce', 'booking',
      ]);
    });
  });

  // --- POST /validate ---

  describe('POST /api/v1/situational/validate', () => {
    it('returns 400 when situational_input is missing', async () => {
      const res = await request(app)
        .post('/api/v1/situational/validate')
        .send({ operations: ['commerce'] });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('situational_input and operations[] are required');
      expect(mockComputeSituationalAwareness).not.toHaveBeenCalled();
    });

    it('returns 400 when operations is not an array', async () => {
      const res = await request(app)
        .post('/api/v1/situational/validate')
        .send({ situational_input: { user_id: USER_ID }, operations: 'commerce' });

      expect(res.status).toBe(400);
    });

    it('validates each known operation against active tags', async () => {
      const bundle = makeBundle({
        action_envelope: {
          active_tags: ['now_ok', 'commerce_ok', 'high_engagement_ok'],
          allowed_actions: [],
          blocked_actions: [],
        },
      });
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle });

      const res = await request(app)
        .post('/api/v1/situational/validate')
        .send({
          situational_input: { user_id: USER_ID },
          operations: ['commerce', 'booking', 'notification', 'deep_engagement', 'proactive_action', 'something_else'],
        });

      expect(res.status).toBe(200);
      expect(res.body.results.commerce.allowed).toBe(true);
      expect(res.body.results.booking.allowed).toBe(false);
      expect(res.body.results.notification.allowed).toBe(true); // no quiet_hours tag
      expect(res.body.results.deep_engagement.allowed).toBe(true);
      expect(res.body.results.proactive_action.allowed).toBe(true); // now_ok, no defer_recommendation
      expect(res.body.results.something_else).toEqual({
        allowed: true,
        reason: 'General validation based on situation',
      });
      expect(res.body.all_allowed).toBe(false); // booking is not allowed
      expect(res.body.active_tags).toEqual(['now_ok', 'commerce_ok', 'high_engagement_ok']);
    });

    it('blocks notification validation when quiet_hours is active', async () => {
      const bundle = makeBundle({
        action_envelope: { active_tags: ['quiet_hours'], allowed_actions: [], blocked_actions: [] },
      });
      mockComputeSituationalAwareness.mockResolvedValue({ ok: true, bundle });

      const res = await request(app)
        .post('/api/v1/situational/validate')
        .send({ situational_input: { user_id: USER_ID }, operations: ['notification'] });

      expect(res.status).toBe(200);
      expect(res.body.results.notification.allowed).toBe(false);
      expect(res.body.results.notification.reason).toContain('quiet hours');
    });

    it('returns 500 when computation fails', async () => {
      mockComputeSituationalAwareness.mockResolvedValue({ ok: false, error: 'validate compute failed' });

      const res = await request(app)
        .post('/api/v1/situational/validate')
        .send({ situational_input: { user_id: USER_ID }, operations: ['commerce'] });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('validate compute failed');
    });

    it('returns 500 when computation throws', async () => {
      mockComputeSituationalAwareness.mockRejectedValue(new Error('validate boom'));

      const res = await request(app)
        .post('/api/v1/situational/validate')
        .send({ situational_input: { user_id: USER_ID }, operations: ['commerce'] });

      expect(res.status).toBe(500);
      expect(res.body.message).toBe('validate boom');
    });
  });
});
