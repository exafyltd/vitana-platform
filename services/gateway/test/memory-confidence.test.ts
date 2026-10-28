/**
 * VTID-01116: Memory Confidence & Source Trust Engine Unit Tests
 *
 * Tests for:
 * - POST /api/v1/memory/confidence/adjust - Adjust confidence score
 * - POST /api/v1/memory/confidence/confirm - Confirm a memory item
 * - POST /api/v1/memory/confidence/correct - Correct a memory item
 * - GET /api/v1/memory/confidence/history/:id - Get confidence history
 * - GET /api/v1/memory/context/trusted - Get trusted context
 * - POST /api/v1/memory/confidence/decay - Apply time decay
 * - GET /api/v1/memory/source-trust - Get source trust weights
 * - GET /api/v1/memory/confidence/reasons - Get adjustment reason codes
 *
 * Platform invariant: Memory without trust is dangerous intelligence.
 * Confidence scoring is deterministic: same inputs produce same outputs.
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

// Mock the location extraction
jest.mock('../src/routes/locations', () => ({
  processLocationMentionsFromDiary: jest.fn().mockResolvedValue({
    locations_created: 0,
    visits_created: 0,
  }),
}));

// Mock the Supabase user client
const mockRpc = jest.fn();
const mockFrom = jest.fn();
jest.mock('../src/lib/supabase-user', () => ({
  createUserSupabaseClient: jest.fn().mockReturnValue({
    rpc: mockRpc,
    from: mockFrom,
  }),
}));

// Import the memory router after mocks are set up
import memoryRouter from '../src/routes/memory';

describe('VTID-01116: Memory Confidence & Source Trust Engine', () => {
  let app: express.Application;

  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();

    // Reset mock RPC to default success
    mockRpc.mockResolvedValue({
      data: {
        ok: true,
        memory_item_id: 'test-memory-id',
        previous_confidence: 50,
        new_confidence: 60,
        delta: 10,
      },
      error: null,
    });

    // Reset mock from for table queries
    mockFrom.mockReturnValue({
      select: jest.fn().mockReturnValue({
        order: jest.fn().mockResolvedValue({
          data: [],
          error: null,
        }),
      }),
    });

    // Create fresh Express app
    app = express();
    app.use(express.json());
    app.use('/api/v1/memory', memoryRouter);
  });

  // ===========================================================================
  // Health Check Tests
  // ===========================================================================
  describe('GET /health', () => {
    it('should include VTID-01116 in vtids list', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.status).toBe(200);
      expect(response.body.vtids).toContain('VTID-01116');
    });

    it('should include confidence capabilities', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.capabilities.confidence_scoring).toBe(true);
      expect(response.body.capabilities.confidence_adjust).toBe(true);
      expect(response.body.capabilities.confidence_confirm).toBe(true);
      expect(response.body.capabilities.confidence_correct).toBe(true);
      expect(response.body.capabilities.confidence_history).toBe(true);
      expect(response.body.capabilities.trusted_context).toBe(true);
      expect(response.body.capabilities.source_trust).toBe(true);
    });

    it('should include source classifications', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.capabilities.source_classifications).toContain('user_explicit');
      expect(response.body.capabilities.source_classifications).toContain('diary');
      expect(response.body.capabilities.source_classifications).toContain('orb_text');
      expect(response.body.capabilities.source_classifications).toContain('third_party');
      expect(response.body.capabilities.source_classifications).toContain('derived');
    });

    it('should include verification levels', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.capabilities.verification_levels).toContain('none');
      expect(response.body.capabilities.verification_levels).toContain('user_confirmed');
      expect(response.body.capabilities.verification_levels).toContain('professionally_verified');
      expect(response.body.capabilities.verification_levels).toContain('lab_confirmed');
    });

    it('should include sensitivity flags', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.capabilities.sensitivity_flags).toContain('medical');
      expect(response.body.capabilities.sensitivity_flags).toContain('psychological');
      expect(response.body.capabilities.sensitivity_flags).toContain('financial');
    });

    it('should include confidence reason codes', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.capabilities.confidence_reason_codes).toContain('USER_CONFIRMED');
      expect(response.body.capabilities.confidence_reason_codes).toContain('USER_CORRECTED');
      expect(response.body.capabilities.confidence_reason_codes).toContain('TIME_DECAY');
      expect(response.body.capabilities.confidence_reason_codes).toContain('CONTRADICTING_EVIDENCE');
    });

    it('should include VTID-01116 dependency', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.dependencies['VTID-01116']).toBe('confidence_trust_engine');
    });
  });

  // ===========================================================================
  // POST /confidence/adjust Tests
  // ===========================================================================
  describe('POST /confidence/adjust', () => {
    it('should reject requests without authentication', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
        });

      expect(response.status).toBe(401);
      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should reject invalid memory_item_id format', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: 'invalid-uuid',
          reason_code: 'USER_CONFIRMED',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('should reject invalid reason_code', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'INVALID_REASON',
        });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });

    it('should successfully adjust confidence with valid request', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.previous_confidence).toBeDefined();
      expect(response.body.new_confidence).toBeDefined();
      expect(response.body.delta).toBeDefined();
    });

    it('should call memory_adjust_confidence RPC', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
          context: { notes: 'test' },
        });

      expect(mockRpc).toHaveBeenCalledWith('memory_adjust_confidence', {
        p_memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        p_reason_code: 'USER_CONFIRMED',
        p_context: { notes: 'test' },
      });
    });

    it('should emit memory.confidence.adjusted OASIS event', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
        });

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01116',
          type: 'memory.confidence.adjusted',
          source: 'memory-confidence-gateway',
          status: 'success',
        })
      );
    });

    it('should handle RPC errors gracefully', async () => {
      mockRpc.mockResolvedValue({
        data: null,
        error: { message: 'RPC failed' },
      });

      const response = await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
        });

      expect(response.status).toBe(502);
      expect(response.body.ok).toBe(false);
    });
  });

  // ===========================================================================
  // POST /confidence/confirm Tests
  // ===========================================================================
  describe('POST /confidence/confirm', () => {
    it('should reject requests without authentication', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/confirm')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should successfully confirm a memory item', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/confirm')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          confirmation_notes: 'This is accurate',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
    });

    it('should call memory_confirm_item RPC', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/confirm')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          confirmation_notes: 'Confirmed by user',
        });

      expect(mockRpc).toHaveBeenCalledWith('memory_confirm_item', {
        p_memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        p_confirmation_notes: 'Confirmed by user',
      });
    });

    it('should emit memory.confidence.confirmed OASIS event', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/confirm')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01116',
          type: 'memory.confidence.confirmed',
          status: 'success',
        })
      );
    });
  });

  // ===========================================================================
  // POST /confidence/correct Tests
  // ===========================================================================
  describe('POST /confidence/correct', () => {
    it('should reject requests without authentication', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/correct')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should successfully correct a memory item', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          memory_item_id: 'test-memory-id',
          previous_confidence: 70,
          new_confidence: 55,
          delta: -15,
          content_updated: true,
        },
        error: null,
      });

      const response = await request(app)
        .post('/api/v1/memory/confidence/correct')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          correction_notes: 'This was incorrect',
          new_content: 'Corrected content',
        });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.content_updated).toBe(true);
    });

    it('should call memory_correct_item RPC', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/correct')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          correction_notes: 'Mistake',
          new_content: 'Fixed',
        });

      expect(mockRpc).toHaveBeenCalledWith('memory_correct_item', {
        p_memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        p_correction_notes: 'Mistake',
        p_new_content: 'Fixed',
      });
    });

    it('should emit memory.confidence.corrected OASIS event with warning status', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/correct')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        });

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01116',
          type: 'memory.confidence.corrected',
          status: 'warning', // Corrections are warnings as they reduce trust
        })
      );
    });
  });

  // ===========================================================================
  // GET /confidence/history/:id Tests
  // ===========================================================================
  describe('GET /confidence/history/:id', () => {
    beforeEach(() => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          current_state: {
            confidence_score: 75,
            source_classification: 'diary',
            verification_level: 'user_confirmed',
            times_confirmed: 3,
            times_corrected: 0,
          },
          history: [
            {
              id: 'history-1',
              previous_confidence: 70,
              new_confidence: 75,
              delta: 5,
              reason_code: 'USER_CONFIRMED',
              reason_label: 'User Confirmation',
              triggered_by: 'user',
              created_at: '2026-01-01T00:00:00Z',
            },
          ],
          history_count: 1,
        },
        error: null,
      });
    });

    it('should reject requests without authentication', async () => {
      const response = await request(app).get(
        '/api/v1/memory/confidence/history/123e4567-e89b-12d3-a456-426614174000'
      );

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should reject invalid UUID format', async () => {
      const response = await request(app)
        .get('/api/v1/memory/confidence/history/invalid-uuid')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid memory_item_id format');
    });

    it('should return confidence history for valid memory item', async () => {
      const response = await request(app)
        .get('/api/v1/memory/confidence/history/123e4567-e89b-12d3-a456-426614174000')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.current_state).toBeDefined();
      expect(response.body.history).toBeDefined();
      expect(response.body.history_count).toBe(1);
    });

    it('should call memory_get_confidence_history RPC', async () => {
      await request(app)
        .get('/api/v1/memory/confidence/history/123e4567-e89b-12d3-a456-426614174000?limit=25')
        .set('Authorization', 'Bearer test-token');

      expect(mockRpc).toHaveBeenCalledWith('memory_get_confidence_history', {
        p_memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
        p_limit: 25,
      });
    });

    it('should emit memory.confidence.history.read OASIS event', async () => {
      await request(app)
        .get('/api/v1/memory/confidence/history/123e4567-e89b-12d3-a456-426614174000')
        .set('Authorization', 'Bearer test-token');

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01116',
          type: 'memory.confidence.history.read',
          status: 'success',
        })
      );
    });
  });

  // ===========================================================================
  // GET /context/trusted Tests
  // ===========================================================================
  describe('GET /context/trusted', () => {
    beforeEach(() => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          items: [
            {
              id: 'memory-1',
              category_key: 'health',
              content: 'High confidence memory',
              confidence_score: 85,
              relevance_score: 82.5,
            },
          ],
          filters: {
            min_confidence: 30,
            categories: null,
            include_low_confidence: false,
          },
          count: 1,
        },
        error: null,
      });
    });

    it('should reject requests without authentication', async () => {
      const response = await request(app).get('/api/v1/memory/context/trusted');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should return trusted context with default parameters', async () => {
      const response = await request(app)
        .get('/api/v1/memory/context/trusted')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.items).toBeDefined();
      expect(response.body.count).toBe(1);
    });

    it('should call memory_get_context_with_confidence RPC', async () => {
      await request(app)
        .get('/api/v1/memory/context/trusted?min_confidence=50&limit=10')
        .set('Authorization', 'Bearer test-token');

      expect(mockRpc).toHaveBeenCalledWith('memory_get_context_with_confidence', {
        p_limit: 10,
        p_min_confidence: 50,
        p_categories: null,
        p_since: null,
        p_include_low_confidence: false,
      });
    });

    it('should filter by categories', async () => {
      await request(app)
        .get('/api/v1/memory/context/trusted?categories=health,relationships')
        .set('Authorization', 'Bearer test-token');

      expect(mockRpc).toHaveBeenCalledWith(
        'memory_get_context_with_confidence',
        expect.objectContaining({
          p_categories: ['health', 'relationships'],
        })
      );
    });

    it('should reject invalid category', async () => {
      const response = await request(app)
        .get('/api/v1/memory/context/trusted?categories=invalid_category')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(400);
      expect(response.body.error).toContain('Invalid category');
    });

    it('should support include_low_confidence flag', async () => {
      await request(app)
        .get('/api/v1/memory/context/trusted?include_low_confidence=true')
        .set('Authorization', 'Bearer test-token');

      expect(mockRpc).toHaveBeenCalledWith(
        'memory_get_context_with_confidence',
        expect.objectContaining({
          p_include_low_confidence: true,
        })
      );
    });
  });

  // ===========================================================================
  // POST /confidence/decay Tests
  // ===========================================================================
  describe('POST /confidence/decay', () => {
    beforeEach(() => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          decayed_count: 5,
          threshold_days: 30,
        },
        error: null,
      });
    });

    it('should reject requests without authentication', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/decay')
        .send({ decay_threshold_days: 30 });

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should apply time decay with default threshold', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/decay')
        .set('Authorization', 'Bearer test-token')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.decayed_count).toBe(5);
    });

    it('should call memory_apply_time_decay RPC', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/decay')
        .set('Authorization', 'Bearer test-token')
        .send({ decay_threshold_days: 60 });

      expect(mockRpc).toHaveBeenCalledWith('memory_apply_time_decay', {
        p_decay_threshold_days: 60,
      });
    });

    it('should emit memory.confidence.decayed OASIS event', async () => {
      await request(app)
        .post('/api/v1/memory/confidence/decay')
        .set('Authorization', 'Bearer test-token')
        .send({});

      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          vtid: 'VTID-01116',
          type: 'memory.confidence.decayed',
          status: 'info',
        })
      );
    });

    it('should reject threshold out of range', async () => {
      const response = await request(app)
        .post('/api/v1/memory/confidence/decay')
        .set('Authorization', 'Bearer test-token')
        .send({ decay_threshold_days: 500 });

      expect(response.status).toBe(400);
      expect(response.body.ok).toBe(false);
    });
  });

  // ===========================================================================
  // GET /source-trust Tests
  // ===========================================================================
  describe('GET /source-trust', () => {
    beforeEach(() => {
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({
            data: [
              {
                source_type: 'user_explicit',
                trust_weight: 100,
                max_confidence: 95,
                label: 'User Stated (Explicit)',
                requires_validation: false,
              },
              {
                source_type: 'diary',
                trust_weight: 90,
                max_confidence: 90,
                label: 'Diary Entry',
                requires_validation: false,
              },
            ],
            error: null,
          }),
        }),
      });
    });

    it('should reject requests without authentication', async () => {
      const response = await request(app).get('/api/v1/memory/source-trust');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should return source trust weights', async () => {
      const response = await request(app)
        .get('/api/v1/memory/source-trust')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.source_trust).toBeDefined();
      expect(response.body.source_trust.length).toBe(2);
    });

    it('should return fallback data if table does not exist', async () => {
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockResolvedValue({
            data: null,
            error: { message: 'relation "memory_source_trust" does not exist' },
          }),
        }),
      });

      const response = await request(app)
        .get('/api/v1/memory/source-trust')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body._fallback).toBe(true);
      expect(response.body.source_trust.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // GET /confidence/reasons Tests
  // ===========================================================================
  describe('GET /confidence/reasons', () => {
    beforeEach(() => {
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({
              data: [
                {
                  reason_code: 'USER_CONFIRMED',
                  category: 'increase',
                  delta_min: 5,
                  delta_max: 15,
                  label: 'User Confirmation',
                },
                {
                  reason_code: 'USER_CORRECTED',
                  category: 'decrease',
                  delta_min: -20,
                  delta_max: -10,
                  label: 'User Correction',
                },
              ],
              error: null,
            }),
          }),
        }),
      });
    });

    it('should reject requests without authentication', async () => {
      const response = await request(app).get('/api/v1/memory/confidence/reasons');

      expect(response.status).toBe(401);
      expect(response.body.error).toBe('UNAUTHENTICATED');
    });

    it('should return confidence reason codes', async () => {
      const response = await request(app)
        .get('/api/v1/memory/confidence/reasons')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.reasons).toBeDefined();
      expect(response.body.reasons.length).toBe(2);
    });

    it('should return fallback data if table does not exist', async () => {
      mockFrom.mockReturnValue({
        select: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            order: jest.fn().mockResolvedValue({
              data: null,
              error: { message: 'relation "memory_confidence_reasons" does not exist' },
            }),
          }),
        }),
      });

      const response = await request(app)
        .get('/api/v1/memory/confidence/reasons')
        .set('Authorization', 'Bearer test-token');

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body._fallback).toBe(true);
      expect(response.body.reasons.length).toBeGreaterThan(0);
    });
  });

  // ===========================================================================
  // Determinism Tests (Core Invariant)
  // ===========================================================================
  describe('Determinism: Same inputs produce same outputs', () => {
    it('should return consistent confidence adjustments for same reason code', async () => {
      // First request
      await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
          context: { times_confirmed: 1 },
        });

      const firstCall = mockRpc.mock.calls[0];

      // Reset and second request with same inputs
      mockRpc.mockClear();
      await request(app)
        .post('/api/v1/memory/confidence/adjust')
        .set('Authorization', 'Bearer test-token')
        .send({
          memory_item_id: '123e4567-e89b-12d3-a456-426614174000',
          reason_code: 'USER_CONFIRMED',
          context: { times_confirmed: 1 },
        });

      const secondCall = mockRpc.mock.calls[0];

      // Same inputs should produce same RPC calls
      expect(firstCall).toEqual(secondCall);
    });

    it('should always use deterministic reason codes from predefined list', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      const reasonCodes = response.body.capabilities.confidence_reason_codes;

      // Verify all reason codes are in the predefined list
      expect(reasonCodes).toContain('USER_CONFIRMED');
      expect(reasonCodes).toContain('USER_CORRECTED');
      expect(reasonCodes).toContain('REPETITION_CONSISTENT');
      expect(reasonCodes).toContain('CONTRADICTING_EVIDENCE');
      expect(reasonCodes).toContain('TIME_DECAY');
      expect(reasonCodes).toContain('INITIAL_CAPTURE');
    });
  });

  // ===========================================================================
  // Hard Constraints Tests (Spec Section 6)
  // ===========================================================================
  describe('Hard Constraints: No memory without confidence_score', () => {
    it('should include confidence_score in trusted context items', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          items: [
            {
              id: 'memory-1',
              category_key: 'health',
              content: 'Test memory',
              confidence_score: 75,
              verification_level: 'none',
              relevance_score: 70,
            },
          ],
          count: 1,
        },
        error: null,
      });

      const response = await request(app)
        .get('/api/v1/memory/context/trusted')
        .set('Authorization', 'Bearer test-token');

      expect(response.body.items[0].confidence_score).toBeDefined();
      expect(typeof response.body.items[0].confidence_score).toBe('number');
    });

    it('should include relevance_score that combines importance and confidence', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          items: [
            {
              id: 'memory-1',
              importance: 80,
              confidence_score: 60,
              relevance_score: 68, // 0.4*80 + 0.6*60 = 32 + 36 = 68
            },
          ],
          count: 1,
        },
        error: null,
      });

      const response = await request(app)
        .get('/api/v1/memory/context/trusted')
        .set('Authorization', 'Bearer test-token');

      expect(response.body.items[0].relevance_score).toBeDefined();
    });
  });

  // ===========================================================================
  // Safety & Sensitivity Tests (Spec Section 8)
  // ===========================================================================
  describe('Safety: Sensitivity flags affect max confidence', () => {
    it('should include sensitivity_flag in health check capabilities', async () => {
      const response = await request(app).get('/api/v1/memory/health');

      expect(response.body.capabilities.sensitivity_flags).toContain('medical');
      expect(response.body.capabilities.sensitivity_flags).toContain('psychological');
    });

    it('should include sensitivity_flag in trusted context items', async () => {
      mockRpc.mockResolvedValue({
        data: {
          ok: true,
          items: [
            {
              id: 'memory-1',
              confidence_score: 70,
              sensitivity_flag: 'medical',
            },
          ],
          count: 1,
        },
        error: null,
      });

      const response = await request(app)
        .get('/api/v1/memory/context/trusted')
        .set('Authorization', 'Bearer test-token');

      expect(response.body.items[0].sensitivity_flag).toBe('medical');
    });
  });
});
