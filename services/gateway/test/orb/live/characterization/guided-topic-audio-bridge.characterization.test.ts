/**
 * VTID-03650 — guided-topic lesson audio (Amazon Polly) must be sent BEFORE
 * the live model's first turn, on every transport, and exactly once per
 * session.
 *
 * Source characterization test, matching this codebase's established pattern
 * for orb-live.ts (too large/stateful to unit-test the WebSocket harness
 * directly — see zero-turn-greeting-recovery-not-silenced.characterization
 * .test.ts and vertex-wake-opener-v2.characterization.test.ts for the same
 * shape). `sendGuidedTopicNarrationAudioBridge` is a module-private function
 * with side effects on a live WebSocket/SSE connection, so its wiring is
 * verified structurally rather than by instantiating the WS harness.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const orbLive = readFileSync(join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');

function extractFunctionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start).toBeGreaterThan(-1);
  // Find the matching closing brace by depth-counting from the first '{'.
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

describe('VTID-03650 — sendGuidedTopicNarrationAudioBridge definition', () => {
  const fnBody = extractFunctionBody(orbLive, 'function sendGuidedTopicNarrationAudioBridge(session: GeminiLiveSession)');

  it('is a one-shot: short-circuits once guidedTopicAudioDelivered has been set', () => {
    expect(fnBody).toMatch(/guidedTopicAudioDelivered\s*!==\s*undefined\)\s*return;/);
  });

  it('reads the pre-synthesized audio off session.guidedTopicNarrationContent.narrationAudio', () => {
    expect(fnBody).toContain('guidedTopicNarrationContent');
    expect(fnBody).toContain('narrationAudio');
  });

  it('does nothing (marks delivered=false) when there is no audio to send', () => {
    expect(fnBody).toMatch(/if \(!audio\) \{[\s\S]*?guidedTopicAudioDelivered = false;[\s\S]*?return;/);
  });

  it('sends on BOTH transports — SSE write and WS message — with the same message shape', () => {
    expect(fnBody).toMatch(/session\.sseResponse\.write\(`data: \$\{JSON\.stringify\(msg\)\}/);
    expect(fnBody).toMatch(/sendWsMessage\(session\.clientWs, msg\)/);
  });

  it('tags the message with source: guided_topic_narration so the client/telemetry can distinguish it', () => {
    expect(fnBody).toContain("source: 'guided_topic_narration'");
  });

  it('marks delivered=true only after a successful send, never before', () => {
    const sendIdx = fnBody.search(/sendWsMessage\(session\.clientWs, msg\)/);
    const trueIdx = fnBody.indexOf('guidedTopicAudioDelivered = true;');
    expect(sendIdx).toBeGreaterThan(-1);
    expect(trueIdx).toBeGreaterThan(sendIdx);
  });

  it('emits diag + OASIS telemetry tagged VTID-03650 on a successful send', () => {
    expect(fnBody).toContain("emitDiag(session, 'guided_topic_audio_bridge_sent'");
    expect(fnBody).toContain("'orb.guided_topic.audio_bridge_sent'");
    expect(fnBody).toContain("vtid: 'VTID-03650'");
  });

  it('never throws out of a failed send — catches and marks delivered=false', () => {
    expect(fnBody).toMatch(/catch \(err\) \{[\s\S]*guidedTopicAudioDelivered = false;/);
  });
});

describe('VTID-03650 — call sites fire BEFORE the live model turn, on every transport', () => {
  it('SSE session-start path calls the bridge right after the greeting bridge, before connectToLiveAPI', () => {
    const greetingIdx = orbLive.indexOf('await sendGreetingAudioBridge(session);');
    const bridgeIdx = orbLive.indexOf('sendGuidedTopicNarrationAudioBridge(session);');
    const connectIdx = orbLive.indexOf('const liveApiPromise = connectToLiveAPI(');
    expect(greetingIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(connectIdx).toBeGreaterThan(-1);
    expect(greetingIdx).toBeLessThan(bridgeIdx);
    expect(bridgeIdx).toBeLessThan(connectIdx);
  });

  it('WS audio_ready primary path calls the bridge after the chime, before the greeting is sent', () => {
    const chimeIdx = orbLive.indexOf("source: 'activation_chime'");
    const bridgeIdx = orbLive.indexOf(
      'sendGuidedTopicNarrationAudioBridge(liveSession);\n        sendGreetingPromptToLiveAPI(liveSession.upstreamWs, liveSession);',
    );
    expect(chimeIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(chimeIdx).toBeLessThan(bridgeIdx);
  });

  it('WS audio_ready 1s-timeout fallback path also calls the bridge before the greeting', () => {
    const fallbackIdx = orbLive.indexOf('Fallback: sending chime + greeting after 1s timeout');
    expect(fallbackIdx).toBeGreaterThan(-1);
    const afterFallback = orbLive.slice(fallbackIdx, fallbackIdx + 1500);
    const bridgeIdx = afterFallback.indexOf('sendGuidedTopicNarrationAudioBridge(liveSession);');
    const greetIdx = afterFallback.indexOf('sendGreetingPromptToLiveAPI(liveSession.upstreamWs, liveSession);');
    expect(bridgeIdx).toBeGreaterThan(-1);
    expect(greetIdx).toBeGreaterThan(-1);
    expect(bridgeIdx).toBeLessThan(greetIdx);
  });

  it('the bridge call itself is NOT awaited (synchronous — the audio was already synthesized during wake-brief decision)', () => {
    expect(orbLive).not.toMatch(/await sendGuidedTopicNarrationAudioBridge/);
  });
});
