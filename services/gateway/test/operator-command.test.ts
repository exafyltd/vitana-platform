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
        triggerWorkflow: jest.fn(),
        getWorkflowRuns: jest.fn(),
    },
}));

// Mock OASIS event service
jest.mock('../src/services/oasis-event-service', () => ({
    default: {
        deployRequested: jest.fn().mockResolvedValue(undefined),
        deployAccepted: jest.fn().mockResolvedValue(undefined),
        deployFailed: jest.fn().mockResolvedValue(undefined),
    },
}));

// Import app AFTER all mocks are set up
import app from '../src/index';
import { naturalLanguageService } from '../src/services/natural-language-service';
import githubService from '../src/services/github-service';

const mockParseCommand = naturalLanguageService.parseCommand as jest.Mock;
const mockTriggerWorkflow = githubService.triggerWorkflow as jest.Mock;
const mockGetWorkflowRuns = githubService.getWorkflowRuns as jest.Mock;

describe('Operator Command Hub - VTID-0525', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockSupabase.mockClear();

        // Default mock for workflow runs
        mockGetWorkflowRuns.mockResolvedValue({
            workflow_runs: [
                {
                    id: 12345,
                    html_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/12345',
                },
            ],
        });

        // Default mock for trigger workflow
        mockTriggerWorkflow.mockResolvedValue(undefined);

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
            expect(response.body.command).toEqual({
                action: 'deploy',
                service: 'gateway',
                environment: 'dev',
                branch: 'main',
                vtid: 'VTID-0525-TEST-0001',
                dry_run: false,
            });
            expect(response.body.orchestrator_result).toBeDefined();
            expect(response.body.orchestrator_result.ok).toBe(true);
            expect(response.body.orchestrator_result.steps).toBeDefined();
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
            expect(response.body.orchestrator_result.steps).toEqual([]);

            // Verify deploy workflow was NOT triggered
            expect(mockTriggerWorkflow).not.toHaveBeenCalled();
        });

        it('should return error for non-deploy commands', async () => {
            mockParseCommand.mockResolvedValueOnce({
                error: 'Not a deploy command',
            });

            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'What is the weather today?',
                    vtid: 'VTID-0525-TEST-0003',
                    environment: 'dev',
                    default_branch: 'main',
                })
                .expect(200);

            expect(response.body.ok).toBe(false);
            expect(response.body.error).toBe('Not a deploy command');
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
            expect(response.body.error).toContain('Invalid');
        });

        it('should validate required fields', async () => {
            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({})
                .expect(400);

            expect(response.body.ok).toBe(false);
            expect(response.body.error).toBe('Validation failed');
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

        it('should require vtid field', async () => {
            const response = await request(app)
                .post('/api/v1/operator/command')
                .send({
                    message: 'Deploy gateway to dev',
                    environment: 'dev',
                })
                .expect(400);

            expect(response.body.ok).toBe(false);
        });
    });

    describe('POST /api/v1/operator/deploy', () => {
        it('should trigger deploy workflow for valid service', async () => {
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
            expect(response.body.vtid).toBe('VTID-0525-TEST-0010');
            expect(response.body.steps).toBeDefined();
            expect(Array.isArray(response.body.steps)).toBe(true);

            // Verify workflow was triggered
            expect(mockTriggerWorkflow).toHaveBeenCalledWith(
                'exafyltd/vitana-platform',
                'EXEC-DEPLOY.yml',
                'main',
                expect.objectContaining({
                    vtid: 'VTID-0525-TEST-0010',
                    service: 'vitana-gateway', // gateway -> vitana-gateway
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

            // Verify workflow was triggered with correct service name
            expect(mockTriggerWorkflow).toHaveBeenCalledWith(
                'exafyltd/vitana-platform',
                'EXEC-DEPLOY.yml',
                'main',
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

        it('should handle workflow trigger failure', async () => {
            mockTriggerWorkflow.mockRejectedValueOnce(new Error('GitHub API error'));

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
            expect(response.body.steps).toBeDefined();

            // Check that deploy_service step is marked as failed
            const deployStep = response.body.steps.find((s: any) => s.step === 'deploy_service');
            expect(deployStep).toBeDefined();
            expect(deployStep.status).toBe('failed');
        });

        it('should include workflow URL in response', async () => {
            mockGetWorkflowRuns.mockResolvedValueOnce({
                workflow_runs: [
                    {
                        id: 99999,
                        html_url: 'https://github.com/exafyltd/vitana-platform/actions/runs/99999',
                    },
                ],
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

            const deployStep = response.body.steps.find((s: any) => s.step === 'deploy_service');
            expect(deployStep.details.workflow_run_id).toBe(99999);
            expect(deployStep.details.workflow_url).toContain('actions/runs/99999');
        });
    });
});
