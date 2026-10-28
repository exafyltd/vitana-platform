/**
 * VTID-01964: Voice Shadow Mode Tests
 *
 * Verifies appendShadowLog writes to the right table with the right shape,
 * and setMode handles idempotent flips + invalid input.
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';

import { appendShadowLog, setMode } from '../src/services/voice-shadow-mode';

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => mockFetch.mockReset());

describe('VTID-01964: Voice Shadow Mode — appendShadowLog', () => {
  test('writes a row to voice_healing_shadow_log with full shape', async () => {
    let captured: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('voice_healing_shadow_log')) {
        captured = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    await appendShadowLog({
      mode: 'shadow',
      action: 'sentinel_quarantined',
      class: 'voice.config_missing',
      normalized_signature: 'vertex_project_id_empty',
      detail: 'quarantined',
      session_id: 'sess-123',
      tenant_scope: 'global',
    });
    expect(captured).toMatchObject({
      mode: 'shadow',
      action: 'sentinel_quarantined',
      class: 'voice.config_missing',
      normalized_signature: 'vertex_project_id_empty',
      detail: 'quarantined',
      session_id: 'sess-123',
      tenant_scope: 'global',
    });
    expect(captured.gateway_revision).toBeTruthy();
  });

  test('returns false on Supabase error but does not throw', async () => {
    mockFetch.mockResolvedValue(jsonResp({}, 500));
    const ok = await appendShadowLog({ mode: 'live', action: 'dispatched' });
    expect(ok).toBe(false);
  });

  test('null fields propagate as null (not undefined)', async () => {
    let captured: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('voice_healing_shadow_log')) {
        captured = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    await appendShadowLog({ mode: 'off', action: 'mode_off' });
    expect(captured.class).toBeNull();
    expect(captured.normalized_signature).toBeNull();
    expect(captured.session_id).toBeNull();
  });
});

describe('VTID-01964: Voice Shadow Mode — setMode', () => {
  test('flip off → shadow upserts system_config and emits OASIS event', async () => {
    let upserted: any = null;
    let emitted: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('system_config?key')) {
        return Promise.resolve(jsonResp([{ value: 'off' }]));
      }
      if (url.includes('system_config?on_conflict')) {
        upserted = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({}));
      }
      if (url.includes('oasis_events')) {
        emitted = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({ id: 'e' }));
      }
      throw new Error('unexpected: ' + url);
    });
    const r = await setMode('shadow', 'VTID-01964');
    expect(r.ok).toBe(true);
    expect(r.previous).toBe('off');
    expect(r.new).toBe('shadow');
    expect(upserted.value).toBe('shadow');
    // emitOasisEvent maps payload→metadata in the Supabase row body.
    const md = emitted.metadata ?? emitted.payload ?? {};
    expect(md.new_mode).toBe('shadow');
  });

  test('idempotent: flipping to current value is a no-op success', async () => {
    let upsertCalled = false;
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config?key')) {
        return Promise.resolve(jsonResp([{ value: 'shadow' }]));
      }
      if (url.includes('system_config?on_conflict')) {
        upsertCalled = true;
        return Promise.resolve(jsonResp({}));
      }
      throw new Error('unexpected: ' + url);
    });
    const r = await setMode('shadow', 'VTID-01964');
    expect(r.ok).toBe(true);
    expect(r.previous).toBe('shadow');
    expect(r.new).toBe('shadow');
    expect(upsertCalled).toBe(false);
  });

  test('invalid mode → ok=false with invalid_mode', async () => {
    const r = await setMode('garbage' as any, 'VTID-01964');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid_mode');
  });

  test('upsert error → ok=false with detail', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config?key')) {
        return Promise.resolve(jsonResp([{ value: 'off' }]));
      }
      if (url.includes('system_config?on_conflict')) {
        return Promise.resolve(jsonResp({ message: 'permission denied' }, 403));
      }
      throw new Error('unexpected: ' + url);
    });
    const r = await setMode('live', 'VTID-01964');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('upsert_403');
  });
});
