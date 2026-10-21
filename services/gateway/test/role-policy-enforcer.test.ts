/**
 * Role policy enforcer tests — BOOTSTRAP-ROLE-AUTH-ENFORCER.
 *
 * Validates the closed-world (deny-by-default) enforcement layer over the
 * assistant role registry (VTID-03240):
 *   - Each of the 7 roles ALLOWS every tool in its declared allowlist.
 *   - Each role DENIES tools that are not in its allowlist (including tools
 *     that belong to OTHER roles → no cross-role leakage).
 *   - Explicit denylist patterns are denied.
 *   - Unknown role → deny-by-default with reason 'unknown_role'.
 *   - Context-source allow/deny mirror the registry.
 *   - Shadow vs enforce gating: flag off => enforced=false, never block;
 *     flag on => enforced=true, block on deny.
 *
 * The enforcer must NOT relax the registry — these tests pin that contract.
 */

process.env.NODE_ENV = 'test';

import { isFeatureLive } from '../src/services/feature-flags';
import {
  ASSISTANT_ROLES,
  ROLE_PROFILES,
  type AssistantRole,
} from '../src/services/intelligence/assistant-role-registry';
import {
  assertSourceAllowed,
  assertToolAllowed,
  isEnforcementLive,
  shouldBlockSource,
  shouldBlockTool,
} from '../src/services/intelligence/role-policy-enforcer';

jest.mock('../src/services/feature-flags', () => ({
  isFeatureLive: jest.fn(),
}));

const mockIsFeatureLive = isFeatureLive as jest.MockedFunction<typeof isFeatureLive>;

beforeEach(() => {
  jest.clearAllMocks();
  // Default: enforcement OFF (shadow mode) unless a test flips it.
  mockIsFeatureLive.mockReturnValue(false);
});

describe('assertToolAllowed — per-role allowlist coverage', () => {
  test('every role allows every tool in its declared allowlist', () => {
    for (const role of ASSISTANT_ROLES) {
      const profile = ROLE_PROFILES[role];
      for (const tool of profile.tool_allowlist) {
        const d = assertToolAllowed(role, tool);
        expect({ role, tool, allowed: d.allowed, reason: d.reason }).toEqual({
          role,
          tool,
          allowed: true,
          reason: 'allowed',
        });
      }
    }
  });

  test('every role denies a tool that is not in any allowlist', () => {
    const fabricated = 'totally_made_up_tool_name_xyz';
    for (const role of ASSISTANT_ROLES) {
      const d = assertToolAllowed(role, fabricated);
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe('denied_by_policy');
    }
  });
});

describe('no cross-role leakage — a role denies tools exclusive to other roles', () => {
  // For each role, take tools that ANOTHER role allows but this role does
  // NOT allow, and assert they are denied.
  test.each([...ASSISTANT_ROLES])('role %s denies other roles\' exclusive tools', (role) => {
    const ownAllow = new Set(ROLE_PROFILES[role as AssistantRole].tool_allowlist);
    const otherTools = new Set<string>();
    for (const other of ASSISTANT_ROLES) {
      if (other === role) continue;
      for (const t of ROLE_PROFILES[other].tool_allowlist) {
        if (!ownAllow.has(t)) otherTools.add(t);
      }
    }
    // Sanity: there should be cross-role-distinct tools to check.
    expect(otherTools.size).toBeGreaterThan(0);
    for (const t of otherTools) {
      const d = assertToolAllowed(role, t);
      expect({ role, tool: t, allowed: d.allowed }).toEqual({ role, tool: t, allowed: false });
    }
  });
});

describe('explicit denylist patterns are denied', () => {
  test('community denies admin_*/devops_* prefixed tools', () => {
    expect(assertToolAllowed('community', 'admin_force_publish').allowed).toBe(false);
    expect(assertToolAllowed('community', 'devops_drop_table').allowed).toBe(false);
    expect(assertToolAllowed('community', 'cicd_run_pipeline').allowed).toBe(false);
  });

  test('developer is explicitly denied community wellness + canary tools', () => {
    for (const t of ['get_pillar_status', 'find_partner', 'publish_canary', 'promote_canary', 'log_symptom']) {
      expect(assertToolAllowed('developer', t).allowed).toBe(false);
    }
  });

  test('admin denies cicd_force_* even though it is operational', () => {
    expect(assertToolAllowed('admin', 'cicd_force_merge').allowed).toBe(false);
    expect(assertToolAllowed('admin', 'devops_drop_secrets').allowed).toBe(false);
  });

  test('staff denies publish/revert/canary prefixes', () => {
    for (const t of ['publish_canary', 'revert_deployment', 'canary_promote']) {
      expect(assertToolAllowed('staff', t).allowed).toBe(false);
    }
  });
});

describe('unknown / null role → deny-by-default', () => {
  test('unrecognized role denies with reason unknown_role', () => {
    const d = assertToolAllowed('superuser', 'send_chat_message');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unknown_role');
    expect(d.role).toBe('superuser');
  });

  test('null role denies with reason unknown_role', () => {
    const d = assertToolAllowed(null, 'remember');
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe('unknown_role');
    expect(d.role).toBeNull();
  });
});

describe('assertSourceAllowed — context-source policy mirrors registry', () => {
  test('every role allows each source in its allowlist and denies denylist + unknown', () => {
    for (const role of ASSISTANT_ROLES) {
      const profile = ROLE_PROFILES[role];
      for (const src of profile.context_source_allowlist) {
        expect(assertSourceAllowed(role, src).allowed).toBe(true);
      }
      for (const src of profile.context_source_denylist) {
        expect(assertSourceAllowed(role, src).allowed).toBe(false);
      }
      // safety_guardrails must never be allowed for any role.
      expect(assertSourceAllowed(role, 'safety_guardrails').allowed).toBe(false);
      // a fabricated source id is denied by default.
      expect(assertSourceAllowed(role, 'made_up_source_id').allowed).toBe(false);
    }
  });

  test('infra denies user memory sources (bounded to infra-only)', () => {
    expect(assertSourceAllowed('infra', 'memory_facts').allowed).toBe(false);
    expect(assertSourceAllowed('infra', 'vitana_index').allowed).toBe(false);
    expect(assertSourceAllowed('infra', 'assistant_state').allowed).toBe(true);
  });
});

describe('shadow vs enforce gating', () => {
  test('flag OFF: enforced=false, shouldBlockTool never blocks even on deny', () => {
    mockIsFeatureLive.mockReturnValue(false);
    expect(isEnforcementLive()).toBe(false);

    const denyDecision = assertToolAllowed('community', 'devops_drop_table');
    expect(denyDecision.allowed).toBe(false);
    expect(denyDecision.enforced).toBe(false);

    // Shadow mode: never blocks.
    expect(shouldBlockTool('community', 'devops_drop_table')).toBe(false);
    expect(shouldBlockSource('infra', 'memory_facts')).toBe(false);
  });

  test('flag ON: enforced=true, shouldBlockTool blocks on deny but not on allow', () => {
    mockIsFeatureLive.mockReturnValue(true);
    expect(isEnforcementLive()).toBe(true);

    // Denied tool → block.
    expect(shouldBlockTool('community', 'devops_drop_table')).toBe(true);
    // Allowed tool → no block.
    expect(shouldBlockTool('community', 'send_chat_message')).toBe(false);
    // Denied source → block.
    expect(shouldBlockSource('infra', 'memory_facts')).toBe(true);
    // Allowed source → no block.
    expect(shouldBlockSource('community', 'memory_facts')).toBe(false);
  });

  test('flag ON: unknown role is blocked', () => {
    mockIsFeatureLive.mockReturnValue(true);
    expect(shouldBlockTool('superuser', 'send_chat_message')).toBe(true);
  });
});

describe('decision shape is stable for telemetry', () => {
  test('decision carries kind, target, role, message', () => {
    const d = assertToolAllowed('developer', 'search_codebase');
    expect(d.kind).toBe('tool');
    expect(d.target).toBe('search_codebase');
    expect(d.role).toBe('developer');
    expect(typeof d.message).toBe('string');
    expect(d.message.length).toBeGreaterThan(0);

    const s = assertSourceAllowed('developer', 'vitana_index');
    expect(s.kind).toBe('source');
    expect(s.allowed).toBe(false);
  });
});
