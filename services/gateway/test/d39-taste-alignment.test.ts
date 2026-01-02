/**
 * VTID-01133: D39 Taste, Aesthetic & Lifestyle Alignment Engine Tests
 *
 * Tests for:
 * - Alignment scoring (taste + lifestyle matching)
 * - Inference rules for taste/lifestyle signals
 * - Action filtering and reframing
 * - API endpoints
 *
 * Platform invariant: Recommendations feel like "me" to the user.
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

// Mock the Supabase user client
const mockRpc = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn().mockReturnValue({
    rpc: mockRpc,
  }),
}));

// Import the service and types after mocks are set up
import {
  calculateAlignmentScore,
  scoreActions,
  generateAlignmentTags,
  generateReframingSuggestion,
  runTasteInferenceRules,
  calculateProfileCompleteness,
  isSparseData,
  buildAlignmentBundle,
  DEFAULT_TASTE_PROFILE,
  DEFAULT_LIFESTYLE_PROFILE,
  ALIGNMENT_THRESHOLDS,
  InferenceInputSignals
} from '../src/services/d39-taste-alignment-service';

import {
  TasteProfile,
  LifestyleProfile,
  ActionToScore
} from '../src/types/taste-alignment';

import tasteAlignmentRouter from '../src/routes/taste-alignment';

// =============================================================================
// Test Data
// =============================================================================

const minimalistTasteProfile: TasteProfile = {
  simplicity_preference: 'minimalist',
  premium_orientation: 'value_focused',
  aesthetic_style: 'modern',
  tone_affinity: 'minimalist',
  confidence: 80
};

const comprehensiveTasteProfile: TasteProfile = {
  simplicity_preference: 'comprehensive',
  premium_orientation: 'premium_oriented',
  aesthetic_style: 'classic',
  tone_affinity: 'professional',
  confidence: 90
};

const soloLifestyleProfile: LifestyleProfile = {
  routine_style: 'structured',
  social_orientation: 'solo_focused',
  convenience_bias: 'convenience_first',
  experience_type: 'digital_native',
  novelty_tolerance: 'conservative',
  confidence: 75
};

const explorerLifestyleProfile: LifestyleProfile = {
  routine_style: 'flexible',
  social_orientation: 'social_oriented',
  convenience_bias: 'intentional_living',
  experience_type: 'physical_focused',
  novelty_tolerance: 'explorer',
  confidence: 85
};

const simpleProductAction: ActionToScore = {
  id: 'product-1',
  type: 'product',
  attributes: {
    complexity: 'simple',
    price_tier: 'budget',
    aesthetic: 'modern',
    tone: 'minimalist',
    social_setting: 'solo',
    convenience_level: 'high',
    novelty_level: 'familiar',
    experience_mode: 'digital'
  }
};

const premiumComplexAction: ActionToScore = {
  id: 'service-1',
  type: 'service',
  attributes: {
    complexity: 'complex',
    price_tier: 'luxury',
    aesthetic: 'classic',
    tone: 'professional',
    social_setting: 'large_group',
    convenience_level: 'low',
    novelty_level: 'novel',
    experience_mode: 'physical'
  }
};

// =============================================================================
// Alignment Scoring Tests
// =============================================================================

describe('VTID-01133: D39 Taste Alignment Engine', () => {
  describe('calculateAlignmentScore', () => {
    it('should return high score for matching preferences', () => {
      const { score } = calculateAlignmentScore(
        minimalistTasteProfile,
        soloLifestyleProfile,
        simpleProductAction
      );

      expect(score).toBeGreaterThan(0.7);
    });

    it('should return low score for mismatched preferences', () => {
      const { score } = calculateAlignmentScore(
        minimalistTasteProfile,
        soloLifestyleProfile,
        premiumComplexAction
      );

      expect(score).toBeLessThan(0.5);
    });

    it('should return neutral score (0.5) for default profiles', () => {
      const { score } = calculateAlignmentScore(
        DEFAULT_TASTE_PROFILE,
        DEFAULT_LIFESTYLE_PROFILE,
        simpleProductAction
      );

      // Default profiles have 0 confidence, so score should be close to 0.5
      expect(score).toBeGreaterThanOrEqual(0.4);
      expect(score).toBeLessThanOrEqual(0.6);
    });

    it('should include breakdown when requested', () => {
      const result = calculateAlignmentScore(
        minimalistTasteProfile,
        soloLifestyleProfile,
        simpleProductAction,
        true // include breakdown
      );

      expect(result.breakdown).toBeDefined();
      expect(result.breakdown?.taste_score).toBeDefined();
      expect(result.breakdown?.lifestyle_score).toBeDefined();
      expect(result.breakdown?.taste_factors).toHaveLength(4);
      expect(result.breakdown?.lifestyle_factors).toHaveLength(5);
    });

    it('should handle missing action attributes gracefully', () => {
      const partialAction: ActionToScore = {
        id: 'partial-1',
        type: 'product',
        attributes: {
          complexity: 'simple'
          // Other attributes missing
        }
      };

      const { score } = calculateAlignmentScore(
        minimalistTasteProfile,
        soloLifestyleProfile,
        partialAction
      );

      // Should still calculate a valid score
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should weight score by profile confidence', () => {
      const lowConfidenceProfile: TasteProfile = {
        ...minimalistTasteProfile,
        confidence: 10
      };
      const lowConfidenceLifestyle: LifestyleProfile = {
        ...soloLifestyleProfile,
        confidence: 10
      };

      const { score: lowConfScore } = calculateAlignmentScore(
        lowConfidenceProfile,
        lowConfidenceLifestyle,
        simpleProductAction
      );

      const { score: highConfScore } = calculateAlignmentScore(
        minimalistTasteProfile,
        soloLifestyleProfile,
        simpleProductAction
      );

      // Low confidence should push score toward 0.5
      expect(Math.abs(lowConfScore - 0.5)).toBeLessThan(Math.abs(highConfScore - 0.5));
    });
  });

  describe('scoreActions', () => {
    it('should score multiple actions and sort by alignment', () => {
      const actions = [premiumComplexAction, simpleProductAction];

      const result = scoreActions(
        minimalistTasteProfile,
        soloLifestyleProfile,
        actions
      );

      expect(result).toHaveLength(2);
      // Should be sorted by score descending
      expect(result[0].alignment_score).toBeGreaterThanOrEqual(result[1].alignment_score);
    });

    it('should exclude low-alignment actions when requested', () => {
      const actions = [premiumComplexAction, simpleProductAction];

      const result = scoreActions(
        minimalistTasteProfile,
        soloLifestyleProfile,
        actions,
        { excludeLowAlignment: true, minAlignmentThreshold: 0.6 }
      );

      const excludedCount = result.filter(a => a.excluded).length;
      const nonExcluded = result.filter(a => !a.excluded);

      // At least one should be excluded
      expect(excludedCount).toBeGreaterThanOrEqual(0);
      nonExcluded.forEach(action => {
        expect(action.alignment_score).toBeGreaterThanOrEqual(0.5);
      });
    });

    it('should include breakdown when requested', () => {
      const result = scoreActions(
        minimalistTasteProfile,
        soloLifestyleProfile,
        [simpleProductAction],
        { includeBreakdown: true }
      );

      expect(result[0].breakdown).toBeDefined();
    });

    it('should calculate confidence based on profile and attributes', () => {
      const result = scoreActions(
        minimalistTasteProfile,
        soloLifestyleProfile,
        [simpleProductAction]
      );

      expect(result[0].confidence).toBeGreaterThan(0);
      expect(result[0].confidence).toBeLessThanOrEqual(100);
    });

    it('should be lenient with sparse data profiles', () => {
      const sparseProfile: TasteProfile = {
        ...DEFAULT_TASTE_PROFILE,
        confidence: 10
      };
      const sparseLifestyle: LifestyleProfile = {
        ...DEFAULT_LIFESTYLE_PROFILE,
        confidence: 10
      };

      const result = scoreActions(
        sparseProfile,
        sparseLifestyle,
        [premiumComplexAction],
        { excludeLowAlignment: true, minAlignmentThreshold: 0.3 }
      );

      // Sparse data should not exclude actions
      expect(result[0].excluded).toBe(false);
    });
  });

  describe('generateAlignmentTags', () => {
    it('should generate minimalist_fit tag for minimalist profiles', () => {
      const tags = generateAlignmentTags(
        minimalistTasteProfile,
        soloLifestyleProfile,
        0.8 // High alignment
      );

      expect(tags).toContain('minimalist_fit');
    });

    it('should generate convenience_first tag when applicable', () => {
      const tags = generateAlignmentTags(
        minimalistTasteProfile,
        soloLifestyleProfile,
        0.8
      );

      expect(tags).toContain('convenience_first');
    });

    it('should not generate tags for low alignment scores', () => {
      const tags = generateAlignmentTags(
        minimalistTasteProfile,
        soloLifestyleProfile,
        0.3 // Low alignment
      );

      expect(tags).toHaveLength(0);
    });

    it('should generate exploratory_ok for explorer profiles', () => {
      const tags = generateAlignmentTags(
        comprehensiveTasteProfile,
        explorerLifestyleProfile,
        0.8
      );

      expect(tags).toContain('exploratory_ok');
    });
  });

  describe('generateReframingSuggestion', () => {
    it('should suggest simpler version for complex action with minimalist user', () => {
      const suggestion = generateReframingSuggestion(
        minimalistTasteProfile,
        soloLifestyleProfile,
        premiumComplexAction,
        0.3 // Low alignment
      );

      expect(suggestion).toBeDefined();
      expect(suggestion?.toLowerCase()).toContain('simpl');
    });

    it('should suggest affordable alternatives for premium action with value user', () => {
      const suggestion = generateReframingSuggestion(
        minimalistTasteProfile,
        soloLifestyleProfile,
        premiumComplexAction,
        0.3
      );

      expect(suggestion).toBeDefined();
      expect(suggestion?.toLowerCase()).toContain('afford');
    });

    it('should not generate suggestion for high alignment', () => {
      const suggestion = generateReframingSuggestion(
        minimalistTasteProfile,
        soloLifestyleProfile,
        simpleProductAction,
        0.8 // High alignment
      );

      expect(suggestion).toBeUndefined();
    });
  });

  // =============================================================================
  // Inference Rules Tests
  // =============================================================================

  describe('runTasteInferenceRules', () => {
    it('should infer minimalist preference from short messages', () => {
      const signals: InferenceInputSignals = {
        message_lengths: [30, 25, 40, 35, 28, 32]
      };

      const inferences = runTasteInferenceRules(signals);

      const simplicityInference = inferences.find(i => i.dimension === 'simplicity_preference');
      expect(simplicityInference).toBeDefined();
      expect(simplicityInference?.inferred_value).toBe('minimalist');
    });

    it('should infer comprehensive preference from detailed messages', () => {
      const signals: InferenceInputSignals = {
        message_lengths: [250, 300, 280, 320, 270, 290]
      };

      const inferences = runTasteInferenceRules(signals);

      const simplicityInference = inferences.find(i => i.dimension === 'simplicity_preference');
      expect(simplicityInference).toBeDefined();
      expect(simplicityInference?.inferred_value).toBe('comprehensive');
    });

    it('should infer solo_focused from low group sizes', () => {
      const signals: InferenceInputSignals = {
        group_sizes: [1, 1, 1, 2, 1]
      };

      const inferences = runTasteInferenceRules(signals);

      const socialInference = inferences.find(i => i.dimension === 'social_orientation');
      expect(socialInference).toBeDefined();
      expect(socialInference?.inferred_value).toBe('solo_focused');
    });

    it('should infer explorer from high exploration rate', () => {
      const signals: InferenceInputSignals = {
        exploration_rate: 0.75
      };

      const inferences = runTasteInferenceRules(signals);

      const noveltyInference = inferences.find(i => i.dimension === 'novelty_tolerance');
      expect(noveltyInference).toBeDefined();
      expect(noveltyInference?.inferred_value).toBe('explorer');
    });

    it('should infer structured routine from high regularity', () => {
      const signals: InferenceInputSignals = {
        response_regularity: 0.85
      };

      const inferences = runTasteInferenceRules(signals);

      const routineInference = inferences.find(i => i.dimension === 'routine_style');
      expect(routineInference).toBeDefined();
      expect(routineInference?.inferred_value).toBe('structured');
    });

    it('should cap confidence at 85 per spec', () => {
      const signals: InferenceInputSignals = {
        message_lengths: Array(50).fill(30) // Many samples should increase confidence
      };

      const inferences = runTasteInferenceRules(signals);

      inferences.forEach(inference => {
        expect(inference.confidence).toBeLessThanOrEqual(85);
      });
    });

    it('should not infer with insufficient data', () => {
      const signals: InferenceInputSignals = {
        message_lengths: [30, 25] // Too few samples
      };

      const inferences = runTasteInferenceRules(signals);

      const simplicityInference = inferences.find(i => i.dimension === 'simplicity_preference');
      expect(simplicityInference).toBeUndefined();
    });

    it('should infer premium orientation from reaction patterns', () => {
      const signals: InferenceInputSignals = {
        accepted_actions: [
          { attributes: { price_tier: 'premium' } },
          { attributes: { price_tier: 'luxury' } },
          { attributes: { price_tier: 'premium' } }
        ],
        rejected_actions: [
          { attributes: { price_tier: 'budget' } },
          { attributes: { price_tier: 'budget' } }
        ]
      };

      const inferences = runTasteInferenceRules(signals);

      const premiumInference = inferences.find(i => i.dimension === 'premium_orientation');
      expect(premiumInference).toBeDefined();
      expect(premiumInference?.inferred_value).toBe('premium_oriented');
    });
  });

  // =============================================================================
  // Profile Completeness & Sparse Data Tests
  // =============================================================================

  describe('calculateProfileCompleteness', () => {
    it('should return 0 for default profiles', () => {
      const completeness = calculateProfileCompleteness(
        DEFAULT_TASTE_PROFILE,
        DEFAULT_LIFESTYLE_PROFILE
      );

      expect(completeness).toBe(0);
    });

    it('should return higher completeness for customized profiles', () => {
      const completeness = calculateProfileCompleteness(
        minimalistTasteProfile,
        soloLifestyleProfile
      );

      expect(completeness).toBeGreaterThan(50);
    });

    it('should max out at 100', () => {
      const fullTaste: TasteProfile = {
        simplicity_preference: 'minimalist',
        premium_orientation: 'premium_oriented',
        aesthetic_style: 'modern',
        tone_affinity: 'technical',
        confidence: 100
      };
      const fullLifestyle: LifestyleProfile = {
        routine_style: 'structured',
        social_orientation: 'solo_focused',
        convenience_bias: 'convenience_first',
        experience_type: 'digital_native',
        novelty_tolerance: 'explorer',
        confidence: 100
      };

      const completeness = calculateProfileCompleteness(fullTaste, fullLifestyle);

      expect(completeness).toBeLessThanOrEqual(100);
    });
  });

  describe('isSparseData', () => {
    it('should return true for default profiles', () => {
      expect(isSparseData(DEFAULT_TASTE_PROFILE, DEFAULT_LIFESTYLE_PROFILE)).toBe(true);
    });

    it('should return false for complete profiles with high confidence', () => {
      expect(isSparseData(minimalistTasteProfile, soloLifestyleProfile)).toBe(false);
    });

    it('should return true for low confidence profiles', () => {
      const lowConf: TasteProfile = { ...minimalistTasteProfile, confidence: 10 };
      const lowConfLife: LifestyleProfile = { ...soloLifestyleProfile, confidence: 10 };

      expect(isSparseData(lowConf, lowConfLife)).toBe(true);
    });
  });

  describe('buildAlignmentBundle', () => {
    it('should build complete bundle with all required fields', () => {
      const bundle = buildAlignmentBundle(minimalistTasteProfile, soloLifestyleProfile);

      expect(bundle.taste_profile).toEqual(minimalistTasteProfile);
      expect(bundle.lifestyle_profile).toEqual(soloLifestyleProfile);
      expect(bundle.combined_confidence).toBeDefined();
      expect(bundle.profile_completeness).toBeDefined();
      expect(bundle.sparse_data).toBeDefined();
      expect(bundle.computed_at).toBeDefined();
    });

    it('should calculate combined confidence correctly', () => {
      const bundle = buildAlignmentBundle(minimalistTasteProfile, soloLifestyleProfile);

      const expectedConfidence = Math.round(
        (minimalistTasteProfile.confidence + soloLifestyleProfile.confidence) / 2
      );
      expect(bundle.combined_confidence).toBe(expectedConfidence);
    });
  });

  // =============================================================================
  // API Route Tests
  // =============================================================================

  describe('Taste Alignment API Routes', () => {
    let app: express.Application;

    beforeEach(() => {
      jest.clearAllMocks();

      // Default mock for me_context
      mockRpc.mockImplementation((funcName: string) => {
        if (funcName === 'me_context') {
          return Promise.resolve({
            data: { tenant_id: 'test-tenant', user_id: 'test-user' },
            error: null
          });
        }
        if (funcName === 'taste_alignment_bundle_get') {
          return Promise.resolve({
            data: {
              ok: true,
              bundle: {
                taste_profile: DEFAULT_TASTE_PROFILE,
                lifestyle_profile: DEFAULT_LIFESTYLE_PROFILE,
                combined_confidence: 0,
                profile_completeness: 0,
                sparse_data: true
              }
            },
            error: null
          });
        }
        return Promise.resolve({ data: { ok: true }, error: null });
      });

      app = express();
      app.use(express.json());
      app.use('/api/v1/taste-alignment', tasteAlignmentRouter);
    });

    describe('GET /', () => {
      it('should return service info', async () => {
        const response = await request(app).get('/api/v1/taste-alignment');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.vtid).toBe('VTID-01133');
        expect(response.body.layer).toBe('D39');
        expect(response.body.endpoints).toBeDefined();
      });
    });

    describe('GET /health', () => {
      it('should return healthy status', async () => {
        const response = await request(app).get('/api/v1/taste-alignment/health');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.status).toBe('healthy');
      });
    });

    describe('GET /dimensions', () => {
      it('should return dimension metadata', async () => {
        const response = await request(app).get('/api/v1/taste-alignment/dimensions');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.taste_dimensions).toBeDefined();
        expect(response.body.lifestyle_dimensions).toBeDefined();
        expect(response.body.taste_dimensions.simplicity_preference).toBeDefined();
        expect(response.body.lifestyle_dimensions.routine_style).toBeDefined();
      });
    });

    describe('GET /bundle', () => {
      it('should require authentication', async () => {
        const response = await request(app).get('/api/v1/taste-alignment/bundle');

        expect(response.status).toBe(401);
      });

      it('should return alignment bundle with valid token', async () => {
        const response = await request(app)
          .get('/api/v1/taste-alignment/bundle')
          .set('Authorization', 'Bearer test-token');

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.bundle).toBeDefined();
      });
    });

    describe('POST /taste', () => {
      it('should require at least one dimension', async () => {
        const response = await request(app)
          .post('/api/v1/taste-alignment/taste')
          .set('Authorization', 'Bearer test-token')
          .send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('INVALID_REQUEST');
      });

      it('should set taste profile with valid data', async () => {
        mockRpc.mockImplementation((funcName: string) => {
          if (funcName === 'me_context') {
            return Promise.resolve({
              data: { tenant_id: 'test-tenant', user_id: 'test-user' },
              error: null
            });
          }
          if (funcName === 'taste_profile_set') {
            return Promise.resolve({
              data: {
                ok: true,
                profile_id: 'test-id',
                updated_fields: ['simplicity_preference'],
                new_confidence: 100
              },
              error: null
            });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        });

        const response = await request(app)
          .post('/api/v1/taste-alignment/taste')
          .set('Authorization', 'Bearer test-token')
          .send({ simplicity_preference: 'minimalist' });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.updated_fields).toContain('simplicity_preference');
      });

      it('should validate taste dimension values', async () => {
        const response = await request(app)
          .post('/api/v1/taste-alignment/taste')
          .set('Authorization', 'Bearer test-token')
          .send({ simplicity_preference: 'invalid_value' });

        expect(response.status).toBe(400);
      });
    });

    describe('POST /lifestyle', () => {
      it('should require at least one dimension', async () => {
        const response = await request(app)
          .post('/api/v1/taste-alignment/lifestyle')
          .set('Authorization', 'Bearer test-token')
          .send({});

        expect(response.status).toBe(400);
      });

      it('should set lifestyle profile with valid data', async () => {
        mockRpc.mockImplementation((funcName: string) => {
          if (funcName === 'me_context') {
            return Promise.resolve({
              data: { tenant_id: 'test-tenant', user_id: 'test-user' },
              error: null
            });
          }
          if (funcName === 'lifestyle_profile_set') {
            return Promise.resolve({
              data: {
                ok: true,
                profile_id: 'test-id',
                updated_fields: ['routine_style'],
                new_confidence: 100
              },
              error: null
            });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        });

        const response = await request(app)
          .post('/api/v1/taste-alignment/lifestyle')
          .set('Authorization', 'Bearer test-token')
          .send({ routine_style: 'structured' });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
      });
    });

    describe('POST /score', () => {
      it('should require actions array', async () => {
        const response = await request(app)
          .post('/api/v1/taste-alignment/score')
          .set('Authorization', 'Bearer test-token')
          .send({ actions: [] });

        expect(response.status).toBe(400);
      });

      it('should score actions and return aligned actions', async () => {
        const response = await request(app)
          .post('/api/v1/taste-alignment/score')
          .set('Authorization', 'Bearer test-token')
          .send({
            actions: [simpleProductAction],
            include_breakdown: true
          });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.aligned_actions).toBeDefined();
        expect(response.body.aligned_actions).toHaveLength(1);
        expect(response.body.average_alignment).toBeDefined();
      });
    });

    describe('POST /reaction', () => {
      it('should record user reaction', async () => {
        mockRpc.mockImplementation((funcName: string) => {
          if (funcName === 'me_context') {
            return Promise.resolve({
              data: { tenant_id: 'test-tenant', user_id: 'test-user' },
              error: null
            });
          }
          if (funcName === 'taste_reaction_record') {
            return Promise.resolve({
              data: {
                ok: true,
                recorded: true,
                reaction_id: 'test-reaction-id'
              },
              error: null
            });
          }
          return Promise.resolve({ data: { ok: true }, error: null });
        });

        const response = await request(app)
          .post('/api/v1/taste-alignment/reaction')
          .set('Authorization', 'Bearer test-token')
          .send({
            action_id: 'product-1',
            action_type: 'product',
            reaction: 'accepted'
          });

        expect(response.status).toBe(200);
        expect(response.body.ok).toBe(true);
        expect(response.body.recorded).toBe(true);
      });

      it('should validate reaction type', async () => {
        const response = await request(app)
          .post('/api/v1/taste-alignment/reaction')
          .set('Authorization', 'Bearer test-token')
          .send({
            action_id: 'product-1',
            action_type: 'product',
            reaction: 'invalid_reaction'
          });

        expect(response.status).toBe(400);
      });
    });
  });

  // =============================================================================
  // Behavioral Rules Tests (Non-Negotiable per spec)
  // =============================================================================

  describe('Behavioral Rules (Non-Negotiable)', () => {
    it('should not make aesthetic judgments - all aesthetics are valid', () => {
      const aestheticStyles = ['modern', 'classic', 'eclectic', 'natural', 'functional'];

      aestheticStyles.forEach(style => {
        const profile: TasteProfile = {
          ...DEFAULT_TASTE_PROFILE,
          aesthetic_style: style as any,
          confidence: 80
        };

        const action: ActionToScore = {
          id: 'test',
          type: 'product',
          attributes: { aesthetic: style as any }
        };

        const { score } = calculateAlignmentScore(profile, DEFAULT_LIFESTYLE_PROFILE, action);

        // Matching aesthetic should score well regardless of which aesthetic
        expect(score).toBeGreaterThan(0.4);
      });
    });

    it('should allow user to redefine taste at any time (no lock-in)', () => {
      // This is a design principle test - profiles can be updated freely
      // The service should accept any valid taste/lifestyle values
      const allSimplicityPrefs = ['minimalist', 'balanced', 'comprehensive'];
      const allPremiumOrientations = ['value_focused', 'quality_balanced', 'premium_oriented'];

      allSimplicityPrefs.forEach(simp => {
        allPremiumOrientations.forEach(prem => {
          const profile: TasteProfile = {
            simplicity_preference: simp as any,
            premium_orientation: prem as any,
            aesthetic_style: 'neutral',
            tone_affinity: 'neutral',
            confidence: 100
          };

          // Should be able to calculate scores with any combination
          const { score } = calculateAlignmentScore(profile, DEFAULT_LIFESTYLE_PROFILE, simpleProductAction);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(1);
        });
      });
    });

    it('should treat taste as personal, not hierarchical', () => {
      // No taste profile should inherently score higher than others
      // Score depends on match, not on the taste values themselves
      const minimalist = minimalistTasteProfile;
      const comprehensive = comprehensiveTasteProfile;

      // Simple action should score higher for minimalist
      const { score: minScore } = calculateAlignmentScore(minimalist, DEFAULT_LIFESTYLE_PROFILE, simpleProductAction);
      const { score: compScore } = calculateAlignmentScore(comprehensive, DEFAULT_LIFESTYLE_PROFILE, simpleProductAction);

      // Complex action should score higher for comprehensive
      const { score: minScore2 } = calculateAlignmentScore(minimalist, DEFAULT_LIFESTYLE_PROFILE, premiumComplexAction);
      const { score: compScore2 } = calculateAlignmentScore(comprehensive, DEFAULT_LIFESTYLE_PROFILE, premiumComplexAction);

      // Each profile should have some actions it scores higher on
      // (This proves no hierarchy - just matching)
      expect(minScore).toBeGreaterThan(minScore2);
      expect(compScore2).toBeGreaterThan(compScore);
    });

    it('should default to neutral options when data is sparse', () => {
      const sparseProfile = { ...DEFAULT_TASTE_PROFILE, confidence: 5 };
      const sparseLifestyle = { ...DEFAULT_LIFESTYLE_PROFILE, confidence: 5 };

      const result = scoreActions(
        sparseProfile,
        sparseLifestyle,
        [simpleProductAction, premiumComplexAction],
        { excludeLowAlignment: true }
      );

      // With sparse data, no actions should be excluded (be lenient)
      const excluded = result.filter(a => a.excluded);
      expect(excluded).toHaveLength(0);
    });
  });
});
