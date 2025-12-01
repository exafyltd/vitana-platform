/**
 * Operator Command Hub Tests - VTID-0525
 *
 * Tests for:
 * - POST /api/v1/operator/command - Natural language command parsing and execution
 * - POST /api/v1/operator/deploy - Deploy orchestrator
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

// Mock natural language service for command parsing
jest.mock('../src/services/natural-language-service', () => ({
    naturalLanguageService: {
        parseCommand: jest.fn(),
        processMessage: jest.fn().mockResolvedValue('AI response'),
    },
}));

// Mock github service
jest.mock('../src/services/github-service', () => ({
    default: {
        triggerWorkflow: jest.fn().mockResolvedValue(undefined),
        getWorkflowRuns: jest.fn().mockResolvedValue({
            workflow_runs: [
                {
                    id: 12345,
                    html_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/12345',
                },
            ],
        }),
    },
}));

// Mock OASIS event service - include both default and named exports
jest.mock('../src/services/oasis-event-service', () => ({
    default: {
        deployRequested: jest.fn().mockResolvedValue(undefined),
        deployAccepted: jest.fn().mockResolvedValue(undefined),
        deployFailed: jest.fn().mockResolvedValue(undefined),
    },
    emitOasisEvent: jest.fn().mockResolvedValue({ ok: true, event_id: 'test-event-id' }),
}));

// Mock deploy orchestrator - use factory function to avoid hoisting issues
jest.mock('../src/services/deploy-orchestrator', () => {
    return {
        __esModule: true,
        default: {
            executeDeploy: jest.fn(),
            createVtid: jest.fn(),
            createTask: jest.fn(),
        },
    };
});

// Import app and modules AFTER all mocks are set up
import app from '../src/index';
import { naturalLanguageService } from '../src/services/natural-language-service';
import githubService from '../src/services/github-service';
import deployOrchestrator from '../src/services/deploy-orchestrator';

const mockParseCommand = naturalLanguageService.parseCommand as jest.Mock;
const mockTriggerWorkflow = githubService.triggerWorkflow as jest.Mock;
const mockGetWorkflowRuns = githubService.getWorkflowRuns as jest.Mock;

describe('Operator Command Hub - VTID-0525', () => {
    // Get mock references from the imported module
    const mockExecuteDeploy = deployOrchestrator.executeDeploy as jest.Mock;
    const mockCreateVtid = deployOrchestrator.createVtid as jest.Mock;
    const mockCreateTask = deployOrchestrator.createTask as jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockSupabase.mockClear();

        // Reset deploy orchestrator mocks
        mockExecuteDeploy.mockResolvedValue({
            ok: true,
            vtid: 'VTID-TEST',
            service: 'gateway',
            environment: 'dev',
            workflow_run_id: 12345,
            workflow_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/12345',
        });
        mockCreateVtid.mockResolvedValue({
            ok: true,
            vtid: 'OASIS-CMD-2025-0001',
        });
        mockCreateTask.mockResolvedValue({
            ok: true,
            task_id: 'OASIS-CMD-2025-0001-TASK1',
        });

        // Default mock for Supabase insert (for event logging)
        mockSupabase.mockResolvedValue({ data: null, error: null });
    });

    describe('POST /api/v1/operator/command', () => {
        it('should parse deploy command and execute deployment', async () => {
            // Mock Gemini returning a valid deploy command
            mockParseCommand.mockResolvedValueOnce({
                action: 'deploy',
                service: 'gateway',
                environment: 'dev',
                branch: 'main',
                confidence: 0.95,
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Deploy latest gateway to dev',
                    vtid: 'VTID-0525-TEST-0001',
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0525-TEST-0001');
            expect(response.body.reply).toBeDefined();
            expect(response.body.command).toEqual({
                action: 'deploy',
                service: 'gateway',
                environment: 'dev',
                branch: 'main',
                vtid: 'VTID-0525-TEST-0001',
                dry_run: false,
            });
        });

        it('should auto-create VTID when not provided', async () => {
            mockParseCommand.mockResolvedValueOnce({
                action: 'deploy',
                service: 'gateway',
                environment: 'dev',
                branch: 'main',
                confidence: 0.95,
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Deploy gateway to dev',
                    // No vtid provided - should auto-create
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('OASIS-CMD-2025-0001'); // Auto-created
            expect(mockCreateVtid).toHaveBeenCalled();
        });

        it('should return dry_run result without triggering deploy', async () => {
            mockParseCommand.mockResolvedValueOnce({
                action: 'deploy',
                service: 'oasis-operator',
                environment: 'dev',
                branch: 'main',
                dry_run: true,
                confidence: 0.9,
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Dry run: deploy oasis-operator to dev',
                    vtid: 'VTID-0525-TEST-0002',
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.command.dry_run).toBe(true);
            expect(response.body.reply).toContain('Dry Run');

            // Verify deploy orchestrator was NOT called
            expect(mockExecuteDeploy).not.toHaveBeenCalled();
        });

        it('should handle task commands', async () => {
            mockParseCommand.mockResolvedValueOnce({
                action: 'task',
                task_type: 'operator.diagnostics.latest-errors',
                title: 'Show latest errors',
                confidence: 0.9,
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Show latest errors',
                    vtid: 'VTID-0525-TEST-TASK',
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0525-TEST-TASK');
            expect(response.body.task_id).toBeDefined();
            expect(response.body.command.action).toBe('task');
            expect(mockCreateTask).toHaveBeenCalled();
        });

        it('should return error for non-parseable commands', async () => {
            mockParseCommand.mockResolvedValueOnce({
                error: 'Could not understand command',
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Hello there!',
                    vtid: 'VTID-0525-TEST-0003',
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(false);
            expect(response.body.reply).toContain("couldn't understand");
        });

        it('should return error for invalid service', async () => {
            mockParseCommand.mockResolvedValueOnce({
                action: 'deploy',
                service: 'invalid-service',
                environment: 'dev',
                branch: 'main',
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Deploy invalid-service to dev',
                    vtid: 'VTID-0525-TEST-0004',
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(false);
            expect(response.body.reply).toContain('Invalid');
        });

        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({})
                .expect(400);

            expect(response.body.ok).toBe(false);
        });

        it('should require message field', async () => {
            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    vtid: 'VTID-0525-TEST-0005',
                    environment: 'dev',
                })
                .expect(400);

            expect(response.body.ok).toBe(false);
        });
    });

    describe('POST /api/v1/operator/deploy', () => {
        it('should execute deploy for valid service', async () => {
            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0010',
                    service: 'gateway',
                    environment: 'dev',
                    branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-TEST');

            // Verify deploy orchestrator was called
            expect(mockExecuteDeploy).toHaveBeenCalledWith(
                expect.objectContaining({
                    vtid: 'VTID-0525-TEST-0010',
                    service: 'gateway',
                    environment: 'dev',
                })
            );
        });

        it('should handle oasis-operator service', async () => {
            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0011',
                    service: 'oasis-operator',
                    environment: 'dev',
                    branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);

            expect(mockExecuteDeploy).toHaveBeenCalledWith(
                expect.objectContaining({
                    service: 'oasis-operator',
                })
            );
        });

        it('should handle oasis-projector service', async () => {
            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0012',
                    service: 'oasis-projector',
                    environment: 'dev',
                    branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
        });

        it('should reject invalid service', async () => {
            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0013',
                    service: 'invalid-service',
                    environment: 'dev',
                    branch: 'main',
                })
                .expect(400);

            expect(response.body.ok).toBe(false);
        });

        it('should reject invalid environment', async () => {
            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0014',
                    service: 'gateway',
                    environment: 'prod',
                    branch: 'main',
                })
                .expect(400);

            expect(response.body.ok).toBe(false);
        });

        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({})
                .expect(400);

            expect(response.body.ok).toBe(false);
        });

        it('should handle deploy orchestrator failure', async () => {
            mockExecuteDeploy.mockResolvedValueOnce({
                ok: false,
                vtid: 'VTID-0525-TEST-0015',
                service: 'gateway',
                environment: 'dev',
                error: 'GitHub API error',
            });

            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0015',
                    service: 'gateway',
                    environment: 'dev',
                    branch: 'main',
                })
                .expect(500);

            expect(response.body.ok).toBe(false);
            expect(response.body.error).toContain('GitHub API error');
        });

        it('should include workflow URL in response', async () => {
            mockExecuteDeploy.mockResolvedValueOnce({
                ok: true,
                vtid: 'VTID-0525-TEST-0016',
                service: 'gateway',
                environment: 'dev',
                workflow_run_id: 99999,
                workflow_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/99999',
            });

            const response = await request(app)
                .post('/api/v1/operator/deploy')
                .send({
                    vtid: 'VTID-0525-TEST-0016',
                    service: 'gateway',
                    environment: 'dev',
                    branch: 'main',
                })
                .expect(200);

            expect(response.body.workflow_url).toContain('actions/runs/99999');
        });
    });
});
