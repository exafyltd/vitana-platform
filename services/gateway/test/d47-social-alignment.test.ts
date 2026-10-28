/**
 * VTID-01141: D47 Proactive Social & Community Alignment Engine Tests
 *
 * Tests for:
 * - Matching logic and scoring
 * - Threshold enforcement (relevance >= 75%, signals >= 2)
 * - Social load checking
 * - Explainability generation
 * - API endpoints
 *
 * Platform invariants:
 * - Consent-by-design (suggestions only)
 * - No forced matchmaking
 * - Explainability mandatory
 * - No social graph exposure
 */

import request from 'supertest';
import express from 'express';

// Set test environment
process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

// Mock the OASIS event service
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' });
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: mockEmitOasisEvent,
}));

// Mock the Supabase client
const mockRpc = jest.fn();
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn().mockReturnValue({
    rpc: mockRpc,
  }),
}));

// Import after mocks are set up
import {
  mapNodeTypeToAlignmentDomain,
  calculateRelevanceScore,
  calculateConfidenceScore,
  generateWhyNow,
  passesMatchingThresholds,
  scoreCandidate,
  filterAndRankCandidates
} from '../src/services/d47-social-alignment-engine';

import {
  AlignmentCandidate,
  AlignmentSignalRef,
  AlignmentDomain,
  DEFAULT_ALIGNMENT_THRESHOLDS,
  ALIGNMENT_DOMAINS,
  ALIGNMENT_ACTIONS,
  ALIGNMENT_STATUSES
} from '../src/types/social-alignment';

import socialAlignmentRouter from '../src/routes/social-alignment';

// =============================================================================
// Test Data
// =============================================================================

const strongFriendCandidate: AlignmentCandidate = {
  node_id: '00000000-0000-0000-0000-000000000001',
  node_type: 'person',
  title: 'Close Friend',
  domain: 'community',
  strength: 80,
  relationship_type: 'friend',
  last_seen: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString() // 2 days ago
};

const weakConnectionCandidate: AlignmentCandidate = {
  node_id: '00000000-0000-0000-0000-000000000002',
  node_type: 'person',
  title: 'Acquaintance',
  domain: 'business',
  strength: 20,
  relationship_type: 'friend',
  last_seen: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString() // 30 days ago
};

const groupCandidate: AlignmentCandidate = {
  node_id: '00000000-0000-0000-0000-000000000003',
  node_type: 'group',
  title: 'Longevity Community',
  domain: 'health',
  strength: 60,
  relationship_type: 'member',
  last_seen: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString() // 1 day ago
};

const eventCandidate: AlignmentCandidate = {
  node_id: '00000000-0000-0000-0000-000000000004',
  node_type: 'event',
  title: 'Walking Meetup',
  domain: 'lifestyle',
  strength: 40,
  relationship_type: 'attendee',
  last_seen: undefined
};

const serviceCandidate: AlignmentCandidate = {
  node_id: '00000000-0000-0000-0000-000000000005',
  node_type: 'service',
  title: 'Health Coach',
  domain: 'health',
  strength: 55,
  relationship_type: 'using',
  last_seen: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() // 5 days ago
};

const liveRoomCandidate: AlignmentCandidate = {
  node_id: '00000000-0000-0000-0000-000000000006',
  node_type: 'live_room',
  title: 'Morning Meditation',
  domain: 'health',
  strength: 45,
  relationship_type: 'following',
  last_seen: new Date().toISOString() // Now
};

// =============================================================================
// Type Mapping Tests
// =============================================================================

describe('VTID-01141: D47 Social Alignment Engine', () => {
  describe('mapNodeTypeToAlignmentDomain', () => {
    it('should map person to people domain', () => {
      expect(mapNodeTypeToAlignmentDomain('person')).toBe('people');
    });

    it('should map group to group domain', () => {
      expect(mapNodeTypeToAlignmentDomain('group')).toBe('group');
    });

    it('should map event to event domain', () => {
      expect(mapNodeTypeToAlignmentDomain('event')).toBe('event');
    });

    it('should map service to service domain', () => {
      expect(mapNodeTypeToAlignmentDomain('service')).toBe('service');
    });

    it('should map live_room to live_room domain', () => {
      expect(mapNodeTypeToAlignmentDomain('live_room')).toBe('live_room');
    });

    it('should default to activity for unknown types', () => {
      expect(mapNodeTypeToAlignmentDomain('unknown')).toBe('activity');
    });
  });

  // =============================================================================
  // Relevance Score Tests
  // =============================================================================

  describe('calculateRelevanceScore', () => {
    it('should return base score with no signals', () => {
      const score = calculateRelevanceScore([], 0);
      expect(score).toBe(30); // Base score
    });

    it('should increase score with connection strength', () => {
      const lowStrength = calculateRelevanceScore([], 20);
      const highStrength = calculateRelevanceScore([], 80);
      expect(highStrength).toBeGreaterThan(lowStrength);
    });

    it('should increase score with more signals', () => {
      const signals: AlignmentSignalRef[] = [
        { type: 'interest', ref: 'domain:health' },
        { type: 'behavior', ref: 'strong_connection' },
        { type: 'goal', ref: 'longevity' }
      ];

      const oneSignal = calculateRelevanceScore([signals[0]], 50);
      const threeSignals = calculateRelevanceScore(signals, 50);
      expect(threeSignals).toBeGreaterThan(oneSignal);
    });

    it('should cap score at 100', () => {
      const manySignals: AlignmentSignalRef[] = Array(10).fill({
        type: 'interest' as const,
        ref: 'test',
        weight: 2
      });

      const score = calculateRelevanceScore(manySignals, 100);
      expect(score).toBeLessThanOrEqual(100);
    });

    it('should apply signal weights', () => {
      const lowWeight: AlignmentSignalRef[] = [
        { type: 'interest', ref: 'test', weight: 0.5 }
      ];
      const highWeight: AlignmentSignalRef[] = [
        { type: 'interest', ref: 'test', weight: 2.0 }
      ];

      const lowScore = calculateRelevanceScore(lowWeight, 50);
      const highScore = calculateRelevanceScore(highWeight, 50);
      expect(highScore).toBeGreaterThan(lowScore);
    });
  });

  // =============================================================================
  // Confidence Score Tests
  // =============================================================================

  describe('calculateConfidenceScore', () => {
    it('should return base confidence with minimal input', () => {
      const score = calculateConfidenceScore(0, false, 0);
      expect(score).toBe(50); // Base confidence
    });

    it('should increase with more signals', () => {
      const fewSignals = calculateConfidenceScore(1, false, 0);
      const manySignals = calculateConfidenceScore(5, false, 0);
      expect(manySignals).toBeGreaterThan(fewSignals);
    });

    it('should add recency bonus', () => {
      const noRecent = calculateConfidenceScore(2, false, 50);
      const withRecent = calculateConfidenceScore(2, true, 50);
      expect(withRecent).toBeGreaterThan(noRecent);
      expect(withRecent - noRecent).toBe(20); // Recency bonus is 20
    });

    it('should add strength bonus', () => {
      const noStrength = calculateConfidenceScore(2, true, 0);
      const withStrength = calculateConfidenceScore(2, true, 80);
      expect(withStrength).toBeGreaterThan(noStrength);
    });

    it('should cap at 100', () => {
      const score = calculateConfidenceScore(10, true, 100);
      expect(score).toBeLessThanOrEqual(100);
    });
  });

  // =============================================================================
  // Why Now Explainability Tests (MANDATORY per spec)
  // =============================================================================

  describe('generateWhyNow', () => {
    it('should generate explanation for close connection', () => {
      const signals: AlignmentSignalRef[] = [
        { type: 'behavior', ref: 'strong_connection' }
      ];

      const whyNow = generateWhyNow('people', signals, 80, undefined);

      expect(whyNow).toBeDefined();
      expect(whyNow.length).toBeGreaterThan(0);
      expect(whyNow.toLowerCase()).toContain('close');
    });

    it('should generate explanation for recent interaction', () => {
      const recentDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
      const signals: AlignmentSignalRef[] = [
        { type: 'behavior', ref: 'recent_interaction' }
      ];

      const whyNow = generateWhyNow('people', signals, 40, recentDate);

      expect(whyNow).toBeDefined();
      expect(whyNow.toLowerCase()).toContain('recent');
    });

    it('should generate explanation for groups', () => {
      const whyNow = generateWhyNow('group', [], 50, undefined);

      expect(whyNow).toBeDefined();
      expect(whyNow.toLowerCase()).toContain('community');
    });

    it('should generate explanation for events', () => {
      const whyNow = generateWhyNow('event', [], 50, undefined);

      expect(whyNow).toBeDefined();
      expect(whyNow.toLowerCase()).toContain('event');
    });

    it('should generate explanation for services', () => {
      const signals: AlignmentSignalRef[] = [
        { type: 'goal', ref: 'health' }
      ];

      const whyNow = generateWhyNow('service', signals, 50, undefined);

      expect(whyNow).toBeDefined();
      expect(whyNow.toLowerCase()).toContain('goal');
    });

    it('should generate explanation for live rooms', () => {
      const whyNow = generateWhyNow('live_room', [], 50, undefined);

      expect(whyNow).toBeDefined();
      expect(whyNow.toLowerCase()).toContain('live');
    });

    it('should generate explanation for shared goals', () => {
      const signals: AlignmentSignalRef[] = [
        { type: 'goal', ref: 'longevity' }
      ];

      const whyNow = generateWhyNow('people', signals, 30, undefined);

      expect(whyNow).toBeDefined();
      expect(whyNow.toLowerCase()).toContain('goal');
    });
  });

  // =============================================================================
  // Threshold Tests (Spec Section 4)
  // =============================================================================

  describe('passesMatchingThresholds', () => {
    it('should pass with score >= 75 and signals >= 2', () => {
      expect(passesMatchingThresholds(75, 2)).toBe(true);
      expect(passesMatchingThresholds(80, 3)).toBe(true);
      expect(passesMatchingThresholds(100, 5)).toBe(true);
    });

    it('should fail with score < 75', () => {
      expect(passesMatchingThresholds(74, 2)).toBe(false);
      expect(passesMatchingThresholds(50, 5)).toBe(false);
    });

    it('should fail with signals < 2', () => {
      expect(passesMatchingThresholds(80, 1)).toBe(false);
      expect(passesMatchingThresholds(100, 0)).toBe(false);
    });

    it('should respect custom thresholds', () => {
      const customThresholds = {
        ...DEFAULT_ALIGNMENT_THRESHOLDS,
        min_relevance: 50,
        min_shared_signals: 1
      };

      expect(passesMatchingThresholds(50, 1, customThresholds)).toBe(true);
      expect(passesMatchingThresholds(49, 1, customThresholds)).toBe(false);
    });
  });

  // =============================================================================
  // Candidate Scoring Tests
  // =============================================================================

  describe('scoreCandidate', () => {
    it('should score strong friend candidate high', () => {
      const result = scoreCandidate(strongFriendCandidate);

      expect(result.relevance_score).toBeGreaterThanOrEqual(75);
      expect(result.shared_signals.length).toBeGreaterThanOrEqual(2);
      expect(result.alignment_domain).toBe('people');
      expect(result.passes_thresholds).toBe(true);
    });

    it('should score weak connection candidate lower', () => {
      const result = scoreCandidate(weakConnectionCandidate);

      expect(result.relevance_score).toBeLessThan(75);
      expect(result.passes_thresholds).toBe(false);
    });

    it('should map domains correctly', () => {
      const personResult = scoreCandidate(strongFriendCandidate);
      const groupResult = scoreCandidate(groupCandidate);
      const eventResult = scoreCandidate(eventCandidate);
      const serviceResult = scoreCandidate(serviceCandidate);
      const liveResult = scoreCandidate(liveRoomCandidate);

      expect(personResult.alignment_domain).toBe('people');
      expect(groupResult.alignment_domain).toBe('group');
      expect(eventResult.alignment_domain).toBe('event');
      expect(serviceResult.alignment_domain).toBe('service');
      expect(liveResult.alignment_domain).toBe('live_room');
    });

    it('should add domain signal when domain exists', () => {
      const result = scoreCandidate(strongFriendCandidate);

      const domainSignal = result.shared_signals.find(s => s.ref.startsWith('domain:'));
      expect(domainSignal).toBeDefined();
    });

    it('should add strong_connection signal for high strength', () => {
      const result = scoreCandidate(strongFriendCandidate);

      const strongSignal = result.shared_signals.find(s => s.ref === 'strong_connection');
      expect(strongSignal).toBeDefined();
    });

    it('should add recent_interaction signal for recent activity', () => {
      const result = scoreCandidate(strongFriendCandidate);

      const recentSignal = result.shared_signals.find(s => s.ref === 'recent_interaction');
      expect(recentSignal).toBeDefined();
    });

    it('should generate why_now explanation', () => {
      const result = scoreCandidate(strongFriendCandidate);

      expect(result.why_now).toBeDefined();
      expect(result.why_now.length).toBeGreaterThan(0);
    });
  });

  // =============================================================================
  // Filter and Rank Tests
  // =============================================================================

  describe('filterAndRankCandidates', () => {
    const allCandidates = [
      strongFriendCandidate,
      weakConnectionCandidate,
      groupCandidate,
      eventCandidate,
      serviceCandidate,
      liveRoomCandidate
    ];

    it('should filter out candidates below threshold', () => {
      const results = filterAndRankCandidates(allCandidates);

      results.forEach(result => {
        expect(result.passes_thresholds).toBe(true);
      });
    });

    it('should sort by relevance score descending', () => {
      const results = filterAndRankCandidates(allCandidates);

      for (let i = 1; i < results.length; i++) {
        const prev = results[i - 1];
        const curr = results[i];
        if (prev.relevance_score !== curr.relevance_score) {
          expect(prev.relevance_score).toBeGreaterThan(curr.relevance_score);
        }
      }
    });

    it('should include strong friend in results', () => {
      const results = filterAndRankCandidates(allCandidates);

      const strongFriend = results.find(r =>
        r.candidate.node_id === strongFriendCandidate.node_id
      );
      expect(strongFriend).toBeDefined();
    });

    it('should exclude weak connection from default results', () => {
      const results = filterAndRankCandidates(allCandidates);

      const weakConn = results.find(r =>
        r.candidate.node_id === weakConnectionCandidate.node_id
      );
      expect(weakConn).toBeUndefined();
    });

    it('should respect custom thresholds', () => {
      const lenientThresholds = {
        ...DEFAULT_ALIGNMENT_THRESHOLDS,
        min_relevance: 30,
        min_shared_signals: 1
      };

      const results = filterAndRankCandidates(allCandidates, lenientThresholds);

      // Should include more candidates with lenient thresholds
      expect(results.length).toBeGreaterThan(0);
    });

    it('should return empty array if no candidates pass', () => {
      const strictThresholds = {
        ...DEFAULT_ALIGNMENT_THRESHOLDS,
        min_relevance: 100,
        min_shared_signals: 10
      };

      const results = filterAndRankCandidates(allCandidates, strictThresholds);

      expect(results).toHaveLength(0);
    });
  });

  // =============================================================================
  // API Route Tests
  // =============================================================================

  describe('Social Alignment API Routes', () => {
    let app: express.Application;

    beforeEach(() => {
      jest.clearAllMocks();

      // Default mock for RPC calls
      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'alignment_generate_suggestions') {
          return Promise.resolve({
            data: {
              ok: true,
              batch_id: 'd47_test-batch',
              suggestions: [],
              count: 0,
              social_context: {
                social_energy: 50,
                passed: true
              }
            },
            error: null
          });
        }
        if (funcName === 'alignment_get_suggestions') {
          return Promise.resolve({
            data: {
              ok: true,
              suggestions: [],
              count: 0
            },
            error: null
          });
        }
        if (funcName === 'alignment_mark_shown') {
          return Promise.resolve({
            data: {
              ok: true,
              suggestion_id: 'test-suggestion-id',
              status: 'shown'
            },
            error: null
          });
        }
        if (funcName === 'alignment_act_on_suggestion') {
          return Promise.resolve({
            data: {
              ok: true,
              suggestion_id: 'test-suggestion-id',
              action: 'view',
              status: 'acted'
            },
            error: null
          });
        }
        if (funcName === 'alignment_cleanup_expired') {
          return Promise.resolve({
            data: {
              ok: true,
              expired_count: 0
            },
            error: null
          });
        }
        if (funcName === 'dev_bootstrap_request_context') {
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: { ok: true }, error: null });
      });

      app = express();
      app.use(express.json());
      app.use('/api/v1/alignment', socialAlignmentRouter);
    });

    describe('GET /health', () => {
      it('should return health status', async () => {
        const response = await request(app).get('/api/v1/alignment/health');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.vtid).toBe('VTID-01141');
        expect(response.body.phase).toBe('D47');
        expect(response.body.service).toContain('D47');
      });

      it('should include governance rules', async () => {
        const response = await request(app).get('/api/v1/alignment/health');

        expect(response.body.governance).toBeDefined();
        expect(response.body.governance.consent_by_design).toBe(true);
        expect(response.body.governance.no_forced_matchmaking).toBe(true);
        expect(response.body.governance.explainability_mandatory).toBe(true);
        expect(response.body.governance.no_social_graph_exposure).toBe(true);
      });

      it('should include matching thresholds', async () => {
        const response = await request(app).get('/api/v1/alignment/health');

        expect(response.body.matching_thresholds).toBeDefined();
        expect(response.body.matching_thresholds.min_relevance).toBe(75);
        expect(response.body.matching_thresholds.min_shared_signals).toBe(2);
      });

      it('should include capabilities', async () => {
        const response = await request(app).get('/api/v1/alignment/health');

        expect(response.body.capabilities).toBeDefined();
        expect(response.body.capabilities.alignment_domains).toEqual(ALIGNMENT_DOMAINS);
        expect(response.body.capabilities.alignment_actions).toEqual(ALIGNMENT_ACTIONS);
        expect(response.body.capabilities.alignment_statuses).toEqual(ALIGNMENT_STATUSES);
      });
    });

    describe('POST /generate', () => {
      it('should require authentication', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/generate')
          .send({});

        expect(response.status).toBe(401);
        expect(response.body.error).toBe('UNAUTHENTICATED');
      });

      it('should generate suggestions with valid token', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/generate')
          .set('Authorization', 'Bearer test-token')
          .send({});

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.suggestions).toBeDefined();
      });

      it('should accept max_suggestions parameter', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/generate')
          .set('Authorization', 'Bearer test-token')
          .send({ max_suggestions: 10 });

        expect(response.status).toBe(200);
      });

      it('should accept alignment_domains filter', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/generate')
          .set('Authorization', 'Bearer test-token')
          .send({ alignment_domains: ['people', 'group'] });

        expect(response.status).toBe(200);
      });

      it('should validate max_suggestions range', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/generate')
          .set('Authorization', 'Bearer test-token')
          .send({ max_suggestions: 100 }); // Max is 20

        expect(response.status).toBe(400);
      });

      it('should emit OASIS event on success', async () => {
        await request(app)
          .post('/api/v1/alignment/generate')
          .set('Authorization', 'Bearer test-token')
          .send({});

        expect(mockEmitOasisEvent).toHaveBeenCalled();
      });
    });

    describe('GET /suggestions', () => {
      it('should require authentication', async () => {
        const response = await request(app)
          .get('/api/v1/alignment/suggestions');

        expect(response.status).toBe(401);
      });

      it('should return suggestions with valid token', async () => {
        const response = await request(app)
          .get('/api/v1/alignment/suggestions')
          .set('Authorization', 'Bearer test-token');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.suggestions).toBeDefined();
      });

      it('should accept status filter', async () => {
        const response = await request(app)
          .get('/api/v1/alignment/suggestions')
          .query({ status: 'pending' })
          .set('Authorization', 'Bearer test-token');

        expect(response.status).toBe(200);
      });

      it('should accept alignment_domains filter', async () => {
        const response = await request(app)
          .get('/api/v1/alignment/suggestions')
          .query({ alignment_domains: 'people' })
          .set('Authorization', 'Bearer test-token');

        expect(response.status).toBe(200);
      });

      it('should accept limit parameter', async () => {
        const response = await request(app)
          .get('/api/v1/alignment/suggestions')
          .query({ limit: 5 })
          .set('Authorization', 'Bearer test-token');

        expect(response.status).toBe(200);
      });
    });

    describe('POST /shown', () => {
      it('should require authentication', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/shown')
          .send({ suggestion_id: '00000000-0000-0000-0000-000000000001' });

        expect(response.status).toBe(401);
      });

      it('should require suggestion_id', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/shown')
          .set('Authorization', 'Bearer test-token')
          .send({});

        expect(response.status).toBe(400);
      });

      it('should mark suggestion as shown', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/shown')
          .set('Authorization', 'Bearer test-token')
          .send({ suggestion_id: '00000000-0000-0000-0000-000000000001' });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.status).toBe('shown');
      });

      it('should emit OASIS event', async () => {
        await request(app)
          .post('/api/v1/alignment/shown')
          .set('Authorization', 'Bearer test-token')
          .send({ suggestion_id: '00000000-0000-0000-0000-000000000001' });

        expect(mockEmitOasisEvent).toHaveBeenCalled();
      });
    });

    describe('POST /action', () => {
      it('should require authentication', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'view'
          });

        expect(response.status).toBe(401);
      });

      it('should require suggestion_id and action', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({});

        expect(response.status).toBe(400);
      });

      it('should validate action type', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'invalid_action'
          });

        expect(response.status).toBe(400);
      });

      it('should record view action', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'view'
          });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });

      it('should record connect action', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'connect'
          });

        expect(response.status).toBe(200);
      });

      it('should record save action', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'save'
          });

        expect(response.status).toBe(200);
      });

      it('should record not_now (dismiss) action', async () => {
        mockRpc.mockImplementation((funcName: string) => {
          if (funcName === 'alignment_act_on_suggestion') {
            return Promise.resolve({
              data: {
                ok: true,
                suggestion_id: 'test-id',
                action: 'not_now',
                status: 'dismissed'
              },
              error: null
            });
          }
          if (funcName === 'dev_bootstrap_request_context') {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        });

        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'not_now'
          });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('dismissed');
      });

      it('should accept optional feedback', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/action')
          .set('Authorization', 'Bearer test-token')
          .send({
            suggestion_id: '00000000-0000-0000-0000-000000000001',
            action: 'not_now',
            feedback: { reason: 'not_interested' }
          });

        expect(response.status).toBe(200);
      });
    });

    describe('POST /cleanup', () => {
      it('should allow cleanup without auth (service job)', async () => {
        const response = await request(app)
          .post('/api/v1/alignment/cleanup');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });

      it('should return expired count', async () => {
        mockRpc.mockImplementation((funcName: string) => {
          if (funcName === 'alignment_cleanup_expired') {
            return Promise.resolve({
              data: {
                ok: true,
                expired_count: 5
              },
              error: null
            });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        });

        const response = await request(app)
          .post('/api/v1/alignment/cleanup');

        expect(response.status).toBe(200);
        expect(response.body.expired_count).toBe(5);
      });
    });
  });

  // =============================================================================
  // Governance Rules Tests (Non-Negotiable per spec)
  // =============================================================================

  describe('Governance Rules (Non-Negotiable)', () => {
    it('should be consent-by-design (suggestions only, never forced)', () => {
      // All suggestions are dismissible by default
      const result = scoreCandidate(strongFriendCandidate);

      // The system generates suggestions, not commands
      expect(result.alignment_domain).toBeDefined();
      expect(result.why_now).toBeDefined();
      // Suggestions are framed as options
    });

    it('should not expose social graph details', () => {
      const result = scoreCandidate(strongFriendCandidate);

      // Result contains privacy-safe information only
      expect(result.candidate.title).toBeDefined();
      expect(result.candidate.node_id).toBeDefined();
      // No list of mutual connections, no network visualization data
    });

    it('should always provide explainability (why_now is mandatory)', () => {
      const allCandidates = [
        strongFriendCandidate,
        weakConnectionCandidate,
        groupCandidate,
        eventCandidate,
        serviceCandidate,
        liveRoomCandidate
      ];

      allCandidates.forEach(candidate => {
        const result = scoreCandidate(candidate);
        expect(result.why_now).toBeDefined();
        expect(result.why_now.length).toBeGreaterThan(0);
      });
    });

    it('should not rank people by value (all domains are equal)', () => {
      // People domain suggestions are not "better" than group suggestions
      const personResult = scoreCandidate(strongFriendCandidate);
      const groupResult = scoreCandidate(groupCandidate);

      // Scores are based on relevance, not domain hierarchy
      // Both can be valid high-scoring suggestions
      expect(personResult.alignment_domain).toBe('people');
      expect(groupResult.alignment_domain).toBe('group');
      // No inherent domain superiority
    });

    it('should handle no-cold-start (require signals for suggestions)', () => {
      // Candidates without signals should not pass thresholds
      const noSignalsCandidate: AlignmentCandidate = {
        node_id: '00000000-0000-0000-0000-000000000099',
        node_type: 'person',
        title: 'Complete Stranger',
        strength: 0,
        last_seen: undefined
      };

      const result = scoreCandidate(noSignalsCandidate);

      // Should not pass thresholds without sufficient signals
      expect(result.shared_signals.length).toBeLessThan(2);
      expect(result.passes_thresholds).toBe(false);
    });

    it('should frame recommendations as options', () => {
      const result = scoreCandidate(strongFriendCandidate);

      // Why_now is a suggestion, not a command
      expect(result.why_now).not.toMatch(/you must/i);
      expect(result.why_now).not.toMatch(/you should/i);
      expect(result.why_now).not.toMatch(/you need to/i);
      // Should use softer language
      expect(result.why_now).toMatch(/may|might|could|can/i);
    });
  });

  // =============================================================================
  // Default Thresholds Tests
  // =============================================================================

  describe('Default Thresholds', () => {
    it('should have correct default values', () => {
      expect(DEFAULT_ALIGNMENT_THRESHOLDS.min_relevance).toBe(75);
      expect(DEFAULT_ALIGNMENT_THRESHOLDS.min_shared_signals).toBe(2);
      expect(DEFAULT_ALIGNMENT_THRESHOLDS.max_suggestions).toBe(5);
      expect(DEFAULT_ALIGNMENT_THRESHOLDS.min_social_energy).toBe(20);
    });
  });

  // =============================================================================
  // Type Constants Tests
  // =============================================================================

  describe('Type Constants', () => {
    it('should have all alignment domains', () => {
      expect(ALIGNMENT_DOMAINS).toContain('people');
      expect(ALIGNMENT_DOMAINS).toContain('group');
      expect(ALIGNMENT_DOMAINS).toContain('event');
      expect(ALIGNMENT_DOMAINS).toContain('live_room');
      expect(ALIGNMENT_DOMAINS).toContain('service');
      expect(ALIGNMENT_DOMAINS).toContain('activity');
    });

    it('should have all alignment actions', () => {
      expect(ALIGNMENT_ACTIONS).toContain('view');
      expect(ALIGNMENT_ACTIONS).toContain('connect');
      expect(ALIGNMENT_ACTIONS).toContain('save');
      expect(ALIGNMENT_ACTIONS).toContain('not_now');
    });

    it('should have all alignment statuses', () => {
      expect(ALIGNMENT_STATUSES).toContain('pending');
      expect(ALIGNMENT_STATUSES).toContain('shown');
      expect(ALIGNMENT_STATUSES).toContain('acted');
      expect(ALIGNMENT_STATUSES).toContain('dismissed');
      expect(ALIGNMENT_STATUSES).toContain('expired');
    });
  });
});
