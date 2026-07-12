/**
 * Governance voice tools (Wave 2, plan section C2) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  GOVERNANCE_TOOL_HANDLERS,
  GOVERNANCE_TOOL_DECLARATIONS,
  dev_evaluate_governance,
  dev_governance_status,
  dev_list_violations,
  dev_create_proposal,
  dev_update_proposal,
  dev_get_control,
  dev_set_control,
} from '../../src/services/orb-tools/governance-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

function makeSb(): SupabaseClient {
  return {} as unknown as SupabaseClient;
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  jest.clearAllMocks();
});

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('governance role gate', () => {
  const names = Object.keys(GOVERNANCE_TOOL_HANDLERS);

  it('exposes all 13 tools with matching declarations', () => {
    expect(names).toHaveLength(13);
    const declNames = GOVERNANCE_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = {
      action: 'deploy', service: 'gateway', environment: 'staging', rule_code: 'R1',
      key: 'vtid_allocator_enabled', enabled: true, reason: 'test',
      type: 'New Rule', proposed_rule: 'x', proposal_id: 'PROP-1', status: 'Approved',
    };
    const r = await GOVERNANCE_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('developer_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await GOVERNANCE_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('dev_evaluate_governance', () => {
  it('requires action/service/environment', async () => {
    const r = await dev_evaluate_governance({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('speaks the allowed decision', async () => {
    mockFetch(200, { ok: true, allowed: true, level: 'L1', violations: [] });
    const r = await dev_evaluate_governance({ action: 'deploy', service: 'gateway', environment: 'staging' }, DEV_ID, makeSb());
    expect(r.text).toContain('Allowed');
  });
});

describe('dev_governance_status', () => {
  it('summarizes disabled controls', async () => {
    mockFetch(200, { ok: true, data: [{ key: 'a', enabled: true }, { key: 'b', enabled: false }] });
    const r = await dev_governance_status({}, DEV_ID, makeSb());
    expect(r.text).toContain('Disabled: b');
  });
});

describe('dev_list_violations', () => {
  it('reports zero violations honestly', async () => {
    mockFetch(200, []);
    const r = await dev_list_violations({}, DEV_ID, makeSb());
    expect(r.text).toContain('No open governance violations');
  });
});

describe('dev_create_proposal', () => {
  it('validates type', async () => {
    const r = await dev_create_proposal({ type: 'bogus', proposed_rule: 'x' }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires confirmation', async () => {
    const r = await dev_create_proposal({ type: 'New Rule', proposed_rule: 'x' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });

  it('creates after confirm=true', async () => {
    mockFetch(201, { proposalId: 'PROP-1' });
    const r = await dev_create_proposal({ type: 'New Rule', proposed_rule: 'x', confirm: true }, DEV_ID, makeSb());
    expect(r.text).toContain('PROP-1');
  });
});

describe('dev_update_proposal', () => {
  it('validates status', async () => {
    const r = await dev_update_proposal({ proposal_id: 'PROP-1', status: 'bogus' }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('dev_get_control / dev_set_control', () => {
  it('dev_get_control reads a control key', async () => {
    mockFetch(200, { ok: true, data: { enabled: true, reason: 'ok' } });
    const r = await dev_get_control({ key: 'vtid_allocator_enabled' }, DEV_ID, makeSb());
    expect(r.text).toContain('enabled');
  });

  it('dev_set_control requires a reason', async () => {
    const r = await dev_set_control({ key: 'vtid_allocator_enabled', enabled: false }, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('dev_set_control requires confirmation', async () => {
    const r = await dev_set_control({ key: 'vtid_allocator_enabled', enabled: false, reason: 'incident' }, DEV_ID, makeSb());
    expect((r as { result: { requires_confirmation: boolean } }).result.requires_confirmation).toBe(true);
  });
});
