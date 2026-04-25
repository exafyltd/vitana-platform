/**
 * VTID-01959: Voice→SelfHealing Adapter Tests
 *
 * Verifies the dispatch state machine end-to-end with a mocked classifier
 * and mocked Supabase/Gateway fetches:
 *   - mode=off blocks dispatch
 *   - synthetic flag blocks dispatch
 *   - dedupe hit blocks dispatch
 *   - mode=shadow logs but does NOT POST
 *   - mode=live POSTs to /report with proper ServiceStatus shape
 *   - classifier with no errors does not dispatch
 */

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.SUPABASE_SERVICE_ROLE = 'test-service-role';
process.env.GATEWAY_URL = 'http://gateway.test';
process.env.K_REVISION = 'test-rev-1';

import {
  dispatchVoiceFailure,
  _resetModeCacheForTests,
} from '../src/services/voice-self-healing-adapter';

// Mock the classifier — adapter calls it during dispatch.
const mockClassify = jest.fn();
jest.mock('../src/services/voice-session-classifier', () => ({
  classifyVoiceSession: (sessionId: string) => mockClassify(sessionId),
}));

const mockFetch = jest.fn();
global.fetch = mockFetch as any;

function jsonResp(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function classification(overrides: Record<string, unknown> = {}) {
  return {
    class: 'voice.config_missing',
    normalized_signature: 'vertex_project_id_empty',
    severity: 'error',
    evidence: {
      session_id: 'test-session',
      stall_description: 'config missing',
      error_count: 1,
      audio_in_chunks: 0,
      audio_out_chunks: 0,
    },
    ...overrides,
  };
}

beforeEach(() => {
  mockFetch.mockReset();
  mockClassify.mockReset();
  _resetModeCacheForTests();
});

describe('VTID-01959: Voice→SelfHealing Adapter', () => {
  test('mode=off → returns mode_off and does not classify or POST', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'off' }]));
      throw new Error('unexpected fetch: ' + url);
    });
    const r = await dispatchVoiceFailure({ sessionId: 's1' });
    expect(r.action).toBe('mode_off');
    expect(mockClassify).not.toHaveBeenCalled();
  });

  test('synthetic=true → returns synthetic_skipped and does not read mode', async () => {
    const r = await dispatchVoiceFailure({
      sessionId: 's2',
      metadata: { synthetic: true },
    });
    expect(r.action).toBe('synthetic_skipped');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('mode missing config row defaults to off', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([]));
      throw new Error('unexpected fetch: ' + url);
    });
    const r = await dispatchVoiceFailure({ sessionId: 's3' });
    expect(r.action).toBe('mode_off');
  });

  test('mode=live + healthy classifier (unknown/info) → classifier_no_error', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'live' }]));
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockResolvedValue(
      classification({ class: 'voice.unknown', severity: 'info' }),
    );
    const r = await dispatchVoiceFailure({ sessionId: 's4' });
    expect(r.action).toBe('classifier_no_error');
  });

  test('mode=live + dedupe hit → dedupe_hit, no POST', async () => {
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'live' }]));
      if (url.includes('voice_healing_dedupe')) {
        // ON CONFLICT DO NOTHING — already-existing row returns []
        return Promise.resolve(jsonResp([]));
      }
      if (url.includes('/api/v1/self-healing/report')) {
        throw new Error('should not POST when dedupe hit');
      }
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockResolvedValue(classification());
    const r = await dispatchVoiceFailure({ sessionId: 's5' });
    expect(r.action).toBe('dedupe_hit');
    expect(r.class).toBe('voice.config_missing');
  });

  test('mode=shadow + first-time signature → shadow_logged, no POST', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'shadow' }]));
      if (url.includes('voice_healing_dedupe')) {
        return Promise.resolve(jsonResp([{ class: 'voice.config_missing' }]));
      }
      if (url.includes('/api/v1/self-healing/report')) {
        throw new Error('should not POST in shadow mode');
      }
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockResolvedValue(classification());
    const r = await dispatchVoiceFailure({ sessionId: 's6' });
    expect(r.action).toBe('shadow_logged');
    expect(r.class).toBe('voice.config_missing');
  });

  test('mode=live + first-time signature → dispatched + POSTs to /report with voice-error:// endpoint', async () => {
    let capturedPostBody: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'live' }]));
      if (url.includes('voice_healing_dedupe')) {
        return Promise.resolve(jsonResp([{ class: 'voice.config_missing' }]));
      }
      if (url.includes('/api/v1/self-healing/report')) {
        capturedPostBody = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp({ ok: true, processed: 1 }));
      }
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockResolvedValue(classification());
    const r = await dispatchVoiceFailure({
      sessionId: 's7',
      tenantScope: 'tenant-abc',
    });
    expect(r.action).toBe('dispatched');
    expect(r.class).toBe('voice.config_missing');
    expect(capturedPostBody).not.toBeNull();
    expect(capturedPostBody.services).toHaveLength(1);
    expect(capturedPostBody.services[0].endpoint).toBe('voice-error://voice.config_missing');
    expect(capturedPostBody.services[0].name).toBe('orb-voice-pipeline');
    expect(capturedPostBody.services[0].status).toBe('down');
  });

  test('mode=live + /report 500 → action=error with detail', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'live' }]));
      if (url.includes('voice_healing_dedupe')) {
        return Promise.resolve(jsonResp([{ class: 'voice.config_missing' }]));
      }
      if (url.includes('/api/v1/self-healing/report')) {
        return Promise.resolve(jsonResp({ ok: false, error: 'internal' }, 500));
      }
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockResolvedValue(classification());
    const r = await dispatchVoiceFailure({ sessionId: 's8' });
    expect(r.action).toBe('error');
    expect(r.detail).toContain('report_500');
  });

  test('classifier throws → action=error with classify_failed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'live' }]));
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockRejectedValue(new Error('boom'));
    const r = await dispatchVoiceFailure({ sessionId: 's9' });
    expect(r.action).toBe('error');
    expect(r.detail).toContain('classify_failed');
  });

  test('dedupe key includes class, signature, gateway_revision, tenant_scope, hour_bucket', async () => {
    let capturedDedupeBody: any = null;
    mockFetch.mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('system_config')) return Promise.resolve(jsonResp([{ value: 'shadow' }]));
      if (url.includes('voice_healing_dedupe')) {
        capturedDedupeBody = JSON.parse((init?.body as string) || '{}');
        return Promise.resolve(jsonResp([{ class: 'voice.model_stall' }]));
      }
      throw new Error('unexpected fetch: ' + url);
    });
    mockClassify.mockResolvedValue(
      classification({ class: 'voice.model_stall', normalized_signature: 'mid_stream_stall' }),
    );
    await dispatchVoiceFailure({ sessionId: 's10', tenantScope: 'tenant-xyz' });
    expect(capturedDedupeBody).toMatchObject({
      class: 'voice.model_stall',
      normalized_signature: 'mid_stream_stall',
      gateway_revision: 'test-rev-1',
      tenant_scope: 'tenant-xyz',
    });
    expect(typeof capturedDedupeBody.hour_bucket).toBe('string');
    expect(capturedDedupeBody.hour_bucket).toMatch(/T\d\d:00:00/);
  });
});
