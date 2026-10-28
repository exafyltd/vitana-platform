/**
 * Skill Pack v1 Tests - VTID-01164
 *
 * Unit tests for all worker skills.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import {
  checkMemoryFirst,
  securityScan,
  validateRlsPolicy,
  previewMigration,
  analyzeService,
  validateAccessibility,
} from '../index';
import { SkillContext } from '../types';

// =============================================================================
// Mock Setup
// =============================================================================

// Mock context for all tests
const createMockContext = (domain: string): SkillContext => ({
  vtid: 'VTID-01164',
  run_id: 'test_run_001',
  domain: domain as any,
  emitEvent: vi.fn().mockResolvedValue({ ok: true, event_id: 'mock-event-id' }),
});

// Mock fetch for OASIS/Supabase calls
const originalFetch = global.fetch;

beforeAll(() => {
  // Mock environment
  process.env.SUPABASE_URL = 'https://mock.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE = 'mock-service-role-key';

  // Mock fetch
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve([]),
    text: () => Promise.resolve(''),
  });
});

afterAll(() => {
  global.fetch = originalFetch;
});

// =============================================================================
// Check Memory First Tests
// =============================================================================

describe('checkMemoryFirst', () => {
  it('should return proceed when no prior work found', async () => {
    const context = createMockContext('common');
    const result = await checkMemoryFirst({
      vtid: 'VTID-01164',
      query: 'Add new endpoint for user preferences',
      target_paths: ['services/gateway/src/routes/preferences.ts'],
    }, context);

    expect(result.ok).toBe(true);
    expect(result.recommendation).toBe('proceed');
    expect(context.emitEvent).toHaveBeenCalledWith(
      'start',
      'info',
      expect.any(String),
      expect.any(Object)
    );
    expect(context.emitEvent).toHaveBeenCalledWith(
      'success',
      'success',
      expect.any(String),
      expect.any(Object)
    );
  });

  it('should include path pattern references', async () => {
    const context = createMockContext('common');
    const result = await checkMemoryFirst({
      vtid: 'VTID-01164',
      query: 'Add migration for new table',
      target_paths: ['supabase/migrations/20260104_new_table.sql'],
    }, context);

    expect(result.ok).toBe(true);
    // Should find memory domain pattern
    expect(result.relevant_refs.some(r => r.type === 'pattern')).toBe(true);
  });
});

// =============================================================================
// Security Scan Tests
// =============================================================================

describe('securityScan', () => {
  it('should detect SQL injection patterns', async () => {
    const context = createMockContext('backend');
    const result = await securityScan({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        const query = \`SELECT * FROM users WHERE id = \${userId}\`;
        db.execute(query);
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings.some(f => f.category === 'injection')).toBe(true);
    expect(result.passed).toBe(false);
  });

  it('should pass clean code', async () => {
    const context = createMockContext('backend');
    const result = await securityScan({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        const schema = z.object({ id: z.string() });
        const { id } = schema.parse(req.body);
        const user = await db.query('SELECT * FROM users WHERE id = $1', [id]);
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.summary.critical).toBe(0);
    expect(result.summary.high).toBe(0);
    expect(result.passed).toBe(true);
  });

  it('should detect hardcoded secrets', async () => {
    const context = createMockContext('backend');
    const result = await securityScan({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        const apiKey = "sk_live_1234567890abcdef";
        const password = "supersecretpassword123";
      `,
      categories: ['sensitive_data'],
    }, context);

    expect(result.ok).toBe(true);
    expect(result.findings.some(f => f.category === 'sensitive_data')).toBe(true);
  });
});

// =============================================================================
// Validate RLS Policy Tests
// =============================================================================

describe('validateRlsPolicy', () => {
  it('should validate policies with tenant isolation', async () => {
    const context = createMockContext('memory');
    const result = await validateRlsPolicy({
      vtid: 'VTID-01164',
      policy_content: `
        CREATE POLICY "users_tenant_isolation"
        ON users
        FOR ALL
        USING (tenant_id = current_tenant_id())
        WITH CHECK (tenant_id = current_tenant_id());
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.violations.length).toBe(0);
    expect(result.tenant_helpers_used).toContain('current_tenant_id()');
  });

  it('should flag policies without tenant isolation', async () => {
    const context = createMockContext('memory');
    const result = await validateRlsPolicy({
      vtid: 'VTID-01164',
      policy_content: `
        CREATE POLICY "public_read"
        ON users
        FOR SELECT
        USING (true);
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
    expect(result.violations[0].severity).toBe('critical');
  });

  it('should allow exempt tables', async () => {
    const context = createMockContext('memory');
    const result = await validateRlsPolicy({
      vtid: 'VTID-01164',
      policy_content: `
        CREATE POLICY "oasis_events_public"
        ON oasis_events
        FOR SELECT
        USING (true);
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// Preview Migration Tests
// =============================================================================

describe('previewMigration', () => {
  it('should detect DROP TABLE as blocker', async () => {
    const context = createMockContext('memory');
    const result = await previewMigration({
      vtid: 'VTID-01164',
      migration_content: `
        DROP TABLE users;
        CREATE TABLE users_v2 (id UUID PRIMARY KEY);
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.safe_to_apply).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
    expect(result.operations_detected.some(o => o.type === 'DROP_TABLE')).toBe(true);
  });

  it('should pass safe migrations', async () => {
    const context = createMockContext('memory');
    const result = await previewMigration({
      vtid: 'VTID-01164',
      migration_content: `
        CREATE TABLE IF NOT EXISTS user_preferences (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id),
          preferences JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.safe_to_apply).toBe(true);
    expect(result.blockers.length).toBe(0);
  });

  it('should validate naming convention', async () => {
    const context = createMockContext('memory');
    const result = await previewMigration({
      vtid: 'VTID-01164',
      migration_content: 'CREATE TABLE test (id INT);',
      file_path: '20260104150000_vtid_01164_add_test.sql',
    }, context);

    expect(result.ok).toBe(true);
    expect(result.naming_check.valid).toBe(true);
  });
});

// =============================================================================
// Analyze Service Tests
// =============================================================================

describe('analyzeService', () => {
  it('should return empty results when no matches', async () => {
    const context = createMockContext('backend');
    const result = await analyzeService({
      vtid: 'VTID-01164',
      keywords: ['nonexistent_feature_xyz123'],
    }, context);

    expect(result.ok).toBe(true);
    expect(result.summary.duplicate_risk).toBe('none');
  });

  it('should include implementation recommendation', async () => {
    const context = createMockContext('backend');
    const result = await analyzeService({
      vtid: 'VTID-01164',
      feature_description: 'Add new endpoint',
    }, context);

    expect(result.ok).toBe(true);
    expect(result.implementation_recommendation).toBeDefined();
    expect(result.implementation_recommendation.location).toBeTruthy();
    expect(result.implementation_recommendation.notes.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// Validate Accessibility Tests
// =============================================================================

describe('validateAccessibility', () => {
  it('should detect missing aria-label on icon buttons', async () => {
    const context = createMockContext('frontend');
    const result = await validateAccessibility({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        <button><i class="fa-trash"></i></button>
        <button><svg class="icon-close"></svg></button>
      `,
    }, context);

    expect(result.ok).toBe(true);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.some(i => i.category === 'aria_labels')).toBe(true);
  });

  it('should pass accessible buttons', async () => {
    const context = createMockContext('frontend');
    const result = await validateAccessibility({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        <button aria-label="Delete item"><i class="fa-trash"></i></button>
        <button title="Close dialog"><svg class="icon-close"></svg></button>
      `,
    }, context);

    expect(result.ok).toBe(true);
    // Should have fewer or no issues
    expect(result.issues.filter(i => i.category === 'aria_labels').length).toBe(0);
  });

  it('should detect positive tabindex', async () => {
    const context = createMockContext('frontend');
    const result = await validateAccessibility({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        <input tabindex="5" />
        <button tabindex="3">Submit</button>
      `,
      checks: ['keyboard_nav'],
    }, context);

    expect(result.ok).toBe(true);
    expect(result.issues.some(i => i.id.includes('TABINDEX_POSITIVE'))).toBe(true);
  });

  it('should detect missing alt text', async () => {
    const context = createMockContext('frontend');
    const result = await validateAccessibility({
      vtid: 'VTID-01164',
      target_paths: [],
      diff_content: `
        <img src="logo.png" />
        <img src="banner.jpg" class="hero-image" />
      `,
      checks: ['alt_text'],
    }, context);

    expect(result.ok).toBe(true);
    expect(result.issues.some(i => i.category === 'alt_text')).toBe(true);
  });
});

// =============================================================================
// Registry Tests
// =============================================================================

describe('Skill Registry', () => {
  it('should list all registered skills', async () => {
    const { listSkills } = await import('../registry');
    const skills = listSkills();

    expect(skills.length).toBe(6);
    expect(skills.some(s => s.skill_id === 'worker.common.check_memory_first')).toBe(true);
    expect(skills.some(s => s.skill_id === 'worker.backend.security_scan')).toBe(true);
    expect(skills.some(s => s.skill_id === 'worker.memory.validate_rls_policy')).toBe(true);
    expect(skills.some(s => s.skill_id === 'worker.memory.preview_migration')).toBe(true);
    expect(skills.some(s => s.skill_id === 'worker.backend.analyze_service')).toBe(true);
    expect(skills.some(s => s.skill_id === 'worker.frontend.validate_accessibility')).toBe(true);
  });

  it('should get skill by ID', async () => {
    const { getSkill } = await import('../registry');
    const skill = getSkill('worker.backend.security_scan');

    expect(skill).toBeDefined();
    expect(skill?.name).toBe('Backend Security Scan');
    expect(skill?.domain).toBe('backend');
  });

  it('should have preflight chains for all domains', async () => {
    const { PREFLIGHT_CHAINS } = await import('../registry');

    expect(PREFLIGHT_CHAINS.frontend).toBeDefined();
    expect(PREFLIGHT_CHAINS.backend).toBeDefined();
    expect(PREFLIGHT_CHAINS.memory).toBeDefined();

    // All chains should include memory-first
    expect(PREFLIGHT_CHAINS.frontend).toContain('worker.common.check_memory_first');
    expect(PREFLIGHT_CHAINS.backend).toContain('worker.common.check_memory_first');
    expect(PREFLIGHT_CHAINS.memory).toContain('worker.common.check_memory_first');
  });
});
