/**
 * Tests for src/routes/orb-livekit.ts (VTID-LIVEKIT-FOUNDATION) — Phase 7
 * (Voice/ORB tools) of docs/TEST_COVERAGE_PLAN.md.
 *
 * This is the LiveKit WebRTC transport route for ORB — the sibling of the
 * Gemini/Nova WebSocket path in orb-live.ts (tested separately; not touched
 * here). Endpoints covered:
 *
 *   GET  /orb/active-provider                 per-identity canary-aware resolution
 *   POST /orb/active-provider                 admin flip + cooldown + nova gate
 *   GET  /orb/nova-sonic/health                secret-free config surface
 *   POST /orb/livekit/token                    LiveKit room JWT mint
 *   GET  /orb/livekit/health                   LiveKit + agent reachability probe
 *   GET  /orb/livekit/sessions/health           admin-only session-health summary
 *   GET  /orb/context-bootstrap                 shared context fetcher (huge handler)
 *   GET  /voice-providers                       provider registry
 *   POST /voice-providers/:id/test              per-provider reachability ping
 *   GET  /agents/:id/voice-config                per-agent provider trio (read)
 *   PUT  /agents/:id/voice-config                per-agent provider trio (write)
 *   POST /agents/:id/voice-config/test-session   ephemeral test token
 *   POST /orb/session/commit-memory              LiveKit session-end memory commit
 *
 * Given production failure-rate skew toward ORB/voice (>70% per the task
 * brief), this suite weights token-mint failure modes, provider-flip gating,
 * agent-unreachable probes, and context-bootstrap degrade-gracefully paths
 * at least as heavily as happy-path coverage.
 *
 * Mocking strategy: every sibling service/module orb-livekit.ts imports is
 * mocked wholesale at the module boundary (livekit-server-sdk, supabase,
 * oasis-event-service, session-memory-commit, wake-decision-snapshot,
 * awareness-unified-context, ./orb-live [huge 15k-line sibling file under
 * test elsewhere — never touched here], live-system-instruction,
 * journey-guide-prompt, guided-topic-narration-prompt, livekit-canary-config,
 * livekit-agent-config, wake-brief-wiring, temporal-bucket,
 * memory-facts-service, decision-contract/*, compile-assistant-decision-
 * context, decision-contract-renderer, new-day-overview-payload,
 * wake-cadence-signals). Left REAL (pure, no DB/heavy deps): the auth
 * middleware (auth-supabase-jwt — this IS the security boundary under test),
 * jose (real JWT sign/verify), active-provider-resolver (pure resolution
 * policy), nova-sonic-config (pure env parsing), and
 * livekit-session-health (pure summarisation math).
 */

import request from 'supertest';
import express from 'express';
import * as jose from 'jose';

// ---------------------------------------------------------------------------
// livekit-server-sdk mock — captures constructor args + grants, controllable
// toJwt() output/failure per test.
// ---------------------------------------------------------------------------
const mockAddGrant = jest.fn();
const mockToJwt = jest.fn(async () => 'mock.livekit.jwt');
const mockAccessTokenCtor = jest.fn();
jest.mock('livekit-server-sdk', () => ({
  AccessToken: jest.fn().mockImplementation((apiKey: string, apiSecret: string, options: any) => {
    mockAccessTokenCtor(apiKey, apiSecret, options);
    return {
      addGrant: mockAddGrant,
      toJwt: mockToJwt,
    };
  }),
}));

// ---------------------------------------------------------------------------
// Supabase — generic per-table chain mock (same pattern as
// test/routes/tenant-admin/overview.test.ts).
// ---------------------------------------------------------------------------
const createChain = () => {
  const responseQueue: any[] = [];
  let defaultData: any = { data: null, error: null };

  const chain: any = {
    select: jest.fn(() => chain),
    insert: jest.fn(() => chain),
    update: jest.fn(() => chain),
    upsert: jest.fn(() => chain),
    delete: jest.fn(() => chain),
    order: jest.fn(() => chain),
    eq: jest.fn(() => chain),
    gte: jest.fn(() => chain),
    gt: jest.fn(() => chain),
    lt: jest.fn(() => chain),
    in: jest.fn(() => chain),
    is: jest.fn(() => chain),
    limit: jest.fn(() => chain),
    single: jest.fn(() => chain),
    maybeSingle: jest.fn(() => chain),
    then: jest.fn((resolve: (v: any) => any, reject?: (e: any) => any) => {
      const value = responseQueue.length > 0 ? responseQueue.shift() : defaultData;
      if (value && value.__throw) {
        return Promise.reject(value.__throw).catch(reject || (() => {}));
      }
      return Promise.resolve(value).then(resolve, reject);
    }),
    mockResolvedValue(v: any) {
      defaultData = v;
      return chain;
    },
    mockResolvedValueOnce(v: any) {
      responseQueue.push(v);
      return chain;
    },
    mockRejectedValueOnce(e: any) {
      responseQueue.push({ __throw: e });
      return chain;
    },
    mockReset() {
      responseQueue.length = 0;
      defaultData = { data: null, error: null };
    },
  };

  return chain;
};

const tableChains: Record<string, ReturnType<typeof createChain>> = {};
const chainFor = (table: string) => (tableChains[table] ??= createChain());

const mockSupabase = { from: jest.fn((table: string) => chainFor(table)) };
const mockGetSupabase = jest.fn(() => mockSupabase as any);

jest.mock('../../src/lib/supabase', () => ({
  getSupabase: () => mockGetSupabase(),
}));

// ---------------------------------------------------------------------------
// OASIS / memory-commit
// ---------------------------------------------------------------------------
const mockEmitOasisEvent = jest.fn().mockResolvedValue({ ok: true });
jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: (...args: any[]) => mockEmitOasisEvent(...args),
}));

const mockCommitSessionMemory = jest.fn();
jest.mock('../../src/services/session-memory-commit', () => ({
  commitSessionMemory: (...args: any[]) => mockCommitSessionMemory(...args),
}));

// ---------------------------------------------------------------------------
// Wake-decision snapshot (telemetry-only — never affects response shape)
// ---------------------------------------------------------------------------
const mockLogWakeDecisionSnapshot = jest.fn();
jest.mock('../../src/orb/live/instruction/wake-decision-snapshot', () => ({
  logWakeDecisionSnapshot: (...args: any[]) => mockLogWakeDecisionSnapshot(...args),
}));

// ---------------------------------------------------------------------------
// awareness-unified-context — resolveSpokenFirstName
// ---------------------------------------------------------------------------
const mockResolveSpokenFirstName = jest.fn(
  ({ memoryFactUserName, displayName, email }: any) => {
    if (memoryFactUserName) return { firstName: memoryFactUserName.split(/\s+/)[0], source: 'memory_facts' };
    if (displayName) return { firstName: displayName.split(/\s+/)[0], source: 'app_users' };
    if (email) return { firstName: email.split('@')[0], source: 'email' };
    return { firstName: null, source: 'none' };
  },
);
jest.mock('../../src/services/awareness-unified-context', () => ({
  resolveSpokenFirstName: (...args: any[]) => mockResolveSpokenFirstName(...args),
}));

// ---------------------------------------------------------------------------
// ./orb-live — huge sibling file (15k lines, tested elsewhere). Mocked
// wholesale at the module boundary; never touched/imported for real here.
// ---------------------------------------------------------------------------
const mockBuildBootstrapContextPack = jest.fn().mockResolvedValue(null);
const mockBuildClientContext = jest.fn().mockResolvedValue(null);
const mockFormatClientContextForInstruction = jest.fn().mockReturnValue('');
const mockBuildPersonaBehavioralRule = jest.fn().mockReturnValue('[BEHAVIORAL RULE]');
const mockBuildSpecialistLanguageDirective = jest.fn().mockReturnValue('[LANG DIRECTIVE]');
const mockFetchSpecialistContextSection = jest.fn().mockResolvedValue('');
jest.mock('../../src/routes/orb-live', () => ({
  buildBootstrapContextPack: (...args: any[]) => mockBuildBootstrapContextPack(...args),
  buildClientContext: (...args: any[]) => mockBuildClientContext(...args),
  formatClientContextForInstruction: (...args: any[]) => mockFormatClientContextForInstruction(...args),
  buildPersonaBehavioralRule: (...args: any[]) => mockBuildPersonaBehavioralRule(...args),
  buildSpecialistLanguageDirective: (...args: any[]) => mockBuildSpecialistLanguageDirective(...args),
  fetchSpecialistContextSection: (...args: any[]) => mockFetchSpecialistContextSection(...args),
}));

// ---------------------------------------------------------------------------
// live-system-instruction — buildLiveSystemInstruction
// ---------------------------------------------------------------------------
const mockBuildLiveSystemInstruction = jest.fn().mockReturnValue('MOCK_SYSTEM_INSTRUCTION');
jest.mock('../../src/orb/live/instruction/live-system-instruction', () => ({
  buildLiveSystemInstruction: (...args: any[]) => mockBuildLiveSystemInstruction(...args),
  describeTimeSince: jest.fn(),
}));

// ---------------------------------------------------------------------------
// journey-guide-prompt / guided-topic-narration-prompt
// ---------------------------------------------------------------------------
const mockBuildJourneyGuideBlock = jest.fn().mockReturnValue('[JOURNEY GUIDE BLOCK]');
jest.mock('../../src/orb/live/instruction/journey-guide-prompt', () => ({
  buildJourneyGuideBlock: (...args: any[]) => mockBuildJourneyGuideBlock(...args),
  buildJourneyGuideOpenerLine: jest.fn(),
}));

const mockBuildGuidedTopicNarrationBlock = jest.fn().mockReturnValue('[GUIDED TOPIC BLOCK]');
jest.mock('../../src/orb/live/instruction/guided-topic-narration-prompt', () => ({
  buildGuidedTopicNarrationBlock: (...args: any[]) => mockBuildGuidedTopicNarrationBlock(...args),
  buildGuidedTopicNarrationOpenerLine: jest.fn(),
  buildGuidedTopicSpokenLesson: jest.fn(),
}));

// ---------------------------------------------------------------------------
// LiveKit canary / agent readiness
// ---------------------------------------------------------------------------
const mockGetLiveKitCanaryConfig = jest.fn().mockResolvedValue({
  enabled: false,
  allowedTenants: [],
  allowedUsers: [],
});
jest.mock('../../src/orb/live/upstream/livekit-canary-config', () => ({
  getLiveKitCanaryConfig: (...args: any[]) => mockGetLiveKitCanaryConfig(...args),
  invalidateLiveKitCanaryConfigCache: jest.fn(),
}));

const mockGetLiveKitAgentReadiness = jest.fn().mockResolvedValue({ enabled: false });
jest.mock('../../src/orb/live/upstream/livekit-agent-config', () => ({
  getLiveKitAgentReadiness: (...args: any[]) => mockGetLiveKitAgentReadiness(...args),
}));

// ---------------------------------------------------------------------------
// wake-brief-wiring / temporal-bucket
// ---------------------------------------------------------------------------
const mockDecideWakeBriefForSession = jest.fn().mockResolvedValue(null);
jest.mock('../../src/services/wake-brief-wiring', () => ({
  decideWakeBriefForSession: (...args: any[]) => mockDecideWakeBriefForSession(...args),
  ensureWakeBriefProviderRegistered: jest.fn(),
}));

const mockFetchLastSessionInfo = jest.fn().mockResolvedValue(null);
const mockDescribeTimeSince = jest.fn().mockReturnValue({ bucket: 'same_day', was_failure: false });
jest.mock('../../src/services/guide/temporal-bucket', () => ({
  fetchLastSessionInfo: (...args: any[]) => mockFetchLastSessionInfo(...args),
  describeTimeSince: (...args: any[]) => mockDescribeTimeSince(...args),
  deriveMotivationSignal: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamically-imported modules from inside the context-bootstrap handler.
// ---------------------------------------------------------------------------
const mockGetCurrentFacts = jest.fn().mockResolvedValue({ ok: true, facts: [] });
jest.mock('../../src/services/memory-facts-service', () => ({
  getCurrentFacts: (...args: any[]) => mockGetCurrentFacts(...args),
}));

const mockPolicyResolverGetValue = jest.fn().mockReturnValue(null);
jest.mock('../../src/services/decision-contract/policy-resolver', () => ({
  getPolicyResolver: () => ({ getValue: (...args: any[]) => mockPolicyResolverGetValue(...args) }),
}));
jest.mock('../../src/services/decision-contract/policy-keys', () => ({
  POLICY_KEYS: { VOICE_CASCADE_DEFAULT: 'voice.cascade.default' },
}));

const mockCompileAssistantDecisionContext = jest.fn().mockResolvedValue(null);
jest.mock('../../src/orb/context/compile-assistant-decision-context', () => ({
  compileAssistantDecisionContext: (...args: any[]) => mockCompileAssistantDecisionContext(...args),
}));

const mockRenderDecisionContract = jest.fn().mockReturnValue('');
jest.mock('../../src/orb/live/instruction/decision-contract-renderer', () => ({
  renderDecisionContract: (...args: any[]) => mockRenderDecisionContract(...args),
}));

const mockFetchGuidedJourney = jest.fn().mockResolvedValue(null);
const mockBuildGuidedJourneyStandingInstruction = jest.fn().mockReturnValue('');
jest.mock('../../src/services/assistant-continuation/providers/new-day-overview-payload', () => ({
  fetchGuidedJourney: (...args: any[]) => mockFetchGuidedJourney(...args),
  buildGuidedJourneyStandingInstruction: (...args: any[]) => mockBuildGuidedJourneyStandingInstruction(...args),
}));

const mockFetchWakeCadenceSignals = jest.fn().mockResolvedValue({});
const mockRecordWakeSessionStart = jest.fn().mockResolvedValue(undefined);
jest.mock('../../src/services/wake-cadence-signals', () => ({
  fetchWakeCadenceSignals: (...args: any[]) => mockFetchWakeCadenceSignals(...args),
  recordWakeSessionStart: (...args: any[]) => mockRecordWakeSessionStart(...args),
}));

// ---------------------------------------------------------------------------
// Environment — set BEFORE requiring the router (module-level consts read
// process.env once, but per-request env reads happen live so most of this
// is just sane defaults).
// ---------------------------------------------------------------------------
const JWT_SECRET = 'test-orb-livekit-jwt-secret';
process.env.SUPABASE_JWT_SECRET = JWT_SECRET;
process.env.SUPABASE_URL = 'http://localhost:54321';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const router = require('../../src/routes/orb-livekit').default;

const app = express();
app.use(express.json());
app.use('/api/v1', router);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let uidCounter = 0;
/** Fresh UUID-shaped user id per call — sidesteps auth middleware's 5-min
 * in-process resolveVitanaId cache bleeding between unrelated tests. */
function freshUserId(): string {
  uidCounter += 1;
  return `11111111-1111-4111-8111-${String(uidCounter).padStart(12, '0')}`;
}

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function signToken(opts: {
  sub: string;
  tenantId?: string | null;
  exafyAdmin?: boolean;
  email?: string | null;
}): Promise<string> {
  const key = new TextEncoder().encode(JWT_SECRET);
  const now = Math.floor(Date.now() / 1000);
  return await new jose.SignJWT({
    aud: 'authenticated',
    role: 'authenticated',
    email: opts.email ?? 'caller@example.com',
    app_metadata: {
      active_tenant_id: opts.tenantId ?? TENANT_A,
      exafy_admin: opts.exafyAdmin === true,
    },
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
}

function setLiveKitEnv() {
  process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
  process.env.LIVEKIT_API_KEY = 'test-api-key';
  process.env.LIVEKIT_API_SECRET = 'test-api-secret';
}
function clearLiveKitEnv() {
  delete process.env.LIVEKIT_URL;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
}

/** Configure readActiveProvider()'s underlying system_config row. */
function mockActiveProviderRow(
  provider: 'vertex' | 'livekit' | 'nova_sonic' | null,
  opts: { updated_at?: string | null; updated_by?: string | null } = {},
) {
  if (provider === null) {
    chainFor('system_config').mockResolvedValueOnce({ data: null, error: null });
  } else {
    chainFor('system_config').mockResolvedValueOnce({
      data: { value: provider, updated_at: opts.updated_at ?? null, updated_by: opts.updated_by ?? null },
      error: null,
    });
  }
}

describe('orb-livekit routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const chain of Object.values(tableChains)) chain.mockReset();
    mockGetSupabase.mockReturnValue(mockSupabase as any);
    mockToJwt.mockResolvedValue('mock.livekit.jwt');
    mockEmitOasisEvent.mockResolvedValue({ ok: true });
    mockCommitSessionMemory.mockReturnValue({ committed: true, cognee_queued: true });
    mockGetLiveKitCanaryConfig.mockResolvedValue({ enabled: false, allowedTenants: [], allowedUsers: [] });
    mockGetLiveKitAgentReadiness.mockResolvedValue({ enabled: false });
    mockBuildLiveSystemInstruction.mockReturnValue('MOCK_SYSTEM_INSTRUCTION');
    mockDecideWakeBriefForSession.mockResolvedValue(null);
    mockCompileAssistantDecisionContext.mockResolvedValue(null);
    mockGetCurrentFacts.mockResolvedValue({ ok: true, facts: [] });
    mockBuildBootstrapContextPack.mockResolvedValue(null);
    mockBuildClientContext.mockResolvedValue(null);
    clearLiveKitEnv();
    delete process.env.ORB_AGENT_URL;
    delete process.env.NOVA_SONIC_ALLOW_GLOBAL_FLIP;
    delete process.env.NOVA_SONIC_ENABLED;
    delete process.env.VOICE_ACTIVE_PROVIDER;
  });

  // =========================================================================
  // GET /orb/active-provider
  // =========================================================================
  describe('GET /orb/active-provider', () => {
    it('unauthenticated caller with no config row defaults to vertex', async () => {
      mockActiveProviderRow(null);
      const res = await request(app).get('/api/v1/orb/active-provider');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.active_provider).toBe('vertex');
      expect(res.body.effectiveProvider).toBe('vertex');
      expect(res.body.reason).toBe('default_vertex');
    });

    it('global=livekit but canary disabled → effective stays vertex (canary_disabled)', async () => {
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      mockGetLiveKitCanaryConfig.mockResolvedValue({ enabled: false, allowedTenants: [], allowedUsers: [] });
      const res = await request(app).get('/api/v1/orb/active-provider');
      expect(res.status).toBe(200);
      expect(res.body.requestedProvider).toBe('livekit');
      expect(res.body.effectiveProvider).toBe('vertex');
      expect(res.body.reason).toBe('canary_disabled');
    });

    it('global=livekit + missing LiveKit creds → livekit_config_invalid regardless of canary', async () => {
      mockActiveProviderRow('livekit');
      clearLiveKitEnv();
      mockGetLiveKitCanaryConfig.mockResolvedValue({ enabled: true, allowedTenants: [TENANT_A], allowedUsers: [] });
      const res = await request(app).get('/api/v1/orb/active-provider');
      expect(res.status).toBe(200);
      expect(res.body.effectiveProvider).toBe('vertex');
      expect(res.body.reason).toBe('livekit_config_invalid');
      expect(res.body.livekitReady).toBe(false);
    });

    it('canary-eligible caller but backend agent not ready → pinned_until_agent_ready + OASIS emitted', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      mockGetLiveKitCanaryConfig.mockResolvedValue({ enabled: true, allowedTenants: [TENANT_A], allowedUsers: [] });
      mockGetLiveKitAgentReadiness.mockResolvedValue({ enabled: false });

      const res = await request(app)
        .get('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.effectiveProvider).toBe('vertex');
      expect(res.body.reason).toBe('pinned_until_agent_ready');
      expect(res.body.canaryEligible).toBe(true);
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'orb.upstream.active_provider.pinned_until_agent_ready' }),
      );
    });

    it('all gates pass → effectiveProvider=livekit, no pinned OASIS event', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      mockGetLiveKitCanaryConfig.mockResolvedValue({ enabled: true, allowedTenants: [TENANT_A], allowedUsers: [] });
      mockGetLiveKitAgentReadiness.mockResolvedValue({ enabled: true });

      const res = await request(app)
        .get('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.effectiveProvider).toBe('livekit');
      expect(res.body.reason).toBe('livekit_all_gates_pass');
      expect(mockEmitOasisEvent).not.toHaveBeenCalled();
    });

    it('returns 500 when an internal lookup throws', async () => {
      mockActiveProviderRow(null);
      mockGetLiveKitCanaryConfig.mockRejectedValueOnce(new Error('canary config blew up'));
      const res = await request(app).get('/api/v1/orb/active-provider');
      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/canary config blew up/);
    });
  });

  // =========================================================================
  // POST /orb/active-provider
  // =========================================================================
  describe('POST /orb/active-provider', () => {
    it('400 on an invalid provider value', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'carrier-pigeon' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('403 when caller is authenticated but not exafy_admin', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: false });
      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'livekit' });
      expect(res.status).toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/exafy_admin/);
    });

    it('401 unauthenticated', async () => {
      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .send({ provider: 'livekit' });
      expect(res.status).toBe(401);
    });

    it('admin flips vertex → livekit: writes system_config, audits, emits OASIS', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      mockActiveProviderRow('vertex');
      chainFor('system_config').mockResolvedValueOnce({ data: null, error: null }); // upsert response
      chainFor('voice_active_provider_changes').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'livekit', reason: 'canary rollout' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.from).toBe('vertex');
      expect(res.body.to).toBe('livekit');
      expect(chainFor('system_config').upsert).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'voice.active_provider', value: 'livekit' }),
        expect.objectContaining({ onConflict: 'key' }),
      );
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'voice.active_provider.flipped',
          payload: expect.objectContaining({ from: 'vertex', to: 'livekit' }),
        }),
      );
    });

    it('429 when a flip is attempted inside the 1-hour cooldown window', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      // Flipped 5 minutes ago — well inside the 60-min cooldown.
      const recentFlip = new Date(Date.now() - 5 * 60_000).toISOString();
      mockActiveProviderRow('vertex', { updated_at: recentFlip });

      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'livekit' });

      expect(res.status).toBe(429);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/cooldown/);
    });

    it('idempotent no-op flip (same provider) skips the cooldown gate and returns ok', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      const recentFlip = new Date(Date.now() - 5 * 60_000).toISOString();
      mockActiveProviderRow('vertex', { updated_at: recentFlip });

      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'vertex' });

      expect(res.status).toBe(200);
      expect(res.body.from).toBe('vertex');
      expect(res.body.to).toBe('vertex');
    });

    it('500 when the system_config upsert fails', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      mockActiveProviderRow('vertex');
      chainFor('system_config').mockResolvedValueOnce({ data: null, error: { message: 'db write failed' } });

      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'livekit' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('db write failed');
    });

    it('500 when supabase is unavailable', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      mockGetSupabase.mockReturnValue(null as any);

      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'livekit' });

      expect(res.status).toBe(500);
      expect(res.body.error).toBe('supabase client unavailable');
    });

    it('409 nova_global_flip_locked when NOVA_SONIC_ALLOW_GLOBAL_FLIP is not set', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'nova_sonic' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('nova_global_flip_locked');
    });

    it('409 nova_not_ready when unlocked but Nova runtime is not configured', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      process.env.NOVA_SONIC_ALLOW_GLOBAL_FLIP = 'true';
      // NOVA_SONIC_ENABLED left unset → getNovaSonicConfig().ready === false
      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'nova_sonic' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('nova_not_ready');
    });

    it('permits a nova_sonic flip when unlocked AND the runtime reports ready', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      process.env.NOVA_SONIC_ALLOW_GLOBAL_FLIP = 'true';
      process.env.NOVA_SONIC_ENABLED = 'true';
      mockActiveProviderRow('vertex');
      chainFor('system_config').mockResolvedValueOnce({ data: null, error: null });
      chainFor('voice_active_provider_changes').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .post('/api/v1/orb/active-provider')
        .set('Authorization', `Bearer ${token}`)
        .send({ provider: 'nova_sonic' });

      expect(res.status).toBe(200);
      expect(res.body.to).toBe('nova_sonic');
    });
  });

  // =========================================================================
  // GET /orb/nova-sonic/health
  // =========================================================================
  describe('GET /orb/nova-sonic/health', () => {
    it('reports disabled + not ready when NOVA_SONIC_ENABLED is unset', async () => {
      const res = await request(app).get('/api/v1/orb/nova-sonic/health');
      expect(res.status).toBe(200);
      expect(res.body.enabled).toBe(false);
      expect(res.body.ready).toBe(false);
      expect(res.body.credential_source).toBe('ecs_task_role');
    });

    it('surfaces a typed issue for an invalid region override without leaking secrets', async () => {
      process.env.NOVA_SONIC_ENABLED = 'true';
      process.env.NOVA_SONIC_REGION = 'us-east-1'; // pinned to eu-north-1 — mismatch
      const res = await request(app).get('/api/v1/orb/nova-sonic/health');
      expect(res.status).toBe(200);
      expect(res.body.ready).toBe(false);
      expect(res.body.issues).toContain('nova_region_invalid');
      expect(JSON.stringify(res.body)).not.toMatch(/key|secret|token/i);
      delete process.env.NOVA_SONIC_REGION;
    });
  });

  // =========================================================================
  // POST /orb/livekit/token
  // =========================================================================
  describe('POST /orb/livekit/token', () => {
    it('503 provider_standby when active_provider is not livekit', async () => {
      mockActiveProviderRow('vertex');
      const res = await request(app).post('/api/v1/orb/livekit/token').send({});
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('provider_standby');
      expect(res.body.active_provider).toBe('vertex');
      expect(mockAccessTokenCtor).not.toHaveBeenCalled();
    });

    it('500 livekit_misconfigured when active=livekit but env vars are missing', async () => {
      mockActiveProviderRow('livekit');
      clearLiveKitEnv();
      const res = await request(app).post('/api/v1/orb/livekit/token').send({});
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('livekit_misconfigured');
    });

    it('mints a token for an authenticated user with correct grants + metadata', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockActiveProviderRow('livekit');
      setLiveKitEnv();

      const res = await request(app)
        .post('/api/v1/orb/livekit/token')
        .set('Authorization', `Bearer ${token}`)
        .send({ lang: 'de', agent_id: 'vitana', voice_override: 'Kore' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.token).toBe('mock.livekit.jwt');
      expect(res.body.url).toBe('wss://test.livekit.cloud');
      expect(res.body.room).toMatch(new RegExp(`^orb-${uid}-`));

      expect(mockAccessTokenCtor).toHaveBeenCalledWith(
        'test-api-key',
        'test-api-secret',
        expect.objectContaining({ identity: uid, ttl: 3600 }),
      );
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.user_id).toBe(uid);
      expect(metadataArg.tenant_id).toBe(TENANT_A);
      expect(metadataArg.lang).toBe('de');
      expect(metadataArg.is_anonymous).toBe(false);
      expect(metadataArg.voice_override).toBe('Kore');
      expect(typeof metadataArg.user_jwt).toBe('string');
      expect(metadataArg.user_jwt.split('.')).toHaveLength(3); // real signed JWT

      expect(mockAddGrant).toHaveBeenCalledWith(
        expect.objectContaining({ roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true }),
      );
    });

    it('mints an anonymous token with no user_jwt and an anon- identity', async () => {
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      const res = await request(app).post('/api/v1/orb/livekit/token').send({});
      expect(res.status).toBe(200);
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.is_anonymous).toBe(true);
      expect(metadataArg.user_id).toMatch(/^anon-/);
      expect(metadataArg.user_jwt).toBeNull();
    });

    it('coerces an admin caller on a mobile user-agent down to the community role', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid });
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      const res = await request(app)
        .post('/api/v1/orb/livekit/token')
        .set('Authorization', `Bearer ${token}`)
        .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) AppleWebKit/605.1')
        .send({});
      expect(res.status).toBe(200);
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.is_mobile).toBe(true);
      expect(metadataArg.role).toBe('community');
    });

    it('defaults lang to "en" and agent_id to "vitana" when omitted', async () => {
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      const res = await request(app).post('/api/v1/orb/livekit/token').send({});
      expect(res.status).toBe(200);
      expect(res.body.lang).toBe('en');
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.agent_id).toBe('vitana');
    });

    it('forwards the real client IP from x-forwarded-for, not the agent egress IP', async () => {
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      const res = await request(app)
        .post('/api/v1/orb/livekit/token')
        .set('X-Forwarded-For', '203.0.113.42, 10.0.0.1')
        .send({});
      expect(res.status).toBe(200);
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.client_ip).toBe('203.0.113.42');
    });

    it('drops a loopback client IP rather than embedding it', async () => {
      mockActiveProviderRow('livekit');
      setLiveKitEnv();
      const res = await request(app)
        .post('/api/v1/orb/livekit/token')
        .set('X-Forwarded-For', '127.0.0.1')
        .send({});
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.client_ip).toBeNull();
    });
  });

  // =========================================================================
  // GET /orb/livekit/health
  // =========================================================================
  describe('GET /orb/livekit/health', () => {
    it('reports agent unreachable when ORB_AGENT_URL is unset', async () => {
      mockActiveProviderRow('vertex');
      delete process.env.ORB_AGENT_URL;
      const res = await request(app).get('/api/v1/orb/livekit/health');
      expect(res.status).toBe(200);
      expect(res.body.agent_worker_reachable).toBe(false);
      expect(res.body.agent_health).toBeNull();
    });

    it('reports agent reachable when the probe responds 200', async () => {
      mockActiveProviderRow('vertex');
      process.env.ORB_AGENT_URL = 'https://orb-agent.example.com';
      (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({ status: 'healthy' }),
      }));
      const res = await request(app).get('/api/v1/orb/livekit/health');
      expect(res.status).toBe(200);
      expect(res.body.agent_worker_reachable).toBe(true);
      expect(res.body.agent_health).toEqual({ status: 'healthy' });
    });

    it('failure mode: agent probe network error → reachable=false, never 500s the whole health check', async () => {
      mockActiveProviderRow('vertex');
      process.env.ORB_AGENT_URL = 'https://orb-agent.example.com';
      (global.fetch as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('ECONNREFUSED');
      });
      const res = await request(app).get('/api/v1/orb/livekit/health');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.agent_worker_reachable).toBe(false);
    });

    it('failure mode: agent probe returns non-2xx → reachable=false', async () => {
      mockActiveProviderRow('vertex');
      process.env.ORB_AGENT_URL = 'https://orb-agent.example.com';
      (global.fetch as jest.Mock).mockImplementationOnce(async () => ({
        ok: false,
        json: async () => ({ error: 'boom' }),
      }));
      const res = await request(app).get('/api/v1/orb/livekit/health');
      expect(res.status).toBe(200);
      expect(res.body.agent_worker_reachable).toBe(false);
      expect(res.body.agent_health).toBeNull();
    });

    it('surfaces which STT/TTS/LLM providers have API keys configured', async () => {
      mockActiveProviderRow('vertex');
      process.env.DEEPGRAM_API_KEY = 'x';
      const res = await request(app).get('/api/v1/orb/livekit/health');
      expect(res.body.providers.deepgram_configured).toBe(true);
      expect(res.body.providers.cartesia_configured).toBe(false);
      delete process.env.DEEPGRAM_API_KEY;
    });
  });

  // =========================================================================
  // GET /orb/livekit/sessions/health
  // =========================================================================
  describe('GET /orb/livekit/sessions/health', () => {
    it('401 unauthenticated', async () => {
      const res = await request(app).get('/api/v1/orb/livekit/sessions/health');
      expect(res.status).toBe(401);
    });

    it('403 non-admin', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: false });
      const res = await request(app)
        .get('/api/v1/orb/livekit/sessions/health')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
    });

    it('503 when supabase is unavailable', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      mockGetSupabase.mockReturnValue(null as any);
      const res = await request(app)
        .get('/api/v1/orb/livekit/sessions/health')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('supabase_unavailable');
    });

    it('computes active/expired/stuck counts for an admin caller', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      const now = Date.now();
      chainFor('orb_session_state').mockResolvedValueOnce({
        data: [
          {
            user_id: 'u1',
            key: 'continuity',
            value: { last_turn_at: new Date(now - 20 * 60_000).toISOString() },
            expires_at: new Date(now + 60 * 60_000).toISOString(), // active, stale (>10min default)
            updated_at: new Date(now - 20 * 60_000).toISOString(),
          },
          {
            user_id: 'u2',
            key: 'continuity',
            value: { last_turn_at: new Date(now - 1 * 60_000).toISOString() },
            expires_at: new Date(now - 1000).toISOString(), // expired
            updated_at: new Date(now - 1 * 60_000).toISOString(),
          },
        ],
        error: null,
      });

      const res = await request(app)
        .get('/api/v1/orb/livekit/sessions/health')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.summary.total_rows).toBe(2);
      expect(res.body.summary.expired_sessions).toBe(1);
      expect(res.body.summary.active_sessions).toBe(1);
      expect(res.body.summary.stuck_sessions).toBe(1);
    });

    it('honors ?stale_minutes= override', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      chainFor('orb_session_state').mockResolvedValueOnce({ data: [], error: null });
      const res = await request(app)
        .get('/api/v1/orb/livekit/sessions/health?stale_minutes=2')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.summary.stale_after_ms).toBe(2 * 60_000);
    });

    it('degrades gracefully (not 500) when the migration has not landed yet', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      chainFor('orb_session_state').mockResolvedValueOnce({
        data: null,
        error: { message: 'relation "orb_session_state" does not exist' },
      });
      const res = await request(app)
        .get('/api/v1/orb/livekit/sessions/health')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.note).toMatch(/does not exist/);
      expect(res.body.summary.total_rows).toBe(0);
    });

    it('500 when the query throws synchronously', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, exafyAdmin: true });
      chainFor('orb_session_state').eq.mockImplementationOnce(() => {
        throw new Error('unexpected DB blowup');
      });
      const res = await request(app)
        .get('/api/v1/orb/livekit/sessions/health')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(500);
      expect(res.body.error).toMatch(/unexpected DB blowup/);
    });
  });

  // =========================================================================
  // GET /orb/context-bootstrap
  // =========================================================================
  describe('GET /orb/context-bootstrap', () => {
    it('anonymous request resolves lang from Accept-Language and renders a system instruction', async () => {
      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap')
        .set('Accept-Language', 'de-DE,de;q=0.9');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.system_instruction).toBe('MOCK_SYSTEM_INSTRUCTION');
      expect(mockBuildLiveSystemInstruction).toHaveBeenCalledWith(
        'de',
        expect.any(String),
        expect.any(String),
        'community',
        undefined,
        undefined,
        false,
        null,
        null,
        null,
        undefined,
        null,
        true,
      );
      // Anonymous → decision-context + wake-brief compile is skipped entirely.
      expect(res.body.decision_context).toBeNull();
      expect(res.body.wake_brief_decision).toBeNull();
      expect(mockCompileAssistantDecisionContext).not.toHaveBeenCalled();
      expect(mockDecideWakeBriefForSession).not.toHaveBeenCalled();
    });

    it('?lang= query param wins over the Accept-Language header', async () => {
      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?lang=fr')
        .set('Accept-Language', 'de-DE');
      expect(res.status).toBe(200);
      expect(mockBuildLiveSystemInstruction.mock.calls[0][0]).toBe('fr');
      // Explicit query lang skips the stored-preference fallback entirely.
      expect(mockGetCurrentFacts).not.toHaveBeenCalled();
    });

    it('falls back to the stored preferred_language fact when no query lang is given (authenticated)', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Dragan Test', registration_seq: 42 }, error: null });
      mockGetCurrentFacts.mockResolvedValueOnce({ ok: true, facts: [{ fact_value: 'german' }] });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept-Language', 'en-US');

      expect(res.status).toBe(200);
      expect(mockBuildLiveSystemInstruction.mock.calls[0][0]).toBe('de');
    });

    it('greeting_only=true returns the fast-path payload with slow fields empty', async () => {
      const res = await request(app).get('/api/v1/orb/context-bootstrap?greeting_only=true');
      expect(res.status).toBe(200);
      expect(res.body.greeting_only).toBe(true);
      expect(res.body.system_instruction).toBeNull();
      expect(res.body.bootstrap_context).toBe('');
      expect(res.body.identity_facts).toEqual([]);
      expect(res.body.memory_items).toEqual([]);
      // Fast path skips buildLiveSystemInstruction entirely.
      expect(mockBuildLiveSystemInstruction).not.toHaveBeenCalled();
    });

    it('greeting_only=true for an authenticated user resolves first_name from display_name', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Dragan Alexander' }, error: null });
      chainFor('memory_facts').mockResolvedValue({ data: null, error: null });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?greeting_only=true')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.display_name).toBe('Dragan Alexander');
      expect(res.body.first_name).toBe('Dragan');
    });

    it('greeting_only=true falls back to memory_facts.user_name when display_name is null', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: null }, error: null });
      chainFor('memory_facts').mockResolvedValueOnce({ data: { fact_value: 'Sasha Petrov' }, error: null });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?greeting_only=true')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.display_name).toBe('Sasha Petrov');
      expect(res.body.first_name).toBe('Sasha');
    });

    it('full path for an authenticated user assembles identity facts + Vitana Index + Life Compass into bootstrap_context', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Dragan Test', registration_seq: 7 }, error: null });
      chainFor('memory_items').mockResolvedValueOnce({ data: [{ id: 'm1', content: 'Loves morning walks' }], error: null });
      chainFor('memory_facts').mockResolvedValueOnce({
        data: [{ fact_key: 'user_name', fact_value: 'Dragan Test', entity: 'self' }],
        error: null,
      });
      chainFor('vitana_index_scores').mockResolvedValueOnce({
        data: {
          score_total: 620, score_nutrition: 80, score_hydration: 90,
          score_exercise: 50, score_sleep: 70, score_mental: 60,
        },
        error: null,
      });
      chainFor('life_compass').mockResolvedValueOnce({
        data: { primary_goal: 'Run a marathon', category: 'fitness' },
        error: null,
      });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.bootstrap_context).toMatch(/Dragan/);
      expect(res.body.bootstrap_context).toMatch(/Vitana Index/);
      expect(res.body.bootstrap_context).toMatch(/Run a marathon/);
      expect(res.body.memory_items).toEqual([{ id: 'm1', text: 'Loves morning walks' }]);
      expect(res.body.life_compass).toEqual({ goal: 'Run a marathon', category: 'fitness' });
    });

    it('L1 in-memory cache hit on a repeat call skips the DB batch entirely', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Cache User' }, error: null });
      chainFor('memory_items').mockResolvedValue({ data: [], error: null });
      chainFor('memory_facts').mockResolvedValue({ data: [], error: null });
      chainFor('vitana_index_scores').mockResolvedValue({ data: null, error: null });
      chainFor('life_compass').mockResolvedValue({ data: null, error: null });
      chainFor('bootstrap_cache').mockResolvedValue({ data: null, error: null });

      const first = await request(app)
        .get('/api/v1/orb/context-bootstrap?agent_id=vitana&lang=en')
        .set('Authorization', `Bearer ${token}`);
      expect(first.status).toBe(200);
      expect(first.body.cached).toBeUndefined();

      chainFor('memory_items').select.mockClear();

      const second = await request(app)
        .get('/api/v1/orb/context-bootstrap?agent_id=vitana&lang=en')
        .set('Authorization', `Bearer ${token}`);

      expect(second.status).toBe(200);
      expect(second.body.cached).toBe(true);
      expect(second.body.cache_layer).toBe('l1_memory');
      expect(chainFor('memory_items').select).not.toHaveBeenCalled();
    });

    it('L2 shared-cache hit re-populates L1 and returns cache_layer=l2_supabase', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      const cachedPayload = { ok: true, vtid: 'VTID-LIVEKIT-FOUNDATION', bootstrap_context: 'FROM-L2-CACHE' };
      chainFor('bootstrap_cache').mockResolvedValueOnce({
        data: { payload: cachedPayload, expires_at: new Date(Date.now() + 60_000).toISOString() },
        error: null,
      });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?agent_id=vitana&lang=en')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.cached).toBe(true);
      expect(res.body.cache_layer).toBe('l2_supabase');
      expect(res.body.bootstrap_context).toBe('FROM-L2-CACHE');
      // The heavy per-request batch never ran.
      expect(mockBuildLiveSystemInstruction).not.toHaveBeenCalled();
    });

    it('specialist persona (devon) uses the persona system_prompt instead of buildLiveSystemInstruction', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Test User' }, error: null });
      chainFor('agent_personas').mockResolvedValueOnce({
        data: { system_prompt: 'DEVON PERSONA PROMPT BODY', display_name: 'Devon' },
        error: null,
      });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?agent_id=devon')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.system_instruction).toMatch(/DEVON PERSONA PROMPT BODY/);
      expect(mockBuildLiveSystemInstruction).not.toHaveBeenCalled();
      expect(mockBuildPersonaBehavioralRule).toHaveBeenCalledWith('devon');
    });

    it('specialist persona with no system_prompt on file falls back to the Vitana builder', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Test User' }, error: null });
      chainFor('agent_personas').mockResolvedValueOnce({ data: null, error: null });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?agent_id=sage')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.system_instruction).toBe('MOCK_SYSTEM_INSTRUCTION');
      expect(mockBuildLiveSystemInstruction).toHaveBeenCalled();
    });

    it('failure mode: decision-context compile throwing degrades gracefully (no 500, decision_context null)', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Test User' }, error: null });
      mockCompileAssistantDecisionContext.mockRejectedValueOnce(new Error('decision engine down'));

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.decision_context).toBeNull();
    });

    it('failure mode: wake-brief decision throwing degrades gracefully (wake_brief_decision null, still 200)', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Test User' }, error: null });
      mockDecideWakeBriefForSession.mockRejectedValueOnce(new Error('wake-brief provider timeout'));

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.wake_brief_decision).toBeNull();
    });

    it('failure mode: buildLiveSystemInstruction throwing still returns 200 with system_instruction null', async () => {
      mockBuildLiveSystemInstruction.mockImplementationOnce(() => {
        throw new Error('prompt renderer exploded');
      });
      const res = await request(app).get('/api/v1/orb/context-bootstrap');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.system_instruction).toBeNull();
    });

    it('re-renders with the LiveKit first-turn suppression block when a wake-brief candidate has a spoken line', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Test User' }, error: null });
      mockDecideWakeBriefForSession.mockResolvedValueOnce({
        decisionId: 'dec-1',
        selectedContinuation: { kind: 'proactive_opener', userFacingLine: 'Hi! Ready to continue your walk streak?', dedupeKey: 'dk-1', evidence: [] },
        suppressionReason: null,
        decisionStartedAt: 't0',
        decisionFinishedAt: 't1',
        sourceProviderResults: [],
      });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?is_reconnect=false')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.system_instruction).toMatch(/FIRST TURN — DO NOT SPEAK FIRST/);
      expect(res.body.wake_brief_decision.user_facing_line).toBe('Hi! Ready to continue your walk streak?');
      expect(res.body.wake_brief_decision.decision_id).toBe('dec-1');
      // Re-rendered: buildLiveSystemInstruction called twice (base + override).
      expect(mockBuildLiveSystemInstruction).toHaveBeenCalledTimes(2);
    });

    it('does NOT apply the first-turn suppression override on a reconnect', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('app_users').mockResolvedValue({ data: { display_name: 'Test User' }, error: null });
      mockDecideWakeBriefForSession.mockResolvedValueOnce({
        decisionId: 'dec-2',
        selectedContinuation: { kind: 'proactive_opener', userFacingLine: 'Welcome back!', dedupeKey: 'dk-2', evidence: [] },
        suppressionReason: null,
        decisionStartedAt: 't0',
        decisionFinishedAt: 't1',
        sourceProviderResults: [],
      });

      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap?is_reconnect=true')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      expect(res.body.system_instruction).not.toMatch(/FIRST TURN — DO NOT SPEAK FIRST/);
      expect(mockBuildLiveSystemInstruction).toHaveBeenCalledTimes(1);
    });

    it('echoes current_route and comma-separated recent_routes back in the response', async () => {
      const res = await request(app).get(
        '/api/v1/orb/context-bootstrap?current_route=/dashboard&recent_routes=/home,/diary,/settings',
      );
      expect(res.status).toBe(200);
      expect(res.body.current_route).toBe('/dashboard');
      expect(res.body.recent_routes).toEqual(['/home', '/diary', '/settings']);
    });

    it('does not crash and degrades to the anonymous-style path when supabase is entirely unavailable', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockGetSupabase.mockReturnValue(null as any);
      const res = await request(app)
        .get('/api/v1/orb/context-bootstrap')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // =========================================================================
  // GET /voice-providers
  // =========================================================================
  describe('GET /voice-providers', () => {
    it('returns an empty list when supabase is unavailable', async () => {
      mockGetSupabase.mockReturnValue(null as any);
      const res = await request(app).get('/api/v1/voice-providers');
      expect(res.status).toBe(200);
      expect(res.body.providers).toEqual([]);
    });

    it('degrades gracefully with a note when the migration has not landed', async () => {
      chainFor('voice_providers').mockResolvedValueOnce({ data: null, error: { message: 'relation missing' } });
      const res = await request(app).get('/api/v1/voice-providers');
      expect(res.status).toBe(200);
      expect(res.body.providers).toEqual([]);
      expect(res.body.note).toMatch(/relation missing/);
    });

    it('returns enabled providers', async () => {
      chainFor('voice_providers').mockResolvedValueOnce({
        data: [{ id: 'deepgram', kind: 'stt', display_name: 'Deepgram', enabled: true }],
        error: null,
      });
      const res = await request(app).get('/api/v1/voice-providers');
      expect(res.status).toBe(200);
      expect(res.body.providers).toHaveLength(1);
      expect(chainFor('voice_providers').eq).toHaveBeenCalledWith('enabled', true);
    });
  });

  // =========================================================================
  // POST /voice-providers/:id/test
  // =========================================================================
  describe('POST /voice-providers/:id/test', () => {
    it('404 for an unknown provider id', async () => {
      const res = await request(app).post('/api/v1/voice-providers/carrier-pigeon/test');
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('unknown_provider');
    });

    it('ok=false with a typed detail when the required API key env var is missing', async () => {
      delete process.env.DEEPGRAM_API_KEY;
      const res = await request(app).post('/api/v1/voice-providers/deepgram/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.detail).toMatch(/DEEPGRAM_API_KEY not configured/);
    });

    it('ok=true when the key is configured and the HEAD probe succeeds', async () => {
      process.env.DEEPGRAM_API_KEY = 'test-key';
      (global.fetch as jest.Mock).mockImplementationOnce(async () => ({ status: 200 }));
      const res = await request(app).post('/api/v1/voice-providers/deepgram/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      delete process.env.DEEPGRAM_API_KEY;
    });

    it('failure mode: network error on the probe → ok=false with a network detail', async () => {
      process.env.DEEPGRAM_API_KEY = 'test-key';
      (global.fetch as jest.Mock).mockImplementationOnce(async () => {
        throw new Error('DNS resolution failed');
      });
      const res = await request(app).post('/api/v1/voice-providers/deepgram/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.detail).toMatch(/network: DNS resolution failed/);
      delete process.env.DEEPGRAM_API_KEY;
    });

    it('azure providers use an env-only check (no network probe)', async () => {
      delete process.env.AZURE_SPEECH_KEY;
      const res = await request(app).post('/api/v1/voice-providers/azure_stt/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(false);
      expect(res.body.detail).toBe('env-only check');
    });

    it('google_stt has no required env key and probes directly', async () => {
      (global.fetch as jest.Mock).mockImplementationOnce(async () => ({ status: 200 }));
      const res = await request(app).post('/api/v1/voice-providers/google_stt/test');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  // =========================================================================
  // GET /agents/:id/voice-config
  // =========================================================================
  describe('GET /agents/:id/voice-config', () => {
    it('401 unauthenticated', async () => {
      const res = await request(app).get('/api/v1/agents/vitana/voice-config');
      expect(res.status).toBe(401);
    });

    it('returns null config when supabase is unavailable', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockGetSupabase.mockReturnValue(null as any);
      const res = await request(app)
        .get('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.config).toBeNull();
    });

    it('returns the stored config for the agent', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('agent_voice_configs').mockResolvedValueOnce({
        data: { agent_id: 'vitana', transport: 'livekit_cascade', stt_provider: 'deepgram' },
        error: null,
      });
      const res = await request(app)
        .get('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.config.transport).toBe('livekit_cascade');
    });
  });

  // =========================================================================
  // PUT /agents/:id/voice-config
  // =========================================================================
  describe('PUT /agents/:id/voice-config', () => {
    it('401 unauthenticated', async () => {
      const res = await request(app).put('/api/v1/agents/vitana/voice-config').send({ transport: 'vertex' });
      expect(res.status).toBe(401);
    });

    it('400 on an invalid transport value', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      const res = await request(app)
        .put('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`)
        .send({ transport: 'carrier-pigeon' });
      expect(res.status).toBe(400);
    });

    it('400 when a referenced provider is unknown or disabled', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('voice_providers').mockResolvedValueOnce({ data: [{ id: 'deepgram', enabled: false }], error: null });
      const res = await request(app)
        .put('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`)
        .send({ stt_provider: 'deepgram' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/unknown or disabled provider/);
    });

    it('500 when supabase is unavailable', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockGetSupabase.mockReturnValue(null as any);
      const res = await request(app)
        .put('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`)
        .send({ transport: 'vertex' });
      expect(res.status).toBe(500);
    });

    it('upserts a valid config and emits an OASIS event', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('voice_providers').mockResolvedValueOnce({ data: [{ id: 'deepgram', enabled: true }], error: null });
      chainFor('agent_voice_configs').mockResolvedValueOnce({
        data: { agent_id: 'vitana', stt_provider: 'deepgram' },
        error: null,
      });
      const res = await request(app)
        .put('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`)
        .send({ stt_provider: 'deepgram' });
      expect(res.status).toBe(200);
      expect(res.body.config.stt_provider).toBe('deepgram');
      expect(chainFor('agent_voice_configs').upsert).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'vitana', stt_provider: 'deepgram' }),
        expect.objectContaining({ onConflict: 'agent_id' }),
      );
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'agent.voice_config.changed' }),
      );
    });

    it('500 when the upsert fails', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      chainFor('agent_voice_configs').mockResolvedValueOnce({ data: null, error: { message: 'upsert failed' } });
      const res = await request(app)
        .put('/api/v1/agents/vitana/voice-config')
        .set('Authorization', `Bearer ${token}`)
        .send({ transport: 'vertex' });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('upsert failed');
    });
  });

  // =========================================================================
  // POST /agents/:id/voice-config/test-session
  // =========================================================================
  describe('POST /agents/:id/voice-config/test-session', () => {
    it('401 unauthenticated', async () => {
      const res = await request(app).post('/api/v1/agents/vitana/voice-config/test-session').send({});
      expect(res.status).toBe(401);
    });

    it('500 livekit_misconfigured when env vars are missing', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      clearLiveKitEnv();
      const res = await request(app)
        .post('/api/v1/agents/vitana/voice-config/test-session')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('livekit_misconfigured');
    });

    it('mints a short-TTL ephemeral token carrying the proposed (unsaved) config', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      setLiveKitEnv();
      const proposed = { stt_provider: 'deepgram', llm_provider: 'anthropic', lang: 'de' };
      const res = await request(app)
        .post('/api/v1/agents/devon/voice-config/test-session')
        .set('Authorization', `Bearer ${token}`)
        .send(proposed);

      expect(res.status).toBe(200);
      expect(res.body.ttl_s).toBe(300);
      expect(res.body.room).toMatch(/^orb-test-devon-/);
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.is_test_session).toBe(true);
      expect(metadataArg.proposed_voice_config).toEqual(proposed);
      expect(metadataArg.lang).toBe('de');
    });

    it('defaults lang to "en" when the proposed config omits it', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      setLiveKitEnv();
      const res = await request(app)
        .post('/api/v1/agents/vitana/voice-config/test-session')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(200);
      const metadataArg = JSON.parse(mockAccessTokenCtor.mock.calls[0][2].metadata);
      expect(metadataArg.lang).toBe('en');
    });
  });

  // =========================================================================
  // POST /orb/session/commit-memory
  // =========================================================================
  describe('POST /orb/session/commit-memory', () => {
    it('401 unauthenticated', async () => {
      const res = await request(app).post('/api/v1/orb/session/commit-memory').send({ transcript: 'hello' });
      expect(res.status).toBe(401);
    });

    it('commits and emits an info-status OASIS event when the transcript is long enough', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockCommitSessionMemory.mockReturnValue({ committed: true, cognee_queued: true });

      const res = await request(app)
        .post('/api/v1/orb/session/commit-memory')
        .set('Authorization', `Bearer ${token}`)
        .send({ transcript: 'A'.repeat(120), session_id: 'sess-1', active_role: 'community' });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.committed).toBe(true);
      expect(mockCommitSessionMemory).toHaveBeenCalledWith(
        expect.objectContaining({ transcript: 'A'.repeat(120), sessionId: 'sess-1', activeRole: 'community' }),
      );
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'orb.live.memory.committed', status: 'info' }),
      );
    });

    it('reports committed=false with a warning-status OASIS event for a too-short transcript', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockCommitSessionMemory.mockReturnValue({ committed: false, cognee_queued: false, reason: 'transcript_too_short' });

      const res = await request(app)
        .post('/api/v1/orb/session/commit-memory')
        .set('Authorization', `Bearer ${token}`)
        .send({ transcript: 'hi' });

      expect(res.status).toBe(200);
      expect(res.body.committed).toBe(false);
      expect(res.body.reason).toBe('transcript_too_short');
      expect(mockEmitOasisEvent).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'warning' }),
      );
    });

    it('defaults session_id to a userId-derived value when omitted', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      const res = await request(app)
        .post('/api/v1/orb/session/commit-memory')
        .set('Authorization', `Bearer ${token}`)
        .send({ transcript: 'A'.repeat(80) });
      expect(res.status).toBe(200);
      expect(mockCommitSessionMemory).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: `livekit-${uid.slice(0, 8)}` }),
      );
    });

    it('failure mode: commitSessionMemory throwing returns 500 commit_failed, never crashes', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockCommitSessionMemory.mockImplementationOnce(() => {
        throw new Error('extraction pipeline exploded');
      });
      const res = await request(app)
        .post('/api/v1/orb/session/commit-memory')
        .set('Authorization', `Bearer ${token}`)
        .send({ transcript: 'A'.repeat(80) });
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('commit_failed');
    });

    it('treats a missing/non-string transcript as empty rather than throwing', async () => {
      const uid = freshUserId();
      const token = await signToken({ sub: uid, tenantId: TENANT_A });
      mockCommitSessionMemory.mockReturnValue({ committed: false, cognee_queued: false, reason: 'transcript_too_short' });
      const res = await request(app)
        .post('/api/v1/orb/session/commit-memory')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(200);
      expect(mockCommitSessionMemory).toHaveBeenCalledWith(expect.objectContaining({ transcript: '' }));
    });
  });
});
