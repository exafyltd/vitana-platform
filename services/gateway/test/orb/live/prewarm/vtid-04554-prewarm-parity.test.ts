/**
 * VTID-04554 — Nova prewarm parity (`ORB_PREWARM_FULL_CONTEXT_ENABLED`).
 *
 * The login-time Nova prewarm (VTID-03779) opened a stream with a reduced
 * instruction (no personal context, no instruction budget, untrimmed tools)
 * and the session claimed it blind. With the flag on, the prewarm builds its
 * envelope through the SAME function the session uses and pools a
 * fingerprint; the session builds its own envelope as a cold start does and
 * claims only on an exact match. Flag off: today's behaviour, unchanged.
 */
import fs from 'fs';
import path from 'path';
import {
  computeNovaStreamFingerprint,
  decidePrewarmClaim,
  isPrewarmFullContextEnabled,
  maskRenderTimeLines,
  toolNamesOf,
  type NovaStreamShape,
} from '../../../../src/orb/live/prewarm/prewarm-fingerprint';
import {
  __clearAllPrewarmedNovaSessionsForTest,
  __prewarmedNovaSessionCountForTest,
  peekPrewarmedNovaSession,
  registerPrewarmedNovaSession,
} from '../../../../src/orb/live/prewarm/nova-session-prewarm';
import {
  assembleOrbSetupEnvelope,
  buildPrewarmShadowSession,
  novaStreamShapeFromEnvelope,
} from '../../../../src/routes/orb-live';
import { composeSessionContext } from '../../../../src/orb/live/session/session-context-builder';

const SRC = fs.readFileSync(path.join(__dirname, '../../../../src/routes/orb-live.ts'), 'utf8');
const code = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n');

const NO_HOOKS = { emitDiag: () => {}, recordBrainContextBuilt: () => {} };

const shape = (over: Partial<NovaStreamShape> = {}): NovaStreamShape => ({
  systemInstruction: 'You are Vitana.\nLocal time: Monday morning, 9:05\nCurrent UTC time: 2026-09-25T07:05:00.000Z',
  tools: [{ function_declarations: [{ name: 'navigate', description: 'go', parameters: { type: 'object', properties: {} } }] }],
  voiceId: 'tiffany',
  lang: 'en',
  model: 'amazon.nova-sonic-v1:0',
  vadSilenceMs: 1200,
  responseModalities: ['audio'],
  ...over,
});

describe('VTID-04554 flag reader', () => {
  it('only the exact string "true" enables it; default OFF', () => {
    expect(isPrewarmFullContextEnabled({} as any)).toBe(false);
    expect(isPrewarmFullContextEnabled({ ORB_PREWARM_FULL_CONTEXT_ENABLED: 'false' } as any)).toBe(false);
    expect(isPrewarmFullContextEnabled({ ORB_PREWARM_FULL_CONTEXT_ENABLED: 'TRUE' } as any)).toBe(false);
    expect(isPrewarmFullContextEnabled({ ORB_PREWARM_FULL_CONTEXT_ENABLED: '1' } as any)).toBe(false);
    expect(isPrewarmFullContextEnabled({ ORB_PREWARM_FULL_CONTEXT_ENABLED: 'true' } as any)).toBe(true);
  });
});

describe('VTID-04554 fingerprint', () => {
  it('is stable across object key order in the tool declarations', () => {
    const a = shape();
    const b = shape({ tools: [{ function_declarations: [{ parameters: { properties: {}, type: 'object' }, description: 'go', name: 'navigate' }] }] });
    expect(computeNovaStreamFingerprint(a)).toBe(computeNovaStreamFingerprint(b));
  });

  it('changes with anything baked into the stream at connect', () => {
    const base = computeNovaStreamFingerprint(shape());
    expect(computeNovaStreamFingerprint(shape({ systemInstruction: 'You are Vitana!' }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ tools: [] }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ tools: [{ function_declarations: [{ name: 'navigate', description: 'GO', parameters: { type: 'object', properties: {} } }] }] }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ voiceId: 'matthew' }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ lang: 'de' }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ model: 'other' }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ vadSilenceMs: 2000 }))).not.toBe(base);
    expect(computeNovaStreamFingerprint(shape({ responseModalities: ['text'] }))).not.toBe(base);
  });

  it('the render-time mask is diagnostic only: it hides the clock lines and nothing else', () => {
    const later = shape({ systemInstruction: shape().systemInstruction.replace('9:05', '9:07').replace('07:05:00.000', '07:07:12.345') });
    expect(computeNovaStreamFingerprint(later)).not.toBe(computeNovaStreamFingerprint(shape()));
    expect(computeNovaStreamFingerprint(later, { ignoreRenderTime: true })).toBe(computeNovaStreamFingerprint(shape(), { ignoreRenderTime: true }));
    expect(maskRenderTimeLines('a\nCurrent UTC time: x\nLocal time: y\nb')).toBe('a\nCurrent UTC time: <render-time>\nLocal time: <render-time>\nb');
  });

  it('toolNamesOf lists declarations in order', () => {
    expect(toolNamesOf([{ function_declarations: [{ name: 'a' }, { name: 'b' }] }, { google_search: {} }])).toEqual(['a', 'b', '<google_search>']);
  });
});

describe('VTID-04554 claim decision', () => {
  const fp = computeNovaStreamFingerprint(shape());
  const session = { lang: 'en', fingerprint: fp, isGuidedTopic: false };

  it('claims only on an exact fingerprint match in the same language', () => {
    expect(decidePrewarmClaim({ prewarm: { lang: 'en', fingerprint: fp }, session })).toEqual({ claim: true });
  });

  it('mismatch → no claim, discard the pooled stream', () => {
    expect(decidePrewarmClaim({ prewarm: { lang: 'en', fingerprint: 'other' }, session }))
      .toEqual({ claim: false, reason: 'fingerprint_mismatch', discard: true });
  });

  it('guided topic → never claims, leaves the pooled stream for a later ordinary open', () => {
    expect(decidePrewarmClaim({ prewarm: { lang: 'en', fingerprint: fp }, session: { ...session, isGuidedTopic: true } }))
      .toEqual({ claim: false, reason: 'guided_topic', discard: false });
  });

  it('language mismatch → never claims, even with an equal fingerprint', () => {
    expect(decidePrewarmClaim({ prewarm: { lang: 'de', fingerprint: fp }, session }))
      .toEqual({ claim: false, reason: 'language_mismatch', discard: true });
  });

  it('a legacy (flag-off) prewarm has no fingerprint → never claimed on the full-context path', () => {
    expect(decidePrewarmClaim({ prewarm: { lang: 'en' }, session }))
      .toEqual({ claim: false, reason: 'no_fingerprint', discard: true });
  });
});

describe('VTID-04554 registry peek', () => {
  afterEach(() => __clearAllPrewarmedNovaSessionsForTest());
  it('peek reads without claiming; the fingerprint travels with the entry', () => {
    const client = { getState: () => 'open', sendAudioChunk: jest.fn(), close: jest.fn(async () => {}) };
    registerPrewarmedNovaSession('u-9', { client: client as any, systemInstruction: 'x', tools: [], voiceId: 'v', lang: 'en', fingerprint: 'fp-1' });
    expect(peekPrewarmedNovaSession('u-9')?.fingerprint).toBe('fp-1');
    expect(__prewarmedNovaSessionCountForTest()).toBe(1);
    expect(peekPrewarmedNovaSession('nobody')).toBeNull();
  });
});

/**
 * Fixture parity: the prewarm's shadow session and the session the start
 * path builds for the same member, on the same context, produce the same
 * Nova stream — through the one envelope builder both use. The clock is
 * frozen because the ENVIRONMENT block renders the current UTC time.
 */
describe('VTID-04554 prewarm envelope == cold envelope for a fixture', () => {
  const NOW = new Date('2026-09-25T07:05:00.000Z');
  const identity = { user_id: 'a27552a3-0257-4305-8ed0-351a80fd3701', tenant_id: 't-1', email: null, exafy_admin: false, role: 'authenticated', aud: null, exp: null, iat: null, vitana_id: 'fixture1' } as any;
  const clientContext = {
    city: 'Berlin', country: 'Germany', timezone: 'Europe/Berlin', localTime: 'Thursday morning, 9:05', timeOfDay: 'morning',
    device: 'Mac', browser: 'Chrome', os: 'macOS', isMobile: false, lang: 'en',
  } as any;
  const base = '=== USER CONTEXT PROFILE ===\nName: Ana\n## Verified Facts About This User\n- user_name: Ana';
  const journeyBlock = '\n\n=== GUIDED JOURNEY ===\nSession 3 of 12.';
  const autopilotOffer = '=== AUTOPILOT OFFER ===\nYou have 2 suggestions.';
  const lastSessionInfo = { time: 'yesterday', wasFailure: false };
  const composed = composeSessionContext({ base, role: 'community', isAdminRole: false, extras: { autopilotOffer, adminBriefing: null }, journeyBlock }).text;

  /** The session object the start path builds (live-session-controller.ts), for the same inputs. */
  function coldSession(over: Record<string, unknown> = {}) {
    return {
      sessionId: 'live-fixture',
      lang: 'en',
      voiceStyle: 'friendly, calm, empathetic',
      responseModalities: ['audio', 'text'],
      upstreamWs: null,
      sseResponse: null,
      active: true,
      createdAt: NOW,
      lastActivity: NOW,
      audioInChunks: 0,
      audioOutChunks: 0,
      turn_count: 0,
      contextInstruction: composed,
      transcriptTurns: [],
      outputTranscriptBuffer: '',
      inputTranscriptBuffer: '',
      isModelSpeaking: false,
      identity,
      conversationSummary: undefined,
      active_role: 'community',
      vadSilenceMs: 1200,
      lastSessionInfo,
      isAnonymous: false,
      clientContext,
      current_route: '/home',
      recent_routes: undefined,
      upstreamProvider: 'nova_sonic',
      onboardingCohortBlock: '',
      ...over,
    } as any;
  }

  function prewarmShadow() {
    return buildPrewarmShadowSession({
      sessionId: 'prewarm-a27552a3-1',
      lang: 'en',
      identity,
      clientContext,
      contextInstruction: composed,
      activeRole: 'community',
      lastSessionInfo,
      currentRoute: '/home',
      onboardingCohortBlock: '',
      vadSilenceMs: 1200,
    });
  }

  function streamOf(session: any) {
    const env = assembleOrbSetupEnvelope(session, 'Aoede', NO_HOOKS);
    return novaStreamShapeFromEnvelope(env, session, 'amazon.nova-sonic-v1:0');
  }

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
  });
  afterEach(() => jest.useRealTimers());

  it('same member, same context, same instant → identical instruction, tools, voice, budget handling → claimed', () => {
    const warmDiags: Array<[string, unknown]> = [];
    const coldDiags: Array<[string, unknown]> = [];
    const warmEnv = assembleOrbSetupEnvelope(prewarmShadow(), 'Aoede', { emitDiag: (_s, st, x) => warmDiags.push([st, x]), recordBrainContextBuilt: () => {} });
    const coldEnv = assembleOrbSetupEnvelope(coldSession(), 'Aoede', { emitDiag: (_s, st, x) => coldDiags.push([st, x]), recordBrainContextBuilt: () => {} });
    const warm = novaStreamShapeFromEnvelope(warmEnv, prewarmShadow(), 'amazon.nova-sonic-v1:0');
    const cold = novaStreamShapeFromEnvelope(coldEnv, coldSession(), 'amazon.nova-sonic-v1:0');
    expect(warm.systemInstruction).toBe(cold.systemInstruction);
    // The prewarm now goes through the instruction budget and the tool-catalog
    // budget exactly as the session does (the old prewarm had neither).
    expect(warmDiags).toEqual(coldDiags);
    expect(warmDiags.map(([st]) => st)).toEqual(expect.arrayContaining(['instruction_budget', 'tool_catalog_trimmed']));
    expect(toolNamesOf(warm.tools)).toEqual(toolNamesOf(cold.tools));
    expect(warm.voiceId).toBe(cold.voiceId);
    const fp = computeNovaStreamFingerprint(warm);
    expect(fp).toBe(computeNovaStreamFingerprint(cold));
    expect(decidePrewarmClaim({ prewarm: { lang: warm.lang, fingerprint: fp }, session: { lang: cold.lang, fingerprint: computeNovaStreamFingerprint(cold), isGuidedTopic: false } }))
      .toEqual({ claim: true });
  });

  it('a wake-brief override chosen at session start is baked into the instruction → mismatch → cold', () => {
    const warm = streamOf(prewarmShadow());
    const cold = streamOf(coldSession({ wakeBriefOverrideBlock: '\n\n<<VERTEX_WAKE_BRIEF_OVERRIDE_ACTIVE>>\nOpen with the journey.' }));
    expect(cold.systemInstruction).not.toBe(warm.systemInstruction);
    expect(decidePrewarmClaim({ prewarm: { lang: 'en', fingerprint: computeNovaStreamFingerprint(warm) }, session: { lang: 'en', fingerprint: computeNovaStreamFingerprint(cold), isGuidedTopic: false } }).claim).toBe(false);
  });

  it('a session on another screen than the prewarm assumed → different instruction/tools → mismatch → cold', () => {
    const warm = streamOf(prewarmShadow());
    const cold = streamOf(coldSession({ current_route: '/health' }));
    expect(computeNovaStreamFingerprint(cold)).not.toBe(computeNovaStreamFingerprint(warm));
  });

  it('a different context (another member state) → mismatch → cold', () => {
    const warm = streamOf(prewarmShadow());
    const cold = streamOf(coldSession({ active_role: 'professional' }));
    expect(computeNovaStreamFingerprint(cold)).not.toBe(computeNovaStreamFingerprint(warm));
  });

  it('a guided-topic session never claims, a language change never claims', () => {
    const warm = streamOf(prewarmShadow());
    const fp = computeNovaStreamFingerprint(warm);
    expect(decidePrewarmClaim({ prewarm: { lang: 'en', fingerprint: fp }, session: { lang: 'en', fingerprint: fp, isGuidedTopic: true } }).claim).toBe(false);
    const coldDe = streamOf(coldSession({ lang: 'de' }));
    expect(decidePrewarmClaim({ prewarm: { lang: 'en', fingerprint: fp }, session: { lang: coldDe.lang, fingerprint: computeNovaStreamFingerprint(coldDe), isGuidedTopic: false } }))
      .toMatchObject({ claim: false, reason: 'language_mismatch' });
  });

  it('the prewarm passes no-op diagnostic hooks (a shadow writes nothing); the session passes the real ones', () => {
    expect(code).toMatch(/const PREWARM_SHADOW_ENVELOPE_HOOKS = \{\s*\n\s*emitDiag: \([^)]*\) => \{ \/\* shadow: no diag \*\/ \},\s*\n\s*recordBrainContextBuilt: \([^)]*\) => \{ \/\* shadow: no diag \*\/ \},/);
    expect(code).toMatch(/assembleOrbSetupEnvelope\(shadow, getLiveApiVoice\(lang\), PREWARM_SHADOW_ENVELOPE_HOOKS\)/);
    expect(code).toMatch(/const setupMessage = assembleOrbSetupEnvelope\(session, _personaVoice, \{\s*emitDiag,\s*recordBrainContextBuilt,\s*(?:\/\/[^\n]*\n\s*)?preconnect: opts\?\.preconnect === true,\s*\}\);/);
  });
});

describe('VTID-04554 wiring (source) — flag off is today', () => {
  it('flag off: the blind login-prewarm claim is exactly the old one; flag on disables it', () => {
    expect(code).toMatch(/const prewarmedNova = session\.identity\?\.user_id && !isWorkSurface\(sessionSurface\) && _prewarmPersonaIsVitana && !_prewarmFullContext\s*\n\s*\? consumePrewarmedNovaSession\(session\.identity\.user_id\)/);
    expect(code).toMatch(/const _prewarmFullContext = isPrewarmFullContextEnabled\(\);/);
  });

  it('flag on: the claim happens in the cold branch, after the cold envelope, through the fingerprint check', () => {
    const coldBranch = code.match(/const envelope = \(await buildOrbVertexSetupEnvelope\(\)\)[\s\S]*?novaClient = createUpstreamClient\('nova_sonic'/)?.[0];
    expect(coldBranch).toBeDefined();
    expect(coldBranch).toMatch(/_prewarmFullContext && _prewarmEligible\s*\n\s*\? claimFullContextPrewarm\(session, session\.identity!\.user_id, \{/);
    expect(coldBranch).toMatch(/reusedWarmNova = true;/);
    expect(coldBranch).toMatch(/rebindSessionDeps\(\{/);
  });

  it('the claim helper consumes only on a decided claim and names every miss', () => {
    const fn = code.match(/function claimFullContextPrewarm\([\s\S]*?\n\}/)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toMatch(/peekPrewarmedNovaSession\(userId\)/);
    expect(fn).toMatch(/decidePrewarmClaim\(/);
    expect(fn).toMatch(/emitDiag\(session, 'nova_prewarm_missed', \{/);
    expect(fn).toMatch(/if \(decision\.discard\) discardPrewarmedNovaSession\(userId/);
    expect(fn!.indexOf('consumePrewarmedNovaSession(userId)')).toBeGreaterThan(fn!.indexOf('if (!decision.claim)'));
  });

  it('the WS prewarm handler keeps the legacy path when the flag is off', () => {
    const fn = code.match(/async function handleWsPrewarmMessage\([\s\S]*?\n\}/)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toMatch(/if \(isPrewarmFullContextEnabled\(\)\) \{\s*\n\s*await prewarmNovaFullContext\(clientSession, message\);\s*\n\s*return;\s*\n\s*\}/);
    // The legacy 4-argument instruction build is still what runs with the flag off.
    expect(fn).toMatch(/buildLiveSystemInstruction\(\s*\n\s*lang,\s*\n\s*'friendly, calm, empathetic',\s*\n\s*buildPersonaBehavioralRule\('vitana'\),\s*\n\s*activeRole,\s*\n\s*\)/);
  });

  it('the full-context prewarm pools the fingerprint of exactly what it connected with', () => {
    const fn = code.match(/async function prewarmNovaFullContext\([\s\S]*?\n\}/)?.[0];
    expect(fn).toBeDefined();
    expect(fn).toMatch(/const fingerprint = computeNovaStreamFingerprint\(shape\);/);
    expect(fn).toMatch(/systemInstruction: shape\.systemInstruction,/);
    expect(fn).toMatch(/tools: shape\.tools,/);
    expect(fn).toMatch(/fingerprint,\s*\n\s*\}\);/);
    // Registration strictly before the ready ack (same rule as the legacy path).
    expect(fn!.indexOf("type: 'prewarm_ready'")).toBeGreaterThan(fn!.indexOf('registerPrewarmedNovaSession('));
  });
});
