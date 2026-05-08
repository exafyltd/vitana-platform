/**
 * BOOTSTRAP-PLANNER-SCANNER-AWARE-TRAPS — verifies that:
 *
 *   1. The planner prompt's "Common traps" block lifts forbidden paths
 *      based on the finding's scanner (so npm-audit gets to write
 *      package.json, rls-policy gets to add a new migration, etc.).
 *
 *   2. The safety gate's applyScannerOverrides() does the same at gate
 *      time, so even if the prompt is bypassed the gate accepts the
 *      finding's canonical fix.
 *
 * The 2026-05-08 audit found that without these two coordinated fixes,
 * ~40% of findings produced test-only PRs that fail CI 100%.
 */

import { buildPlanningPrompt } from '../src/services/dev-autopilot-planning';
import {
  applyScannerOverrides,
  evaluateSafetyGate,
} from '../src/services/dev-autopilot-safety';

const BASE_FINDING = {
  id: 'f-1',
  title: 'Test finding',
  summary: 'Description',
  domain: 'security',
  risk_class: 'medium' as const,
  spec_snapshot: { scanner: 'todo-scanner-v1' as string | undefined },
};

const BASE_SCOPE = {
  allow: ['services/gateway/src/routes/**', 'services/gateway/test/**'],
  deny: [
    'supabase/migrations/**',
    '**/auth*',
    '.github/workflows/**',
  ],
};

describe('applyScannerOverrides — safety gate per-scanner overrides', () => {
  it('returns inputs unchanged when scanner is undefined', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, undefined);
    expect(out.effectiveAllow).toEqual(BASE_SCOPE.allow);
    expect(out.effectiveDeny).toEqual(BASE_SCOPE.deny);
  });

  it('returns inputs unchanged for unknown scanner', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, 'unknown-scanner');
    expect(out.effectiveAllow).toEqual(BASE_SCOPE.allow);
    expect(out.effectiveDeny).toEqual(BASE_SCOPE.deny);
  });

  it('npm-audit-scanner-v1 → adds package.json + pnpm-lock.yaml to allow', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, 'npm-audit-scanner-v1');
    expect(out.effectiveAllow).toContain('**/package.json');
    expect(out.effectiveAllow).toContain('**/pnpm-lock.yaml');
    // Deny rules untouched
    expect(out.effectiveDeny).toEqual(BASE_SCOPE.deny);
  });

  it('cve-scanner-v1 → same package-manifest allow as npm-audit', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, 'cve-scanner-v1');
    expect(out.effectiveAllow).toContain('**/package.json');
  });

  it('rls-policy-scanner-v1 → lifts migrations deny rule', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, 'rls-policy-scanner-v1');
    expect(out.effectiveDeny).not.toContain('supabase/migrations/**');
    // Other deny rules preserved
    expect(out.effectiveDeny).toContain('**/auth*');
    expect(out.effectiveDeny).toContain('.github/workflows/**');
  });

  it('schema-drift-scanner-v1 → lifts migrations deny rule', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, 'schema-drift-scanner-v1');
    expect(out.effectiveDeny).not.toContain('supabase/migrations/**');
  });

  it('workflow-fix-scanner-v1 → lifts workflows deny rule', () => {
    const out = applyScannerOverrides(BASE_SCOPE.allow, BASE_SCOPE.deny, 'workflow-fix-scanner-v1');
    expect(out.effectiveDeny).not.toContain('.github/workflows/**');
    expect(out.effectiveDeny).toContain('supabase/migrations/**');
  });
});

describe('evaluateSafetyGate — end-to-end with scanner override', () => {
  const baseConfig = {
    kill_switch: false,
    daily_budget: 500,
    concurrency_cap: 4,
    max_auto_fix_depth: 2,
    allow_scope: BASE_SCOPE.allow,
    deny_scope: BASE_SCOPE.deny,
  };

  it('npm-audit finding modifying package.json + a test passes the gate', () => {
    const decision = evaluateSafetyGate(
      {
        risk_class: 'low',
        files_to_modify: [
          'services/gateway/package.json',
          'services/gateway/test/cve.test.ts',
        ],
      },
      {
        config: baseConfig,
        approved_today: 0,
        auto_fix_depth: 0,
        scanner: 'npm-audit-scanner-v1',
      },
    );
    expect(decision.ok).toBe(true);
    expect(decision.violations).toEqual([]);
  });

  it('todo finding cannot modify package.json (override does NOT leak)', () => {
    const decision = evaluateSafetyGate(
      {
        risk_class: 'low',
        files_to_modify: [
          'services/gateway/package.json',
          'services/gateway/test/foo.test.ts',
        ],
      },
      {
        config: baseConfig,
        approved_today: 0,
        auto_fix_depth: 0,
        scanner: 'todo-scanner-v1',
      },
    );
    expect(decision.ok).toBe(false);
    expect(decision.violations.find(v => v.code === 'file_outside_allow_scope')).toBeDefined();
  });

  it('rls-policy finding adding a new migration + a test passes the gate', () => {
    const allowWithMigrations = baseConfig.allow_scope.concat(['supabase/migrations/**']);
    const decision = evaluateSafetyGate(
      {
        risk_class: 'low',
        files_to_modify: [
          'supabase/migrations/20260508000000_add_rls.sql',
          'services/gateway/test/rls-policy.test.ts',
        ],
      },
      {
        config: { ...baseConfig, allow_scope: allowWithMigrations },
        approved_today: 0,
        auto_fix_depth: 0,
        scanner: 'rls-policy-scanner-v1',
      },
    );
    expect(decision.ok).toBe(true);
  });

  it('todo finding cannot add a migration (deny override does NOT leak)', () => {
    const allowWithMigrations = baseConfig.allow_scope.concat(['supabase/migrations/**']);
    const decision = evaluateSafetyGate(
      {
        risk_class: 'low',
        files_to_modify: [
          'supabase/migrations/20260508000000_random.sql',
          'services/gateway/test/rls.test.ts',
        ],
      },
      {
        config: { ...baseConfig, allow_scope: allowWithMigrations },
        approved_today: 0,
        auto_fix_depth: 0,
        scanner: 'todo-scanner-v1',
      },
    );
    expect(decision.ok).toBe(false);
    expect(decision.violations.find(v => v.code === 'file_in_deny_scope')).toBeDefined();
  });
});

describe('buildPlanningPrompt — scanner-aware traps', () => {
  function expectPromptFor(scanner: string): string {
    return buildPlanningPrompt(
      {
        ...BASE_FINDING,
        spec_snapshot: { scanner },
      } as Parameters<typeof buildPlanningPrompt>[0],
      undefined,
      undefined,
      BASE_SCOPE,
    );
  }

  it('npm-audit finding: prompt does NOT forbid package.json', () => {
    const prompt = expectPromptFor('npm-audit-scanner-v1');
    // The trap line that bans package.json must not be present for this scanner.
    expect(prompt).not.toMatch(/`services\/gateway\/package\.json` \/ any `package\.json`/);
  });

  it('todo finding: prompt DOES forbid package.json', () => {
    const prompt = expectPromptFor('todo-scanner-v1');
    expect(prompt).toMatch(/`package\.json`/);
    // sanity: we explicitly state to put it in Out-of-scope, not Files to modify
    expect(prompt).toMatch(/Out-of-scope/);
  });

  it('rls-policy finding: prompt does NOT forbid migrations as a class', () => {
    const prompt = expectPromptFor('rls-policy-scanner-v1');
    // It still tells you not to MODIFY existing migrations, but adding new ones is OK
    expect(prompt).not.toMatch(/Any `supabase\/migrations\/\*` file\n/);
    expect(prompt).toMatch(/ADDING a new dated migration file IS allowed/);
  });

  it('schema-drift finding: same allowance for new migrations', () => {
    const prompt = expectPromptFor('schema-drift-scanner-v1');
    expect(prompt).toMatch(/ADDING a new dated migration file IS allowed/);
  });

  it('todo finding: migrations DO appear in the trap list', () => {
    const prompt = expectPromptFor('todo-scanner-v1');
    expect(prompt).toMatch(/Any `supabase\/migrations\/\*` file/);
  });

  it('workflow-fix finding: prompt lifts the .github/workflows trap', () => {
    const prompt = expectPromptFor('workflow-fix-scanner-v1');
    expect(prompt).not.toMatch(/Any `\.github\/workflows\/\*` file/);
  });
});
