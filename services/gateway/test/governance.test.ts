import request from 'supertest';
import app from '../src/index';

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
        // Make chain thenable (awaitable) - uses queue or default
        then: jest.fn((resolve) => {
            const data = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
            return Promise.resolve(data).then(resolve);
        }),
        // Method to set default resolved value
        mockResolvedValue: (data: any) => {
            defaultData = data;
            return chain;
        },
        // Method to queue a one-time response
        mockResolvedValueOnce: (data: any) => {
            responseQueue.push(data);
            return chain;
        },
        // Clear the queue (useful in beforeEach)
        mockClear: () => {
            responseQueue.length = 0;
            defaultData = { data: [], error: null };
        },
    };

    return chain;
};

// Create the mock
const mockSupabase = createChainableMock();

// Mock the supabase module
jest.mock('../src/lib/supabase', () => ({
    getSupabase: jest.fn(() => mockSupabase),
}));

describe('Governance API', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Clear mock queue and reset default
        mockSupabase.mockClear();
    });

    describe('GET /api/v1/governance/rules', () => {
        it('should return catalog format with rules array (VTID-0401)', async () => {
            // First call: get rules
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        rule_id: 'MG-001',
                        name: 'Test Rule',
                        description: 'Test rule description',
                        domain: 'MIGRATION_GOVERNANCE',
                        level: 'L2',
                        status: 'Active',
                        category: 'Migration',
                        logic: { rule_code: 'MG-001', type: 'policy' },
                        is_active: true,
                        created_at: '2025-11-20T00:00:00Z',
                        updated_at: '2025-11-20T00:00:00Z',
                        governance_categories: { name: 'MIGRATION_GOVERNANCE' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/rules')
                .expect(200);

            // VTID-0401: Response is now catalog format
            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0401');
            expect(response.body.count).toBe(1);
            expect(Array.isArray(response.body.data)).toBe(true);
            expect(response.body.data[0]).toHaveProperty('id');
            expect(response.body.data[0]).toHaveProperty('domain');
        });

        it('should filter rules by category', async () => {
            mockSupabase.mockResolvedValueOnce({
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

            await request(app)
                .get('/api/v1/governance/rules?category=MIGRATION_GOVERNANCE')
                .expect(200);
        });
    });

    describe('GET /api/v1/governance/rules/:ruleCode', () => {
        it('should return single rule by code', async () => {
            mockSupabase.mockResolvedValueOnce({
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

            const response = await request(app)
                .get('/api/v1/governance/rules/MG-001')
                .expect(200);

            expect(response.body).toHaveProperty('ruleCode', 'MG-001');
        });

        it('should return 404 for non-existent rule', async () => {
            mockSupabase.mockResolvedValueOnce({
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
            // Mock insert returning the created proposal
            mockSupabase.mockResolvedValueOnce({
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
            // First call: fetch current proposal
            mockSupabase.mockResolvedValueOnce({
                data: {
                    id: 'uuid-1',
                    tenant_id: 'SYSTEM',
                    proposal_id: 'PROP-123',
                    status: 'Draft',
                    timeline: []
                },
                error: null
            });

            // Second call: update
            mockSupabase.mockResolvedValueOnce({
                data: {
                    id: 'uuid-1',
                    tenant_id: 'SYSTEM',
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

            // Third call: OASIS event insert
            mockSupabase.mockResolvedValueOnce({
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
            mockSupabase.mockResolvedValueOnce({
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
            mockSupabase.mockResolvedValueOnce({
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
            mockSupabase.mockResolvedValueOnce({
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
            mockSupabase.mockResolvedValueOnce({
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
            mockSupabase.mockResolvedValueOnce({
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
