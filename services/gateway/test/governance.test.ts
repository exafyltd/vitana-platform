import request from 'supertest';
import app from '../src/index';
import { createClient } from '@supabase/supabase-js';

// Mock Supabase
jest.mock('@supabase/supabase-js');

const mockSupabase = {
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
};

(createClient as jest.Mock).mockReturnValue(mockSupabase);

describe('Governance API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('GET /api/v1/governance/rules', () => {
        it('should return array of rules', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        name: 'Test Rule',
                        description: 'Test rule description',
                        logic: { rule_code: 'MG-001', type: 'policy' },
                        is_active: true,
                        created_at: '2025-11-20T00:00:00Z',
                        governance_categories: { name: 'MIGRATION_GOVERNANCE' }
                    }
                ],
                error: null
            });

            mockSupabase.select.mockResolvedValueOnce({
                data: [],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/rules')
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
        });

        it('should filter rules by category', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        name: 'Test Rule',
                        description: 'Test',
                        logic: { rule_code: 'MG-001' },
                        is_active: true,
                        created_at: '2025-11-20T00:00:00Z',
                        governance_categories: { name: 'MIGRATION_GOVERNANCE' }
                    }
                ],
                error: null
            });

            mockSupabase.select.mockResolvedValue({
                data: [],
                error: null
            });

            await request(app)
                .get('/api/v1/governance/rules?category=MIGRATION_GOVERNANCE')
                .expect(200);
        });
    });

    describe('GET /api/v1/governance/rules/:ruleCode', () => {
        it('should return single rule by code', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        name: 'Test Rule',
                        description: 'Test',
                        logic: { rule_code: 'MG-001' },
                        is_active: true,
                        created_at: '2025-11-20T00:00:00Z',
                        governance_categories: { name: 'MIGRATION_GOVERNANCE' }
                    }
                ],
                error: null
            });

            mockSupabase.select.mockResolvedValueOnce({
                data: [],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/rules/MG-001')
                .expect(200);

            expect(response.body).toHaveProperty('ruleCode', 'MG-001');
        });

        it('should return 404 for non-existent rule', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [],
                error: null
            });

            await request(app)
                .get('/api/v1/governance/rules/NON-EXISTENT')
                .expect(404);
        });
    });

    describe('POST /api/v1/governance/proposals', () => {
        it('should create a new proposal', async () => {
            mockSupabase.insert.mockResolvedValueOnce({
                data: {
                    id: 'uuid-1',
                    tenant_id: 'SYSTEM',
                    proposal_id: 'PROP-20251120-ABCD',
                    type: 'New Rule',
                    rule_code: null,
                    status: 'Draft',
                    created_by: 'User',
                    original_rule: null,
                    proposed_rule: { test: true },
                    rationale: 'Testing',
                    timeline: [{ event: 'Created', timestamp: '2025-11-20T00:00:00Z', actor: 'User' }],
                    created_at: '2025-11-20T00:00:00Z',
                    updated_at: '2025-11-20T00:00:00Z'
                },
                error: null
            });

            // Mock OASIS event insert
            mockSupabase.insert.mockResolvedValueOnce({
                data: null,
                error: null
            });

            const response = await request(app)
                .post('/api/v1/governance/proposals')
                .send({
                    type: 'New Rule',
                    proposedRule: { test: true },
                    rationale: 'Testing'
                })
                .expect(201);

            expect(response.body).toHaveProperty('proposalId');
            expect(response.body.proposalId).toMatch(/^PROP-/);
        });

        it('should require type and proposedRule', async () => {
            await request(app)
                .post('/api/v1/governance/proposals')
                .send({})
                .expect(400);
        });
    });

    describe('PATCH /api/v1/governance/proposals/:proposalId/status', () => {
        it('should update proposal status', async () => {
            // Mock fetch current proposal
            mockSupabase.select.mockResolvedValueOnce({
                data: {
                    id: 'uuid-1',
                    proposal_id: 'PROP-123',
                    status: 'Draft',
                    timeline: []
                },
                error: null
            });

            // Mock update
            mockSupabase.update.mockResolvedValueOnce({
                data: {
                    proposal_id: 'PROP-123',
                    type: 'New Rule',
                    rule_code: null,
                    status: 'Under Review',
                    created_by: 'User',
                    updated_at: '2025-11-20T00:00:00Z',
                    original_rule: null,
                    proposed_rule: {},
                    rationale: null,
                    timeline: [{ event: 'Status changed to Under Review', timestamp: '2025-11-20T00:00:00Z', actor: 'System' }]
                },
                error: null
            });

            // Mock OASIS event insert
            mockSupabase.insert.mockResolvedValueOnce({
                data: null,
                error: null
            });

            const response = await request(app)
                .patch('/api/v1/governance/proposals/PROP-123/status')
                .send({ status: 'Under Review' })
                .expect(200);

            expect(response.body.status).toBe('Under Review');
        });

        it('should validate status transitions', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: {
                    id: 'uuid-1',
                    proposal_id: 'PROP-123',
                    status: 'Approved',
                    timeline: []
                },
                error: null
            });

            await request(app)
                .patch('/api/v1/governance/proposals/PROP-123/status')
                .send({ status: 'Draft' })
                .expect(400);
        });
    });

    describe('GET /api/v1/governance/proposals', () => {
        it('should return array of proposals', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [
                    {
                        proposal_id: 'PROP-123',
                        type: 'New Rule',
                        rule_code: null,
                        status: 'Draft',
                        created_by: 'User',
                        updated_at: '2025-11-20T00:00:00Z',
                        original_rule: null,
                        proposed_rule: {},
                        rationale: null,
                        timeline: []
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/proposals')
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
        });
    });

    describe('GET /api/v1/governance/evaluations', () => {
        it('should return array of evaluations', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/evaluations')
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
        });
    });

    describe('GET /api/v1/governance/violations', () => {
        it('should return array of violations', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/violations')
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
        });
    });

    describe('GET /api/v1/governance/feed', () => {
        it('should return array of feed entries', async () => {
            mockSupabase.select.mockResolvedValueOnce({
                data: [],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/feed')
                .expect(200);

            expect(Array.isArray(response.body)).toBe(true);
        });
    });
});
