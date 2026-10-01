/**
 * VTID-04336 — the Vitana → Devon hand-off on the Serbian Vertex bridge.
 *
 * On Vertex the swap is a close(`persona_swap`) + transparent reconnect; the
 * reconnect re-runs `connectToLiveAPI`, which re-selects the upstream and
 * rebuilds the setup with Devon's prompt and voice. Two things must hold:
 *   1. the reconnect re-selects the bridge (not Nova) — selection does not
 *      depend on the persona, and
 *   2. the setup's `voice_name` is a Gemini prebuilt voice for Devon.
 */

import * as fs from 'fs';
import * as path from 'path';
import { selectUpstreamProvider } from '../../../../src/orb/live/upstream/upstream-provider-selector';
import {
  GEMINI_LIVE_PREBUILT_VOICES,
  VERTEX_SPECIALIST_FALLBACK_VOICE,
  resolveVertexLivePersonaVoice,
} from '../../../../src/orb/live/upstream/vertex-serbian-bridge';
import { getLiveApiVoice } from '../../../../src/orb/live/voice/live-api-voice';

const ORB_LIVE = fs.readFileSync(path.resolve(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

describe('VTID-04336 Serbian bridge — persona-swap reconnect re-selects the bridge', () => {
  const bridgeCtx = {
    nova: { enabled: true, identityAllowed: true, languageSupported: false, runtime: 'aws-ecs' as const },
    cascade: { enabled: true, languageSupported: true },
    vertexSerbianBridge: { enabled: true, languageSupported: true },
    identity: { userId: 'u', tenantId: 't' },
  };

  it('the initial connect and the persona-swap reconnect resolve identically (vertex_serbian_bridge)', () => {
    const initial = selectUpstreamProvider(bridgeCtx);
    // The reconnect builds the same context (the selector never sees the
    // persona) — so the second selection must be the bridge again, never Nova.
    const reconnect = selectUpstreamProvider({ ...bridgeCtx });
    expect(initial).toEqual(reconnect);
    expect(reconnect.provider).toBe('vertex');
    expect(reconnect.reason).toBe('vertex_serbian_bridge');
  });

  it('the reconnect path re-enters connectToLiveAPI (re-selection), with the persona-swap cue', () => {
    const fn = ORB_LIVE.slice(ORB_LIVE.indexOf('async function attemptTransparentReconnect('));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toMatch(/await connectToLiveAPI\(/);
    expect(body).toMatch(/persona_swap_reconnected/);
  });
});

describe('VTID-04336 resolveVertexLivePersonaVoice', () => {
  it("keeps Devon's registry voice (Charon) — a Gemini prebuilt voice", () => {
    expect(GEMINI_LIVE_PREBUILT_VOICES.has('Charon')).toBe(true);
    expect(resolveVertexLivePersonaVoice('Charon', 'devon')).toBe('Charon');
  });

  it('replaces a non-Gemini specialist voice (a Nova/Polly id) with the Gemini specialist fallback', () => {
    expect(resolveVertexLivePersonaVoice('matthew', 'devon')).toBe(VERTEX_SPECIALIST_FALLBACK_VOICE);
    expect(resolveVertexLivePersonaVoice('Daniel', 'devon')).toBe('Charon');
  });

  it('returns null when there is no usable voice, so the language voice applies (unchanged behaviour)', () => {
    expect(resolveVertexLivePersonaVoice('', 'devon')).toBeNull();
    expect(resolveVertexLivePersonaVoice(undefined, 'vitana')).toBeNull();
    expect(resolveVertexLivePersonaVoice('tiffany', 'vitana')).toBeNull();
  });

  it("Serbian's receptionist language voice is itself a Gemini prebuilt voice", () => {
    expect(GEMINI_LIVE_PREBUILT_VOICES.has(getLiveApiVoice('sr'))).toBe(true);
    expect(getLiveApiVoice('sr')).not.toBe(VERTEX_SPECIALIST_FALLBACK_VOICE);
  });

  it('the Vertex setup envelope routes the persona voice through the resolver', () => {
    expect(ORB_LIVE).toMatch(
      /_personaVoice = resolveVertexLivePersonaVoice\(_personaVoice, _persona\) \|\| getLiveApiVoice\(session\.lang\);/,
    );
    expect(ORB_LIVE).toMatch(/voice_name: _personaVoice/);
  });
});

describe('VTID-04336 cascade connect carries the envelope catalog', () => {
  it('the cascaded connect passes the setup tools so the hand-off tools are declared', () => {
    const start = ORB_LIVE.indexOf("if (__upstreamDecision.provider === 'cascaded')");
    const block = ORB_LIVE.slice(start, start + 8000);
    expect(block).toMatch(/await cascadedClient\.connect\(\{[\s\S]*tools: Array\.isArray\(cascadedSetup\.tools\)/);
  });
});
