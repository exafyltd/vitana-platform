/**
 * VTID-04542 — ORB latency guardrail: voice payload + memory-write identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * The ORB voice-latency plan runs several parallel streams that touch the
 * connect path (envelope build, context gate, prewarm, tool selection, greeting
 * ladder, per-turn persistence). A latency change is only acceptable if what
 * the voice assistant RECEIVES, and what the platform PERSISTS, stays the same.
 * This suite pins both, captured on unchanged `main` so its snapshots are
 * today's truth.
 *
 * WHAT IS PINNED
 * --------------
 *   A. For nine session shapes, the payload each upstream actually receives,
 *      captured by driving the REAL `connectToLiveAPI` (routes/orb-live.ts)
 *      with the upstream clients faked at the transport seam:
 *        - Nova Sonic   → the `connect()` options of the client built by
 *                         `createUpstreamClient('nova_sonic')` (instruction
 *                         after the instruction budget + sanitizeInstructionForNova,
 *                         tool catalog after the Nova byte budget);
 *        - cascade (ru) → the `connect()` options of `createUpstreamClient('cascaded')`;
 *        - Vertex (sr)  → the setup envelope `VertexLiveClient` would send
 *                         (`customSetupMessage`), after the Vertex byte budget.
 *      Nothing between the session object and the client is mocked except I/O
 *      (OASIS, Supabase, persona-registry DB read, voice/canary config reads,
 *      Bedrock transport prewarm). Every instruction/tool builder runs for real.
 *   B. The greeting decision (`computeGreetingDecision`) — rung + directive —
 *      for the opening rungs the voice session can take.
 *   C. The memory/persistence writes a completed turn performs
 *      (`handleTurnComplete`), and the writes a session start performs
 *      (`handleLiveSessionStart`, anonymous + authenticated).
 *
 * HOW TO READ A FAILURE
 * ---------------------
 * The small hash manifest next to this file
 * (`vtid-04542-voice-payload-identity.hashes.json`) is asserted first, so a
 * failing run names WHICH scenario's instruction / tool catalog / directive
 * changed in one short diff. The full text lives in the jest snapshot.
 * If a change is intentional (a deliberate prompt or catalog change), say so
 * in the PR and regenerate: `npx jest test/orb/latency -u` (the manifest is
 * rewritten in the same run). Otherwise the change is a regression — a latency
 * optimisation altered what the assistant receives.
 *
 * DETERMINISM: `Date` is frozen at FROZEN_NOW (only `Date` is faked — real
 * timers keep the async connect path working; the session-start section uses
 * a clock that starts at FROZEN_NOW and advances, because its bounded waits
 * measure elapsed time), `Math.random` is a seeded LCG reset per scenario,
 * every provider/budget/feature env var is cleared then pinned per scenario,
 * and every timer created during a scenario is cleared afterwards.
 *
 * Seam used: `routes/orb-live.ts` re-exports `connectToLiveAPI` as
 * `__connectToLiveAPIForTest` (a re-export only, no behaviour).
 *
 * Run: `npm run test:voice-identity`.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

// ---------------------------------------------------------------------------
// I/O mocks (never the builders under test)
// ---------------------------------------------------------------------------

/** Mutable holder the supabase mock reads, so each section decides what
 *  `getSupabase()` returns (null for the connect path; a recording fake for
 *  the persistence guards). Prefixed `mock` so jest.mock may reference it. */
const mockSupabaseHolder: { current: unknown } = { current: null };

jest.mock('../../../src/lib/supabase', () => {
  const actual = jest.requireActual('../../../src/lib/supabase');
  return { ...actual, getSupabase: () => mockSupabaseHolder.current };
});

jest.mock('../../../src/services/oasis-event-service', () => {
  const actual = jest.requireActual('../../../src/services/oasis-event-service');
  return { ...actual, emitOasisEvent: jest.fn(async () => ({ ok: true })) };
});

jest.mock('../../../src/services/voice-config', () => {
  const actual = jest.requireActual('../../../src/services/voice-config');
  return { ...actual, getVoiceConfig: jest.fn(async () => ({ active_provider: 'nova_sonic' })) };
});

jest.mock('../../../src/orb/live/upstream/livekit-canary-config', () => {
  const actual = jest.requireActual('../../../src/orb/live/upstream/livekit-canary-config');
  return {
    ...actual,
    getLiveKitCanaryConfig: jest.fn(async () => ({ enabled: false, allowedTenants: [], allowedUsers: [] })),
  };
});

jest.mock('../../../src/services/persona-registry', () => {
  const actual = jest.requireActual('../../../src/services/persona-registry');
  return {
    ...actual,
    getPersonaVoice: jest.fn(async () => ''),
    getPersonaVoiceForTenant: jest.fn(async () => ''),
  };
});

jest.mock('../../../src/orb/live/upstream/nova-sonic-live-client', () => {
  const actual = jest.requireActual('../../../src/orb/live/upstream/nova-sonic-live-client');
  return { ...actual, prewarmNovaSonicBedrock: jest.fn(async () => false) };
});

/** Every connect() the fakes see, in order. */
const mockCaptured: { connects: Array<{ provider: string; options: any }> } = { connects: [] };

jest.mock('../../../src/orb/live/upstream/upstream-client-factory', () => {
  const actual = jest.requireActual('../../../src/orb/live/upstream/upstream-client-factory');
  class MockFakeUpstreamClient {
    kind: string;
    state = 'idle';
    constructor(kind: string) { this.kind = kind; }
    async connect(options: any) { mockCaptured.connects.push({ provider: this.kind, options }); this.state = 'open'; }
    sendAudioChunk() { return true; }
    sendTextTurn() { return true; }
    sendEndOfTurn() { return true; }
    sendToolResult() { return true; }
    onAudioOutput() {}
    onTranscript() {}
    onToolCall() {}
    onTurnComplete() {}
    onInterrupted() {}
    onUsage() {}
    onError() {}
    onClose() {}
    async close() { this.state = 'closed'; }
    getState() { return this.state; }
    rebindSessionDeps() {}
    applyPersona() { return { persona: 'vitana', voiceRole: 'vitana', instructionChars: 0, restoredBaseInstruction: false }; }
  }
  return {
    ...actual,
    createUpstreamClient: jest.fn((kind: string) => new MockFakeUpstreamClient(kind)),
  };
});

jest.mock('../../../src/orb/live/upstream/vertex-live-client', () => {
  const actual = jest.requireActual('../../../src/orb/live/upstream/vertex-live-client');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { EventEmitter: MockEE } = require('events');
  class MockFakeVertexLiveClient {
    private socket: any = null;
    onSessionResumption() {}
    onGoAway() {}
    async connect(options: any) {
      const envelope = await options.customSetupMessage();
      mockCaptured.connects.push({ provider: 'vertex', options: { ...options, envelope } });
      const ws = new MockEE();
      ws.readyState = 1;
      ws.send = () => undefined;
      ws.ping = () => undefined;
      ws.close = () => undefined;
      ws.terminate = () => undefined;
      this.socket = ws;
    }
    getSocket() { return this.socket; }
    async close() {}
    sendAudioChunk() { return true; }
    sendTextTurn() { return true; }
    sendEndOfTurn() { return true; }
    sendToolResult() { return true; }
    onAudioOutput() {}
    onTranscript() {}
    onToolCall() {}
    onTurnComplete() {}
    onInterrupted() {}
    onUsage() {}
    onError() {}
    onClose() {}
    getState() { return 'open'; }
  }
  return { ...actual, VertexLiveClient: MockFakeVertexLiveClient };
});

// Persistence writers the per-turn handler calls (section C).
jest.mock('../../../src/services/orb-memory-bridge', () => {
  const actual = jest.requireActual('../../../src/services/orb-memory-bridge');
  return { ...actual, writeMemoryItemWithIdentity: jest.fn(async () => ({ ok: true })) };
});
jest.mock('../../../src/services/session-memory-buffer', () => {
  const actual = jest.requireActual('../../../src/services/session-memory-buffer');
  return { ...actual, addTurn: jest.fn() };
});
jest.mock('../../../src/services/redis-turn-buffer', () => {
  const actual = jest.requireActual('../../../src/services/redis-turn-buffer');
  return { ...actual, addTurnRedis: jest.fn(async () => undefined) };
});
jest.mock('../../../src/services/extraction-dedup-manager', () => {
  const actual = jest.requireActual('../../../src/services/extraction-dedup-manager');
  return { ...actual, deduplicatedExtract: jest.fn() };
});
jest.mock('../../../src/services/identity-intent-handler', () => {
  const actual = jest.requireActual('../../../src/services/identity-intent-handler');
  return { ...actual, handleIdentityIntent: jest.fn(async () => ({ handled: false })) };
});
jest.mock('../../../src/services/wake-cadence-signals', () => {
  const actual = jest.requireActual('../../../src/services/wake-cadence-signals');
  return { ...actual, recordWakeTurn: jest.fn(async () => undefined) };
});
jest.mock('../../../src/services/conversation/greeting-facts-ledger', () => {
  const actual = jest.requireActual('../../../src/services/conversation/greeting-facts-ledger');
  return { ...actual, recordGreetingUtterance: jest.fn(async () => undefined) };
});
jest.mock('../../../src/services/voice-quota-guard', () => ({
  reserveVoiceQuotaAtSessionStart: jest.fn(async () => ({
    feature: 'voice_live_minutes',
    paywall_action: 'allow',
    quota: 600,
    used: 0,
    remaining: 600,
    reset_at: null,
    start_on_standard_tier: false,
    deferred_for_vulnerability: false,
  })),
  recordVoiceMinute: jest.fn(async () => 0),
  triggerDowngrade: jest.fn(async () => undefined),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { __connectToLiveAPIForTest as connectToLiveAPI } from '../../../src/routes/orb-live';
import { buildVertexWakeBriefBlock } from '../../../src/orb/live/session/live-session-controller';
import {
  computeGreetingDecision,
  setNewdayOverviewRungEnabled,
  setDayCloseRungEnabled,
  type GreetingDecisionContext,
} from '../../../src/services/conversation/compute-greeting-decision';
import type { OverviewPayload } from '../../../src/services/assistant-continuation/providers/new-day-overview-payload';
import { PERSONA_DAY_30, PERSONA_DAY_180_RECONNECT } from '../live/characterization/personas';

// ---------------------------------------------------------------------------
// Determinism helpers
// ---------------------------------------------------------------------------

/** 2026-06-30 09:30 Europe/Berlin — a weekday morning, matching the greeting fixtures. */
const FROZEN_NOW = new Date('2026-06-30T07:30:00.000Z');

const NOT_DATE: Array<
  'hrtime' | 'nextTick' | 'performance' | 'queueMicrotask' | 'requestAnimationFrame' | 'cancelAnimationFrame'
  | 'requestIdleCallback' | 'cancelIdleCallback' | 'setImmediate' | 'clearImmediate' | 'setInterval'
  | 'clearInterval' | 'setTimeout' | 'clearTimeout'
> = [
  'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setInterval',
  'clearInterval', 'setTimeout', 'clearTimeout',
];

function freezeDate(): void {
  jest.useFakeTimers({ now: FROZEN_NOW, doNotFake: NOT_DATE });
}

function seedRandom(seed = 0x04542): () => void {
  let s = seed >>> 0;
  const spy = jest.spyOn(Math, 'random').mockImplementation(() => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  });
  return () => spy.mockRestore();
}

/** Record every timer created while `fn` runs; clear them all afterwards so a
 *  connect's keepalives/watchdogs never leak into the next scenario. */
async function withTrackedTimers<T>(fn: () => Promise<T>): Promise<T> {
  const g = global as any;
  const origSetInterval = g.setInterval;
  const origSetTimeout = g.setTimeout;
  const handles: any[] = [];
  g.setInterval = (...args: any[]) => { const h = origSetInterval(...args); handles.push(h); return h; };
  g.setTimeout = (...args: any[]) => { const h = origSetTimeout(...args); handles.push(h); return h; };
  try {
    return await fn();
  } finally {
    g.setInterval = origSetInterval;
    g.setTimeout = origSetTimeout;
    for (const h of handles) { clearInterval(h); clearTimeout(h); }
  }
}

const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

/** Env vars that change routing, budgets or prompt content. Every scenario
 *  starts from ALL of these unset, then sets only its own. */
const GATED_ENV = [
  'ORB_LIVE_PROVIDER',
  'NOVA_SONIC_ENABLED',
  'NOVA_SONIC_GLOBAL_ENABLED',
  'NOVA_TOOL_CATALOG_BYTE_BUDGET',
  'VERTEX_TOOL_CATALOG_BYTE_BUDGET',
  'ORB_TOOL_SELECTION_ENABLED',
  'ORB_CASCADED_VOICE_ENABLED',
  'VERTEX_SERBIAN_BRIDGE_ENABLED',
  'VERTEX_LIVE_UNAVAILABLE',
  'ORB_VERTEX_SHARED_HANDLERS',
  'ORB_LOG_NOVA_INSTRUCTION_DEBUG',
  'ORB_LIVE_ADVISOR_ENABLED',
  'FEATURE_VOICE_SPECULATION_ENV',
  'ECS_CONTAINER_METADATA_URI',
  'ECS_CONTAINER_METADATA_URI_V4',
  'K_SERVICE',
  'GEMINI_LIVE_TRANSPORT',
];

const GATED_ENV_PREFIX = /^(FEATURE_|ORB_|NOVA_|NOVA_SONIC_|VERTEX_|TTS_|GEMINI_|LIVEKIT_|WAKE_BRIEF_|GUIDED_|NAV_|VOICE_)/;

function withEnv(overrides: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};
  // Plus every flag-family variable present in the runner's environment, so a
  // CI or developer shell that happens to export one cannot shift a snapshot.
  const flagFamily = Object.keys(process.env).filter((k) => GATED_ENV_PREFIX.test(k));
  for (const k of [...GATED_ENV, ...flagFamily, ...Object.keys(overrides)]) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// ---------------------------------------------------------------------------
// Hash manifest (quick-diff companion to the full-text snapshot)
// ---------------------------------------------------------------------------

const MANIFEST_PATH = path.join(__dirname, 'vtid-04542-voice-payload-identity.hashes.json');
const manifest: Record<string, Record<string, unknown>> = {};

function isSnapshotUpdateRun(): boolean {
  const state = (expect.getState() as any).snapshotState;
  return process.env.VOICE_IDENTITY_UPDATE === '1' || state?._updateSnapshot === 'all';
}

// ---------------------------------------------------------------------------
// A. Connect-time payload (instruction + tool catalog) — real connectToLiveAPI
// ---------------------------------------------------------------------------

const CLIENT_CONTEXT_DE = {
  ip: '0.0.0.0',
  city: 'Berlin',
  country: 'DE',
  timezone: 'Europe/Berlin',
  localTime: 'Tuesday morning, 09:30',
  timeOfDay: 'morning',
  device: 'Desktop',
  browser: 'Chrome',
  os: 'macOS',
  isMobile: false,
  lang: 'de',
};
const CLIENT_CONTEXT_EN = { ...CLIENT_CONTEXT_DE, city: 'London', country: 'GB', timezone: 'Europe/London', localTime: 'Tuesday morning, 08:30', lang: 'en' };

const GUIDED_TOPIC_CONTENT = {
  topic_id: 'T001',
  topic_title: 'Vitanaland',
  voice_script: 'Vitanaland ist deine Langlebigkeits-Community und hilft dir dabei, gesünder zu leben.',
  explanation: { whatItIs: 'Eine Community', userBenefit: 'Du lernst', whenToUse: 'Täglich', tryThis: 'Schau rein' },
  practice_target: 'community',
  source: 'published',
};

function identity(over: Record<string, unknown> = {}) {
  return {
    user_id: '11111111-1111-4111-8111-111111111111',
    tenant_id: '22222222-2222-4222-8222-222222222222',
    vitana_id: '@guardrail1',
    email: 'guardrail@vitanatest.exafy.io',
    role: 'authenticated',
    aud: 'authenticated',
    exp: null,
    iat: null,
    exafy_admin: false,
    ...over,
  };
}

function baseSession(over: Record<string, unknown>): any {
  return {
    sessionId: 'live-vtid-04542',
    lang: 'en',
    voiceStyle: 'friendly, calm, empathetic',
    responseModalities: ['audio', 'text'],
    upstreamWs: null,
    sseResponse: null,
    active: true,
    createdAt: new Date(FROZEN_NOW),
    lastActivity: new Date(FROZEN_NOW),
    audioInChunks: 0,
    audioInForwarded: 0,
    videoInFrames: 0,
    audioOutChunks: 0,
    turn_count: 0,
    contextInstruction: '',
    transcriptTurns: [],
    outputTranscriptBuffer: '',
    pendingEventLinks: [],
    inputTranscriptBuffer: '',
    isModelSpeaking: false,
    turnCompleteAt: 0,
    identity: undefined,
    conversationSummary: undefined,
    active_role: undefined,
    lastAudioForwardedTime: FROZEN_NOW.getTime(),
    lastTelemetryEmitTime: 0,
    vadSilenceMs: 1200,
    greetingDeferred: false,
    lastSessionInfo: null,
    consecutiveModelTurns: 0,
    consecutiveToolCalls: 0,
    isAnonymous: false,
    clientContext: CLIENT_CONTEXT_EN,
    current_route: undefined,
    recent_routes: undefined,
    ...over,
  };
}

interface ConnectScenario {
  name: string;
  expectProvider: 'nova_sonic' | 'cascaded' | 'vertex';
  env?: Record<string, string>;
  session: () => any;
}

const CONNECT_SCENARIOS: ConnectScenario[] = [
  {
    name: 'anonymous-de',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'de',
      isAnonymous: true,
      clientContext: CLIENT_CONTEXT_DE,
      current_route: '/maxina',
    }),
  },
  {
    name: 'authenticated-community-de-first-day',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'de',
      identity: identity({ vitana_id: '@erstertag1' }),
      active_role: 'community',
      clientContext: CLIENT_CONTEXT_DE,
      current_route: '/home',
      recent_routes: ['/home'],
      contextInstruction: '\n\n[FACTS] Display name: Ana. Tenure: 0 days.\n[ACTIVITY_14D] First day on Vitanaland.',
      onboardingCohortBlock: '\n\n=== ONBOARDING COHORT (fixture) ===\nThis member joined today; the onboarding journey is at step 1.',
      greetingFirstName: 'Ana',
      lastSessionInfo: null,
    }),
  },
  {
    name: 'authenticated-community-en-returning',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'en',
      identity: identity({ vitana_id: '@vet180' }),
      active_role: 'community',
      current_route: '/health',
      recent_routes: ['/', '/intent', '/community'],
      contextInstruction: `\n\n${PERSONA_DAY_180_RECONNECT.bootstrapContext}`,
      conversationSummary: PERSONA_DAY_180_RECONNECT.conversationSummary,
      lastSessionInfo: { time: '2026-06-30T04:30:00.000Z', wasFailure: false },
      greetingFirstName: 'Alex',
      wakeBriefOverrideBlock: buildVertexWakeBriefBlock(
        'Good morning Alex — your sleep pillar climbed overnight. Shall we look at what helped?',
        'en',
        'newday:sleep_up',
      ),
    }),
  },
  {
    name: 'devon-specialist-en',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'en',
      identity: identity(),
      active_role: 'community',
      current_route: '/support',
      activePersona: 'devon',
      personaSystemOverride:
        'You are Devon, the Vitanaland technical support specialist (fixture prompt). ' +
        'Collect the details of the member\'s problem and keep the ticket updated.',
      personaForcedFirstMessage: 'Hi, Devon here from support.',
      personaFirstUtteranceDelivered: false,
    }),
  },
  {
    name: 'admin-surface-en',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'en',
      identity: identity({ vitana_id: '@admin1' }),
      active_role: 'admin',
      current_route: '/admin/users',
      recent_routes: ['/admin', '/admin/users'],
      contextInstruction: '\n\n[FACTS] Display name: Morgan.',
      greetingFirstName: 'Morgan',
    }),
  },
  {
    name: 'command-hub-developer-en',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'en',
      identity: identity({ vitana_id: '@dev1', exafy_admin: true }),
      active_role: 'developer',
      current_route: '/command-hub/tasks',
      recent_routes: ['/command-hub', '/command-hub/tasks'],
      greetingFirstName: 'Sam',
    }),
  },
  {
    name: 'guided-topic-de',
    expectProvider: 'nova_sonic',
    session: () => baseSession({
      lang: 'de',
      identity: identity(),
      active_role: 'community',
      clientContext: CLIENT_CONTEXT_DE,
      current_route: '/my-journey',
      contextInstruction: `\n\n${PERSONA_DAY_30.bootstrapContext}`,
      greetingFirstName: 'Ana',
      guided_topic_id: 'T001',
      guidedTopicNarrationContent: GUIDED_TOPIC_CONTENT,
      wakeBriefOverrideBlock: buildVertexWakeBriefBlock('Lass uns über Vitanaland sprechen.', 'de', 'guided_topic:T001'),
    }),
  },
  {
    name: 'cascade-ru',
    expectProvider: 'cascaded',
    env: { ORB_CASCADED_VOICE_ENABLED: 'true' },
    session: () => baseSession({
      lang: 'ru',
      identity: identity(),
      active_role: 'community',
      clientContext: { ...CLIENT_CONTEXT_EN, lang: 'ru', city: 'Riga', country: 'LV', timezone: 'Europe/Riga' },
      current_route: '/home',
      contextInstruction: '\n\n[FACTS] Display name: Olga.',
      greetingFirstName: 'Olga',
    }),
  },
  {
    name: 'vertex-serbian-bridge-sr',
    expectProvider: 'vertex',
    env: { VERTEX_SERBIAN_BRIDGE_ENABLED: 'true' },
    session: () => baseSession({
      lang: 'sr',
      identity: identity(),
      active_role: 'community',
      clientContext: { ...CLIENT_CONTEXT_EN, lang: 'sr', city: 'Belgrade', country: 'RS', timezone: 'Europe/Belgrade' },
      current_route: '/home',
      contextInstruction: '\n\n[FACTS] Display name: Milica.',
      greetingFirstName: 'Milica',
    }),
  },
];

type ToolGroup = { function_declarations?: Array<{ name?: string }>; google_search?: unknown };

function toolNames(tools: unknown): string[] {
  const names: string[] = [];
  for (const g of (Array.isArray(tools) ? tools : []) as ToolGroup[]) {
    if (g && Array.isArray(g.function_declarations)) {
      for (const d of g.function_declarations) if (typeof d?.name === 'string') names.push(d.name);
    } else if (g && typeof g === 'object' && 'google_search' in g) {
      names.push('__google_search__');
    } else {
      names.push(`__group:${Object.keys(g || {}).join('+')}__`);
    }
  }
  return names;
}

interface CapturedPayload {
  provider: string;
  voice: string | null;
  instruction: string;
  tools: unknown[];
}

async function captureConnectPayload(scenario: ConnectScenario): Promise<{ captured: CapturedPayload; session: any }> {
  const restoreEnv = withEnv(scenario.env ?? {});
  const restoreRandom = seedRandom();
  mockCaptured.connects = [];
  mockSupabaseHolder.current = null;
  const session = scenario.session();
  try {
    await withTrackedTimers(async () => {
      await connectToLiveAPI(
        session,
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
        () => undefined,
      );
    });
  } finally {
    restoreRandom();
    restoreEnv();
  }
  expect(mockCaptured.connects).toHaveLength(1);
  const c = mockCaptured.connects[0];
  if (c.provider === 'vertex') {
    const setup = c.options.envelope?.setup ?? {};
    return {
      session,
      captured: {
        provider: 'vertex',
        voice: setup.generation_config?.speech_config?.voice_config?.prebuilt_voice_config?.voice_name ?? null,
        instruction: setup.system_instruction?.parts?.[0]?.text ?? '',
        tools: Array.isArray(setup.tools) ? setup.tools : [],
      },
    };
  }
  return {
    session,
    captured: {
      provider: c.provider,
      voice: c.options.voiceName ?? null,
      instruction: c.options.systemInstruction ?? '',
      tools: Array.isArray(c.options.tools) ? c.options.tools : [],
    },
  };
}

describe('VTID-04542 A — connect-time payload identity (real connectToLiveAPI)', () => {
  beforeEach(() => {
    freezeDate();
    setNewdayOverviewRungEnabled(true);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(CONNECT_SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    const { captured, session } = await captureConnectPayload(scenario);

    expect(captured.provider).toBe(scenario.expectProvider);
    expect(session.upstreamProvider).toBe(scenario.expectProvider);
    expect(captured.instruction.length).toBeGreaterThan(0);

    const toolsJson = JSON.stringify(captured.tools);
    const names = toolNames(captured.tools);
    const summary = {
      provider: captured.provider,
      voice: captured.voice,
      instruction_sha256: sha256(captured.instruction),
      instruction_bytes: utf8Bytes(captured.instruction),
      tools_sha256: sha256(toolsJson),
      tools_bytes: utf8Bytes(toolsJson),
      tool_count: names.length,
      deferred_tools: session.deferredTools ? session.deferredTools.size : 0,
    };
    manifest[`connect:${scenario.name}`] = summary;

    expect(summary).toMatchSnapshot('summary');
    expect(names).toMatchSnapshot('tool names (in declared order)');
    expect(captured.instruction).toMatchSnapshot('system instruction (full text as sent)');
  });

  it('is deterministic — the same scenario twice yields byte-identical payloads', async () => {
    const s = CONNECT_SCENARIOS.find((x) => x.name === 'authenticated-community-en-returning')!;
    const a = await captureConnectPayload(s);
    const b = await captureConnectPayload(s);
    expect(sha256(a.captured.instruction)).toBe(sha256(b.captured.instruction));
    expect(sha256(JSON.stringify(a.captured.tools))).toBe(sha256(JSON.stringify(b.captured.tools)));
  });
});

// ---------------------------------------------------------------------------
// B. Greeting decision identity (computeGreetingDecision)
// ---------------------------------------------------------------------------
//
// Fixture builders follow test/services/conversation/compute-greeting-decision.golden.test.ts
// (same base context, same rich payload) so a divergence between the two
// suites is a signal, not noise. They are restated rather than imported
// because importing a test file would re-register its tests here.

function richPayload(over: Partial<OverviewPayload> = {}): OverviewPayload {
  return {
    journey: null,
    vitana_index: {
      state: 'ok',
      today: 200,
      tier: 'Early',
      tier_framing: null,
      trend_7d: 0,
      weakest_pillar: { name: 'nutrition', score: 30 },
      strongest_pillar: null,
      balance_label: 'balanced',
      pillars: null,
      projected_day_90: null,
      projected_day_90_tier: null,
    },
    life_compass: {
      state: 'set',
      primary_goal: 'longer life',
      category: null,
      target_date: null,
      target_value: null,
      target_unit: null,
      starting_value: null,
      set_at: null,
      days_to_deadline: null,
      goal_progress_pct: null,
    },
    calendar_today: { count: 0, next: null },
    calendar_passed: { count: 0, most_recent: null },
    autopilot: { state: 'none_yet', today_checkpoint: null, this_week: [], pending_total: 0 },
    matches_unread: 0,
    messages_unread: 0,
    reminders_today: { count: 0, next: null },
    diary_last_7d: 3,
    facts_learned_since_last: null,
    guided_journey: null,
    last_session_date_user_tz: null,
    ...over,
  } as OverviewPayload;
}

function greetCtx(over: Partial<GreetingDecisionContext> = {}): GreetingDecisionContext {
  return {
    contextReadyResolved: true,
    isAnonymous: false,
    safeFastGreetingLive: false,
    reconnectCount: 0,
    lang: 'de',
    greetLang: 'de',
    bucket: 'today',
    timeAgo: 'earlier today',
    wasFailure: false,
    firstName: 'Dragan',
    hasUserId: true,
    hasSupabase: true,
    hasPriorSession: true,
    greetingNeedsOnboarding: false,
    greetingIsFirstTime: false,
    lastFullBriefingDate: '2026-06-30',
    todayTz: '2026-06-30',
    localHour: 9,
    timezone: 'Europe/Berlin',
    timeOfDay: 'morning',
    proactiveLine: null,
    newdayOverview: null,
    resumeOverview: null,
    rotationSeed: 42,
    recentNbaKeys: [],
    currentRoute: null,
    currentScreenTitle: null,
    menuPhrases: ['Schön, dass du da bist.', 'Lass uns weitermachen.', 'Ich höre dir zu.'],
    openDecision: { mode: 'speak', source: 'baseline_lead', line: null },
    guidedTopicNarrationContent: null,
    wakeBriefDecisionId: null,
    silenceOnSkipEnabled: true,
    wakeBriefHasSelectedContinuation: false,
    voiceWakeBriefReason: null,
    nowIso: FROZEN_NOW.toISOString(),
    ...over,
  };
}

const safeFast = (over: Partial<GreetingDecisionContext> = {}) =>
  greetCtx({ contextReadyResolved: false, safeFastGreetingLive: true, ...over });

interface GreetingScenario {
  name: string;
  expectOpener: string;
  ctx: () => GreetingDecisionContext;
}

const GREETING_SCENARIOS: GreetingScenario[] = [
  {
    name: 'first_time_welcome (safe-fast)',
    expectOpener: 'safe_fast_first_time_welcome',
    ctx: () => safeFast({ hasPriorSession: false, greetingIsFirstTime: true, greetingNeedsOnboarding: true }),
  },
  {
    name: 'conv_resume',
    expectOpener: 'conv_resume',
    ctx: () => safeFast({
      bucket: 'recent',
      lastFullBriefingDate: '2026-06-30',
      resumeOverview: richPayload({ messages_unread: 2 }),
    }),
  },
  {
    name: 'newday_overview (safe-fast ladder)',
    expectOpener: 'safe_fast_newday_overview',
    ctx: () => safeFast({ lastFullBriefingDate: '2026-06-29', newdayOverview: richPayload() }),
  },
  {
    name: 'newday_overview (normal ladder)',
    expectOpener: 'newday_overview',
    ctx: () => greetCtx({ bucket: 'yesterday', lastFullBriefingDate: '2026-06-29', newdayOverview: richPayload() }),
  },
  {
    name: 'short-gap reconnect (legacy_default, bucket=reconnect)',
    expectOpener: 'legacy_default',
    ctx: () => greetCtx({ bucket: 'reconnect', reconnectCount: 1 }),
  },
  {
    name: 'silent reconnect (native resume)',
    expectOpener: 'silent_reconnect',
    ctx: () => greetCtx({ reconnectCount: 1, openDecision: { mode: 'silent', source: 'native_resume', line: null } }),
  },
  {
    name: 'guided topic (override_v2 guided)',
    expectOpener: 'override_v2',
    ctx: () => greetCtx({
      openDecision: { mode: 'speak', source: 'wake:guided', line: 'Lass uns über Vitanaland sprechen.' },
      guidedTopicNarrationContent: 'Vitanaland ist deine Langlebigkeits-Community.',
      wakeBriefDecisionId: 'wb-guided-T001',
      wakeBriefHasSelectedContinuation: true,
    }),
  },
  {
    name: 'support report',
    expectOpener: 'support_report',
    ctx: () => greetCtx({ supportReportOpen: true }),
  },
  {
    name: 'day_close (full)',
    expectOpener: 'day_close',
    ctx: () => greetCtx({
      localHour: 23,
      timeOfDay: 'night',
      lastFullBriefingDate: '2026-06-30',
      lastDayCloseDate: null,
      bucket: 'same_day',
      userId: 'user-abc',
    }),
  },
  {
    name: 'day_close (reduced retry)',
    expectOpener: 'day_close',
    ctx: () => greetCtx({
      localHour: 23,
      timeOfDay: 'night',
      lastFullBriefingDate: '2026-06-30',
      lastDayCloseDate: null,
      bucket: 'same_day',
      userId: 'user-abc',
      dayCloseReduced: true,
    }),
  },
  {
    name: 'override_v2 (wake-brief line)',
    expectOpener: 'override_v2',
    ctx: () => greetCtx({
      openDecision: { mode: 'speak', source: 'wake:teacher', line: 'Heute ist dein 12. Tag — bleiben wir dran.' },
      wakeBriefDecisionId: 'wb-123',
      wakeBriefHasSelectedContinuation: true,
    }),
  },
  {
    name: 'anonymous (legacy_default intro)',
    expectOpener: 'legacy_default',
    ctx: () => greetCtx({ isAnonymous: true, lang: 'en', greetLang: 'en', hasUserId: false, firstName: null }),
  },
];

describe('VTID-04542 B — greeting decision identity (computeGreetingDecision)', () => {
  let savedSwitches: { newday_overview: boolean; day_close: boolean };
  beforeAll(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../../src/services/conversation/compute-greeting-decision');
    savedSwitches = mod.wakeOpenerRungSwitches();
  });
  beforeEach(() => {
    freezeDate();
    setNewdayOverviewRungEnabled(true);
    setDayCloseRungEnabled(true);
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    setNewdayOverviewRungEnabled(savedSwitches.newday_overview);
    setDayCloseRungEnabled(savedSwitches.day_close);
  });

  it.each(GREETING_SCENARIOS.map((s) => [s.name, s] as const))('%s', (_name, scenario) => {
    const restoreRandom = seedRandom();
    let d;
    try {
      d = computeGreetingDecision(scenario.ctx());
    } finally {
      restoreRandom();
    }
    expect(d.wakeOpener).toBe(scenario.expectOpener);
    const directive = d.directive ?? '';
    manifest[`greeting:${scenario.name}`] = {
      wake_opener: d.wakeOpener,
      directive_sha256: d.directive == null ? null : sha256(directive),
      directive_bytes: d.directive == null ? 0 : utf8Bytes(directive),
    };
    expect({ wakeOpener: d.wakeOpener, register: (d as any).register ?? null, effects: d.effects, diag: d.diag }).toMatchSnapshot('decision');
    expect(d.directive).toMatchSnapshot('directive (full text)');
  });
});

// ---------------------------------------------------------------------------
// C. Memory / persistence write identity
// ---------------------------------------------------------------------------

import { handleTurnComplete } from '../../../src/orb/live/session/upstream-message-handler';
import {
  configureLiveSessionController,
  handleLiveSessionStart,
  __resetLiveSessionControllerForTests,
  type LiveSessionControllerDeps,
} from '../../../src/orb/live/session/live-session-controller';
import { liveSessions, sessions as sseSessions, wsClientSessions } from '../../../src/orb/live/session/live-session-registry';
import { writeMemoryItemWithIdentity } from '../../../src/services/orb-memory-bridge';
import { addTurn as addSessionTurn } from '../../../src/services/session-memory-buffer';
import { addTurnRedis } from '../../../src/services/redis-turn-buffer';
import { deduplicatedExtract } from '../../../src/services/extraction-dedup-manager';
import { handleIdentityIntent } from '../../../src/services/identity-intent-handler';
import { recordWakeTurn } from '../../../src/services/wake-cadence-signals';
import { recordGreetingUtterance } from '../../../src/services/conversation/greeting-facts-ledger';
import { emitOasisEvent } from '../../../src/services/oasis-event-service';
import { reserveVoiceQuotaAtSessionStart } from '../../../src/services/voice-quota-guard';

const WRITE_OPS = new Set(['insert', 'upsert', 'update', 'delete']);

/** A supabase-js shaped fake that records every write (table + op + payload)
 *  and every rpc; every read resolves `{ data: null, error: null }`. */
function makeRecordingSupabase() {
  const writes: Array<{ table: string; op: string; payload: unknown; filters: unknown[] }> = [];
  const rpcs: Array<{ fn: string; args: unknown }> = [];
  const reads = new Set<string>();
  const result = { data: null, error: null, count: 0, status: 200 };

  function chain(table: string): any {
    let write: { table: string; op: string; payload: unknown; filters: unknown[] } | null = null;
    const target: any = {};
    const proxy: any = new Proxy(target, {
      get(_t, prop: string | symbol) {
        if (prop === 'then') {
          return (res: any, rej: any) => Promise.resolve(result).then(res, rej);
        }
        if (typeof prop !== 'string') return undefined;
        return (...args: unknown[]) => {
          if (WRITE_OPS.has(prop)) {
            write = { table, op: prop, payload: args[0], filters: [] };
            writes.push(write);
          } else if (write && ['eq', 'neq', 'in', 'is', 'match', 'filter'].includes(prop)) {
            write.filters.push([prop, ...args]);
          } else if (prop === 'select' && !write) {
            reads.add(table);
          }
          return proxy;
        };
      },
    });
    return proxy;
  }

  const client: any = {
    from: (table: string) => chain(table),
    rpc: (fn: string, args: unknown) => {
      rpcs.push({ fn, args });
      return chain(`rpc:${fn}`);
    },
    schema: () => client,
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
    storage: { from: () => chain('storage') },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}) }),
    removeChannel: () => undefined,
  };
  return { client, writes, rpcs, reads };
}

/** Replace live objects (supabase clients, sessions) with stable tokens. */
function scrub(value: unknown, supa: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (v === supa) return '<supabase>';
      if (typeof v === 'function') return '<fn>';
      return v;
    }),
  );
}

/** Record every non-GET `fetch` (raw PostgREST writes bypass supabase-js)
 *  while `fn` runs; the global fetch mock from setup-tests still answers. */
async function withRecordedFetchWrites<T>(fn: () => Promise<T>): Promise<{ result: T; writes: string[] }> {
  const g = global as any;
  const orig = g.fetch;
  const writes: string[] = [];
  g.fetch = (url: any, opts?: any) => {
    const method = String(opts?.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      const raw = typeof url === 'string' ? url : String(url?.url ?? url);
      let pathOnly = raw;
      try { pathOnly = new URL(raw).pathname; } catch { /* relative */ }
      writes.push(`${method} ${pathOnly}`);
    }
    return orig(url, opts);
  };
  try {
    const result = await fn();
    return { result, writes };
  } finally {
    g.fetch = orig;
  }
}

const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
};

function turnSession(over: Record<string, unknown> = {}): any {
  return {
    sessionId: 'live-vtid-04542-turn',
    conversation_id: 'conv-vtid-04542',
    active: true,
    lang: 'de',
    isModelSpeaking: true,
    audioOutChunks: 12,
    turn_count: 1,
    consecutiveModelTurns: 0,
    consecutiveToolCalls: 0,
    greetingSent: true,
    greetingTurnIndex: 0,
    inputTranscriptBuffer: '',
    outputTranscriptBuffer: '',
    transcriptTurns: [
      { role: 'assistant', text: 'Guten Morgen Ana — schön, dass du da bist.', timestamp: FROZEN_NOW.toISOString(), persona: 'vitana' },
    ],
    pendingEventLinks: [],
    lastAudioForwardedTime: FROZEN_NOW.getTime(),
    createdAt: new Date(FROZEN_NOW),
    identity: identity(),
    active_role: 'community',
    isAnonymous: false,
    sseResponse: null,
    clientWs: null,
    navigationDispatched: false,
    pendingNavigation: undefined,
    upstreamProvider: 'nova_sonic',
    current_route: '/home',
    ...over,
  };
}

function turnDeps() {
  return {
    clearResponseWatchdog: jest.fn(),
    detectAuthIntent: jest.fn().mockReturnValue(null),
    detectStillHereComplaint: jest.fn().mockReturnValue(false),
    dispatchEndConversationDirective: jest.fn(),
    emitDiag: jest.fn(),
    emitLiveSessionEvent: jest.fn().mockResolvedValue(undefined),
    executeLiveApiTool: jest.fn().mockResolvedValue({ success: true, result: '{}' }),
    isDevSandbox: jest.fn().mockReturnValue(false),
    sendAudioToLiveAPI: jest.fn().mockReturnValue(true),
    sendFunctionResponseToLiveAPI: jest.fn().mockReturnValue(true),
    sendWsMessage: jest.fn(),
    markVoiceLatency: jest.fn(),
    finalizeVoiceTurnLatency: jest.fn(),
    startResponseWatchdog: jest.fn(),
  };
}

const PERSISTENCE_SPIES = {
  writeMemoryItemWithIdentity: writeMemoryItemWithIdentity as unknown as jest.Mock,
  addSessionTurn: addSessionTurn as unknown as jest.Mock,
  addTurnRedis: addTurnRedis as unknown as jest.Mock,
  deduplicatedExtract: deduplicatedExtract as unknown as jest.Mock,
  handleIdentityIntent: handleIdentityIntent as unknown as jest.Mock,
  recordWakeTurn: recordWakeTurn as unknown as jest.Mock,
  recordGreetingUtterance: recordGreetingUtterance as unknown as jest.Mock,
};

function persistenceCalls(supa: unknown) {
  const out: Record<string, unknown> = {};
  for (const [name, spy] of Object.entries(PERSISTENCE_SPIES)) {
    out[name] = scrub(spy.mock.calls, supa);
  }
  return out;
}

interface TurnScenario {
  name: string;
  session: () => any;
}

const TURN_SCENARIOS: TurnScenario[] = [
  {
    name: 'greeting turn (first assistant turn, no user speech)',
    session: () => turnSession({
      turn_count: 0,
      transcriptTurns: [],
      outputTranscriptBuffer: 'Guten Morgen Ana — schön, dass du da bist. Sollen wir mit deinem Schlaf weitermachen?',
    }),
  },
  {
    name: 'regular turn (user + assistant, authenticated)',
    session: () => turnSession({
      turn_count: 1,
      inputTranscriptBuffer: 'Ich habe letzte Nacht nur fünf Stunden geschlafen und fühle mich müde.',
      outputTranscriptBuffer: 'Das klingt anstrengend. Magst du, dass ich deinen Schlaf heute Abend im Blick behalte?',
    }),
  },
  {
    name: 'regular turn (anonymous, no identity)',
    session: () => turnSession({
      identity: undefined,
      isAnonymous: true,
      active_role: undefined,
      turn_count: 1,
      inputTranscriptBuffer: 'What is Vitanaland and how does it work for me?',
      outputTranscriptBuffer: 'Vitanaland is a longevity community — shall I show you around?',
    }),
  },
];

describe('VTID-04542 C1 — per-turn persistence identity (handleTurnComplete)', () => {
  beforeEach(() => {
    freezeDate();
    for (const spy of Object.values(PERSISTENCE_SPIES)) spy.mockClear();
    (emitOasisEvent as unknown as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
    mockSupabaseHolder.current = null;
  });

  it.each(TURN_SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    const restoreEnv = withEnv({});
    const restoreRandom = seedRandom();
    const rec = makeRecordingSupabase();
    mockSupabaseHolder.current = rec.client;
    const session = scenario.session();
    const client = {
      close: jest.fn(async () => undefined),
      applyPersona: jest.fn(),
    } as any;
    const callbacks = {
      onAudioResponse: jest.fn(),
      onTextResponse: jest.fn(),
      onError: jest.fn(),
      onTurnComplete: jest.fn(),
      onInterrupted: jest.fn(),
    };
    let fetchWrites: string[] = [];
    try {
      fetchWrites = (await withRecordedFetchWrites(() => withTrackedTimers(async () => {
        handleTurnComplete({ session, client, callbacks, deps: turnDeps() as any } as any, {} as any);
        await flush();
      }))).writes;
    } finally {
      restoreRandom();
      restoreEnv();
    }

    const snapshot = {
      persistence: persistenceCalls(rec.client),
      supabase_writes: scrub(rec.writes, rec.client),
      supabase_rpcs: scrub(rec.rpcs, rec.client),
      http_non_get: fetchWrites,
      oasis_event_types: (emitOasisEvent as unknown as jest.Mock).mock.calls.map((c) => (c[0] as any)?.type ?? null),
      transcript_turns_after: scrub(session.transcriptTurns, rec.client),
    };
    manifest[`turn:${scenario.name}`] = { sha256: sha256(JSON.stringify(snapshot)) };
    expect(snapshot).toMatchSnapshot('writes');
  });
});

// Session start — the persistence side effects of /live/session/start.
// Harness mirrors test/orb/live/session/live-session-controller.test.ts's
// baseDeps(); every deps callback that writes is recorded.
function sessionStartDeps(recorder: Array<[string, unknown[]]>): LiveSessionControllerDeps {
  const rec = (name: string, ret: unknown) => (...args: unknown[]) => {
    recorder.push([name, args]);
    return ret;
  };
  return {
    // The real resolver re-reads the JWT identity; the fixture hands back what
    // optionalAuth put on the request.
    resolveOrbIdentity: async (req: any) => req.identity ?? null,
    clearResponseWatchdog: () => undefined,
    sendEndOfTurn: () => true,
    validateOrigin: () => true,
    buildClientContext: async () => ({ ...CLIENT_CONTEXT_DE } as any),
    normalizeLang: (l) => l || 'en',
    getVoiceForLang: () => 'Aoede',
    getStoredLanguagePreference: async () => null,
    persistLanguagePreference: rec('persistLanguagePreference', undefined) as any,
    fetchLastSessionInfo: async () => ({ time: '2026-06-30T04:30:00.000Z', wasFailure: false }),
    fetchOnboardingCohortBlock: async () => '',
    buildBootstrapContextPack: async () => ({
      contextInstruction: '\n\n[FACTS] Display name: Ana.',
      contextPack: undefined,
      latencyMs: 0,
      skippedReason: undefined,
    }),
    resolveEffectiveRole: async () => 'community',
    terminateExistingSessionsForUser: rec('terminateExistingSessionsForUser', 0) as any,
    emitLiveSessionEvent: (async (type: string) => { recorder.push(['emitLiveSessionEvent', [type]]); }) as any,
    describeTimeSince: () => ({ bucket: 'today', wasFailure: false }),
    sendAudioToLiveAPI: () => true,
    startResponseWatchdog: () => undefined,
    emitDiag: () => undefined,
    getGoogleAuthReady: () => true,
  };
}

interface StartScenario {
  name: string;
  req: () => any;
}

const START_SCENARIOS: StartScenario[] = [
  {
    name: 'anonymous de',
    req: () => ({ identity: undefined, headers: {}, body: { lang: 'de', current_route: '/maxina' }, query: {} }),
  },
  {
    name: 'authenticated community de',
    req: () => ({
      identity: identity(),
      headers: { authorization: 'Bearer test-token' },
      body: { lang: 'de', current_route: '/home', conversation_id: 'conv-vtid-04542' },
      query: {},
    }),
  },
];

describe('VTID-04542 C2 — session-start persistence identity (handleLiveSessionStart)', () => {
  beforeEach(() => {
    // The session-start background work measures elapsed time against
    // Date.now(); a clock frozen solid would never let its bounded waits
    // expire. Start the clock at FROZEN_NOW and let it run in real time.
    jest.useFakeTimers({ now: FROZEN_NOW, advanceTimers: true });
    __resetLiveSessionControllerForTests();
    liveSessions.clear();
    sseSessions.clear();
    wsClientSessions.clear();
    for (const spy of Object.values(PERSISTENCE_SPIES)) spy.mockClear();
    (reserveVoiceQuotaAtSessionStart as unknown as jest.Mock).mockClear();
  });
  afterEach(() => {
    jest.useRealTimers();
    mockSupabaseHolder.current = null;
    __resetLiveSessionControllerForTests();
    liveSessions.clear();
    sseSessions.clear();
    wsClientSessions.clear();
  });

  it.each(START_SCENARIOS.map((s) => [s.name, s] as const))('%s', async (_name, scenario) => {
    const restoreEnv = withEnv({});
    const restoreRandom = seedRandom();
    const rec = makeRecordingSupabase();
    mockSupabaseHolder.current = rec.client;
    const depCalls: Array<[string, unknown[]]> = [];
    configureLiveSessionController(sessionStartDeps(depCalls));
    const res: any = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    let status: unknown;
    let fetchWrites: string[] = [];
    let createdSession: any;
    let hadContextPromise = false;
    try {
      fetchWrites = (await withRecordedFetchWrites(() => withTrackedTimers(async () => {
        await handleLiveSessionStart(scenario.req(), res);
        const payload = res.json.mock.calls[0]?.[0] as any;
        const created = payload?.session_id ? liveSessions.get(payload.session_id) : undefined;
        createdSession = created;
        const ready = (created as any)?.contextReadyPromise as Promise<void> | undefined;
        hadContextPromise = !!ready;
        if (ready) {
          await Promise.race([ready.catch(() => undefined), new Promise((r) => setTimeout(r, 5000))]);
        }
        await flush(10);
      }))).writes;
      status = res.status.mock.calls[0]?.[0];
    } finally {
      restoreRandom();
      restoreEnv();
    }

    expect(status).toBe(200);
    // Tables written (and how) — the set, not the order: background work
    // overlaps, so the ORDER of independent writes is not a contract.
    const tableWrites = Array.from(new Set(rec.writes.map((w) => `${w.table}:${w.op}`))).sort();
    const rpcNames = Array.from(new Set(rec.rpcs.map((r) => r.fn))).sort();
    const depWrites = Array.from(
      new Set(depCalls.map(([name, args]) => (name === 'emitLiveSessionEvent' ? `${name}:${String(args[0])}` : name))),
    ).sort();
    const snapshot = {
      table_writes: tableWrites,
      rpcs: rpcNames,
      http_non_get: Array.from(new Set(fetchWrites)).sort(),
      dep_side_effects: depWrites,
      voice_quota_reserved: (reserveVoiceQuotaAtSessionStart as unknown as jest.Mock).mock.calls.length,
      memory_writes: (PERSISTENCE_SPIES.writeMemoryItemWithIdentity.mock.calls.length),
      session: {
        is_anonymous: !!createdSession?.isAnonymous,
        has_identity: !!createdSession?.identity,
        active_role: createdSession?.active_role ?? null,
        had_context_ready_promise: hadContextPromise,
        context_instruction_sha256: sha256(String(createdSession?.contextInstruction ?? '')),
      },
    };
    manifest[`session_start:${scenario.name}`] = { sha256: sha256(JSON.stringify(snapshot)) };
    expect(snapshot).toMatchSnapshot('writes');
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Hash manifest check — runs last (jest runs a file's tests in order).
// ---------------------------------------------------------------------------

describe('VTID-04542 — hash manifest', () => {
  it('matches the committed quick-diff manifest (regenerated with -u)', () => {
    const keys = Object.keys(manifest).sort();
    expect(keys.length).toBeGreaterThan(0);
    const current: Record<string, Record<string, unknown>> = {};
    for (const k of keys) current[k] = manifest[k];
    if (isSnapshotUpdateRun() || !fs.existsSync(MANIFEST_PATH)) {
      let stored: Record<string, unknown> = {};
      try { stored = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { /* first write */ }
      const merged: Record<string, unknown> = { ...stored, ...current };
      const ordered: Record<string, unknown> = {};
      for (const k of Object.keys(merged).sort()) ordered[k] = merged[k];
      fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(ordered, null, 2)}\n`);
      return;
    }
    const stored = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>;
    // Only the scenarios that ran (a `-t` filter runs a subset).
    const storedSubset: Record<string, unknown> = {};
    for (const k of keys) storedSubset[k] = stored[k];
    expect(current).toEqual(storedSubset);
  });
});
