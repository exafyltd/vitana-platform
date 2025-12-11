/**
 * Operator Chat OASIS Integration Tests - VTID-0531
 *
 * Tests for:
 * - POST /api/v1/operator/chat - Extended chat with threadId, vtid, role, mode
 * - GET /api/v1/operator/chat/:threadId - Thread history endpoint
 * - OASIS event logging with unified operator.chat.message type
 */

import request from 'supertest';

// Create a chainable mock that supports Supabase's fluent API
const createChainableMock = () => {
  let defaultData: any = { data: [], error: null };
  const responseQueue: any[] = [];

  const chain: any = {
    from: jest.fn(() => chain),
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    neq: jest.fn(() => chain),
    gt: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    lte: jest.fn(() => chain),
    like: jest.fn(() => chain),
    ilike: jest.fn(() => chain),
    is: jest.fn(() => chain),
    in: jest.fn(() => chain),
    contains: jest.fn(() => chain),
    containedBy: jest.fn(() => chain),
    range: jest.fn(() => chain),
    order: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    offset: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    or: jest.fn(() => chain),
    filter: jest.fn(() => chain),
    match: jest.fn(() => chain),
    then: jest.fn((resolve) => {
      const data = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      return Promise.resolve(data).then(resolve);
    }),
    mockResolvedValue: (data: any) => {
      defaultData = data;
      return chain;
    },
    mockResolvedValueOnce: (data: any) => {
      responseQueue.push(data);
      return chain;
    },
    mockClear: () => {
      responseQueue.length = 0;
      defaultData = { data: [], error: null };
    },
  };

  return chain;
};

const mockSupabase = createChainableMock();

// Mock supabase - must be before app import
jest.mock('../src/lib/supabase', () => ({
  getSupabase: jest.fn(() => mockSupabase),
}));

// Mock AI orchestrator
jest.mock('../src/services/ai-orchestrator', () => ({
  processMessage: jest.fn().mockResolvedValue({
    reply: 'This is a test AI response',
    meta: { model: 'test-model', stub: true }
  })
}));

// Mock github service
jest.mock('../src/services/github-service', () => ({
  default: {
    triggerWorkflow: jest.fn().mockResolvedValue(undefined),
    getWorkflowRuns: jest.fn().mockResolvedValue({ workflow_runs: [] }),
  },
}));

// Mock OASIS event service
jest.mock('../src/services/oasis-event-service', () => ({
  default: {
    deployRequested: jest.fn().mockResolvedValue(undefined),
    deployAccepted: jest.fn().mockResolvedValue(undefined),
    deployFailed: jest.fn().mockResolvedValue(undefined),
  },
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
}));

// Mock deploy orchestrator
jest.mock('../src/services/deploy-orchestrator', () => ({
  __esModule: true,
  default: {
    executeDeploy: jest.fn(),
    createVtid: jest.fn(),
    createTask: jest.fn(),
  },
}));

// Import app AFTER all mocks are set up
import app from '../src/index';
import { processMessage } from '../src/services/ai-orchestrator';

const mockProcessMessage = processMessage as jest.Mock;

describe('Operator Chat OASIS Integration - VTID-0531', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabase.mockClear();
    mockProcessMessage.mockResolvedValue({
      reply: 'This is a test AI response',
      meta: { model: 'test-model', stub: true }
    });
  });

  describe('POST /api/v1/operator/chat', () => {
    it('should return ok: true with threadId, messageId, createdAt', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Hello, assistant!',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.reply).toBeDefined();
      expect(response.body.threadId).toBeDefined();
      expect(response.body.messageId).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
      // Verify UUID format for threadId
      expect(response.body.threadId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
      // Verify ISO date format for createdAt
      expect(new Date(response.body.createdAt).toISOString()).toBe(response.body.createdAt);
    });

    it('should generate threadId when not provided', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Hello without threadId',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.threadId).toBeDefined();
      expect(response.body.threadId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      );
    });

    it('should preserve provided threadId', async () => {
      const providedThreadId = 'e7a3b5c1-2d4f-4e6a-8b9c-1d2e3f4a5b6c';

      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Hello with specific threadId',
          threadId: providedThreadId,
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.threadId).toBe(providedThreadId);
    });

    it('should handle invalid vtid gracefully (warn but not fail)', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test with invalid VTID',
          vtid: 'VTID-9999', // This VTID doesn't exist
        })
        .expect(200);

      // Should still succeed
      expect(response.body.ok).toBe(true);
      expect(response.body.reply).toBeDefined();
    });

    it('should preserve backwards compatibility with existing response fields', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test backwards compatibility',
        })
        .expect(200);

      // Existing fields should still be present
      expect(response.body.ok).toBe(true);
      expect(response.body.reply).toBeDefined();
      expect(response.body.attachments).toBeDefined();
      expect(response.body.oasis_ref).toBeDefined();
      expect(response.body.meta).toBeDefined();

      // New fields should also be present
      expect(response.body.threadId).toBeDefined();
      expect(response.body.messageId).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
    });

    it('should reject empty message', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: '',
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should reject invalid threadId format', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test',
          threadId: 'not-a-uuid',
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should reject invalid role value', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test',
          role: 'invalid-role',
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should reject invalid mode value', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test',
          mode: 'invalid-mode',
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should accept valid role and mode values', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test with valid role/mode',
          role: 'system',
          mode: 'control',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
    });

    it('should accept metadata field', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Test with metadata',
          metadata: { custom: 'data', priority: 1 },
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
    });
  });

  describe('GET /api/v1/operator/chat/:threadId', () => {
    it('should return 200 for valid threadId', async () => {
      const threadId = 'f1e2d3c4-b5a6-4978-8d9e-0a1b2c3d4e5f';

      const response = await request(app)
        .get(`/api/v1/operator/chat/${threadId}`)
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should reject invalid threadId format', async () => {
      const response = await request(app)
        .get('/api/v1/operator/chat/not-a-valid-uuid')
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Invalid threadId format');
    });

    it('should reject short invalid UUID', async () => {
      const response = await request(app)
        .get('/api/v1/operator/chat/123')
        .expect(400);

      expect(response.body.ok).toBe(false);
    });
  });
});
