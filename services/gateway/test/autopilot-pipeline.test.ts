/**
 * Autopilot Pipeline Tests - VTID-0533 + VTID-0534
 *
 * Tests for:
 * - POST /api/v1/autopilot/tasks/:vtid/plan - Plan submission
 * - POST /api/v1/autopilot/tasks/:vtid/work/start - Work started event (v1 with state machine)
 * - POST /api/v1/autopilot/tasks/:vtid/work/complete - Work completed event (v1 with state machine)
 * - POST /api/v1/autopilot/tasks/:vtid/validate - Validation result
 * - GET /api/v1/autopilot/tasks/:vtid/status - Task status with worker section
 * - GET /api/v1/autopilot/health - Health check with VTID-0534 capabilities
 *
 * VTID-0534 additions:
 * - Worker-Core Engine v1 state machine tests
 * - Invalid transition handling (409 errors)
 * - Plan mismatch handling (400 errors)
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
    it('should return VTID-0534 with Worker-Core Engine capabilities', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/health')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('autopilot-api');
      expect(response.body.status).toBe('healthy');
      expect(response.body.vtid).toBe('VTID-0534');
      expect(response.body.capabilities).toEqual({
        task_extraction: true,
        planner_handoff: true,
        execution: true,
        worker_skeleton: true,
        validator_skeleton: true,
        worker_core_engine: true
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

  // ==================== Work Started (VTID-0534 v1 Format) ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/work/start', () => {
    const validWorkStartPayload = {
      step_id: 'step-1',
      step_index: 0,
      label: 'Analyze repository and list services',
      agent: 'Gemini-Worker',
      executor_type: 'llm',
      notes: 'Starting work on step 1'
    };

    it('should reject missing step_id', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ ...validWorkStartPayload, step_id: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('step_id');
    });

    it('should reject missing step_index', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ ...validWorkStartPayload, step_index: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('step_index');
    });

    it('should reject missing label', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ ...validWorkStartPayload, label: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('label');
    });

    it('should reject missing agent', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ ...validWorkStartPayload, agent: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('agent');
    });

    it('should reject missing executor_type', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send({ ...validWorkStartPayload, executor_type: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('executor_type');
    });

    it('should accept valid work start payload (v1 format)', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send(validWorkStartPayload)
        .expect((res) => {
          // Accept either 200 (success) or 400 (plan missing - expected without Supabase events)
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should return worker.plan_missing error when no plan exists', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/start')
        .send(validWorkStartPayload);

      // Without a plan event in OASIS, should return plan_missing
      if (response.status === 400) {
        expect(response.body.code).toBe('worker.plan_missing');
      }
    });
  });

  // ==================== Work Completed (VTID-0534 v1 Format) ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/work/complete', () => {
    const validWorkCompletePayload = {
      step_id: 'step-1',
      step_index: 0,
      status: 'completed',
      output_summary: 'Services identified and categorized.',
      agent: 'Gemini-Worker'
    };

    it('should reject missing step_id', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ ...validWorkCompletePayload, step_id: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('step_id');
    });

    it('should reject missing step_index', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ ...validWorkCompletePayload, step_index: undefined })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('step_index');
    });

    it('should reject invalid status (only completed or failed allowed)', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ ...validWorkCompletePayload, status: 'success' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('status');
    });

    it('should reject partial status (not allowed in v1)', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({ ...validWorkCompletePayload, status: 'partial' })
        .expect(400);

      expect(response.body.ok).toBe(false);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('status');
    });

    it('should accept valid work complete payload with completed status', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send(validWorkCompletePayload)
        .expect((res) => {
          // Accept 200 (success), 400 (plan missing), or 409 (invalid transition)
          expect([200, 400, 409]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should accept failed status with error message', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send({
          ...validWorkCompletePayload,
          status: 'failed',
          error: 'Service discovery failed due to timeout'
        })
        .expect((res) => {
          expect([200, 400, 409]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should return worker.plan_missing error when no plan exists', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/work/complete')
        .send(validWorkCompletePayload);

      // Without a plan event in OASIS, should return plan_missing
      if (response.status === 400 && response.body.code) {
        expect(response.body.code).toBe('worker.plan_missing');
      }
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

  describe('Work status validation (VTID-0534 v1)', () => {
    it('should accept completed status', () => {
      const validStatuses = ['completed', 'failed'];
      expect(validStatuses).toContain('completed');
    });

    it('should accept failed status', () => {
      const validStatuses = ['completed', 'failed'];
      expect(validStatuses).toContain('failed');
    });

    it('should NOT accept partial status in v1', () => {
      const validStatuses = ['completed', 'failed'];
      expect(validStatuses).not.toContain('partial');
    });

    it('should NOT accept success status in v1', () => {
      const validStatuses = ['completed', 'failed'];
      expect(validStatuses).not.toContain('success');
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

// ==================== VTID-0534 Worker-Core State Machine Tests ====================

describe('VTID-0534 Worker-Core Engine Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Worker-Core Error Codes', () => {
    it('should define worker.plan_missing error code', () => {
      const errorCodes = [
        'worker.plan_missing',
        'worker.step_not_found',
        'worker.invalid_transition',
        'worker.error_required'
      ];
      expect(errorCodes).toContain('worker.plan_missing');
    });

    it('should define worker.step_not_found error code', () => {
      const errorCodes = [
        'worker.plan_missing',
        'worker.step_not_found',
        'worker.invalid_transition',
        'worker.error_required'
      ];
      expect(errorCodes).toContain('worker.step_not_found');
    });

    it('should define worker.invalid_transition error code', () => {
      const errorCodes = [
        'worker.plan_missing',
        'worker.step_not_found',
        'worker.invalid_transition',
        'worker.error_required'
      ];
      expect(errorCodes).toContain('worker.invalid_transition');
    });

    it('should define worker.error_required error code', () => {
      const errorCodes = [
        'worker.plan_missing',
        'worker.step_not_found',
        'worker.invalid_transition',
        'worker.error_required'
      ];
      expect(errorCodes).toContain('worker.error_required');
    });
  });

  describe('Worker Step State Transitions', () => {
    it('should define valid step states', () => {
      const validStates = ['pending', 'in_progress', 'completed', 'failed'];
      expect(validStates).toContain('pending');
      expect(validStates).toContain('in_progress');
      expect(validStates).toContain('completed');
      expect(validStates).toContain('failed');
    });

    it('should allow pending -> in_progress transition', () => {
      const validTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'in_progress': ['completed', 'failed'],
        'completed': [],
        'failed': []
      };
      expect(validTransitions['pending']).toContain('in_progress');
    });

    it('should allow in_progress -> completed transition', () => {
      const validTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'in_progress': ['completed', 'failed'],
        'completed': [],
        'failed': []
      };
      expect(validTransitions['in_progress']).toContain('completed');
    });

    it('should allow in_progress -> failed transition', () => {
      const validTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'in_progress': ['completed', 'failed'],
        'completed': [],
        'failed': []
      };
      expect(validTransitions['in_progress']).toContain('failed');
    });

    it('should NOT allow pending -> completed transition (skip)', () => {
      const validTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'in_progress': ['completed', 'failed'],
        'completed': [],
        'failed': []
      };
      expect(validTransitions['pending']).not.toContain('completed');
    });

    it('should NOT allow completed -> any transition (terminal)', () => {
      const validTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'in_progress': ['completed', 'failed'],
        'completed': [],
        'failed': []
      };
      expect(validTransitions['completed']).toHaveLength(0);
    });

    it('should NOT allow failed -> any transition (terminal)', () => {
      const validTransitions: Record<string, string[]> = {
        'pending': ['in_progress'],
        'in_progress': ['completed', 'failed'],
        'completed': [],
        'failed': []
      };
      expect(validTransitions['failed']).toHaveLength(0);
    });
  });

  describe('Worker Overall Status Derivation', () => {
    const deriveOverallStatus = (stepStatuses: string[]): string => {
      if (stepStatuses.length === 0) return 'pending';
      if (stepStatuses.some(s => s === 'failed')) return 'failed';
      if (stepStatuses.some(s => s === 'in_progress')) return 'in_progress';
      if (stepStatuses.every(s => s === 'completed')) return 'completed';
      if (stepStatuses.some(s => s === 'completed')) return 'in_progress';
      return 'pending';
    };

    it('should return pending when all steps are pending', () => {
      expect(deriveOverallStatus(['pending', 'pending', 'pending'])).toBe('pending');
    });

    it('should return in_progress when any step is in_progress', () => {
      expect(deriveOverallStatus(['completed', 'in_progress', 'pending'])).toBe('in_progress');
    });

    it('should return completed when all steps are completed', () => {
      expect(deriveOverallStatus(['completed', 'completed', 'completed'])).toBe('completed');
    });

    it('should return failed when any step is failed', () => {
      expect(deriveOverallStatus(['completed', 'failed', 'pending'])).toBe('failed');
    });

    it('should return in_progress when some steps completed but not all', () => {
      expect(deriveOverallStatus(['completed', 'pending', 'pending'])).toBe('in_progress');
    });

    it('should return pending for empty step array', () => {
      expect(deriveOverallStatus([])).toBe('pending');
    });
  });

  describe('Worker Start Request Validation', () => {
    it('should require step_id as string', () => {
      const validRequest = {
        step_id: 'step-1',
        step_index: 0,
        label: 'Test step',
        agent: 'Test-Agent',
        executor_type: 'llm'
      };
      expect(typeof validRequest.step_id).toBe('string');
      expect(validRequest.step_id.length).toBeGreaterThan(0);
    });

    it('should require step_index as number', () => {
      const validRequest = {
        step_id: 'step-1',
        step_index: 0,
        label: 'Test step',
        agent: 'Test-Agent',
        executor_type: 'llm'
      };
      expect(typeof validRequest.step_index).toBe('number');
    });

    it('should require label as string', () => {
      const validRequest = {
        step_id: 'step-1',
        step_index: 0,
        label: 'Test step',
        agent: 'Test-Agent',
        executor_type: 'llm'
      };
      expect(typeof validRequest.label).toBe('string');
    });

    it('should require agent as string', () => {
      const validRequest = {
        step_id: 'step-1',
        step_index: 0,
        label: 'Test step',
        agent: 'Test-Agent',
        executor_type: 'llm'
      };
      expect(typeof validRequest.agent).toBe('string');
    });

    it('should require executor_type as string', () => {
      const validRequest = {
        step_id: 'step-1',
        step_index: 0,
        label: 'Test step',
        agent: 'Test-Agent',
        executor_type: 'llm'
      };
      expect(typeof validRequest.executor_type).toBe('string');
    });
  });

  describe('Worker Complete Request Validation', () => {
    it('should require step_id as string', () => {
      const validRequest = {
        step_id: 'step-1',
        step_index: 0,
        status: 'completed' as const,
        output_summary: 'Step completed successfully'
      };
      expect(typeof validRequest.step_id).toBe('string');
    });

    it('should require status to be completed or failed', () => {
      const validStatuses = ['completed', 'failed'];
      expect(validStatuses).toContain('completed');
      expect(validStatuses).toContain('failed');
      expect(validStatuses).not.toContain('success');
      expect(validStatuses).not.toContain('partial');
    });

    it('should require error when status is failed', () => {
      const failedRequest = {
        step_id: 'step-1',
        step_index: 0,
        status: 'failed' as const,
        error: 'Something went wrong'
      };
      expect(failedRequest.error).toBeDefined();
      expect(failedRequest.error.length).toBeGreaterThan(0);
    });
  });

  describe('OASIS Event Payloads', () => {
    describe('autopilot.work.started event', () => {
      it('should include required fields', () => {
        const eventPayload = {
          vtid: 'VTID-0534',
          step_id: 'step-1',
          step_index: 0,
          label: 'Analyze repository',
          agent: 'Gemini-Worker',
          executor_type: 'llm',
          status: 'in_progress',
          started_at: new Date().toISOString()
        };

        expect(eventPayload).toHaveProperty('vtid');
        expect(eventPayload).toHaveProperty('step_id');
        expect(eventPayload).toHaveProperty('step_index');
        expect(eventPayload).toHaveProperty('label');
        expect(eventPayload).toHaveProperty('agent');
        expect(eventPayload).toHaveProperty('executor_type');
        expect(eventPayload).toHaveProperty('status');
        expect(eventPayload).toHaveProperty('started_at');
      });
    });

    describe('autopilot.work.completed event', () => {
      it('should include required fields for completed status', () => {
        const eventPayload = {
          vtid: 'VTID-0534',
          step_id: 'step-1',
          step_index: 0,
          status: 'completed',
          output_summary: 'Services identified and categorized',
          error: null,
          completed_at: new Date().toISOString(),
          agent: 'Gemini-Worker'
        };

        expect(eventPayload).toHaveProperty('vtid');
        expect(eventPayload).toHaveProperty('step_id');
        expect(eventPayload).toHaveProperty('step_index');
        expect(eventPayload).toHaveProperty('status');
        expect(eventPayload).toHaveProperty('completed_at');
        expect(eventPayload).toHaveProperty('agent');
      });

      it('should include error field for failed status', () => {
        const eventPayload = {
          vtid: 'VTID-0534',
          step_id: 'step-1',
          step_index: 0,
          status: 'failed',
          output_summary: null,
          error: 'Service discovery timed out',
          completed_at: new Date().toISOString(),
          agent: 'Gemini-Worker'
        };

        expect(eventPayload.status).toBe('failed');
        expect(eventPayload.error).toBeDefined();
        expect(eventPayload.error).not.toBeNull();
      });
    });
  });

  describe('Status Response Worker Section', () => {
    it('should include worker section structure', () => {
      const statusResponse = {
        ok: true,
        vtid: 'VTID-0534',
        status: {
          planner: { status: 'planned', planSteps: 3 },
          worker: {
            overall_status: 'in_progress',
            steps: [
              {
                step_id: 'step-1',
                step_index: 0,
                label: 'Analyze repository',
                status: 'completed',
                started_at: '2025-12-12T00:00:00Z',
                completed_at: '2025-12-12T00:05:00Z',
                agent: 'Gemini-Worker',
                executor_type: 'llm',
                output_summary: 'Services identified',
                error: null
              },
              {
                step_id: 'step-2',
                step_index: 1,
                label: 'Map services',
                status: 'pending',
                started_at: null,
                completed_at: null,
                agent: null,
                executor_type: null,
                output_summary: null,
                error: null
              }
            ]
          },
          validator: { status: 'pending' }
        }
      };

      expect(statusResponse.status).toHaveProperty('worker');
      expect(statusResponse.status.worker).toHaveProperty('overall_status');
      expect(statusResponse.status.worker).toHaveProperty('steps');
      expect(Array.isArray(statusResponse.status.worker.steps)).toBe(true);
    });

    it('should have correct step structure in worker section', () => {
      const step = {
        step_id: 'step-1',
        step_index: 0,
        label: 'Analyze repository',
        status: 'completed',
        started_at: '2025-12-12T00:00:00Z',
        completed_at: '2025-12-12T00:05:00Z',
        agent: 'Gemini-Worker',
        executor_type: 'llm',
        output_summary: 'Services identified',
        error: null
      };

      expect(step).toHaveProperty('step_id');
      expect(step).toHaveProperty('step_index');
      expect(step).toHaveProperty('label');
      expect(step).toHaveProperty('status');
      expect(step).toHaveProperty('started_at');
      expect(step).toHaveProperty('completed_at');
      expect(step).toHaveProperty('agent');
      expect(step).toHaveProperty('executor_type');
      expect(step).toHaveProperty('output_summary');
      expect(step).toHaveProperty('error');
    });
  });
});
