/**
 * VTID-04531 — the per-turn voice latency provider label must name the upstream
 * that actually served the turn.
 *
 * Before this, `startVoiceTurnLatency()` (routes/orb-live.ts) resolved the
 * label with a Nova-vs-everything-else ternary whose else-branch was
 * `vertex/${GEMINI_MODEL}` = `vertex/gemini-2.0-flash-exp` — a stale constant
 * from the deleted GEMINI_API_KEY era. Cascade sessions (Transcribe -> Bedrock
 * -> Polly/Fish) and Vertex Serbian-bridge sessions were therefore both
 * reported under a model that never served them.
 *
 * Three cases, one per provider the request names.
 */

import {
  CASCADE_LATENCY_LABEL,
  resolveLatencyProviderLabel,
} from '../../../../src/orb/live/upstream/latency-provider-label';
import { NOVA_SONIC_MODEL_ID } from '../../../../src/orb/live/upstream/nova-sonic-config';
import { VERTEX_LIVE_MODEL } from '../../../../src/orb/live/protocol';

describe('VTID-04531: resolveLatencyProviderLabel', () => {
  it('labels Nova Sonic sessions with the real Nova model id', () => {
    expect(resolveLatencyProviderLabel('nova_sonic')).toBe(
      `nova_sonic/${NOVA_SONIC_MODEL_ID}`,
    );
    expect(resolveLatencyProviderLabel('nova_sonic')).toBe(
      'nova_sonic/amazon.nova-2-sonic-v1:0',
    );
  });

  it('gives the cascade its own model-less label — no single model serves it', () => {
    const label = resolveLatencyProviderLabel('cascaded');
    expect(label).toBe(CASCADE_LATENCY_LABEL);
    expect(label).toBe('cascade');
    // The bug: a cascaded turn was charted as a Gemini model it never used.
    expect(label).not.toContain('gemini');
  });

  it('labels the Vertex bridge with the configured Vertex Live model id', () => {
    const label = resolveLatencyProviderLabel('vertex');
    expect(label).toBe(`vertex/${VERTEX_LIVE_MODEL}`);
    expect(label).toBe('vertex/gemini-live-2.5-flash-native-audio');
    // The bug: the stale GEMINI_MODEL (gemini-2.0-flash-exp) is not the model
    // the remaining Vertex path runs on.
    expect(label).not.toContain('gemini-2.0-flash-exp');
  });

  it('falls back to the Vertex label for unknown/absent providers instead of throwing', () => {
    for (const unknown of [undefined, null, '', 'livekit', 'something_new']) {
      expect(resolveLatencyProviderLabel(unknown)).toBe(
        `vertex/${VERTEX_LIVE_MODEL}`,
      );
    }
  });

  it('never returns the stale gemini-2.0-flash-exp label for any provider', () => {
    for (const provider of ['nova_sonic', 'cascaded', 'vertex']) {
      expect(resolveLatencyProviderLabel(provider)).not.toContain(
        'gemini-2.0-flash-exp',
      );
    }
  });
});
