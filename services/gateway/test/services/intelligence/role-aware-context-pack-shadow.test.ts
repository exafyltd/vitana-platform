/**
 * Tests for src/services/intelligence/role-aware-context-pack-shadow.ts
 * (VTID-03241 — Phase 2 tenancy & RBAC).
 *
 * decideRoleAwareShadow() is pure and runs against the REAL role registry
 * (VTID-03240), so the assertions here pin actual cross-role behavior
 * differences: what community may consult/dispatch vs developer vs an
 * unrecognized role. emitRoleAwareContextPackShadow() is feature-flag
 * gated telemetry — flag off must be a no-op, and emit errors must never
 * escape.
 */

const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: unknown[]) => mockEmitOasisEvent(...args),
}));

const mockIsFeatureLive = jest.fn().mockReturnValue(false);
jest.mock('../../../src/services/feature-flags', () => ({
  isFeatureLive: (...args: unknown[]) => mockIsFeatureLive(...args),
}));

import {
  decideRoleAwareShadow,
  emitRoleAwareContextPackShadow,
  shadowDecisionOnly,
  type RoleAwareShadowInput,
} from '../../../src/services/intelligence/role-aware-context-pack-shadow';

function input(overrides: Partial<RoleAwareShadowInput> = {}): RoleAwareShadowInput {
  return {
    session_id: 'sess-1',
    active_role: 'community',
    context_sources_consulted: [],
    tools_available: [],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFeatureLive.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// decideRoleAwareShadow — unrecognized roles
// ---------------------------------------------------------------------------

describe('decideRoleAwareShadow — unrecognized role', () => {
  it('blocks EVERYTHING for an unknown role (closed-world)', () => {
    const d = decideRoleAwareShadow(input({
      active_role: 'superuser',
      context_sources_consulted: ['memory_facts', 'orb_turns'],
      tools_available: ['get_today_plan'],
      tool_dispatched: 'get_today_plan',
    }));
    expect(d).toEqual({
      active_role: 'superuser',
      role_recognized: false,
      would_allow_context_sources: [],
      would_block_context_sources: ['memory_facts', 'orb_turns'],
      would_allow_tools: [],
      would_deny_tools: ['get_today_plan'],
      dispatched_tool_would_pass: null,
      policy_match_rate: null,
    });
  });

  it('a null role is not recognized', () => {
    const d = decideRoleAwareShadow(input({ active_role: null, tools_available: ['remember'] }));
    expect(d.role_recognized).toBe(false);
    expect(d.active_role).toBeNull();
    expect(d.would_deny_tools).toEqual(['remember']);
  });
});

// ---------------------------------------------------------------------------
// decideRoleAwareShadow — role-aware behavior differences
// ---------------------------------------------------------------------------

describe('decideRoleAwareShadow — community vs developer', () => {
  const SOURCES = ['memory_facts', 'vitana_index', 'safety_guardrails'];
  const TOOLS = ['get_pillar_status', 'search_codebase', 'admin_grant_role'];

  it('community: wellness tools allowed, admin_* denied by prefix, guardrails source hidden', () => {
    const d = decideRoleAwareShadow(input({
      active_role: 'community',
      context_sources_consulted: SOURCES,
      tools_available: TOOLS,
    }));
    expect(d.role_recognized).toBe(true);
    expect(d.would_allow_context_sources).toEqual(['memory_facts', 'vitana_index']);
    expect(d.would_block_context_sources).toEqual(['safety_guardrails']);
    expect(d.would_allow_tools).toEqual(['get_pillar_status']);
    // search_codebase is not on the community allowlist (default deny);
    // admin_grant_role matches the explicit 'admin_*' denylist prefix.
    expect(d.would_deny_tools).toEqual(['search_codebase', 'admin_grant_role']);
  });

  it('developer: the SAME inputs decide differently — codebase allowed, wellness denied', () => {
    const d = decideRoleAwareShadow(input({
      active_role: 'developer',
      context_sources_consulted: SOURCES,
      tools_available: TOOLS,
    }));
    expect(d.role_recognized).toBe(true);
    // vitana_index is explicitly denied for the developer lane
    expect(d.would_allow_context_sources).toEqual(['memory_facts']);
    expect(d.would_block_context_sources).toEqual(['vitana_index', 'safety_guardrails']);
    // get_pillar_status is on the developer DENYLIST (no wellness lane)
    expect(d.would_allow_tools).toEqual(['search_codebase']);
    expect(d.would_deny_tools).toEqual(['get_pillar_status', 'admin_grant_role']);
  });

  it('the two roles disagree on the same tool — no cross-role leakage', () => {
    const community = decideRoleAwareShadow(input({ active_role: 'community', tools_available: ['get_pillar_status'] }));
    const developer = decideRoleAwareShadow(input({ active_role: 'developer', tools_available: ['get_pillar_status'] }));
    expect(community.would_allow_tools).toEqual(['get_pillar_status']);
    expect(developer.would_deny_tools).toEqual(['get_pillar_status']);
  });
});

describe('decideRoleAwareShadow — dispatched tool + match rate', () => {
  it('dispatched_tool_would_pass reflects the policy verdict', () => {
    const pass = decideRoleAwareShadow(input({ active_role: 'community', tool_dispatched: 'remember' }));
    expect(pass.dispatched_tool_would_pass).toBe(true);

    const fail = decideRoleAwareShadow(input({ active_role: 'community', tool_dispatched: 'admin_grant_role' }));
    expect(fail.dispatched_tool_would_pass).toBe(false);

    const none = decideRoleAwareShadow(input({ active_role: 'community', tool_dispatched: null }));
    expect(none.dispatched_tool_would_pass).toBeNull();
  });

  it('policy_match_rate = allowed / (sources + tools)', () => {
    const d = decideRoleAwareShadow(input({
      active_role: 'community',
      context_sources_consulted: ['memory_facts', 'safety_guardrails'], // 1 allowed
      tools_available: ['get_pillar_status', 'admin_grant_role'],       // 1 allowed
    }));
    expect(d.policy_match_rate).toBe(0.5);
  });

  it('policy_match_rate is null when there is nothing to decide', () => {
    const d = decideRoleAwareShadow(input({ active_role: 'community' }));
    expect(d.policy_match_rate).toBeNull();
  });

  it('shadowDecisionOnly is the same decision function', () => {
    const i = input({
      active_role: 'developer',
      context_sources_consulted: ['memory_facts', 'vitana_index'],
      tools_available: ['search_codebase', 'find_partner'],
      tool_dispatched: 'search_codebase',
    });
    expect(shadowDecisionOnly(i)).toEqual(decideRoleAwareShadow(i));
  });
});

// ---------------------------------------------------------------------------
// emitRoleAwareContextPackShadow — flag gating + telemetry safety
// ---------------------------------------------------------------------------

describe('emitRoleAwareContextPackShadow', () => {
  it('is a no-op returning false when the feature flag is off', async () => {
    mockIsFeatureLive.mockReturnValue(false);
    const ran = await emitRoleAwareContextPackShadow(input());
    expect(ran).toBe(false);
    expect(mockIsFeatureLive).toHaveBeenCalledWith('ROLE_AWARE_CONTEXT_SHADOW');
    expect(mockEmitOasisEvent).not.toHaveBeenCalled();
  });

  it('emits the shadow OASIS event (info) for a recognized role when live', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    const ran = await emitRoleAwareContextPackShadow(input({
      active_role: 'community',
      actor_id: 'user-1',
      surface: 'orb-live',
      context_sources_consulted: ['memory_facts', 'safety_guardrails'],
      tools_available: ['get_pillar_status'],
      tool_dispatched: 'get_pillar_status',
    }));
    expect(ran).toBe(true);
    expect(mockEmitOasisEvent).toHaveBeenCalledTimes(1);
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      vtid: 'VTID-03241',
      type: 'assistant.role.context_pack.shadow',
      status: 'info',
      actor_id: 'user-1',
      payload: expect.objectContaining({
        session_id: 'sess-1',
        surface: 'orb-live',
        active_role: 'community',
        role_recognized: true,
        would_block_sources: ['safety_guardrails'],
        would_allow_tools: ['get_pillar_status'],
        dispatched_tool_would_pass: true,
      }),
    }));
  });

  it('emits a WARNING event for an unrecognized role', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    await emitRoleAwareContextPackShadow(input({ active_role: 'not-a-role' }));
    expect(mockEmitOasisEvent).toHaveBeenCalledWith(expect.objectContaining({
      status: 'warning',
      message: "shadow: unrecognized active_role 'not-a-role'",
      payload: expect.objectContaining({ role_recognized: false }),
    }));
  });

  it('swallows emit failures — telemetry never breaks the turn', async () => {
    mockIsFeatureLive.mockReturnValue(true);
    mockEmitOasisEvent.mockRejectedValueOnce(new Error('oasis down'));
    await expect(emitRoleAwareContextPackShadow(input())).resolves.toBe(true);
  });
});
