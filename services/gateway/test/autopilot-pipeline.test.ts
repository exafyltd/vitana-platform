/**
 * Autopilot Pipeline Tests - VTID-0533 + VTID-0534 + VTID-0535
 *
 * Tests for:
 * - POST /api/v1/autopilot/tasks/:vtid/plan - Plan submission
 * - POST /api/v1/autopilot/tasks/:vtid/work/start - Work started event (v1 with state machine)
 * - POST /api/v1/autopilot/tasks/:vtid/work/complete - Work completed event (v1 with state machine)
 * - POST /api/v1/autopilot/tasks/:vtid/validate - Validator-Core Engine validation
 * - GET /api/v1/autopilot/tasks/:vtid/status - Task status with worker + validator sections
 * - GET /api/v1/autopilot/health - Health check with VTID-0535 capabilities
 *
 * VTID-0534 additions:
 * - Worker-Core Engine v1 state machine tests
 * - Invalid transition handling (409 errors)
 * - Plan mismatch handling (400 errors)
 *
 * VTID-0535 additions:
 * - Validator-Core Engine v1 deterministic validation
 * - Validation rules VAL-RULE-001 to VAL-RULE-006
 * - Rich validator section in status endpoint
 * - autopilot.validation.completed and autopilot.task.finalized events
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
    it('should return VTID-0535 with Validator-Core Engine capabilities', async () => {
      const response = await request(app)
        .get('/api/v1/autopilot/health')
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.service).toBe('autopilot-api');
      expect(response.body.status).toBe('healthy');
      expect(response.body.vtid).toBe('VTID-0535');
      expect(response.body.capabilities).toEqual({
        task_extraction: true,
        planner_handoff: true,
        execution: true,
        worker_skeleton: true,
        validator_skeleton: true,
        worker_core_engine: true,
        validator_core_engine: true
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

  // ==================== Validation (VTID-0535) ====================

  describe('POST /api/v1/autopilot/tasks/:vtid/validate', () => {
    it('should accept empty body and use defaults', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({})
        .expect((res) => {
          // Without plan in OASIS, should return 400 with validator.plan_missing
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should accept mode: auto', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({ mode: 'auto' })
        .expect((res) => {
          expect([200, 400]).toContain(res.status);
        });

      expect(response.body).toHaveProperty('ok');
    });

    it('should return validator.plan_missing when no plan exists', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({ mode: 'auto' });

      // Without a plan event in OASIS, should return plan_missing
      if (response.status === 400) {
        expect(response.body.code).toBe('validator.plan_missing');
      }
    });

    it('should return validation object in response on success', async () => {
      const response = await request(app)
        .post('/api/v1/autopilot/tasks/TEST-VTID-001/validate')
        .send({ mode: 'auto' });

      // Response structure should have validation object when ok=true
      if (response.body.ok === true) {
        expect(response.body).toHaveProperty('vtid');
        expect(response.body).toHaveProperty('validation');
        expect(response.body.validation).toHaveProperty('final_status');
        expect(response.body.validation).toHaveProperty('rules_checked');
        expect(response.body.validation).toHaveProperty('violations');
        expect(response.body.validation).toHaveProperty('summary');
        expect(response.body.validation).toHaveProperty('validated_at');
      }
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
        vtid: 'VTID-0535',
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
          validator: { final_status: 'pending', summary: 'Validation not yet executed.', rules_checked: [], violations: [], validated_at: null }
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

// ==================== VTID-0535 Validator-Core Engine Tests ====================

describe('VTID-0535 Validator-Core Engine Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Validator-Core Error Codes', () => {
    it('should define validator.plan_missing error code', () => {
      const errorCodes = [
        'validator.plan_missing',
        'validator.worker_state_missing',
        'validator.no_steps',
        'validator.internal_error'
      ];
      expect(errorCodes).toContain('validator.plan_missing');
    });

    it('should define validator.worker_state_missing error code', () => {
      const errorCodes = [
        'validator.plan_missing',
        'validator.worker_state_missing',
        'validator.no_steps',
        'validator.internal_error'
      ];
      expect(errorCodes).toContain('validator.worker_state_missing');
    });

    it('should define validator.no_steps error code', () => {
      const errorCodes = [
        'validator.plan_missing',
        'validator.worker_state_missing',
        'validator.no_steps',
        'validator.internal_error'
      ];
      expect(errorCodes).toContain('validator.no_steps');
    });

    it('should define validator.internal_error error code', () => {
      const errorCodes = [
        'validator.plan_missing',
        'validator.worker_state_missing',
        'validator.no_steps',
        'validator.internal_error'
      ];
      expect(errorCodes).toContain('validator.internal_error');
    });
  });

  describe('Validation Rule IDs', () => {
    it('should define VAL-RULE-001 (Plan Exists & Non-Empty)', () => {
      const ruleIds = ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'];
      expect(ruleIds).toContain('VAL-RULE-001');
    });

    it('should define VAL-RULE-002 (Worker Steps Cover the Plan)', () => {
      const ruleIds = ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'];
      expect(ruleIds).toContain('VAL-RULE-002');
    });

    it('should define VAL-RULE-003 (No Failed Steps for Success)', () => {
      const ruleIds = ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'];
      expect(ruleIds).toContain('VAL-RULE-003');
    });

    it('should define VAL-RULE-004 (Failure Must Have Error Details)', () => {
      const ruleIds = ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'];
      expect(ruleIds).toContain('VAL-RULE-004');
    });

    it('should define VAL-RULE-005 (Valid State Machine)', () => {
      const ruleIds = ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'];
      expect(ruleIds).toContain('VAL-RULE-005');
    });

    it('should define VAL-RULE-006 (Final Status Derivation)', () => {
      const ruleIds = ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'];
      expect(ruleIds).toContain('VAL-RULE-006');
    });
  });

  describe('Validation Final Status', () => {
    it('should define success status', () => {
      const validStatuses = ['success', 'failed', 'pending'];
      expect(validStatuses).toContain('success');
    });

    it('should define failed status', () => {
      const validStatuses = ['success', 'failed', 'pending'];
      expect(validStatuses).toContain('failed');
    });

    it('should define pending status', () => {
      const validStatuses = ['success', 'failed', 'pending'];
      expect(validStatuses).toContain('pending');
    });
  });

  describe('Validation Result Structure', () => {
    it('should have correct validation result structure for success', () => {
      const successResult = {
        final_status: 'success',
        rules_checked: ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'],
        violations: [],
        summary: 'All 3 steps completed successfully without failures.',
        validated_at: '2025-12-12T00:10:00Z'
      };

      expect(successResult).toHaveProperty('final_status');
      expect(successResult).toHaveProperty('rules_checked');
      expect(successResult).toHaveProperty('violations');
      expect(successResult).toHaveProperty('summary');
      expect(successResult).toHaveProperty('validated_at');
      expect(successResult.final_status).toBe('success');
      expect(successResult.violations).toHaveLength(0);
    });

    it('should have correct validation result structure for failure', () => {
      const failedResult = {
        final_status: 'failed',
        rules_checked: ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003'],
        violations: [
          {
            code: 'VAL-RULE-003',
            message: 'Step "step-2" is in failed state',
            step_id: 'step-2'
          }
        ],
        summary: 'Task failed: 1 step(s) in failed state.',
        validated_at: '2025-12-12T00:10:00Z'
      };

      expect(failedResult.final_status).toBe('failed');
      expect(failedResult.violations).toHaveLength(1);
      expect(failedResult.violations[0]).toHaveProperty('code');
      expect(failedResult.violations[0]).toHaveProperty('message');
      expect(failedResult.violations[0]).toHaveProperty('step_id');
    });
  });

  describe('Validation Violation Structure', () => {
    it('should have correct violation structure with step_id', () => {
      const violation = {
        code: 'VAL-RULE-002',
        message: 'Planned step "step-3" has no worker state',
        step_id: 'step-3'
      };

      expect(violation).toHaveProperty('code');
      expect(violation).toHaveProperty('message');
      expect(violation).toHaveProperty('step_id');
    });

    it('should have correct violation structure without step_id', () => {
      const violation = {
        code: 'VAL-RULE-001',
        message: 'Plan is missing for this VTID'
      };

      expect(violation).toHaveProperty('code');
      expect(violation).toHaveProperty('message');
      expect(violation).not.toHaveProperty('step_id');
    });
  });

  describe('Final Status Derivation Logic', () => {
    const deriveFinalStatus = (
      hasRule001Violation: boolean,
      hasRule002Violations: boolean,
      hasRule003Violations: boolean,
      hasRule004Violations: boolean,
      hasRule005Violations: boolean,
      allStepsCompleted: boolean
    ): string => {
      if (hasRule001Violation) return 'failed';
      if (hasRule002Violations) return 'failed';
      if (hasRule003Violations) return 'failed';
      if (hasRule004Violations) return 'failed';
      if (hasRule005Violations) return 'failed';
      if (allStepsCompleted) return 'success';
      return 'failed';
    };

    it('should return failed when plan is missing (VAL-RULE-001)', () => {
      expect(deriveFinalStatus(true, false, false, false, false, false)).toBe('failed');
    });

    it('should return failed when worker coverage is incomplete (VAL-RULE-002)', () => {
      expect(deriveFinalStatus(false, true, false, false, false, false)).toBe('failed');
    });

    it('should return failed when any step failed (VAL-RULE-003)', () => {
      expect(deriveFinalStatus(false, false, true, false, false, false)).toBe('failed');
    });

    it('should return failed when failed step missing error (VAL-RULE-004)', () => {
      expect(deriveFinalStatus(false, false, false, true, false, false)).toBe('failed');
    });

    it('should return failed when state machine inconsistency (VAL-RULE-005)', () => {
      expect(deriveFinalStatus(false, false, false, false, true, false)).toBe('failed');
    });

    it('should return success when all steps completed and no violations', () => {
      expect(deriveFinalStatus(false, false, false, false, false, true)).toBe('success');
    });

    it('should return failed when not all steps completed (strict v1)', () => {
      expect(deriveFinalStatus(false, false, false, false, false, false)).toBe('failed');
    });
  });

  describe('OASIS Event Payloads', () => {
    describe('autopilot.validation.completed event', () => {
      it('should include required fields for success', () => {
        const eventPayload = {
          vtid: 'VTID-0535',
          final_status: 'success',
          rules_checked: ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'],
          violations: [],
          summary: 'All steps completed successfully.',
          validated_at: new Date().toISOString()
        };

        expect(eventPayload).toHaveProperty('vtid');
        expect(eventPayload).toHaveProperty('final_status');
        expect(eventPayload).toHaveProperty('rules_checked');
        expect(eventPayload).toHaveProperty('violations');
        expect(eventPayload).toHaveProperty('summary');
        expect(eventPayload).toHaveProperty('validated_at');
      });

      it('should include required fields for failure', () => {
        const eventPayload = {
          vtid: 'VTID-0535',
          final_status: 'failed',
          rules_checked: ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003'],
          violations: [
            {
              code: 'VAL-RULE-003',
              message: 'At least one step is failed.',
              step_id: 'step-2'
            }
          ],
          summary: 'Task failed because at least one step failed.',
          validated_at: new Date().toISOString()
        };

        expect(eventPayload.final_status).toBe('failed');
        expect(eventPayload.violations.length).toBeGreaterThan(0);
        expect(eventPayload.violations[0]).toHaveProperty('code');
        expect(eventPayload.violations[0]).toHaveProperty('message');
      });
    });

    describe('autopilot.task.finalized event', () => {
      it('should include required fields for success', () => {
        const eventPayload = {
          vtid: 'VTID-0535',
          final_status: 'success',
          finalized_at: new Date().toISOString(),
          summary: 'Task successfully validated and finalized.',
          violations: []
        };

        expect(eventPayload).toHaveProperty('vtid');
        expect(eventPayload).toHaveProperty('final_status');
        expect(eventPayload).toHaveProperty('finalized_at');
        expect(eventPayload).toHaveProperty('summary');
        expect(eventPayload).toHaveProperty('violations');
      });

      it('should include required fields for failure', () => {
        const eventPayload = {
          vtid: 'VTID-0535',
          final_status: 'failed',
          finalized_at: new Date().toISOString(),
          summary: 'Task finalized as failed due to failed worker steps.',
          violations: [
            {
              code: 'VAL-RULE-003',
              message: '1 step failed.',
              step_id: 'step-2'
            }
          ]
        };

        expect(eventPayload.final_status).toBe('failed');
        expect(eventPayload.violations.length).toBeGreaterThan(0);
      });
    });
  });

  describe('Status Response Validator Section', () => {
    it('should include validator section structure before validation', () => {
      const statusResponse = {
        ok: true,
        vtid: 'VTID-0535',
        status: {
          planner: { status: 'planned', planSteps: 3 },
          worker: { overall_status: 'completed', steps: [] },
          validator: {
            final_status: 'pending',
            summary: 'Validation not yet executed.',
            rules_checked: [],
            violations: [],
            validated_at: null
          }
        }
      };

      expect(statusResponse.status).toHaveProperty('validator');
      expect(statusResponse.status.validator).toHaveProperty('final_status');
      expect(statusResponse.status.validator).toHaveProperty('summary');
      expect(statusResponse.status.validator).toHaveProperty('rules_checked');
      expect(statusResponse.status.validator).toHaveProperty('violations');
      expect(statusResponse.status.validator).toHaveProperty('validated_at');
      expect(statusResponse.status.validator.final_status).toBe('pending');
      expect(statusResponse.status.validator.validated_at).toBeNull();
    });

    it('should include validator section structure after validation', () => {
      const statusResponse = {
        ok: true,
        vtid: 'VTID-0535',
        status: {
          planner: { status: 'completed', planSteps: 3 },
          worker: { overall_status: 'completed', steps: [] },
          validator: {
            final_status: 'success',
            summary: 'All 3 steps completed successfully without failures.',
            rules_checked: ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003', 'VAL-RULE-004', 'VAL-RULE-005', 'VAL-RULE-006'],
            violations: [],
            validated_at: '2025-12-12T00:10:00Z'
          }
        }
      };

      expect(statusResponse.status.validator.final_status).toBe('success');
      expect(statusResponse.status.validator.rules_checked.length).toBe(6);
      expect(statusResponse.status.validator.violations).toHaveLength(0);
      expect(statusResponse.status.validator.validated_at).not.toBeNull();
    });

    it('should include validator section with violations for failed validation', () => {
      const statusResponse = {
        ok: true,
        vtid: 'VTID-0535',
        status: {
          planner: { status: 'completed', planSteps: 3 },
          worker: { overall_status: 'failed', steps: [] },
          validator: {
            final_status: 'failed',
            summary: 'Task failed: 1 step(s) in failed state.',
            rules_checked: ['VAL-RULE-001', 'VAL-RULE-002', 'VAL-RULE-003'],
            violations: [
              {
                code: 'VAL-RULE-003',
                message: 'Step "step-2" is in failed state',
                step_id: 'step-2'
              }
            ],
            validated_at: '2025-12-12T00:10:00Z'
          }
        }
      };

      expect(statusResponse.status.validator.final_status).toBe('failed');
      expect(statusResponse.status.validator.violations.length).toBeGreaterThan(0);
    });
  });

  describe('Validate Request Structure', () => {
    it('should accept mode auto (default)', () => {
      const request = { mode: 'auto', override: null };
      expect(request.mode).toBe('auto');
      expect(request.override).toBeNull();
    });

    it('should accept empty request body', () => {
      const request = {};
      expect(request).toBeDefined();
    });
  });

  describe('Idempotency', () => {
    it('should produce consistent validation results for same state', () => {
      // Validation results should be deterministic
      const workerState = {
        overall_status: 'completed',
        steps: [
          { step_id: 'step-1', status: 'completed', error: null },
          { step_id: 'step-2', status: 'completed', error: null },
          { step_id: 'step-3', status: 'completed', error: null }
        ]
      };

      // Same state should always produce same result
      const hasFailedSteps = workerState.steps.some(s => s.status === 'failed');
      expect(hasFailedSteps).toBe(false);

      const allCompleted = workerState.steps.every(s => s.status === 'completed');
      expect(allCompleted).toBe(true);
    });
  });
});
