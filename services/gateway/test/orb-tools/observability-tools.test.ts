/**
 * Observability voice tools (Wave 2, plan section C9) — unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolIdentity } from '../../src/services/orb-tools-shared';
import {
  OBSERVABILITY_TOOL_HANDLERS,
  OBSERVABILITY_TOOL_DECLARATIONS,
  dev_build_info,
  dev_error_rate,
  dev_latency_summary,
  dev_recent_events,
  dev_telemetry_snapshot,
  dev_get_session_turns,
  dev_conversation_decisions,
  dev_tool_failures,
  dev_tool_health,
  dev_get_agent_detail,
} from '../../src/services/orb-tools/observability-tools';

const DEV_ID: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer', user_jwt: 'jwt-abc' };
const DEV_ID_NO_JWT: OrbToolIdentity = { user_id: 'u-dev', tenant_id: 't-1', role: 'developer' };
const COMMUNITY_ID: OrbToolIdentity = { user_id: 'u-com', tenant_id: 't-1', role: 'community' };
const ANON_ID: OrbToolIdentity = { user_id: '', tenant_id: null, role: 'developer' };

interface StubResp {
  data: unknown;
  error: { message: string } | null;
}

function makeSb(tables: Record<string, StubResp[]> = {}): SupabaseClient {
  const used: Record<string, number> = {};
  const sb = {
    from(table: string) {
      const queue = tables[table] ?? [];
      const i = used[table] ?? 0;
      used[table] = i + 1;
      const resp: StubResp = queue[Math.min(i, queue.length - 1)] ?? { data: [], error: null };
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'gte', 'lte', 'order', 'limit']) {
        chain[m] = () => chain;
      }
      chain.then = (onOk: (v: StubResp) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(resp).then(onOk, onErr);
      return chain;
    },
  };
  return sb as unknown as SupabaseClient;
}

const ok = (data: unknown): StubResp => ({ data, error: null });

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

describe('observability role gate', () => {
  const names = Object.keys(OBSERVABILITY_TOOL_HANDLERS);

  it('exposes all 15 tools with matching declarations', () => {
    expect(names).toHaveLength(15);
    const declNames = OBSERVABILITY_TOOL_DECLARATIONS.map((d) => d.name);
    for (const n of names) expect(declNames).toContain(n);
  });

  it.each(names)('%s denies community role', async (name) => {
    const args = { session_id: 's-1', agent_id: 'a-1' };
    const r = await OBSERVABILITY_TOOL_HANDLERS[name](args, COMMUNITY_ID, makeSb());
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('developer_role_required');
  });

  it.each(names)('%s denies unauthenticated callers', async (name) => {
    const r = await OBSERVABILITY_TOOL_HANDLERS[name]({}, ANON_ID, makeSb());
    expect(r.ok).toBe(false);
  });
});

describe('dev_build_info', () => {
  it('speaks the running commit and notes the gateway-only scope', async () => {
    mockFetch(200, { git_commit: 'abc1234', cloud_run_revision: 'gateway-00001-abc', env: 'staging' });
    const r = await dev_build_info({}, DEV_ID, makeSb());
    expect(r.text).toContain('abc1234');
    expect(r.text).toContain('this gateway instance');
  });
});

describe('dev_error_rate', () => {
  it('computes an error rate from oasis_events', async () => {
    const sb = makeSb({
      oasis_events: [ok([{ status: 'ok' }, { status: 'error' }, { status: 'ok' }, { status: 'ok' }])],
    });
    const r = await dev_error_rate({ hours: 24 }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { errors: number; total: number }).errors).toBe(1);
    expect((r.result as { errors: number; total: number }).total).toBe(4);
  });
});

describe('dev_latency_summary', () => {
  it('computes p50/p95 from payload.total_ms', async () => {
    const values = Array.from({ length: 10 }, (_, i) => ({ payload: { total_ms: (i + 1) * 100 } }));
    const sb = makeSb({ oasis_events: [ok(values)] });
    const r = await dev_latency_summary({ hours: 24 }, DEV_ID, sb);
    expect(r.ok).toBe(true);
    expect((r.result as { count: number }).count).toBe(10);
  });

  it('handles zero samples honestly', async () => {
    const sb = makeSb({ oasis_events: [ok([])] });
    const r = await dev_latency_summary({}, DEV_ID, sb);
    expect(r.text).toContain('No voice latency samples');
  });
});

describe('dev_telemetry_snapshot', () => {
  it('requires a session', async () => {
    const r = await dev_telemetry_snapshot({}, DEV_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });

  it('forwards the session JWT', async () => {
    mockFetch(200, { ok: true });
    await dev_telemetry_snapshot({}, DEV_ID, makeSb());
    const call = (global.fetch as jest.Mock).mock.calls[0];
    expect((call[1].headers as Record<string, string>).Authorization).toBe('Bearer jwt-abc');
  });
});

describe('dev_recent_events', () => {
  it('speaks recent events', async () => {
    mockFetch(200, { data: [{ type: 'vtid.lifecycle.completed', message: 'done', created_at: new Date().toISOString() }] });
    const r = await dev_recent_events({}, DEV_ID, makeSb());
    expect(r.text).toContain('vtid.lifecycle.completed');
  });
});

describe('dev_get_session_turns', () => {
  it('requires session_id', async () => {
    const r = await dev_get_session_turns({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('requires a session', async () => {
    const r = await dev_get_session_turns({ session_id: 's-1' }, DEV_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });
});

describe('dev_conversation_decisions', () => {
  it('requires a session', async () => {
    const r = await dev_conversation_decisions({}, DEV_ID_NO_JWT, makeSb());
    expect((r.result as { reason: string }).reason).toBe('no_session');
  });

  it('reports zero decisions honestly', async () => {
    mockFetch(200, { data: [] });
    const r = await dev_conversation_decisions({}, DEV_ID, makeSb());
    expect(r.text).toContain('No greeting/NBA decisions');
  });
});

describe('dev_tool_failures / dev_tool_health', () => {
  it('dev_tool_failures groups by tool', async () => {
    mockFetch(200, { data: [{ metadata: { tool: 'send_funds' } }, { metadata: { tool: 'send_funds' } }, { metadata: { tool: 'log_meal' } }] });
    const r = await dev_tool_failures({}, DEV_ID, makeSb());
    expect(r.text).toContain('send_funds: 2');
  });

  it('dev_tool_health reports healthy with no failures', async () => {
    mockFetch(200, { data: [] });
    const r = await dev_tool_health({}, DEV_ID, makeSb());
    expect(r.text).toContain('healthy');
  });
});

describe('dev_get_agent_detail', () => {
  it('requires agent_id', async () => {
    const r = await dev_get_agent_detail({}, DEV_ID, makeSb());
    expect(r.ok).toBe(false);
  });

  it('reports not-found for a 404', async () => {
    mockFetch(404, { error: 'not found' });
    const r = await dev_get_agent_detail({ agent_id: 'nope' }, DEV_ID, makeSb());
    expect((r.result as { found: boolean }).found).toBe(false);
  });

  it('speaks the agent detail', async () => {
    mockFetch(200, { display_name: 'Worker Runner', tier: 'service', derived_status: 'healthy' });
    const r = await dev_get_agent_detail({ agent_id: 'worker-runner' }, DEV_ID, makeSb());
    expect(r.text).toContain('Worker Runner');
  });
});
