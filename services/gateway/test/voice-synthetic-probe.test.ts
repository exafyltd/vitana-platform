/**
 * VTID-01961: Synthetic Voice Probe Tests
 *
 * The probe is the load-bearing safety check for the inner-loop fix
 * verification. These tests cover every failure_mode_code path so a
 * future code change can't silently weaken the verification.
 */

process.env.NODE_ENV = 'test';
process.env.GATEWAY_URL = 'http://gateway.test';

import { runVoiceProbe } from '../src/services/voice-synthetic-probe';

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

const HEALTHY_BODY = {
  ok: true,
  service: 'orb-live',
  gemini_configured: true,
  tts_client_ready: true,
  voice_conversation_enabled: true,
  fallback_chat_tts: { available: true, gemini_api: true, tts_ready: true },
};

beforeEach(() => mockFetch.mockReset());

describe('VTID-01961: Synthetic Voice Probe', () => {
  test('all health flags true → ok=true, no failure_mode_code', async () => {
    mockFetch.mockResolvedValue(jsonResp(HEALTHY_BODY));
    const r = await runVoiceProbe();
    expect(r.ok).toBe(true);
    expect(r.failure_mode_code).toBeNull();
    expect(typeof r.duration_ms).toBe('number');
    expect(r.evidence.gemini_configured).toBe(true);
    expect(r.evidence.tts_client_ready).toBe(true);
    expect(r.evidence.voice_conversation_enabled).toBe(true);
    expect(r.evidence.fallback_chat_tts_available).toBe(true);
  });

  test('gemini_configured=false → gemini_not_configured', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({ ...HEALTHY_BODY, gemini_configured: false }),
    );
    const r = await runVoiceProbe();
    expect(r.ok).toBe(false);
    expect(r.failure_mode_code).toBe('gemini_not_configured');
  });

  test('tts_client_ready=false → tts_not_ready', async () => {
    mockFetch.mockResolvedValue(jsonResp({ ...HEALTHY_BODY, tts_client_ready: false }));
    const r = await runVoiceProbe();
    expect(r.failure_mode_code).toBe('tts_not_ready');
  });

  test('voice_conversation_enabled=false → voice_disabled', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({ ...HEALTHY_BODY, voice_conversation_enabled: false }),
    );
    const r = await runVoiceProbe();
    expect(r.failure_mode_code).toBe('voice_disabled');
  });

  test('fallback_chat_tts.available=false → fallback_chat_tts_unavailable', async () => {
    mockFetch.mockResolvedValue(
      jsonResp({ ...HEALTHY_BODY, fallback_chat_tts: { available: false } }),
    );
    const r = await runVoiceProbe();
    expect(r.failure_mode_code).toBe('fallback_chat_tts_unavailable');
  });

  test('non-2xx response → health_non_2xx', async () => {
    mockFetch.mockResolvedValue(jsonResp({ error: 'down' }, 500));
    const r = await runVoiceProbe();
    expect(r.failure_mode_code).toBe('health_non_2xx');
    expect(r.evidence.health_status).toBe(500);
  });

  test('fetch throws → health_unreachable', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    const r = await runVoiceProbe();
    expect(r.ok).toBe(false);
    expect(r.failure_mode_code).toBe('health_unreachable');
  });

  test('malformed JSON → health_malformed_json', async () => {
    const badResp = {
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token');
      },
      text: async () => 'not json',
    } as unknown as Response;
    mockFetch.mockResolvedValue(badResp);
    const r = await runVoiceProbe();
    expect(r.failure_mode_code).toBe('health_malformed_json');
  });

  test('chime-only would-pass simulation: this v1 probe is config/auth-focused', async () => {
    // v1 documents intentionally: this probe checks gateway config/auth only.
    // The chime-aware audio-path verification is v2 (PR #4 follow-up). Here
    // we assert the v1 contract holds for the dominant config-missing /
    // auth-rejected classes.
    mockFetch.mockResolvedValue(jsonResp(HEALTHY_BODY));
    const r = await runVoiceProbe();
    expect(r.ok).toBe(true);
  });

  test('probe records duration_ms', async () => {
    mockFetch.mockResolvedValue(jsonResp(HEALTHY_BODY));
    const r = await runVoiceProbe();
    expect(r.duration_ms).toBeGreaterThanOrEqual(0);
    expect(r.duration_ms).toBeLessThan(5_000);
  });
});
