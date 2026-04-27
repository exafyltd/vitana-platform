/**
 * VTID-01958: Voice Failure Taxonomy Tests
 *
 * Tests the core contract of the voice self-healing loop: stable mapping
 * from raw signals (OASIS topic / gRPC code / HTTP status / reason field /
 * stall type) to (failure_class, normalized_signature). Free-text error
 * messages are evidence, never identity — the same input must always map
 * to the same signature so dedupe + Spec Memory Gate keys hold.
 */

process.env.NODE_ENV = 'test';

import {
  mapTopicToClass,
  mapStallTypeToClass,
  detectAudioOneWay,
  VOICE_FAILURE_CLASSES,
  CLASS_SEVERITY,
  SIGNATURE_VERSION,
  CONFIG_FALLBACK_PROJECT_ID,
} from '../src/services/voice-failure-taxonomy';

describe('VTID-01958: Voice Failure Taxonomy', () => {
  describe('module shape', () => {
    test('SIGNATURE_VERSION is non-empty string', () => {
      expect(typeof SIGNATURE_VERSION).toBe('string');
      expect(SIGNATURE_VERSION.length).toBeGreaterThan(0);
    });

    test('VOICE_FAILURE_CLASSES contains all 14 expected classes (incl. VTID-01994 quality classes)', () => {
      expect(VOICE_FAILURE_CLASSES).toHaveLength(14);
      const expected = [
        'voice.config_missing',
        'voice.config_fallback_active',
        'voice.auth_rejected',
        'voice.model_stall',
        'voice.upstream_disconnect',
        'voice.tts_failed',
        'voice.session_leak',
        'voice.tool_loop',
        'voice.audio_one_way',
        'voice.permission_denied',
        'voice.model_under_responds',
        'voice.no_engagement',
        'voice.low_turn_progression',
        'voice.unknown',
      ];
      for (const c of expected) {
        expect(VOICE_FAILURE_CLASSES).toContain(c);
      }
    });

    test('CLASS_SEVERITY has an entry for every class', () => {
      for (const c of VOICE_FAILURE_CLASSES) {
        expect(CLASS_SEVERITY[c]).toBeGreaterThanOrEqual(0);
      }
    });

    test('CONFIG_FALLBACK_PROJECT_ID matches the orb-live.ts hardcoded fallback', () => {
      expect(CONFIG_FALLBACK_PROJECT_ID).toBe('lovable-vitana-vers1');
    });
  });

  describe('mapTopicToClass — config_missing vs config_fallback_active', () => {
    test('startup config_missing with VERTEX_PROJECT_ID empty → vertex_project_id_empty', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.startup.config_missing',
        status: 'error',
        error_message: 'VERTEX_PROJECT_ID is empty',
      });
      expect(r.class).toBe('voice.config_missing');
      expect(r.normalized_signature).toBe('vertex_project_id_empty');
    });

    test('startup config_missing with VERTEX_LOCATION empty → vertex_location_empty', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.startup.config_missing',
        status: 'error',
        error_message: 'VERTEX_LOCATION not set',
      });
      expect(r.class).toBe('voice.config_missing');
      expect(r.normalized_signature).toBe('vertex_location_empty');
    });

    test('startup config_missing with google auth issue → google_auth_unready', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.startup.config_missing',
        status: 'error',
        error_message: 'google_auth not initialized',
      });
      expect(r.class).toBe('voice.config_missing');
      expect(r.normalized_signature).toBe('google_auth_unready');
    });

    test('config_missing with using_fallback metadata → config_fallback_active', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.config_missing',
        status: 'warning',
        metadata: { using_fallback: true },
      });
      expect(r.class).toBe('voice.config_fallback_active');
      expect(r.normalized_signature).toBe('vertex_fallback_active');
    });

    test('config_missing with fallback project_id in error_message → config_fallback_active', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.config_missing',
        status: 'warning',
        error_message: `using fallback ${CONFIG_FALLBACK_PROJECT_ID}`,
      });
      expect(r.class).toBe('voice.config_fallback_active');
    });
  });

  describe('mapTopicToClass — auth and permission', () => {
    test('UNAUTHENTICATED gRPC code → auth_unauthenticated', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        status: 'error',
        grpc_code: 'UNAUTHENTICATED',
      });
      expect(r.class).toBe('voice.auth_rejected');
      expect(r.normalized_signature).toBe('auth_unauthenticated');
    });

    test('HTTP 401 → auth_unauthenticated', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        status: 'error',
        http_status: 401,
      });
      expect(r.class).toBe('voice.auth_rejected');
    });

    test('PERMISSION_DENIED gRPC → permission_denied_vertex', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        status: 'error',
        grpc_code: 'PERMISSION_DENIED',
      });
      expect(r.class).toBe('voice.permission_denied');
      expect(r.normalized_signature).toBe('permission_denied_vertex');
    });

    test('JWT expired in error_message → auth_jwt_expired', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        status: 'error',
        error_message: 'JWT token expired',
      });
      expect(r.class).toBe('voice.auth_rejected');
      expect(r.normalized_signature).toBe('auth_jwt_expired');
    });

    test('service_account in error_message → auth_service_account_invalid', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        status: 'error',
        error_message: 'invalid service account credentials',
      });
      expect(r.class).toBe('voice.auth_rejected');
      expect(r.normalized_signature).toBe('auth_service_account_invalid');
    });

    test('connection_failed with no recognizable signal → connection_failed_generic', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        status: 'error',
        error_message: 'something weird happened',
      });
      expect(r.class).toBe('voice.unknown');
      expect(r.normalized_signature).toBe('connection_failed_generic');
    });
  });

  describe('mapTopicToClass — model stall', () => {
    test('reason=audio_stall → model_stall_audio', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.stall_detected',
        status: 'error',
        reason: 'audio_stall',
      });
      expect(r.class).toBe('voice.model_stall');
      expect(r.normalized_signature).toBe('model_stall_audio');
    });

    test('reason=text_stall → model_stall_text', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.stall_detected',
        status: 'error',
        reason: 'text_stall',
      });
      expect(r.normalized_signature).toBe('model_stall_text');
    });

    test('reason=forwarding_no_ack → model_stall_forwarding_no_ack', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.stall_detected',
        status: 'error',
        reason: 'forwarding_no_ack',
      });
      expect(r.normalized_signature).toBe('model_stall_forwarding_no_ack');
    });

    test('stall_detected without reason → model_stall_generic', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.stall_detected',
        status: 'error',
      });
      expect(r.class).toBe('voice.model_stall');
      expect(r.normalized_signature).toBe('model_stall_generic');
    });
  });

  describe('mapTopicToClass — TTS and tool loop', () => {
    test('fallback_error → tts_synth_failed', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.fallback_error',
        status: 'error',
      });
      expect(r.class).toBe('voice.tts_failed');
      expect(r.normalized_signature).toBe('tts_synth_failed');
    });

    test('fallback_used → tts_init_failed', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.fallback_used',
        status: 'warning',
      });
      expect(r.class).toBe('voice.tts_failed');
      expect(r.normalized_signature).toBe('tts_init_failed');
    });

    test('tool_loop_guard_activated → tool_loop_8plus', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.tool_loop_guard_activated',
        status: 'warning',
      });
      expect(r.class).toBe('voice.tool_loop');
      expect(r.normalized_signature).toBe('tool_loop_8plus');
    });
  });

  describe('mapTopicToClass — fallback', () => {
    test('unknown topic → voice.unknown / unknown', () => {
      const r = mapTopicToClass({
        topic: 'orb.live.something_we_dont_track',
        status: 'error',
      });
      expect(r.class).toBe('voice.unknown');
      expect(r.normalized_signature).toBe('unknown');
    });

    test('empty input → voice.unknown', () => {
      const r = mapTopicToClass({});
      expect(r.class).toBe('voice.unknown');
    });
  });

  describe('signature stability', () => {
    test('same input always produces same (class, signature)', () => {
      const inputs = [
        { topic: 'orb.live.connection_failed', grpc_code: 'UNAUTHENTICATED' },
        { topic: 'orb.live.startup.config_missing', error_message: 'VERTEX_PROJECT_ID is empty' },
        { topic: 'orb.live.stall_detected', reason: 'forwarding_no_ack' },
        { topic: 'orb.live.fallback_error' },
        { topic: 'orb.live.tool_loop_guard_activated' },
      ];
      for (const input of inputs) {
        const r1 = mapTopicToClass(input);
        const r2 = mapTopicToClass({ ...input });
        const r3 = mapTopicToClass(input);
        expect(r2).toEqual(r1);
        expect(r3).toEqual(r1);
      }
    });

    test('case-insensitive matching on error_message and grpc_code', () => {
      const a = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        grpc_code: 'unauthenticated',
        error_message: 'JWT EXPIRED',
      });
      const b = mapTopicToClass({
        topic: 'orb.live.connection_failed',
        grpc_code: 'UNAUTHENTICATED',
        error_message: 'jwt expired',
      });
      expect(a.class).toBe(b.class);
      expect(a.normalized_signature).toBe(b.normalized_signature);
    });
  });

  describe('mapStallTypeToClass', () => {
    test('null returns null', () => {
      expect(mapStallTypeToClass(null)).toBeNull();
      expect(mapStallTypeToClass(undefined)).toBeNull();
      expect(mapStallTypeToClass('')).toBeNull();
    });

    test('watchdog_timeout → voice.model_stall / model_stall_watchdog', () => {
      const r = mapStallTypeToClass('watchdog_timeout');
      expect(r?.class).toBe('voice.model_stall');
      expect(r?.normalized_signature).toBe('model_stall_watchdog');
    });

    test('upstream_disconnect_mid_response → voice.upstream_disconnect', () => {
      const r = mapStallTypeToClass('upstream_disconnect_mid_response');
      expect(r?.class).toBe('voice.upstream_disconnect');
      expect(r?.normalized_signature).toBe('upstream_disconnect_mid_response');
    });

    test('upstream_disconnect_before_response → voice.upstream_disconnect', () => {
      const r = mapStallTypeToClass('upstream_disconnect_before_response');
      expect(r?.class).toBe('voice.upstream_disconnect');
    });

    test('mid_stream_stall → voice.model_stall', () => {
      const r = mapStallTypeToClass('mid_stream_stall');
      expect(r?.class).toBe('voice.model_stall');
      expect(r?.normalized_signature).toBe('mid_stream_stall');
    });

    test('no_model_response → voice.model_stall', () => {
      const r = mapStallTypeToClass('no_model_response');
      expect(r?.class).toBe('voice.model_stall');
      expect(r?.normalized_signature).toBe('no_model_response');
    });

    test('unknown stall_type returns null (caller falls through)', () => {
      expect(mapStallTypeToClass('something_new')).toBeNull();
    });
  });

  describe('detectAudioOneWay', () => {
    test('input chunks > 0, output 0, no stall → audio_one_way', () => {
      const r = detectAudioOneWay({
        audio_in_chunks: 50,
        audio_out_chunks: 0,
        stall_type: null,
      });
      expect(r?.class).toBe('voice.audio_one_way');
      expect(r?.normalized_signature).toBe('audio_one_way_post_chime');
    });

    test('input chunks > 0, output > 0 → null', () => {
      expect(
        detectAudioOneWay({ audio_in_chunks: 50, audio_out_chunks: 30, stall_type: null }),
      ).toBeNull();
    });

    test('any stall_type present → null (stall takes precedence)', () => {
      expect(
        detectAudioOneWay({ audio_in_chunks: 50, audio_out_chunks: 0, stall_type: 'mid_stream_stall' }),
      ).toBeNull();
    });

    test('zero input → null', () => {
      expect(
        detectAudioOneWay({ audio_in_chunks: 0, audio_out_chunks: 0, stall_type: null }),
      ).toBeNull();
    });
  });

  describe('VTID-01994: classifyQualityFromSessionStop', () => {
    const { classifyQualityFromSessionStop } = require('../src/services/voice-failure-taxonomy');

    test('the worst-case session (585:5:1) → voice.model_under_responds with high-ratio bucket', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 585,
        audio_out_chunks: 5,
        duration_ms: 93700,
        turn_count: 1,
      });
      expect(r?.class).toBe('voice.model_under_responds');
      expect(r?.normalized_signature).toBe('model_under_responds_r100plus');
    });

    test('the 945:46 session → voice.model_under_responds with mid-ratio bucket', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 945,
        audio_out_chunks: 46,
        duration_ms: 80000,
        turn_count: 5,
      });
      expect(r?.class).toBe('voice.model_under_responds');
      expect(r?.normalized_signature).toBe('model_under_responds_r20to100');
    });

    test('user spoke but model never started turn → voice.no_engagement', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 200,
        audio_out_chunks: 5,
        duration_ms: 60000,
        turn_count: 0,
      });
      expect(r?.class).toBe('voice.no_engagement');
      expect(r?.normalized_signature).toBe('no_engagement_user_active');
    });

    test('long session, few turns → voice.low_turn_progression', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 80,
        audio_out_chunks: 30,
        duration_ms: 120000,
        turn_count: 1,
      });
      expect(r?.class).toBe('voice.low_turn_progression');
    });

    test('healthy ratio session → null (no quality failure)', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 200,
        audio_out_chunks: 100,
        duration_ms: 60000,
        turn_count: 5,
      });
      expect(r).toBeNull();
    });

    test('very brief session (mic test) → null (not a real conversation)', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 5,
        audio_out_chunks: 50,
        duration_ms: 4000,
        turn_count: 0,
      });
      expect(r).toBeNull();
    });

    test('healthy short conversation → null', () => {
      const r = classifyQualityFromSessionStop({
        audio_in_chunks: 100,
        audio_out_chunks: 60,
        duration_ms: 25000,
        turn_count: 3,
      });
      expect(r).toBeNull();
    });
  });
});
