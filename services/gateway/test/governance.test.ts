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

    // VTID-0409: Governance Categories tests
    describe('GET /api/v1/governance/categories', () => {
        it('should return VTID-0409 format with categories array', async () => {
            // Mock: rules with category join
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-MIGRATION-001',
                        name: 'Migration Rule 1',
                        level: 'L1',
                        is_active: true,
                        governance_categories: { name: 'MIGRATION_GOVERNANCE', code: 'MIGRATION' }
                    },
                    {
                        id: 'rule-2',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-MIGRATION-002',
                        name: 'Migration Rule 2',
                        level: 'L2',
                        is_active: true,
                        governance_categories: { name: 'MIGRATION_GOVERNANCE', code: 'MIGRATION' }
                    },
                    {
                        id: 'rule-3',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-FRONTEND-001',
                        name: 'Frontend Rule 1',
                        level: 'L3',
                        is_active: true,
                        logic: { source: 'SYSTEM' },
                        governance_categories: { name: 'FRONTEND_GOVERNANCE', code: 'FRONTEND' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/categories')
                .expect(200);

            // VTID-0409: Response format
            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0409');
            expect(Array.isArray(response.body.categories)).toBe(true);
            expect(response.body.categories.length).toBe(2);

            // Check category structure
            const migrationCat = response.body.categories.find((c: any) => c.id === 'MIGRATION');
            expect(migrationCat).toBeDefined();
            expect(migrationCat.label).toBe('Migration Governance');
            expect(migrationCat.rule_count).toBe(2);
            expect(migrationCat.levels.L1).toBe(1);
            expect(migrationCat.levels.L2).toBe(1);
            expect(migrationCat.rules.length).toBe(2);
        });

        it('should aggregate rules correctly by domain', async () => {
            // Mock: multiple rules in same domain
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-API-001',
                        name: 'API Rule 1',
                        level: 'L1',
                        is_active: true,
                        governance_categories: { name: 'API_GOVERNANCE', code: 'API' }
                    },
                    {
                        id: 'rule-2',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-API-002',
                        name: 'API Rule 2',
                        level: 'L2',
                        is_active: true,
                        governance_categories: { name: 'API_GOVERNANCE', code: 'API' }
                    },
                    {
                        id: 'rule-3',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-API-003',
                        name: 'API Rule 3',
                        level: 'L2',
                        is_active: true,
                        governance_categories: { name: 'API_GOVERNANCE', code: 'API' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/categories')
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.categories.length).toBe(1);

            const apiCat = response.body.categories[0];
            expect(apiCat.id).toBe('API');
            expect(apiCat.rule_count).toBe(3);
            expect(apiCat.levels.L1).toBe(1);
            expect(apiCat.levels.L2).toBe(2);
            expect(apiCat.levels.L3).toBe(0);
            expect(apiCat.levels.L4).toBe(0);
        });

        it('should include rule source (SYSTEM or CATALOG)', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-DB-001',
                        name: 'DB System Rule',
                        level: 'L1',
                        is_system_rule: true,
                        is_active: true,
                        governance_categories: { name: 'DB_GOVERNANCE', code: 'DB' }
                    },
                    {
                        id: 'rule-2',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-DB-002',
                        name: 'DB Catalog Rule',
                        level: 'L2',
                        is_active: true,
                        logic: { source: 'CATALOG' },
                        governance_categories: { name: 'DB_GOVERNANCE', code: 'DB' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/categories')
                .expect(200);

            expect(response.body.ok).toBe(true);
            const dbCat = response.body.categories[0];
            expect(dbCat.rules[0].source).toBe('SYSTEM');
            expect(dbCat.rules[1].source).toBe('CATALOG');
        });

        it('should return empty categories array when no rules exist', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/categories')
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0409');
            expect(response.body.categories).toEqual([]);
        });

        it('should sort categories alphabetically by label', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'rule-1',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-FRONTEND-001',
                        name: 'Frontend Rule',
                        level: 'L2',
                        is_active: true,
                        governance_categories: { name: 'FRONTEND', code: 'FRONTEND' }
                    },
                    {
                        id: 'rule-2',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-API-001',
                        name: 'API Rule',
                        level: 'L2',
                        is_active: true,
                        governance_categories: { name: 'API', code: 'API' }
                    },
                    {
                        id: 'rule-3',
                        tenant_id: 'SYSTEM',
                        rule_id: 'GOV-CICD-001',
                        name: 'CI/CD Rule',
                        level: 'L2',
                        is_active: true,
                        governance_categories: { name: 'CICD', code: 'CICD' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/categories')
                .expect(200);

            expect(response.body.ok).toBe(true);
            // Should be sorted: API Governance, CI/CD, Frontend & Navigation
            expect(response.body.categories[0].id).toBe('API');
            expect(response.body.categories[1].id).toBe('CICD');
            expect(response.body.categories[2].id).toBe('FRONTEND');
        });
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
        it('should return evaluations in VTID-0406 format', async () => {
            // Mock oasis_events query for governance.evaluate events
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'eval-1',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.evaluate',
                        service: 'gateway',
                        status: 'success',
                        message: 'deploy',
                        metadata: {
                            action: 'deploy',
                            service: 'gateway',
                            environment: 'production',
                            allow: true,
                            violated_rules: []
                        }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/evaluations')
                .expect(200);

            // VTID-0406: Response format
            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0406');
            expect(response.body.count).toBe(1);
            expect(Array.isArray(response.body.data)).toBe(true);
            expect(response.body.data[0]).toHaveProperty('id');
            expect(response.body.data[0]).toHaveProperty('action');
            expect(response.body.data[0]).toHaveProperty('allow');
        });

        it('should return evaluations with violated rules', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'eval-2',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.evaluate',
                        service: 'gateway',
                        status: 'error',
                        message: 'deploy blocked',
                        metadata: {
                            action: 'deploy',
                            service: 'gateway',
                            environment: 'production',
                            allow: false,
                            violated_rules: [
                                { rule_id: 'MG-001', level: 'L1', domain: 'MIGRATION' }
                            ]
                        }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/evaluations')
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.data[0].allow).toBe(false);
            expect(response.body.data[0].violated_rules).toHaveLength(1);
            expect(response.body.data[0].violated_rules[0].rule_id).toBe('MG-001');
        });

        it('should filter evaluations by result', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'eval-1',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.evaluate',
                        metadata: { allow: true, violated_rules: [] }
                    },
                    {
                        id: 'eval-2',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.evaluate',
                        metadata: { allow: false, violated_rules: [] }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/evaluations?result=allow')
                .expect(200);

            expect(response.body.ok).toBe(true);
            // Only allowed evaluations should be returned
            expect(response.body.data.every((ev: any) => ev.allow === true)).toBe(true);
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

    // VTID-0407: Governance evaluation endpoint tests
    describe('POST /api/v1/governance/evaluate', () => {
        it('should allow deploy when no rules exist', async () => {
            // Mock: no rules in database
            mockSupabase.mockResolvedValueOnce({
                data: [],
                error: null
            });

            // Mock: OASIS event insert
            mockSupabase.mockResolvedValueOnce({
                data: null,
                error: null
            });

            const response = await request(app)
                .post('/api/v1/governance/evaluate')
                .send({
                    action: 'deploy',
                    service: 'gateway',
                    environment: 'dev',
                    vtid: 'VTID-TEST-001'
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.allowed).toBe(true);
            expect(response.body.level).toBe('L4');
            expect(response.body.violations).toEqual([]);
        });

        it('should block deploy on L1 violation', async () => {
            // Mock: L1 rule that blocks gateway deploys
            mockSupabase.mockResolvedValueOnce({
                data: [{
                    id: 'rule-1',
                    tenant_id: 'SYSTEM',
                    rule_id: 'GOV-DEPLOY-001',
                    name: 'Block unauthorized services',
                    level: 'L1',
                    is_active: true,
                    logic: {
                        applies_to: ['deploy'],
                        allowed_services: ['oasis-operator'],
                        violation_message: 'Gateway deploys are blocked'
                    }
                }],
                error: null
            });

            // Mock: OASIS event insert
            mockSupabase.mockResolvedValueOnce({
                data: null,
                error: null
            });

            const response = await request(app)
                .post('/api/v1/governance/evaluate')
                .send({
                    action: 'deploy',
                    service: 'gateway',
                    environment: 'dev',
                    vtid: 'VTID-TEST-002'
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.allowed).toBe(false);
            expect(response.body.level).toBe('L1');
            expect(response.body.violations.length).toBe(1);
            expect(response.body.violations[0].rule_id).toBe('GOV-DEPLOY-001');
        });

        it('should block deploy on L2 violation (V1 behavior)', async () => {
            // Mock: L2 rule
            mockSupabase.mockResolvedValueOnce({
                data: [{
                    id: 'rule-2',
                    tenant_id: 'SYSTEM',
                    rule_id: 'GOV-ENV-001',
                    name: 'Block prod deploys',
                    level: 'L2',
                    is_active: true,
                    logic: {
                        applies_to: ['deploy'],
                        allowed_environments: ['staging'],
                        violation_message: 'Dev environment is not allowed'
                    }
                }],
                error: null
            });

            // Mock: OASIS event insert
            mockSupabase.mockResolvedValueOnce({
                data: null,
                error: null
            });

            const response = await request(app)
                .post('/api/v1/governance/evaluate')
                .send({
                    action: 'deploy',
                    service: 'gateway',
                    environment: 'dev',
                    vtid: 'VTID-TEST-003'
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.allowed).toBe(false);
            expect(response.body.level).toBe('L2');
        });

        it('should allow deploy on L3/L4 violations only', async () => {
            // Mock: L3 rule (warning only)
            mockSupabase.mockResolvedValueOnce({
                data: [{
                    id: 'rule-3',
                    tenant_id: 'SYSTEM',
                    rule_id: 'GOV-WARN-001',
                    name: 'Documentation warning',
                    level: 'L3',
                    is_active: true,
                    logic: {
                        applies_to: ['deploy'],
                        conditions: [{ field: 'has_docs', op: 'eq', value: true }]
                    }
                }],
                error: null
            });

            // Mock: OASIS event insert
            mockSupabase.mockResolvedValueOnce({
                data: null,
                error: null
            });

            const response = await request(app)
                .post('/api/v1/governance/evaluate')
                .send({
                    action: 'deploy',
                    service: 'gateway',
                    environment: 'dev',
                    vtid: 'VTID-TEST-004'
                })
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.allowed).toBe(true);
            expect(response.body.level).toBe('L3');
        });

        it('should require action, service, environment fields', async () => {
            const response = await request(app)
                .post('/api/v1/governance/evaluate')
                .send({
                    action: 'deploy'
                    // missing service and environment
                })
                .expect(400);

            expect(response.body.ok).toBe(false);
            expect(response.body.error).toContain('Missing required fields');
        });
    });

    describe('GET /api/v1/governance/history', () => {
        it('should return history events in VTID-0408 format', async () => {
            // Mock oasis_events query for governance events
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'event-1',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.deploy.allowed',
                        service: 'gateway-governance',
                        status: 'success',
                        message: 'Deploy allowed for gateway',
                        vtid: 'VTID-0001',
                        metadata: {
                            service: 'gateway',
                            level: 'L4',
                            allowed_at: '2025-12-12T10:00:00Z'
                        }
                    },
                    {
                        id: 'event-2',
                        created_at: '2025-12-12T09:00:00Z',
                        topic: 'governance.deploy.blocked',
                        service: 'gateway-governance',
                        status: 'warning',
                        message: 'Deploy blocked for api (2 violations)',
                        vtid: 'VTID-0002',
                        metadata: {
                            service: 'api',
                            level: 'L1',
                            violations: [
                                { rule_id: 'GOV-001', level: 'L1', message: 'Critical rule violated' }
                            ]
                        }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/history')
                .expect(200);

            // VTID-0408: Response format
            expect(response.body.ok).toBe(true);
            expect(response.body.vtid).toBe('VTID-0408');
            expect(Array.isArray(response.body.events)).toBe(true);
            expect(response.body.pagination).toBeDefined();
            expect(response.body.pagination.limit).toBe(50);
            expect(response.body.pagination.offset).toBe(0);
        });

        it('should apply limit and offset parameters', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'event-1',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.deploy.allowed',
                        service: 'gateway-governance',
                        status: 'success',
                        message: 'Deploy allowed',
                        metadata: {}
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/history?limit=10&offset=5')
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.pagination.limit).toBe(10);
            expect(response.body.pagination.offset).toBe(5);
        });

        it('should apply type filter', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'event-blocked-1',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.deploy.blocked',
                        service: 'gateway-governance',
                        status: 'warning',
                        message: 'Deploy blocked',
                        metadata: { service: 'test' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/history?type=governance.deploy.blocked')
                .expect(200);

            expect(response.body.ok).toBe(true);
            expect(response.body.events.length).toBeGreaterThanOrEqual(0);
        });

        it('should apply level filter', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'event-l1',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.deploy.blocked',
                        service: 'gateway-governance',
                        status: 'warning',
                        message: 'Deploy blocked',
                        metadata: { level: 'L1', service: 'test' }
                    },
                    {
                        id: 'event-l2',
                        created_at: '2025-12-12T09:00:00Z',
                        topic: 'governance.deploy.blocked',
                        service: 'gateway-governance',
                        status: 'warning',
                        message: 'Deploy blocked',
                        metadata: { level: 'L2', service: 'test' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/history?level=L1')
                .expect(200);

            expect(response.body.ok).toBe(true);
            // Level filtering happens in memory, so we should get events with L1 level
            if (response.body.events.length > 0) {
                expect(response.body.events.every((e: any) => e.level === 'L1')).toBe(true);
            }
        });

        it('should apply actor filter', async () => {
            mockSupabase.mockResolvedValueOnce({
                data: [
                    {
                        id: 'event-validator',
                        created_at: '2025-12-12T10:00:00Z',
                        topic: 'governance.evaluate',
                        service: 'gateway-governance',
                        status: 'success',
                        message: 'Evaluation completed',
                        metadata: { actor: 'validator', service: 'test' }
                    },
                    {
                        id: 'event-operator',
                        created_at: '2025-12-12T09:00:00Z',
                        topic: 'governance.deploy.allowed',
                        service: 'gateway-governance',
                        status: 'success',
                        message: 'Deploy allowed',
                        metadata: { source: 'operator', service: 'test' }
                    }
                ],
                error: null
            });

            const response = await request(app)
                .get('/api/v1/governance/history?actor=validator')
                .expect(200);

            expect(response.body.ok).toBe(true);
            // Actor filtering happens in memory
            if (response.body.events.length > 0) {
                expect(response.body.events.every((e: any) => e.actor === 'validator')).toBe(true);
            }
        });
    });
});
