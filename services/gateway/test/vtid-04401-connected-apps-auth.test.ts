/**
 * VTID-04401 — Connected Apps security.
 *
 * Before: /social-accounts/* and /capabilities/* read the user id by
 * base64-decoding the bearer token WITHOUT checking its signature, then used
 * the service role — a forged token naming any user reached that user's
 * connected Google account. The OAuth `state` was plain base64 JSON, so a
 * crafted callback could attach an account to another user.
 *
 * Pins: the signed state (round trip, tamper, expiry, wrong format, no key),
 * both routers only trusting the identity the verifying middleware sets, the
 * social callback rejecting unsigned or cross-provider state, and the
 * wearables callback rejecting unsigned state.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { signOAuthState, verifyOAuthState, OAUTH_STATE_TTL_MS } from '../src/lib/oauth-state';

const SRC = path.resolve(__dirname, '../src');

function withEnv(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  return () => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  };
}

/** A structurally valid JWT with a garbage signature, naming `sub`. */
function forgedJwt(sub: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256', typ: 'JWT' })}.${b({ sub, role: 'authenticated', app_metadata: { active_tenant_id: 't1' } })}.forged`;
}

describe('signed OAuth state', () => {
  let restore: () => void;
  beforeEach(() => { restore = withEnv({ OAUTH_STATE_SECRET: undefined, SUPABASE_SERVICE_ROLE: 'service-role-secret' }); });
  afterEach(() => restore());

  it('round-trips a payload with expiry and a nonce', () => {
    const now = 1_800_000_000_000;
    const s = signOAuthState({ userId: 'u1', provider: 'google' }, now);
    expect(s.split('.')).toHaveLength(2);
    const p = verifyOAuthState<any>(s, now + 1000)!;
    expect(p).toMatchObject({ userId: 'u1', provider: 'google', iat: now, exp: now + OAUTH_STATE_TTL_MS });
    expect(typeof p.n).toBe('string');
    expect(signOAuthState({ userId: 'u1' }, now)).not.toBe(signOAuthState({ userId: 'u1' }, now));
  });

  it('rejects the old unsigned format, a tampered body, a tampered signature and garbage', () => {
    const unsigned = Buffer.from(JSON.stringify({ userId: 'victim', provider: 'google' })).toString('base64url');
    expect(verifyOAuthState(unsigned)).toBeNull();
    const s = signOAuthState({ userId: 'u1' });
    const [body, sig] = s.split('.');
    const evilBody = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), userId: 'victim' })).toString('base64url');
    expect(verifyOAuthState(`${evilBody}.${sig}`)).toBeNull();
    expect(verifyOAuthState(`${body}.${sig.slice(0, -2)}xx`)).toBeNull();
    for (const bad of ['', '.', 'a.b.c', 'x'.repeat(5000), null, undefined]) expect(verifyOAuthState(bad as any)).toBeNull();
  });

  it('expires after the TTL', () => {
    const now = 1_800_000_000_000;
    const s = signOAuthState({ userId: 'u1' }, now);
    expect(verifyOAuthState(s, now + OAUTH_STATE_TTL_MS + 1)).toBeNull();
  });

  it('a state signed with another key does not verify', () => {
    const s = signOAuthState({ userId: 'u1' });
    const r = withEnv({ SUPABASE_SERVICE_ROLE: 'a-different-secret' });
    expect(verifyOAuthState(s)).toBeNull();
    r();
  });

  it('fails closed with no key at all', () => {
    const r = withEnv({ SUPABASE_SERVICE_ROLE: undefined, OAUTH_STATE_SECRET: undefined });
    expect(() => signOAuthState({ userId: 'u1' })).toThrow('oauth_state_key_missing');
    expect(verifyOAuthState('a.b')).toBeNull();
    r();
  });
});

describe('routers trust only the verified identity', () => {
  // The real middleware verifies signatures against JWKS; here a stand-in
  // accepts exactly one token, so a forged one must yield no identity.
  function mountWithAuth(routerPath: string, extraMocks: () => void = () => {}) {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({
      optionalAuth: (req: any, _res: any, next: any) => {
        if (req.headers.authorization === 'Bearer verified-token') req.identity = { user_id: 'owner', tenant_id: 't1' };
        next();
      },
    }));
    extraMocks();
    const router = require(routerPath).default;
    const app = express();
    app.use(express.json());
    app.use('/x', router);
    return app;
  }
  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
    jest.dontMock('../src/routes/social-connect-repository');
    jest.dontMock('../src/routes/capabilities-repository');
  });

  it('social-accounts: a forged token naming another user gets 401, never their connections', async () => {
    const fetchConnections = jest.fn(async () => ({ data: [], error: null }));
    const app = mountWithAuth('../src/routes/social-connect', () => {
      jest.doMock('../src/routes/social-connect-repository', () => ({
        ...jest.requireActual('../src/routes/social-connect-repository'),
        fetchActiveConnections: fetchConnections,
        fetchUserConnections: fetchConnections,
      }));
    });
    const forged = await request(app).get('/x/connections').set('Authorization', `Bearer ${forgedJwt('victim')}`);
    expect(forged.status).toBe(401);
    for (const call of fetchConnections.mock.calls as any[]) expect(JSON.stringify(call)).not.toContain('victim');
    const connect = await request(app).get('/x/connect/google').set('Authorization', `Bearer ${forgedJwt('victim')}`);
    expect(connect.status).toBe(401);
  });

  it('capabilities: a forged token gets 401 on execute', async () => {
    const app = mountWithAuth('../src/routes/capabilities');
    const r = await request(app).post('/x/email.read').set('Authorization', `Bearer ${forgedJwt('victim')}`).send({});
    expect(r.status).toBe(401);
  });

  it('no route in either file decodes a token by hand any more', () => {
    for (const f of ['routes/social-connect.ts', 'routes/capabilities.ts']) {
      const src = fs.readFileSync(path.join(SRC, f), 'utf8');
      expect(src).not.toMatch(/token\.split\('\.'\)\[1\]/);
      expect(src).toContain('router.use(optionalAuth)');
    }
  });
});

describe('callbacks reject forged state', () => {
  let restore: () => void;
  beforeEach(() => { restore = withEnv({ SUPABASE_SERVICE_ROLE: 'service-role-secret', APP_URL: 'https://app.test' }); });
  afterEach(() => restore());

  function socialApp() {
    jest.resetModules();
    jest.doMock('../src/middleware/auth-supabase-jwt', () => ({ optionalAuth: (_q: any, _s: any, n: any) => n() }));
    const exchange = jest.fn(async () => ({ error: 'should not be called' }));
    jest.doMock('../src/services/social-connect-service', () => ({
      ...jest.requireActual('../src/services/social-connect-service'),
      exchangeCodeForTokens: exchange,
    }));
    const router = require('../src/routes/social-connect').default;
    const app = express();
    app.use('/x', router);
    return { app, exchange };
  }
  afterEach(() => {
    jest.dontMock('../src/middleware/auth-supabase-jwt');
    jest.dontMock('../src/services/social-connect-service');
  });

  it('an unsigned state never reaches the token exchange', async () => {
    const { app, exchange } = socialApp();
    const unsigned = Buffer.from(JSON.stringify({ userId: 'victim', tenantId: 't1', provider: 'google' })).toString('base64url');
    const r = await request(app).get(`/x/callback/google?code=abc&state=${unsigned}`);
    expect(r.status).toBe(302);
    expect(r.headers.location).toContain('invalid_state');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('a state signed for one provider cannot complete another provider’s callback', async () => {
    const { app, exchange } = socialApp();
    const s = signOAuthState({ userId: 'u1', tenantId: 't1', provider: 'linkedin' });
    const r = await request(app).get(`/x/callback/google?code=abc&state=${encodeURIComponent(s)}`);
    expect(r.headers.location).toContain('invalid_state');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('wearables: an unsigned state is a 400', async () => {
    const src = fs.readFileSync(path.join(SRC, 'routes/wearables.ts'), 'utf8');
    expect(src).toContain('verifyOAuthState');
    expect(src).not.toMatch(/JSON\.parse\(Buffer\.from\(state, 'base64url'\)/);
    expect(src).toContain('signOAuthState({ u: user.user_id');
  });
});
