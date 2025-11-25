import { RuleMatcher } from '../src/validator-core/ruleMatcher';
import { EnforcementExecutor } from '../src/validator-core/enforcementExecutor';
import { OasisPipeline } from '../src/validator-core/oasisPipeline';
import { ViolationGenerator } from '../src/validator-core/violationGenerator';

/**
 * VTID-112: Test that validator-core doesn't crash when Supabase env vars are missing
 * 
 * This test simulates the Cloud Run startup scenario where SUPABASE_URL and 
 * SUPABASE_SERVICE_ROLE may not be configured yet.
 */

describe('Validator Core - Safe Initialization (VTID-112)', () => {
    beforeAll(() => {
        // Clear env vars to simulate missing config
        delete process.env.SUPABASE_URL;
        delete process.env.SUPABASE_SERVICE_ROLE;
        delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    });

    test('RuleMatcher returns empty array when Supabase unavailable', async () => {
        const matcher = new RuleMatcher();
        const rules = await matcher.getActiveRules('test-tenant');
        expect(rules).toEqual([]);
    });

    test('OasisPipeline logs without crashing when Supabase unavailable', async () => {
        const pipeline = new OasisPipeline();
        await expect(
            pipeline.logEvent('test.event', { eventType: 'test', data: {} })
        ).resolves.not.toThrow();
    });

    test('EnforcementExecutor executes without crashing when Supabase unavailable', async () => {
        const executor = new EnforcementExecutor();
        const mockRule: any = {
            id: 'test-rule',
            tenant_id: 'test-tenant',
            name: 'Test Rule',
            logic: { action: 'LOG' }
        };

        await expect(
            executor.executeEnforcement(mockRule, 'test-entity', {})
        ).resolves.not.toThrow();
    });

    test('ViolationGenerator creates violation without crashing when Supabase unavailable', async () => {
        const generator = new ViolationGenerator();
        const mockRule: any = {
            id: 'test-rule',
            tenant_id: 'test-tenant'
        };
        const mockViolation: any = {
            id: 'test-violation',
            tenant_id: 'test-tenant',
            rule_id: 'test-rule',
            severity: 'MEDIUM'
        };

        await expect(
            generator.createViolation(mockRule, mockViolation)
        ).resolves.not.toThrow();
    });
});
