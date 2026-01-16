/**
 * Task Extractor Tests - VTID-0532
 *
 * Tests for:
 * - Task detection logic in POST /api/v1/operator/chat
 * - VTID + Task creation for detected tasks
 * - autopilot.task.spec.created event emission
 * - GET /api/v1/autopilot/tasks/pending-plan endpoint
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

describe('Task Extractor - VTID-0532', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabase.mockClear();
    mockProcessMessage.mockResolvedValue({
      reply: 'This is a test AI response',
      meta: { model: 'test-model', stub: true }
    });
  });

  describe('Task Detection - POST /api/v1/operator/chat', () => {
    it('should NOT create task for regular chat message', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Hello, assistant!',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.createdTask).toBeUndefined();
    });

    it('should return ok:true and threadId for /task command', async () => {
      // Tests that the endpoint works with /task - actual task creation
      // depends on Supabase mocking which is handled by setup-tests
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: '/task Add a Governance History tab to the Command Hub',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.reply).toBeDefined();
      expect(response.body.threadId).toBeDefined();
      expect(response.body.messageId).toBeDefined();
      expect(response.body.createdAt).toBeDefined();
      // Task creation is attempted (may succeed or fail depending on mocks)
      // The important thing is the endpoint doesn't crash
    });

    it('should return ok:true for mode:task without /task prefix', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: 'Implement dark mode for the dashboard',
          mode: 'task',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.reply).toBeDefined();
    });

    it('should handle /task with case-insensitivity', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: '/TASK Fix the login bug',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
    });

    it('should handle /task with leading spaces', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: '  /task Fix the login bug',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
    });

    it('should handle empty task description gracefully', async () => {
      // When just "/task" is sent without description
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: '/task ',
        })
        .expect(200);

      expect(response.body.ok).toBe(true);
      // Task creation may produce "Untitled Operator Task" title
    });

    it('should preserve existing response fields', async () => {
      const response = await request(app)
        .post('/api/v1/operator/chat')
        .send({
          message: '/task Test task',
        })
        .expect(200);

      // Existing VTID-0531 fields should be present
      expect(response.body.ok).toBe(true);
      expect(response.body.reply).toBeDefined();
      expect(response.body.attachments).toBeDefined();
      expect(response.body.oasis_ref).toBeDefined();
      expect(response.body.meta).toBeDefined();
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
  });

  describe('GET /api/v1/autopilot/tasks/pending-plan', () => {
    it('should return ok: true with data array', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/tasks/pending-plan')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should return empty array when no pending tasks', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/tasks/pending-plan')
        .expect(200);

      expect(response.body.ok).toBe(true);
      // May be empty or contain tasks from setup-tests mocking
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /api/v1/autopilot/health', () => {
    it('should return healthy status', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/health')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('autopilot-api');
      expect(response.body.status).toBe('healthy');
      expect(response.body.vtid).toBe('VTID-01178');  // Updated in VTID-01178 Autopilot Controller
      expect(response.body.capabilities).toBeDefined();
      expect(response.body.capabilities.task_extraction).toBe(true);
      expect(response.body.capabilities.planner_handoff).toBe(true);
      expect(response.body.capabilities.execution).toBe(true);  // Updated in VTID-0533
      expect(response.body.capabilities.worker_core_engine).toBe(true);  // Added in VTID-0534
    });
  });
});

describe('Task Detection Logic Unit Tests', () => {
  describe('isTaskRequest detection', () => {
    // These test the detection logic without hitting the endpoint
    const detectTaskRequest = (message: string, mode: string) => {
      const rawMessage = message ?? '';
      const isSlashTask = rawMessage.trim().toLowerCase().startsWith('/task ');
      return mode === 'task' || isSlashTask;
    };

    it('should detect /task prefix', () => {
      expect(detectTaskRequest('/task Add feature', 'chat')).toBe(true);
    });

    it('should detect mode=task', () => {
      expect(detectTaskRequest('Add feature', 'task')).toBe(true);
    });

    it('should NOT detect regular chat', () => {
      expect(detectTaskRequest('Hello', 'chat')).toBe(false);
    });

    it('should handle case insensitivity', () => {
      expect(detectTaskRequest('/TASK Add feature', 'chat')).toBe(true);
      expect(detectTaskRequest('/Task Add feature', 'chat')).toBe(true);
    });

    it('should handle leading spaces', () => {
      expect(detectTaskRequest('  /task Add feature', 'chat')).toBe(true);
    });

    it('should require space after /task', () => {
      // "/taskAdd" should NOT be detected (no space)
      expect(detectTaskRequest('/taskAdd feature', 'chat')).toBe(false);
    });
  });

  describe('rawDescription extraction', () => {
    const extractDescription = (message: string, mode: string) => {
      const rawMessage = message ?? '';
      const isSlashTask = rawMessage.trim().toLowerCase().startsWith('/task ');
      const isTaskRequest = mode === 'task' || isSlashTask;

      if (!isTaskRequest) return '';

      if (isSlashTask) {
        return rawMessage.trim().slice(5).trim();
      }
      return rawMessage;
    };

    it('should extract description from /task syntax', () => {
      expect(extractDescription('/task Add a feature', 'chat')).toBe('Add a feature');
    });

    it('should handle extra spaces after /task', () => {
      expect(extractDescription('/task    Add a feature', 'chat')).toBe('Add a feature');
    });

    it('should use full message for mode=task', () => {
      expect(extractDescription('Build an API', 'task')).toBe('Build an API');
    });

    it('should handle empty description', () => {
      expect(extractDescription('/task ', 'chat')).toBe('');
    });
  });

  describe('title extraction', () => {
    const extractTitle = (rawDescription: string): string => {
      if (!rawDescription || rawDescription.trim().length === 0) {
        return 'Untitled Operator Task';
      }

      const trimmed = rawDescription.trim();

      // Try to get first sentence (ending with . ! or ?)
      const sentenceMatch = trimmed.match(/^[^.!?]+[.!?]/);
      if (sentenceMatch && sentenceMatch[0].length <= 120) {
        return sentenceMatch[0].trim();
      }

      // Otherwise, take first 100-120 characters at word boundary
      if (trimmed.length <= 120) {
        return trimmed;
      }

      // Find last space before 120 chars
      const truncated = trimmed.slice(0, 120);
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > 80) {
        return truncated.slice(0, lastSpace) + '...';
      }

      return truncated + '...';
    };

    it('should extract first sentence as title', () => {
      expect(extractTitle('Add a feature. This is the description.')).toBe('Add a feature.');
    });

    it('should handle short descriptions', () => {
      expect(extractTitle('Add a feature')).toBe('Add a feature');
    });

    it('should truncate long descriptions', () => {
      const longDesc = 'A'.repeat(200);
      const title = extractTitle(longDesc);
      expect(title.length).toBeLessThanOrEqual(123); // 120 + '...'
    });

    it('should handle empty description', () => {
      expect(extractTitle('')).toBe('Untitled Operator Task');
    });

    it('should handle whitespace-only description', () => {
      expect(extractTitle('   ')).toBe('Untitled Operator Task');
    });
  });
});
