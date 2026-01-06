/**
 * VTID-01160: Task Discovery Validator Tests
 *
 * Tests for OASIS_ONLY_TASK_TRUTH governance rule enforcement.
 *
 * VERIFICATION REQUIREMENTS (from spec section 4):
 * 4.1 Negative test: Force an attempted repo-based list, governance must block it and log violation.
 * 4.2 Positive test: Normal request using discover_tasks, governance passes.
 */

import {
    TaskDiscoveryValidator,
    getTaskDiscoveryValidator,
    detectTaskSource,
    extractTaskIds,
    buildTaskDiscoveryContext,
    RULE_ID,
    RULE_NAME,
    BLOCKED_MESSAGE,
    REQUIRED_DISCOVERY_TOOL,
} from '../src/validator-core/task-discovery-validator';
import type {
    TaskDiscoveryContext,
    TaskDiscoverySurface,
} from '../src/types/governance';
import { VTID_FORMAT } from '../src/types/governance';

describe('VTID-01160: TaskDiscoveryValidator', () => {
    let validator: TaskDiscoveryValidator;

    beforeEach(() => {
        validator = getTaskDiscoveryValidator();
    });

    describe('Constants', () => {
        it('should have correct rule identifiers', () => {
            expect(RULE_ID).toBe('GOV-INTEL-R.1');
            expect(RULE_NAME).toBe('OASIS_ONLY_TASK_TRUTH');
            expect(BLOCKED_MESSAGE).toBe('Blocked by governance: task status must come from OASIS.');
            expect(REQUIRED_DISCOVERY_TOOL).toBe('mcp__vitana-work__discover_tasks');
        });

        it('should have correct VTID format patterns', () => {
            expect(VTID_FORMAT.PATTERN.source).toBe('^VTID-\\d{4,5}$');
            expect(VTID_FORMAT.LEGACY_PATTERNS.length).toBe(4);
            expect(VTID_FORMAT.ALLOWED_PENDING_STATUSES).toEqual(['scheduled', 'allocated', 'in_progress']);
        });
    });

    // =========================================================================
    // SECTION 4.2: POSITIVE TESTS - Compliant OASIS-sourced task discovery
    // =========================================================================
    describe('4.2 Positive Test: Compliant OASIS Task Discovery', () => {
        it('should PASS when using OASIS source with discover_tasks tool', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'What are the pending tasks?',
                used_discover_tasks: true,
                response_source_of_truth: 'OASIS',
                task_ids: ['VTID-01160', 'VTID-01161'],
                pending_statuses: ['scheduled', 'in_progress'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(true);
            expect(result.action).toBe('pass');
            expect(result.errors).toHaveLength(0);
            expect(result.reason).toBeUndefined();
        });

        it('should PASS for ORB surface with valid VTID formats', () => {
            const context: TaskDiscoveryContext = {
                surface: 'orb',
                detected_source: 'oasis',
                requested_query: 'Show me my tasks',
                used_discover_tasks: true,
                response_source_of_truth: 'OASIS',
                task_ids: ['VTID-0001', 'VTID-99999'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(true);
            expect(result.action).toBe('pass');
        });

        it('should PASS for MCP surface with scheduled status', () => {
            const context: TaskDiscoveryContext = {
                surface: 'mcp',
                detected_source: 'oasis',
                requested_query: 'list pending tasks',
                used_discover_tasks: true,
                pending_statuses: ['scheduled'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(true);
            expect(result.action).toBe('pass');
        });

        it('should PASS when no task_ids provided (empty response)', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Any pending work?',
                used_discover_tasks: true,
                response_source_of_truth: 'OASIS',
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(true);
            expect(result.action).toBe('pass');
        });
    });

    // =========================================================================
    // SECTION 4.1: NEGATIVE TESTS - Non-compliant task discovery
    // =========================================================================
    describe('4.1 Negative Test: Block Non-OASIS Sources', () => {
        it('should BLOCK when source is repo_scan', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'repo_scan',
                requested_query: 'What tasks are in the specs folder?',
                used_discover_tasks: false,
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
            expect(result.user_message).toBe(BLOCKED_MESSAGE);
            expect(result.retry_action).toBe('discover_tasks_required');
            expect(result.errors.some(e => e.code === 'INVALID_SOURCE')).toBe(true);
        });

        it('should BLOCK when source is memory', () => {
            const context: TaskDiscoveryContext = {
                surface: 'orb',
                detected_source: 'memory',
                requested_query: 'What did I ask about before?',
                used_discover_tasks: false,
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
            expect(result.errors.some(e => e.code === 'INVALID_SOURCE')).toBe(true);
        });

        it('should BLOCK when source is unknown', () => {
            const context: TaskDiscoveryContext = {
                surface: 'mcp',
                detected_source: 'unknown',
                requested_query: 'Show tasks',
                used_discover_tasks: false,
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
        });

        it('should BLOCK when discover_tasks tool is not used', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis', // Even if source is OASIS
                requested_query: 'List tasks',
                used_discover_tasks: false, // But tool not used
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
            expect(result.errors.some(e => e.code === 'MISSING_DISCOVER_TASKS')).toBe(true);
        });

        it('should BLOCK when response source_of_truth is not OASIS', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Show pending work',
                used_discover_tasks: true,
                response_source_of_truth: 'LOCAL_CACHE', // Invalid source
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
            expect(result.errors.some(e => e.code === 'INVALID_SOURCE' && e.value === 'LOCAL_CACHE')).toBe(true);
        });
    });

    // =========================================================================
    // Legacy ID Detection Tests
    // =========================================================================
    describe('Legacy ID Detection (DEV-*, ADM-*, AICOR-*, OASIS-TASK-*)', () => {
        it('should BLOCK when DEV-* pattern detected in task_ids', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Show tasks',
                used_discover_tasks: true,
                task_ids: ['VTID-01160', 'DEV-OASIS-0101'], // Legacy ID
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
            expect(result.errors.some(e => e.code === 'LEGACY_ID_DETECTED')).toBe(true);
            expect(result.errors.find(e => e.code === 'LEGACY_ID_DETECTED')?.value).toBe('DEV-OASIS-0101');
        });

        it('should BLOCK when ADM-* pattern detected', () => {
            const context: TaskDiscoveryContext = {
                surface: 'orb',
                detected_source: 'oasis',
                requested_query: 'List tasks',
                used_discover_tasks: true,
                task_ids: ['ADM-001'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.code === 'LEGACY_ID_DETECTED')).toBe(true);
        });

        it('should BLOCK when AICOR-* pattern detected', () => {
            const context: TaskDiscoveryContext = {
                surface: 'mcp',
                detected_source: 'oasis',
                requested_query: 'Get tasks',
                used_discover_tasks: true,
                task_ids: ['AICOR-TASK-42'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.code === 'LEGACY_ID_DETECTED')).toBe(true);
        });

        it('should BLOCK when OASIS-TASK-* pattern detected', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Tasks',
                used_discover_tasks: true,
                task_ids: ['OASIS-TASK-0001'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.code === 'LEGACY_ID_DETECTED')).toBe(true);
        });

        it('should detect multiple legacy IDs', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'All tasks',
                used_discover_tasks: true,
                task_ids: ['DEV-001', 'ADM-002', 'VTID-01160'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            const legacyErrors = result.errors.filter(e => e.code === 'LEGACY_ID_DETECTED');
            expect(legacyErrors.length).toBe(2);
        });
    });

    // =========================================================================
    // VTID Format Validation Tests
    // =========================================================================
    describe('VTID Format Validation (^VTID-\\d{4,5}$)', () => {
        it('should PASS for valid 4-digit VTID', () => {
            expect(validator.isValidVtidFormat('VTID-0001')).toBe(true);
            expect(validator.isValidVtidFormat('VTID-9999')).toBe(true);
        });

        it('should PASS for valid 5-digit VTID', () => {
            expect(validator.isValidVtidFormat('VTID-01160')).toBe(true);
            expect(validator.isValidVtidFormat('VTID-99999')).toBe(true);
        });

        it('should FAIL for 3-digit VTID (too short)', () => {
            expect(validator.isValidVtidFormat('VTID-001')).toBe(false);
        });

        it('should FAIL for 6-digit VTID (too long)', () => {
            expect(validator.isValidVtidFormat('VTID-123456')).toBe(false);
        });

        it('should FAIL for VTID with letters', () => {
            expect(validator.isValidVtidFormat('VTID-01A60')).toBe(false);
        });

        it('should FAIL for lowercase vtid', () => {
            expect(validator.isValidVtidFormat('vtid-01160')).toBe(false);
        });

        it('should FAIL for missing hyphen', () => {
            expect(validator.isValidVtidFormat('VTID01160')).toBe(false);
        });

        it('should BLOCK context with invalid VTID formats', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Show tasks',
                used_discover_tasks: true,
                task_ids: ['VTID-01160', 'VTID-123', 'TASK-9999'], // Last two are invalid
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.action).toBe('block');
            const formatErrors = result.errors.filter(e => e.code === 'INVALID_VTID_FORMAT');
            expect(formatErrors.length).toBe(2);
        });
    });

    // =========================================================================
    // Pending Status Validation Tests
    // =========================================================================
    describe('Pending Status Validation', () => {
        it('should PASS for valid pending statuses', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Pending tasks',
                used_discover_tasks: true,
                pending_statuses: ['scheduled', 'allocated', 'in_progress'],
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(true);
        });

        it('should BLOCK for invalid pending status', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Tasks',
                used_discover_tasks: true,
                pending_statuses: ['completed'], // Not a pending status
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            expect(result.errors.some(e => e.code === 'INVALID_STATUS' && e.value === 'completed')).toBe(true);
        });

        it('should BLOCK for terminal status in pending list', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'oasis',
                requested_query: 'Tasks',
                used_discover_tasks: true,
                pending_statuses: ['scheduled', 'cancelled', 'failed'], // Terminal statuses
            };

            const result = validator.validate(context);

            expect(result.valid).toBe(false);
            const statusErrors = result.errors.filter(e => e.code === 'INVALID_STATUS');
            expect(statusErrors.length).toBe(2);
        });
    });

    // =========================================================================
    // isLegacyId Helper Tests
    // =========================================================================
    describe('isLegacyId helper', () => {
        it('should detect DEV- prefix', () => {
            expect(validator.isLegacyId('DEV-OASIS-0101')).toBe('^DEV-');
        });

        it('should detect ADM- prefix', () => {
            expect(validator.isLegacyId('ADM-001')).toBe('^ADM-');
        });

        it('should detect AICOR- prefix', () => {
            expect(validator.isLegacyId('AICOR-TASK-42')).toBe('^AICOR-');
        });

        it('should detect OASIS-TASK- prefix', () => {
            expect(validator.isLegacyId('OASIS-TASK-0001')).toBe('^OASIS-TASK-');
        });

        it('should return undefined for valid VTID', () => {
            expect(validator.isLegacyId('VTID-01160')).toBeUndefined();
        });
    });

    // =========================================================================
    // isTaskStateQuery Helper Tests
    // =========================================================================
    describe('isTaskStateQuery helper', () => {
        it('should detect "what tasks" queries', () => {
            expect(validator.isTaskStateQuery('What are the pending tasks?')).toBe(true);
            expect(validator.isTaskStateQuery('what tasks are assigned?')).toBe(true);
        });

        it('should detect "pending tasks" queries', () => {
            expect(validator.isTaskStateQuery('Show pending tasks')).toBe(true);
        });

        it('should detect "task status" queries', () => {
            expect(validator.isTaskStateQuery('What is the task status for VTID-01160?')).toBe(true);
        });

        it('should detect "scheduled tasks" queries', () => {
            expect(validator.isTaskStateQuery('List scheduled tasks')).toBe(true);
        });

        it('should detect "in progress" queries', () => {
            expect(validator.isTaskStateQuery('Any tasks in progress?')).toBe(true);
        });

        it('should detect "my tasks" queries', () => {
            expect(validator.isTaskStateQuery('Show my tasks')).toBe(true);
        });

        it('should detect VTID references', () => {
            expect(validator.isTaskStateQuery('What is VTID-01160?')).toBe(true);
        });

        it('should NOT detect unrelated queries', () => {
            expect(validator.isTaskStateQuery('Hello, how are you?')).toBe(false);
            expect(validator.isTaskStateQuery('What is the weather?')).toBe(false);
        });
    });

    // =========================================================================
    // Violation Payload Generation Tests
    // =========================================================================
    describe('createViolationPayload', () => {
        it('should create correct violation payload', () => {
            const context: TaskDiscoveryContext = {
                surface: 'operator',
                detected_source: 'repo_scan',
                requested_query: 'List spec files',
                used_discover_tasks: false,
                task_ids: ['DEV-001', 'VTID-123'],
            };

            const errors = [
                { code: 'INVALID_SOURCE' as const, message: 'Bad source', value: 'repo_scan' },
                { code: 'LEGACY_ID_DETECTED' as const, message: 'Legacy ID', value: 'DEV-001' },
                { code: 'INVALID_VTID_FORMAT' as const, message: 'Bad format', value: 'VTID-123' },
            ];

            const payload = validator.createViolationPayload(context, errors);

            expect(payload.rule_id).toBe('GOV-INTEL-R.1');
            expect(payload.rule_name).toBe('OASIS_ONLY_TASK_TRUTH');
            expect(payload.status).toBe('blocked');
            expect(payload.surface).toBe('operator');
            expect(payload.detected_source).toBe('repo_scan');
            expect(payload.requested_query).toBe('List spec files');
            expect(payload.retry_action).toBe('discover_tasks_required');
            expect(payload.invalid_task_ids).toEqual(['DEV-001', 'VTID-123']);
            expect(payload.violated_at).toBeDefined();
        });
    });

    // =========================================================================
    // Utility Function Tests
    // =========================================================================
    describe('Utility Functions', () => {
        describe('detectTaskSource', () => {
            it('should detect OASIS from source_of_truth field', () => {
                expect(detectTaskSource({ source_of_truth: 'OASIS' })).toBe('oasis');
            });

            it('should detect OASIS from tool_used field', () => {
                expect(detectTaskSource({ tool_used: 'mcp__vitana-work__discover_tasks' })).toBe('oasis');
            });

            it('should detect repo_scan from data_origin', () => {
                expect(detectTaskSource({ data_origin: 'repository_scan' })).toBe('repo_scan');
                expect(detectTaskSource({ data_origin: 'file_system' })).toBe('repo_scan');
            });

            it('should detect memory from data_origin', () => {
                expect(detectTaskSource({ data_origin: 'memory_cache' })).toBe('memory');
            });

            it('should return unknown for unrecognized sources', () => {
                expect(detectTaskSource({})).toBe('unknown');
                expect(detectTaskSource({ data_origin: 'other' })).toBe('unknown');
            });
        });

        describe('extractTaskIds', () => {
            it('should extract from pending array', () => {
                const ids = extractTaskIds({
                    pending: [
                        { vtid: 'VTID-01160' },
                        { vtid: 'VTID-01161' },
                    ],
                });
                expect(ids).toEqual(['VTID-01160', 'VTID-01161']);
            });

            it('should extract from tasks array with vtid', () => {
                const ids = extractTaskIds({
                    tasks: [
                        { vtid: 'VTID-01160' },
                        { vtid: 'VTID-01161' },
                    ],
                });
                expect(ids).toEqual(['VTID-01160', 'VTID-01161']);
            });

            it('should extract from tasks array with id fallback', () => {
                const ids = extractTaskIds({
                    tasks: [
                        { id: 'VTID-01160' },
                    ],
                });
                expect(ids).toEqual(['VTID-01160']);
            });

            it('should extract from task_ids array', () => {
                const ids = extractTaskIds({
                    task_ids: ['VTID-01160', 'VTID-01161'],
                });
                expect(ids).toEqual(['VTID-01160', 'VTID-01161']);
            });

            it('should dedupe extracted IDs', () => {
                const ids = extractTaskIds({
                    pending: [{ vtid: 'VTID-01160' }],
                    task_ids: ['VTID-01160', 'VTID-01161'],
                });
                expect(ids).toEqual(['VTID-01160', 'VTID-01161']);
            });
        });

        describe('buildTaskDiscoveryContext', () => {
            it('should build context from params', () => {
                const context = buildTaskDiscoveryContext({
                    surface: 'operator',
                    query: 'Show tasks',
                    response: {
                        source_of_truth: 'OASIS',
                        pending: [
                            { vtid: 'VTID-01160', status: 'scheduled' },
                        ],
                    },
                    tool_used: 'mcp__vitana-work__discover_tasks',
                });

                expect(context.surface).toBe('operator');
                expect(context.detected_source).toBe('oasis');
                expect(context.requested_query).toBe('Show tasks');
                expect(context.used_discover_tasks).toBe(true);
                expect(context.task_ids).toEqual(['VTID-01160']);
                expect(context.response_source_of_truth).toBe('OASIS');
                expect(context.pending_statuses).toEqual(['scheduled']);
            });
        });
    });

    // =========================================================================
    // All Surfaces Test
    // =========================================================================
    describe('All Surfaces (orb, operator, mcp, other)', () => {
        const surfaces: TaskDiscoverySurface[] = ['orb', 'operator', 'mcp', 'other'];

        surfaces.forEach(surface => {
            it(`should validate ${surface} surface correctly`, () => {
                const validContext: TaskDiscoveryContext = {
                    surface,
                    detected_source: 'oasis',
                    requested_query: 'List tasks',
                    used_discover_tasks: true,
                };

                const result = validator.validate(validContext);
                expect(result.valid).toBe(true);
            });

            it(`should block ${surface} surface on non-OASIS source`, () => {
                const invalidContext: TaskDiscoveryContext = {
                    surface,
                    detected_source: 'repo_scan',
                    requested_query: 'List tasks',
                    used_discover_tasks: false,
                };

                const result = validator.validate(invalidContext);
                expect(result.valid).toBe(false);
                expect(result.action).toBe('block');
            });
        });
    });
});
