/**
 * VTID-01144: D50 Positive Trajectory Reinforcement & Momentum Engine Tests
 *
 * Tests for:
 * - Positive trajectory detection from D43 trends
 * - Eligibility checking (7-day sustained, 80% confidence, 21-day gap)
 * - Reinforcement generation (specific, not generic)
 * - Momentum calculation
 * - Framing rules (no praise inflation, continuation focus)
 * - API endpoints
 *
 * Core Rules (Non-Negotiable):
 * - Positive-only reinforcement (no correction)
 * - No comparison with others
 * - No gamification pressure
 * - Focus on continuation, not escalation
 */

import request from 'supertest';
import express from 'express';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.ENVIRONMENT = 'dev-sandbox';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key';

// Mock the OASIS event service
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

// Mock the Supabase user client
const mockRpc = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn().mockReturnValue({
    rpc: mockRpc,
  }),
}));

// Mock the D43 engine
const mockGetTrends = jest.fn();
const mockDetectDrift = jest.fn();
jest.mock('../src/services/d43-longitudinal-adaptation-engine', () => ({
  getTrends: mockGetTrends,
  detectDrift: mockDetectDrift,
  DRIFT_THRESHOLDS: {
    MIN_CONFIDENCE: 60,
    MIN_MAGNITUDE_FOR_ADAPTATION: 30,
    GRADUAL_DRIFT_MIN_DAYS: 14,
    ABRUPT_DRIFT_MAX_DAYS: 3,
    AUTO_ADAPT_CONFIDENCE: 85,
    CONFIRMATION_REQUIRED_ABOVE: 50,
    ROLLBACK_WINDOW_DAYS: 30,
    MIN_DATA_POINTS_FOR_TREND: 5,
    MIN_DATA_POINTS_FOR_DRIFT: 10,
    SEASONAL_CYCLE_DAYS: 7
  }
}));

// Import after mocks
import {
  derivePositiveSignalsFromTrends,
  isTrendPositive,
  calculateDaysSustained,
  domainToTrajectoryType,
  buildReinforcement,
  calculateOverallMomentum,
  generateWhatIsWorking,
  generateWhyItMatters,
  REINFORCEMENT_THRESHOLDS,
  TRAJECTORY_TYPE_METADATA,
  FRAMING_RULES
} from '../src/services/d50-positive-trajectory-reinforcement-engine';

import {
  TrajectoryType,
  EligibilityResult,
  DerivedPositiveSignal,
  LongitudinalSignalBundle
} from '../src/types/positive-trajectory-reinforcement';

import {
  TrendAnalysis,
  TrendDirection
} from '../src/types/longitudinal-adaptation';

// =============================================================================
// Test Data
// =============================================================================

const createTrendAnalysis = (
  domain: string,
  direction: TrendDirection,
  magnitude: number,
  confidence: number,
  daysSustained: number,
  dataPoints: number = 10
): TrendAnalysis => ({
  domain: domain as any,
  key: `${domain}_key`,
  direction,
  magnitude,
  velocity: 0.05,
  data_points_count: dataPoints,
  time_span_days: daysSustained,
  first_observation: new Date(Date.now() - daysSustained * 24 * 60 * 60 * 1000).toISOString(),
  last_observation: new Date().toISOString(),
  confidence,
  baseline_value: 0,
  current_value: 100
});

const positiveTrend: TrendAnalysis = createTrendAnalysis(
  'health',
  'increasing',
  40,
  85,
  14
);

const weakTrend: TrendAnalysis = createTrendAnalysis(
  'engagement',
  'increasing',
  10, // Below threshold
  85,
  14
);

const lowConfidenceTrend: TrendAnalysis = createTrendAnalysis(
  'social',
  'increasing',
  40,
  70, // Below 80%
  14
);

const shortDurationTrend: TrendAnalysis = createTrendAnalysis(
  'health',
  'increasing',
  40,
  85,
  5 // Less than 7 days
);

const stableTrend: TrendAnalysis = createTrendAnalysis(
  'communication',
  'stable',
  5,
  85,
  14
);

const stableWithManyDataPoints: TrendAnalysis = createTrendAnalysis(
  'communication',
  'stable',
  5,
  85,
  14,
  15 // Many data points for consistency
);

const mockSignalBundle: LongitudinalSignalBundle = {
  computed_at: new Date().toISOString(),
  health_trend: positiveTrend
};

const mockDerivedSignal: DerivedPositiveSignal = {
  source: 'trend',
  trend_domain: 'health',
  trajectory_type: 'health',
  confidence: 85,
  evidence: 'increasing trend in health over 14 days (10 observations)',
  sustained_days: 14
};

// =============================================================================
// Unit Tests: Core Functions
// =============================================================================

describe('VTID-01144: D50 Positive Trajectory Reinforcement Engine', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('domainToTrajectoryType', () => {
    it('should map health domain to health trajectory', () => {
      expect(domainToTrajectoryType('health')).toBe('health');
    });

    it('should map social domain to social trajectory', () => {
      expect(domainToTrajectoryType('social')).toBe('social');
    });

    it('should map engagement domain to consistency trajectory', () => {
      expect(domainToTrajectoryType('engagement')).toBe('consistency');
    });

    it('should map goal domain to learning trajectory', () => {
      expect(domainToTrajectoryType('goal')).toBe('learning');
    });

    it('should map communication domain to social trajectory', () => {
      expect(domainToTrajectoryType('communication')).toBe('social');
    });

    it('should map autonomy domain to emotional trajectory', () => {
      expect(domainToTrajectoryType('autonomy')).toBe('emotional');
    });

    it('should return null for unmapped domains', () => {
      expect(domainToTrajectoryType('preference')).toBeNull();
      expect(domainToTrajectoryType('monetization')).toBeNull();
    });
  });

  describe('isTrendPositive', () => {
    it('should return true for increasing trend with sufficient magnitude', () => {
      expect(isTrendPositive(positiveTrend)).toBe(true);
    });

    it('should return false for weak magnitude trend', () => {
      expect(isTrendPositive(weakTrend)).toBe(false);
    });

    it('should return false for stable trend with few data points', () => {
      expect(isTrendPositive(stableTrend)).toBe(false);
    });

    it('should return true for stable trend with many data points (consistency)', () => {
      expect(isTrendPositive(stableWithManyDataPoints)).toBe(true);
    });

    it('should return false for decreasing trend', () => {
      const decreasingTrend = { ...positiveTrend, direction: 'decreasing' as TrendDirection };
      expect(isTrendPositive(decreasingTrend)).toBe(false);
    });

    it('should return false for oscillating trend', () => {
      const oscillatingTrend = { ...positiveTrend, direction: 'oscillating' as TrendDirection };
      expect(isTrendPositive(oscillatingTrend)).toBe(false);
    });
  });

  describe('calculateDaysSustained', () => {
    it('should return time_span_days from trend', () => {
      expect(calculateDaysSustained(positiveTrend)).toBe(14);
    });

    it('should return 5 for short duration trend', () => {
      expect(calculateDaysSustained(shortDurationTrend)).toBe(5);
    });
  });

  describe('derivePositiveSignalsFromTrends', () => {
    it('should derive positive signal from positive health trend', () => {
      const signals = derivePositiveSignalsFromTrends(mockSignalBundle);

      expect(signals).toHaveLength(1);
      expect(signals[0].trajectory_type).toBe('health');
      expect(signals[0].confidence).toBe(85);
      expect(signals[0].sustained_days).toBe(14);
    });

    it('should not derive signal from weak magnitude trend', () => {
      const bundle: LongitudinalSignalBundle = {
        computed_at: new Date().toISOString(),
        engagement_trend: weakTrend
      };

      const signals = derivePositiveSignalsFromTrends(bundle);
      expect(signals).toHaveLength(0);
    });

    it('should derive signals from multiple positive trends', () => {
      const bundle: LongitudinalSignalBundle = {
        computed_at: new Date().toISOString(),
        health_trend: positiveTrend,
        social_trend: { ...positiveTrend, domain: 'social' as any }
      };

      const signals = derivePositiveSignalsFromTrends(bundle);
      expect(signals.length).toBeGreaterThanOrEqual(2);
    });

    it('should include evidence string in derived signal', () => {
      const signals = derivePositiveSignalsFromTrends(mockSignalBundle);

      expect(signals[0].evidence).toContain('increasing');
      expect(signals[0].evidence).toContain('health');
      expect(signals[0].evidence).toContain('14');
    });
  });

  // =============================================================================
  // Eligibility Tests
  // =============================================================================

  describe('Eligibility Thresholds', () => {
    it('should require minimum 7 days sustained', () => {
      expect(REINFORCEMENT_THRESHOLDS.MIN_SUSTAINED_DAYS).toBe(7);
    });

    it('should require minimum 80% confidence', () => {
      expect(REINFORCEMENT_THRESHOLDS.MIN_CONFIDENCE).toBe(80);
    });

    it('should require 21 days between reinforcements', () => {
      expect(REINFORCEMENT_THRESHOLDS.MIN_DAYS_BETWEEN_REINFORCEMENTS).toBe(21);
    });

    it('should limit to 2 reinforcements per day', () => {
      expect(REINFORCEMENT_THRESHOLDS.MAX_DAILY_REINFORCEMENTS).toBe(2);
    });
  });

  // =============================================================================
  // Reinforcement Generation Tests
  // =============================================================================

  describe('buildReinforcement', () => {
    it('should create reinforcement with all required fields', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      expect(reinforcement.reinforcement_id).toBeDefined();
      expect(reinforcement.trajectory_type).toBe('health');
      expect(reinforcement.confidence).toBe(85);
      expect(reinforcement.what_is_working).toBeDefined();
      expect(reinforcement.why_it_matters).toBeDefined();
      expect(reinforcement.dismissible).toBe(true);
    });

    it('should generate specific observation, not generic', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      // Should reference the domain
      expect(reinforcement.what_is_working.toLowerCase()).toContain('health');
    });

    it('should have suggested_focus as optional field', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      // suggested_focus can be null
      expect(reinforcement.suggested_focus === null || typeof reinforcement.suggested_focus === 'string').toBe(true);
    });
  });

  describe('generateWhatIsWorking', () => {
    it('should not exceed maximum word count', () => {
      const observation = generateWhatIsWorking('health', mockDerivedSignal);
      const wordCount = observation.split(' ').length;

      expect(wordCount).toBeLessThanOrEqual(FRAMING_RULES.MAX_OBSERVATION_WORDS);
    });

    it('should not contain prohibited phrases (praise inflation)', () => {
      const observation = generateWhatIsWorking('health', mockDerivedSignal);
      const lowerObservation = observation.toLowerCase();

      FRAMING_RULES.PROHIBITED_PHRASES.forEach(phrase => {
        expect(lowerObservation).not.toContain(phrase);
      });
    });

    it('should be specific to trajectory type', () => {
      const healthObs = generateWhatIsWorking('health', mockDerivedSignal);
      const socialObs = generateWhatIsWorking('social', { ...mockDerivedSignal, trajectory_type: 'social' });

      // Should have different content for different types
      expect(healthObs).not.toBe(socialObs);
    });
  });

  describe('generateWhyItMatters', () => {
    it('should not exceed maximum word count', () => {
      const explanation = generateWhyItMatters('health', mockDerivedSignal);
      const wordCount = explanation.split(' ').length;

      expect(wordCount).toBeLessThanOrEqual(FRAMING_RULES.MAX_EXPLANATION_WORDS);
    });

    it('should not contain prohibited phrases', () => {
      const explanation = generateWhyItMatters('health', mockDerivedSignal);
      const lowerExplanation = explanation.toLowerCase();

      FRAMING_RULES.PROHIBITED_PHRASES.forEach(phrase => {
        expect(lowerExplanation).not.toContain(phrase);
      });
    });

    it('should focus on continuation, not escalation', () => {
      const explanation = generateWhyItMatters('health', mockDerivedSignal);
      const lowerExplanation = explanation.toLowerCase();

      // Should not have escalation language
      expect(lowerExplanation).not.toContain('push harder');
      expect(lowerExplanation).not.toContain('do more');
      expect(lowerExplanation).not.toContain('level up');
    });
  });

  // =============================================================================
  // Momentum Calculation Tests
  // =============================================================================

  describe('calculateOverallMomentum', () => {
    it('should return unknown for empty results', () => {
      const momentum = calculateOverallMomentum([]);
      expect(momentum).toBe('unknown');
    });

    it('should return unknown when all have zero sustained days', () => {
      const results: EligibilityResult[] = [
        {
          eligible: false,
          trajectory_type: 'health',
          confidence: 0,
          days_sustained: 0,
          last_reinforcement_date: null,
          days_since_last_reinforcement: null,
          rejection_reason: 'No data',
          evidence_summary: null
        }
      ];

      const momentum = calculateOverallMomentum(results);
      expect(momentum).toBe('unknown');
    });

    it('should return building for high eligibility and confidence', () => {
      const results: EligibilityResult[] = [
        {
          eligible: true,
          trajectory_type: 'health',
          confidence: 90,
          days_sustained: 14,
          last_reinforcement_date: null,
          days_since_last_reinforcement: null,
          rejection_reason: null,
          evidence_summary: 'Positive health trend'
        },
        {
          eligible: true,
          trajectory_type: 'social',
          confidence: 85,
          days_sustained: 12,
          last_reinforcement_date: null,
          days_since_last_reinforcement: null,
          rejection_reason: null,
          evidence_summary: 'Positive social trend'
        }
      ];

      const momentum = calculateOverallMomentum(results);
      expect(momentum).toBe('building');
    });

    it('should return fragile for low confidence and few eligible', () => {
      const results: EligibilityResult[] = [
        {
          eligible: false,
          trajectory_type: 'health',
          confidence: 40,
          days_sustained: 5,
          last_reinforcement_date: null,
          days_since_last_reinforcement: null,
          rejection_reason: 'Low confidence',
          evidence_summary: null
        }
      ];

      const momentum = calculateOverallMomentum(results);
      expect(momentum).toBe('fragile');
    });
  });

  // =============================================================================
  // Framing Rules Tests (Non-Negotiable)
  // =============================================================================

  describe('Framing Rules (Non-Negotiable)', () => {
    it('should have correct max word counts defined', () => {
      expect(FRAMING_RULES.MAX_OBSERVATION_WORDS).toBe(30);
      expect(FRAMING_RULES.MAX_EXPLANATION_WORDS).toBe(25);
      expect(FRAMING_RULES.MAX_FOCUS_WORDS).toBe(20);
    });

    it('should have observational tone, not praising', () => {
      expect(FRAMING_RULES.TONE).toBe('observational');
    });

    it('should focus on continuation, not escalation', () => {
      expect(FRAMING_RULES.FOCUS).toBe('continuation');
    });

    it('should have prohibited phrases list for praise inflation', () => {
      expect(FRAMING_RULES.PROHIBITED_PHRASES).toContain('amazing');
      expect(FRAMING_RULES.PROHIBITED_PHRASES).toContain('incredible');
      expect(FRAMING_RULES.PROHIBITED_PHRASES).toContain('great job');
      expect(FRAMING_RULES.PROHIBITED_PHRASES).toContain('keep it up');
    });
  });

  // =============================================================================
  // Trajectory Type Metadata Tests
  // =============================================================================

  describe('Trajectory Type Metadata', () => {
    it('should have metadata for all trajectory types', () => {
      const types: TrajectoryType[] = ['health', 'routine', 'social', 'emotional', 'learning', 'consistency'];

      types.forEach(type => {
        expect(TRAJECTORY_TYPE_METADATA[type]).toBeDefined();
        expect(TRAJECTORY_TYPE_METADATA[type].label).toBeDefined();
        expect(TRAJECTORY_TYPE_METADATA[type].description).toBeDefined();
        expect(TRAJECTORY_TYPE_METADATA[type].icon).toBeDefined();
        expect(TRAJECTORY_TYPE_METADATA[type].message_templates).toBeDefined();
      });
    });

    it('should have message templates for each type', () => {
      Object.values(TRAJECTORY_TYPE_METADATA).forEach(metadata => {
        expect(metadata.message_templates.what_is_working.length).toBeGreaterThan(0);
        expect(metadata.message_templates.why_it_matters.length).toBeGreaterThan(0);
      });
    });
  });

  // =============================================================================
  // Hard Governance Tests (Non-Negotiable)
  // =============================================================================

  describe('Hard Governance (Non-Negotiable)', () => {
    it('should be positive-only (no correction capability)', () => {
      // The engine only has positive reinforcement functions
      // No "correct" or "fix" or "improve" functions should exist
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      // Reinforcement should never suggest something is wrong
      expect(reinforcement.what_is_working).not.toContain('wrong');
      expect(reinforcement.what_is_working).not.toContain('bad');
      expect(reinforcement.what_is_working).not.toContain('needs improvement');
    });

    it('should not compare with others', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      // Should not reference other users
      expect(reinforcement.what_is_working).not.toContain('others');
      expect(reinforcement.what_is_working).not.toContain('average');
      expect(reinforcement.what_is_working).not.toContain('compared to');
      expect(reinforcement.what_is_working).not.toContain('percentile');
    });

    it('should not use gamification language', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      // Should not use points, badges, levels
      expect(reinforcement.what_is_working).not.toContain('points');
      expect(reinforcement.what_is_working).not.toContain('badge');
      expect(reinforcement.what_is_working).not.toContain('level');
      expect(reinforcement.what_is_working).not.toContain('streak');
      expect(reinforcement.what_is_working).not.toContain('achievement');
    });

    it('should not enforce behavior', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);

      // Should not use directive language
      expect(reinforcement.what_is_working).not.toContain('you should');
      expect(reinforcement.what_is_working).not.toContain('you must');
      expect(reinforcement.what_is_working).not.toContain('you need to');
    });

    it('should be dismissible by default', () => {
      const reinforcement = buildReinforcement('health', mockDerivedSignal);
      expect(reinforcement.dismissible).toBe(true);
    });
  });

  // =============================================================================
  // API Route Tests
  // =============================================================================

  describe('Positive Trajectory Reinforcement API Routes', () => {
    let app: express.Application;

    beforeEach(async () => {
      jest.clearAllMocks();

      // Setup D43 mock
      mockGetTrends.mockResolvedValue({
        ok: true,
        signals: mockSignalBundle,
        data_points_count: 10,
        time_span_days: 30
      });

      // Setup RPC mock
      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'dev_bootstrap_request_context') {
          return Promise.resolve({ data: { ok: true }, error: null });
        }
        if (funcName === 'd50_get_last_reinforcement') {
          return Promise.resolve({
            data: { ok: true, found: false },
            error: null
          });
        }
        if (funcName === 'd50_count_today_reinforcements') {
          return Promise.resolve({ data: 0, error: null });
        }
        if (funcName === 'd50_store_reinforcement') {
          return Promise.resolve({
            data: { ok: true, reinforcement_id: 'test-reinforcement-id' },
            error: null
          });
        }
        if (funcName === 'd50_get_recent_reinforcements') {
          return Promise.resolve({
            data: [],
            error: null
          });
        }
        if (funcName === 'd50_get_eligibility_cache') {
          return Promise.resolve({
            data: [],
            error: null
          });
        }
        return Promise.resolve({ data: { ok: true }, error: null });
      });

      // Import router after mocks are set up
      const router = require('../src/routes/positive-trajectory-reinforcement').default;

      app = express();
      app.use(express.json());
      app.use('/api/v1/reinforcement', router);
    });

    describe('GET /', () => {
      it('should return service info with philosophy', async () => {
        const response = await request(app).get('/api/v1/reinforcement');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.vtid).toBe('VTID-01144');
        expect(response.body.philosophy).toBeDefined();
        expect(response.body.philosophy.core).toBe('Positive-only reinforcement');
        expect(response.body.philosophy.rules).toContain('No correction');
        expect(response.body.endpoints).toBeDefined();
      });
    });

    describe('GET /metadata', () => {
      it('should return trajectory type metadata', async () => {
        const response = await request(app).get('/api/v1/reinforcement/metadata');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.trajectory_types).toBeDefined();
        expect(response.body.thresholds).toBeDefined();
        expect(response.body.framing_rules).toBeDefined();
      });

      it('should include framing rules', async () => {
        const response = await request(app).get('/api/v1/reinforcement/metadata');

        expect(response.body.framing_rules.tone).toBe('observational');
        expect(response.body.framing_rules.focus).toBe('continuation');
      });
    });

    describe('GET /eligibility', () => {
      it('should allow dev sandbox access without token', async () => {
        const response = await request(app).get('/api/v1/reinforcement/eligibility');

        // Should not return 401 in dev sandbox
        expect(response.status).not.toBe(401);
      });

      it('should accept trajectory_types filter', async () => {
        const response = await request(app)
          .get('/api/v1/reinforcement/eligibility?trajectory_types=health,social');

        expect(response.status).toBe(200);
      });
    });

    describe('GET /momentum', () => {
      it('should return momentum state', async () => {
        const response = await request(app).get('/api/v1/reinforcement/momentum');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });
    });

    describe('POST /generate', () => {
      it('should accept generation request', async () => {
        const response = await request(app)
          .post('/api/v1/reinforcement/generate')
          .send({});

        // May succeed or fail based on eligibility, but should not 401
        expect(response.status).not.toBe(401);
      });

      it('should accept specific trajectory type', async () => {
        const response = await request(app)
          .post('/api/v1/reinforcement/generate')
          .send({ trajectory_type: 'health' });

        expect(response.status).not.toBe(401);
      });
    });

    describe('POST /:id/dismiss', () => {
      it('should validate UUID format', async () => {
        const response = await request(app)
          .post('/api/v1/reinforcement/invalid-id/dismiss')
          .send({});

        expect(response.status).toBe(400);
      });

      it('should accept valid dismiss request', async () => {
        mockRpc.mockImplementation((funcName: string) => {
          if (funcName === 'd50_dismiss_reinforcement') {
            return Promise.resolve({
              data: { ok: true },
              error: null
            });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        });

        const response = await request(app)
          .post('/api/v1/reinforcement/00000000-0000-0000-0000-000000000001/dismiss')
          .send({ reason: 'not_relevant' });

        expect(response.status).not.toBe(401);
      });
    });

    describe('GET /history', () => {
      it('should return reinforcement history', async () => {
        const response = await request(app).get('/api/v1/reinforcement/history');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });

      it('should accept limit parameter', async () => {
        const response = await request(app)
          .get('/api/v1/reinforcement/history?limit=5');

        expect(response.status).toBe(200);
      });

      it('should accept include_dismissed parameter', async () => {
        const response = await request(app)
          .get('/api/v1/reinforcement/history?include_dismissed=true');

        expect(response.status).toBe(200);
      });
    });

    describe('GET /orb-context', () => {
      it('should return ORB context', async () => {
        const response = await request(app).get('/api/v1/reinforcement/orb-context');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });
    });
  });
});
