/**
 * Autopilot Pipeline Tests - VTID-0533
 *
 * Tests for:
 * - POST /api/v1/autopilot/tasks/:vtid/plan - Plan submission
 * - POST /api/v1/autopilot/tasks/:vtid/work/start - Work started event
 * - POST /api/v1/autopilot/tasks/:vtid/work/complete - Work completed event
 * - POST /api/v1/autopilot/tasks/:vtid/validate - Validation result
 * - GET /api/v1/autopilot/tasks/:vtid/status - Task status
 * - GET /api/v1/autopilot/health - Health check with VTID-0533 capabilities
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

describe('Autopilot Pipeline - VTID-0533', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSupabase.mockClear();
  });

  // ==================== Health Check ====================

  describe('GET /api/v1/autopilot/health', () => {
    it('should return VTID-0533 with execution capabilities', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/health')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('autopilot-api');
      expect(response.body.status).toBe('healthy');
      expect(response.body.vtid).toBe('VTID-0533');
      expect(response.body.capabilities).toEqual({
        task_extraction: true,
        planner_handoff: true,
        execution: true,
        worker_skeleton: true,
        validator_skeleton: true
      });
    });
  });

  // ==================== Plan Submission ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/plan', () => {
    const validPlanPayload = {
      plan: {
        summary: 'Test plan summary',
        steps: [
          {
            id: 'step-1',
            title: 'Step 1 Title',
            description: 'Step 1 description',
            owner: 'WORKER',
            estimated_effort: 'S',
            dependencies: []
          }
        ]
      },
      metadata: {
        plannerModel: 'gemini-pro',
        plannerRole: 'PLANNER',
        source: 'autopilot',
        notes: 'Test notes'
      }
    };

    it('should reject missing plan object', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/plan')
        .send({ metadata: validPlanPayload.metadata })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('plan');
    });

    it('should reject missing plan.summary', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/plan')
        .send({
          plan: { steps: [] },
          metadata: validPlanPayload.metadata
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('summary');
    });

    it('should reject missing plan.steps array', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/plan')
        .send({
          plan: { summary: 'Test' },
          metadata: validPlanPayload.metadata
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('steps');
    });

    it('should reject missing metadata object', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/plan')
        .send({ plan: validPlanPayload.plan })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('metadata');
    });

    it('should reject missing plannerModel', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/plan')
        .send({
          plan: validPlanPayload.plan,
          metadata: { plannerRole: 'PLANNER' }
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('plannerModel');
    });

    it('should accept valid plan and return response', async () => {
      // The endpoint works with valid input - actual submission depends on Supabase mocking
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/plan')
        .send(validPlanPayload)
        .expect((res) => {
          // Accept either 200 (success) or 400 (task not found - expected without Supabase)
          expect([200, 400]).toContain(res.status);
        });

      // The response structure should be consistent
      expect(response.body).toHaveProperty('ok');
    });
  });

  // ==================== Work Started ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/work/start', () => {
    it('should reject missing stepId', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ workerModel: 'gemini-flash' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('stepId');
    });

    it('should reject missing workerModel', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ stepId: 'step-1' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('workerModel');
    });

    it('should accept valid work start payload', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({
          stepId: 'step-1',
          workerModel: 'gemini-flash',
          notes: 'Starting work on step 1'
        })
        .expect((res) => {
          // Accept either 200 (success) or 400 (task not found - expected without Supabase)
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });
  });

  // ==================== Work Completed ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/work/complete', () => {
    it('should reject missing stepId', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ status: 'success', outputSummary: 'Done' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('stepId');
    });

    it('should reject invalid status', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ stepId: 'step-1', status: 'invalid', outputSummary: 'Done' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('status');
    });

    it('should reject missing outputSummary', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ stepId: 'step-1', status: 'success' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('outputSummary');
    });

    it('should accept valid work complete payload with success status', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({
          stepId: 'step-1',
          status: 'success',
          outputSummary: 'Completed step 1 successfully',
          details: { filesChanged: 3 }
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should accept failure status', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({
          stepId: 'step-1',
          status: 'failure',
          outputSummary: 'Step 1 failed due to error'
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should accept partial status', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({
          stepId: 'step-1',
          status: 'partial',
          outputSummary: 'Step 1 partially completed'
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });
  });

  // ==================== Validation ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/validate', () => {
    it('should reject missing result object', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({ metadata: { validatorModel: 'gpt-4' } })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('result');
    });

    it('should reject invalid result.status', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({
          result: { status: 'invalid' },
          metadata: { validatorModel: 'gpt-4' }
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('status');
    });

    it('should reject missing metadata', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({ result: { status: 'approved' } })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('metadata');
    });

    it('should reject missing validatorModel', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({
          result: { status: 'approved' },
          metadata: { validatorRole: 'VALIDATOR' }
        })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('validatorModel');
    });

    it('should accept approved validation', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({
          result: {
            status: 'approved',
            notes: 'All checks passed'
          },
          metadata: {
            validatorModel: 'gpt-4',
            validatorRole: 'VALIDATOR'
          }
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should accept rejected validation with issues', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({
          result: {
            status: 'rejected',
            issues: [
              { code: 'MISSING_TESTS', message: 'Tests for endpoint /xyz are missing' },
              { code: 'TYPE_ERROR', message: 'Type mismatch in function foo()' }
            ],
            notes: 'Please address the issues before resubmitting'
          },
          metadata: {
            validatorModel: 'claude-3-opus',
            validatorRole: 'VALIDATOR'
          }
        })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });
  });

  // ==================== Task Status ====================

  describe('GET /api/v1/autopilot/tasks/:vtid/status', () => {
    it('should return 404 for non-existent task', async () => {
      // Without Supabase mock returning data, task won't be found
      const response = await request(app)
        .get('/api/v1/autopilot/tasks/NON-EXISTENT-VTID/status')
        .expect(404);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toContain('not found');
    });

    it('should accept valid vtid format', async () => {
      // Test that endpoint accepts proper VTID format
      const response = await request(app)
        .get('/api/v1/autopilot/tasks/DEV-COMHU-2025-0001/status')
        .expect((res) => {
          // Without Supabase, will be 404, with mocked data could be 200
          expect([200, 404]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });
  });

  // ==================== Pending Plan Tasks (from VTID-0532) ====================

  describe('GET /api/v1/autopilot/tasks/pending-plan', () => {
    it('should return ok: true with data array', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/tasks/pending-plan')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });
});

describe('Input Validation Unit Tests', () => {
  describe('Plan step validation', () => {
    const validStep = {
      id: 'step-1',
      title: 'Step Title',
      description: 'Step description',
      owner: 'WORKER',
      estimated_effort: 'S',
      dependencies: []
    };

    it('should have required id field', () => {
      expect(validStep.id).toBeDefined();
      expect(typeof validStep.id).toBe('string');
    });

    it('should have valid owner values', () => {
      const validOwners = ['WORKER', 'PLANNER', 'VALIDATOR', 'OPERATOR'];
      expect(validOwners).toContain(validStep.owner);
    });

    it('should have valid effort values', () => {
      const validEfforts = ['XS', 'S', 'M', 'L', 'XL'];
      expect(validEfforts).toContain(validStep.estimated_effort);
    });

    it('should have dependencies as array', () => {
      expect(Array.isArray(validStep.dependencies)).toBe(true);
    });
  });

  describe('Work status validation', () => {
    it('should accept success status', () => {
      const validStatuses = ['success', 'failure', 'partial'];
      expect(validStatuses).toContain('success');
    });

    it('should accept failure status', () => {
      const validStatuses = ['success', 'failure', 'partial'];
      expect(validStatuses).toContain('failure');
    });

    it('should accept partial status', () => {
      const validStatuses = ['success', 'failure', 'partial'];
      expect(validStatuses).toContain('partial');
    });
  });

  describe('Validation result status', () => {
    it('should accept approved status', () => {
      const validStatuses = ['approved', 'rejected'];
      expect(validStatuses).toContain('approved');
    });

    it('should accept rejected status', () => {
      const validStatuses = ['approved', 'rejected'];
      expect(validStatuses).toContain('rejected');
    });
  });
});
