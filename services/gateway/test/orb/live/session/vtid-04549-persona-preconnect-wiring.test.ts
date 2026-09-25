/**
 * VTID-04549 (ORB latency G) — source pins on routes/orb-live.ts.
 *
 * connectToLiveAPI is a 2,000-line closure that cannot be driven in a unit
 * test, so these pins hold the parts of the Devon pre-connect that live there:
 *   - the envelope builder's side-effect-free mode is only ever reached with
 *     `preconnect: true` (every other call is unchanged);
 *   - the pre-connected stream is opened with the same connect options and the
 *     same voice resolver as the swap's own cold connect;
 *   - the claim compares against the envelope the swap just built, and is only
 *     attempted when the turn-complete hand-over armed it;
 *   - only the Nova connect path supplies the hooks (the cascade swaps in
 *     process and is untouched).
 * The runtime behaviour itself is covered by vtid-04549-persona-preconnect.test.ts.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../../src');
const code = readFileSync(join(SRC, 'routes/orb-live.ts'), 'utf8');

function between(src: string, startMarker: string, endMarker: string): string {
  const a = src.indexOf(startMarker);
  expect(a).toBeGreaterThan(-1);
  const b = src.indexOf(endMarker, a + startMarker.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a + startMarker.length, b);
}

/** `key: value` pairs of an object literal body (comments dropped). */
function literalFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const m = line.match(/^(\w+):\s*(.+?),?$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

describe('VTID-04549 envelope builder', () => {
  it('takes an optional persona override / preconnect mode, and every other caller passes nothing', () => {
    expect(code).toMatch(/const buildOrbVertexSetupEnvelope = async \(\s*opts\?: \{ personaOverride\?: string; preconnect\?: boolean \},\s*\)/);
    const calls = code.match(/buildOrbVertexSetupEnvelope\(([^)]*)\)/g) ?? [];
    const withArgs = calls.filter((c) => c !== 'buildOrbVertexSetupEnvelope()');
    expect(withArgs).toEqual(['buildOrbVertexSetupEnvelope({ personaOverride: persona, preconnect: true })']);
  });

  it('preconnect mode touches no session state and emits no diag', () => {
    expect(code).toContain('if (ctxPromise && !opts?.preconnect) {');
    expect(code).toContain('const _persona = opts?.personaOverride || (session as any).activePersona || RECEPTIONIST_PERSONA_KEY;');
    expect(code).toMatch(/const _speculated = opts\?\.preconnect\s*\?\s*undefined\s*:\s*await consumeSpeculatedVoice\(voiceSpeculation, INLINE_VOICE_LOOKUP_BASELINE_MS\);/);
    // VTID-04554 moved the instruction/tool/budget body into the module-level
    // assembleOrbSetupEnvelope (shared with the Nova prewarm); the builder
    // hands it the pre-connect flag and the gates live there now.
    expect(code).toMatch(/assembleOrbSetupEnvelope\(session, _personaVoice, \{[^}]*preconnect: opts\?\.preconnect === true,\s*\}\)/);
    const asm = code.slice(code.indexOf('export function assembleOrbSetupEnvelope('), code.indexOf('return setupMessage as { setup: Record<string, any> };'));
    expect(asm).toContain('const preconnect = hooks.preconnect === true;');
    expect(asm).toContain("if (!preconnect) emitDiag(session, 'instruction_budget'");
    expect(asm).toContain("if (!preconnect) emitDiag(session, 'tool_catalog_trimmed'");
    expect(asm).toContain("if (session.upstreamProvider === 'vertex' && !preconnect) {");
    expect(asm).toContain('if (pendingTools.length > 0 && !preconnect) {');
    // Every write of the deferred-tool maps is behind the gate.
    const writes = asm.match(/^\s*session\.(deferredTools|declaredToolNames) = [^\n]*$/gm) ?? [];
    expect(writes.length).toBe(4);
    const guarded = asm.match(/if \(!preconnect\) \{\s*\n\s*session\.deferredTools = /g) ?? [];
    expect(guarded.length).toBe(2);
  });
});

describe('VTID-04549 pre-connected stream = the swap\'s own connect', () => {
  const pcBody = between(code, 'await pcClient.connect({', '});');
  const coldBody = between(code, 'await novaClient.connect({', '});');
  const pc = literalFields(pcBody);
  const cold = literalFields(coldBody);

  it('uses exactly the cold connect\'s option set', () => {
    expect(Object.keys(pc).sort()).toEqual(Object.keys(cold).sort());
  });

  it('shares every option value except the three per-envelope ones', () => {
    const perEnvelope: Record<string, [string, string]> = {
      voiceName: ['pcVoice', 'novaVoice'],
      systemInstruction: ['pcInstruction', 'novaSystemInstruction'],
      tools: ['pcTools', 'novaTools'],
    };
    for (const key of Object.keys(cold)) {
      if (perEnvelope[key]) {
        expect([key, pc[key]]).toEqual([key, perEnvelope[key][0]]);
        expect([key, cold[key]]).toEqual([key, perEnvelope[key][1]]);
      } else {
        expect([key, pc[key]]).toEqual([key, cold[key]]);
      }
    }
  });

  it('sanitizes the instruction and resolves the voice with the same functions (Devon male, VTID-04445)', () => {
    const fn = between(code, 'const preconnectPersonaUpstream = async (', 'return { client: pcClient');
    expect(fn).toContain("sanitizeInstructionForNova(pcSetup.system_instruction?.parts?.[0]?.text ?? '')");
    expect(fn).toContain("resolveNovaSonicVoiceOrFallback({ language: session.lang || 'en', persona })");
    expect(code).toMatch(/resolveNovaSonicVoiceOrFallback\(\{\s*language: session\.lang \|\| 'en',\s*persona: novaPersona,/);
    // The pre-connect sends nothing on its own — no greeting, no text turn.
    expect(fn).not.toMatch(/sendTextTurn|client_content|sendGreeting/);
  });
});

describe('VTID-04549 claim at the swap\'s connect', () => {
  const claim = between(code, 'const claimedPersonaClient =', 'novaClient = createUpstreamClient(');

  it('is only attempted when the turn-complete hand-over armed it', () => {
    expect(claim).toMatch(/\(session as any\)\._personaPreconnectClaimArmed === true\s*\?\s*await claimPersonaPreconnect<NovaSonicLiveClient>\(/);
    expect(claim).toMatch(/:\s*null;/);
  });

  it('compares against the envelope this connect just built', () => {
    expect(claim).toContain('persona: novaPersona,');
    expect(claim).toContain('systemInstruction: novaSystemInstruction,');
    expect(claim).toContain('tools: novaTools,');
    expect(claim).toContain('voiceId: novaVoice,');
    // Built first — the claim sits after the envelope build in the cold branch.
    const envelopeAt = code.indexOf('const envelope = (await buildOrbVertexSetupEnvelope())');
    expect(envelopeAt).toBeGreaterThan(-1);
    expect(code.indexOf('const claimedPersonaClient =')).toBeGreaterThan(envelopeAt);
  });

  it('skips connect() only for a claimed stream; the cold connect is unchanged', () => {
    expect(code).toMatch(/if \(reusedPersonaPreconnect\) \{[\s\S]{0,400}\} else if \(!reusedWarmNova\) \{\s*\n\s*await novaClient\.connect\(/);
    expect(claim).toContain('claimedPersonaClient.rebindSessionDeps({');
  });
});

describe('VTID-04549 hooks', () => {
  it('only the Nova connect path supplies them', () => {
    const hooks = code.match(/onPersonaSwapMaybeQueued,\s*\n\s*takeOverPersonaSwap,/g) ?? [];
    expect(hooks.length).toBe(1);
    const novaBind = between(code, 'const takeOverPersonaSwap = (', 'options: {');
    expect(novaBind).toContain('client: novaClient,');
    expect(novaBind).toContain('onPersonaSwapMaybeQueued,');
  });

  it('the hand-over reconnects through attemptTransparentReconnect (today\'s greeting nudge)', () => {
    const takeover = between(code, 'const takeOverPersonaSwap = (', 'bindUpstreamSessionHandlers({');
    expect(takeover).toContain('takeOverPersonaSwapWithPreconnect({');
    expect(takeover).toContain('oldClient: novaClient,');
    expect(takeover).toContain('clearKeepalive: clearUpstreamKeepalive,');
    expect(takeover).toMatch(/reconnect: \(\) => attemptTransparentReconnect\(\s*session,\s*onAudioResponse,\s*onTextResponse,\s*onError,\s*onTurnComplete,\s*onInterrupted,\s*\),/);
  });
});
