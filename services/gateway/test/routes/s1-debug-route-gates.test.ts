/**
 * VTID-05040 — Track S / S1: debug routes are gated.
 *
 * Before this fix an anonymous GET /api/v1/orb/debug/context-bootstrap?user_id=…
 * returned any member's memory items plus the full context instruction, and an
 * anonymous GET /api/v1/orb/debug/tts triggered a Google Cloud TTS call. These
 * tests mount the real routers with mocked auth (testing-catalog pattern) and pin:
 *   - context-bootstrap: anonymous 401, member 403, exafy_admin 200
 *   - tts: anonymous 401, member 403, exafy_admin 503 DEBUG_ROUTE_DISABLED, no TTS call
 *   - brain-instruction: another tenant 403 FORBIDDEN_TENANT_SCOPE, own tenant 200
 *   - memory / intent: 404 off the dev sandbox
 * plus a drift guard: every `debug` route registration under src/routes and
 * src/index.ts is gated or explicitly allowlisted with a reason.
 */
import request from 'supertest';
import express from 'express';
import fs from 'fs';
import path from 'path';

process.env.NODE_ENV = 'test';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_ANON_KEY = 'test-anon-key';

type Identity = { user_id: string; tenant_id: string; exafy_admin: boolean };
const MEMBER: Identity = { user_id: '11111111-1111-4111-8111-111111111111', tenant_id: '22222222-2222-4222-8222-222222222222', exafy_admin: false };
const ADMIN: Identity = { user_id: '33333333-3333-4333-8333-333333333333', tenant_id: '22222222-2222-4222-8222-222222222222', exafy_admin: true };
const OTHER_TENANT = '44444444-4444-4444-8444-444444444444';

let mockIdentity: Identity | null = null;
jest.mock('../../src/middleware/auth-supabase-jwt', () => {
  const actual = jest.requireActual('../../src/middleware/auth-supabase-jwt');
  const authenticate = (req: any, res: any, next: any) => {
    if (!mockIdentity) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
    req.identity = mockIdentity;
    next();
  };
  return {
    ...actual,
    requireAuth: authenticate,
    requireAuthWithTenant: authenticate,
    optionalAuth: (req: any, _res: any, next: any) => { if (mockIdentity) req.identity = mockIdentity; next(); },
    requireExafyAdmin: (req: any, res: any, next: any) => {
      if (!req.identity?.exafy_admin) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
      next();
    },
  };
});

jest.mock('../../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../src/services/orb-memory-bridge', () => ({
  writeMemoryItemWithIdentity: jest.fn().mockResolvedValue({ ok: true }),
  DEV_IDENTITY: { USER_ID: '00000000-0000-0000-0000-000000000099', TENANT_ID: '00000000-0000-0000-0000-000000000001', ACTIVE_ROLE: 'community' },
  isMemoryBridgeEnabled: () => false,
  isDevSandbox: () => false,
}));

const mockBuildBaseSessionContext = jest.fn();
jest.mock('../../src/orb/live/session/session-context-builder', () => ({
  buildBaseSessionContext: (...args: any[]) => mockBuildBaseSessionContext(...args),
}));

const mockBuildBrainSystemInstruction = jest.fn();
jest.mock('../../src/services/vitana-brain', () => ({
  buildBrainSystemInstruction: (...args: any[]) => mockBuildBrainSystemInstruction(...args),
}));

const mockSynthesizeSpeech = jest.fn();
jest.mock('@google-cloud/text-to-speech', () => ({
  TextToSpeechClient: jest.fn().mockImplementation(() => ({ synthesizeSpeech: mockSynthesizeSpeech })),
  protos: {},
}));

import orbLiveRouter from '../../src/routes/orb-live';

const app = express();
app.use(express.json());
app.use('/api/v1/orb', orbLiveRouter);

beforeEach(() => {
  mockIdentity = null;
  mockBuildBaseSessionContext.mockReset().mockResolvedValue({
    contextInstruction: 'CONTEXT',
    contextPack: { memory_hits: [], knowledge_hits: [], web_hits: [] },
    latencyMs: 1,
  });
  mockBuildBrainSystemInstruction.mockReset().mockResolvedValue({ instruction: 'INSTRUCTION' });
  mockSynthesizeSpeech.mockReset();
});

describe('GET /api/v1/orb/debug/context-bootstrap', () => {
  const url = `/api/v1/orb/debug/context-bootstrap?user_id=${MEMBER.user_id}&tenant_id=${MEMBER.tenant_id}`;

  it('rejects an anonymous caller with 401 JSON and never builds the context', async () => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error).toBe('UNAUTHENTICATED');
    expect(mockBuildBaseSessionContext).not.toHaveBeenCalled();
  });

  it('rejects a member with 403 and never builds the context', async () => {
    mockIdentity = MEMBER;
    const res = await request(app).get(url);
    expect(res.status).toBe(403);
    expect(mockBuildBaseSessionContext).not.toHaveBeenCalled();
  });

  it('serves an exafy_admin', async () => {
    mockIdentity = ADMIN;
    const res = await request(app).get(url);
    expect(res.status).toBe(200);
    expect(res.body.full_context_instruction).toBe('CONTEXT');
    expect(mockBuildBaseSessionContext).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/v1/orb/debug/tts', () => {
  it('rejects an anonymous caller with 401 JSON', async () => {
    const res = await request(app).get('/api/v1/orb/debug/tts');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('UNAUTHENTICATED');
  });

  it('rejects a member with 403', async () => {
    mockIdentity = MEMBER;
    const res = await request(app).get('/api/v1/orb/debug/tts');
    expect(res.status).toBe(403);
  });

  it('is disabled for an exafy_admin and never calls Google Cloud TTS', async () => {
    mockIdentity = ADMIN;
    const res = await request(app).get('/api/v1/orb/debug/tts?text=hi&lang=en');
    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({ ok: false, error: 'DEBUG_ROUTE_DISABLED' }));
    expect(mockSynthesizeSpeech).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/orb/debug/brain-instruction', () => {
  it('rejects an anonymous caller with 401', async () => {
    const res = await request(app).get('/api/v1/orb/debug/brain-instruction');
    expect(res.status).toBe(401);
  });

  it('rejects a member asking for another tenant with FORBIDDEN_TENANT_SCOPE', async () => {
    mockIdentity = MEMBER;
    const res = await request(app).get(`/api/v1/orb/debug/brain-instruction?tenant_id=${OTHER_TENANT}&full=1`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_TENANT_SCOPE');
    expect(mockBuildBrainSystemInstruction).not.toHaveBeenCalled();
  });

  it("serves a member in their own tenant", async () => {
    mockIdentity = MEMBER;
    const res = await request(app).get(`/api/v1/orb/debug/brain-instruction?tenant_id=${MEMBER.tenant_id}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(mockBuildBrainSystemInstruction).toHaveBeenCalledWith(expect.objectContaining({ user_id: MEMBER.user_id, tenant_id: MEMBER.tenant_id }));
  });

  it('lets an exafy_admin render another tenant', async () => {
    mockIdentity = ADMIN;
    const res = await request(app).get(`/api/v1/orb/debug/brain-instruction?tenant_id=${OTHER_TENANT}`);
    expect(res.status).toBe(200);
  });
});

describe('dev-sandbox-only debug routes', () => {
  it('GET /debug/memory is 404 off the sandbox', async () => {
    mockIdentity = ADMIN;
    const res = await request(app).get('/api/v1/orb/debug/memory');
    expect(res.status).toBe(404);
  });

  it('GET /debug/intent is 404 off the sandbox', async () => {
    mockIdentity = ADMIN;
    const res = await request(app).get('/api/v1/orb/debug/intent?text=hi');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: a new ungated debug route fails CI.
// ---------------------------------------------------------------------------

const GATE_PATTERN = /requireExafyAdmin|requireVoiceLabDevAccess|requireAuth|requireAuthWithTenant|isDevSandbox/;
const REGISTRATION = /\.(get|post|put|patch|delete|all)\(\s*['"]([^'"]*debug[^'"]*)['"]/g;
const NEXT_REGISTRATION = /\n\s*(router|app)\.(get|post|put|patch|delete|all|use)\(/;

// Routes intentionally left without a gate, keyed `<file> <METHOD> <path>`.
const ALLOWLIST: Record<string, string> = {
  'routes/orb-live.ts GET /debug/awareness': 'optionalAuth; a JWT gives self only, ?user_id needs the service-role key; anonymous gets an empty fixed payload',
  'routes/reminders.ts GET /_format-time-debug': 'pure time formatter, no data',
  'routes/admin-staging.ts GET /wake-brief-debug': 'gated by serviceTokenAuth (GATEWAY_SERVICE_TOKEN) + stagingOnlyGuard (403 off staging)',
  'index.ts GET /debug/governance-ping': 'build/route diagnostic, no member data (WS0 inventory cleanup)',
  'index.ts GET /debug/vtid-0524': 'build/route diagnostic, env presence booleans only (WS0 inventory cleanup)',
  'index.ts GET /debug/vtid-0600-check': 'build/route diagnostic, no member data (WS0 inventory cleanup)',
  'index.ts GET /debug/vtid-0538-routes': 'route listing, no member data (WS0 inventory cleanup)',
  'index.ts GET /debug/vtid-0529': 'build/route diagnostic, no member data (WS0 inventory cleanup)',
  'routes/domain-routing.ts GET /debug': 'TEMPORARY — gated in the second VTID-05040 commit',
  'routes/situational-awareness.ts GET /debug': 'TEMPORARY — gated in the second VTID-05040 commit',
};

// Routers whose every route is gated by a router-level `router.use(<middleware>)`.
const ROUTER_LEVEL_GATES: Record<string, { middleware: string; reason: string }> = {
  'routes/voice-lab.ts': { middleware: 'requireVoiceLabDevAccess', reason: 'router.use(requireVoiceLabDevAccess): exafy_admin or internal token' },
};

function findDebugRoutes(): Array<{ key: string; file: string; gated: boolean }> {
  const srcDir = path.join(__dirname, '../../src');
  const files = [
    'index.ts',
    ...fs.readdirSync(path.join(srcDir, 'routes')).filter((f) => f.endsWith('.ts')).map((f) => `routes/${f}`),
  ];
  const found: Array<{ key: string; file: string; gated: boolean }> = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
    const routerGate = ROUTER_LEVEL_GATES[file];
    const routerGated = !!routerGate && new RegExp(`router\\.use\\(\\s*${routerGate.middleware}\\s*\\)`).test(text);
    for (const m of text.matchAll(REGISTRATION)) {
      const start = m.index ?? 0;
      // The handler runs until its closing `});` or the next registration, whichever comes first.
      const rest = text.slice(start + 1);
      const ends = [rest.indexOf('\n});'), rest.search(NEXT_REGISTRATION)].filter((i) => i !== -1);
      const handler = text.slice(start, ends.length ? start + 1 + Math.min(...ends) : undefined);
      found.push({
        key: `${file} ${m[1].toUpperCase()} ${m[2]}`,
        file,
        gated: routerGated || GATE_PATTERN.test(handler),
      });
    }
  }
  return found;
}

describe('debug-route drift guard', () => {
  const routes = findDebugRoutes();

  it('finds the known debug routes', () => {
    const keys = routes.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([
      'routes/orb-live.ts GET /debug/context-bootstrap',
      'routes/orb-live.ts GET /debug/tts',
      'routes/orb-live.ts GET /debug/brain-instruction',
      'routes/voice-lab.ts GET /debug/events',
    ]));
  });

  it('every debug route is gated or allowlisted with a reason', () => {
    const ungated = routes.filter((r) => !r.gated && !ALLOWLIST[r.key]).map((r) => r.key);
    expect(ungated).toEqual([]);
  });

  it('the gated routes named by VTID-05040 are not on the allowlist', () => {
    for (const key of ['routes/orb-live.ts GET /debug/context-bootstrap', 'routes/orb-live.ts GET /debug/tts']) {
      expect(ALLOWLIST[key]).toBeUndefined();
      expect(routes.find((r) => r.key === key)?.gated).toBe(true);
    }
  });

  it('router-level gates are really applied', () => {
    for (const file of Object.keys(ROUTER_LEVEL_GATES)) {
      const fileRoutes = routes.filter((r) => r.file === file);
      expect(fileRoutes.length).toBeGreaterThan(0);
      expect(fileRoutes.every((r) => r.gated)).toBe(true);
    }
  });

  it('every allowlist entry still exists (no stale exemptions)', () => {
    const keys = new Set(routes.map((r) => r.key));
    expect(Object.keys(ALLOWLIST).filter((k) => !keys.has(k))).toEqual([]);
  });
});
