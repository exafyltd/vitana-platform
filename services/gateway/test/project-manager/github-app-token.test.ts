/**
 * VTID-05352 (plan pm-ci-load, lane pm-app-token) — the Project Manager's GitHub App installation token.
 *
 * With PM_GITHUB_APP_ID / PM_GITHUB_APP_PRIVATE_KEY / PM_GITHUB_APP_INSTALLATION_ID unset, every PM GitHub call uses
 * exactly today's token. When set, the PM mints an RS256 App JWT, exchanges it for an installation token limited to the
 * two repos and the least-privilege permissions of plan §4, caches it until 5 min before expiry, refreshes single-flight,
 * and falls back to today's token (one log line, no secret) when the exchange fails.
 */
import { generateKeyPairSync } from 'crypto';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import {
  PM_APP_PERMISSIONS,
  PM_APP_REPOSITORIES,
  appConfigFromEnv,
  createAppTokenSource,
} from '../../src/services/project-manager/github-app-token';
import { resolvePmToken } from '../../src/services/project-manager/github-rest';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CFG = { appId: '123456', privateKey: PEM, installationId: '987654' };

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const fn = jest.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift() ?? { status: 500, body: {} };
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'Content-Type': 'application/json' } });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const ok = (token: string, expiresInMs: number, now: number) => ({ status: 201, body: { token, expires_at: new Date(now + expiresInMs).toISOString() } });

describe('appConfigFromEnv', () => {
  it('is null unless all three variables are set', () => {
    expect(appConfigFromEnv({})).toBeNull();
    expect(appConfigFromEnv({ PM_GITHUB_APP_ID: '1', PM_GITHUB_APP_PRIVATE_KEY: PEM })).toBeNull();
    expect(appConfigFromEnv({ PM_GITHUB_APP_ID: '1', PM_GITHUB_APP_INSTALLATION_ID: '2' })).toBeNull();
    expect(appConfigFromEnv({ PM_GITHUB_APP_ID: '1', PM_GITHUB_APP_PRIVATE_KEY: PEM, PM_GITHUB_APP_INSTALLATION_ID: '2' })).toEqual({ appId: '1', privateKey: PEM, installationId: '2' });
  });
  it('accepts a key stored with escaped newlines (Secrets Manager single-line value)', () => {
    const cfg = appConfigFromEnv({ PM_GITHUB_APP_ID: '1', PM_GITHUB_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'), PM_GITHUB_APP_INSTALLATION_ID: '2' });
    expect(cfg?.privateKey).toBe(PEM);
  });
});

describe('createAppTokenSource', () => {
  it('mints an RS256 App JWT (iss = app id, iat −60 s, exp +9 min) and asks for exactly the §4 permissions on the two repos', async () => {
    const now = Date.UTC(2026, 9, 27, 18, 0, 0);
    const f = fakeFetch([ok('ghs_one', 3600e3, now)]);
    const src = createAppTokenSource(CFG, { fetch: f.fn, now: () => now, log: () => {} });
    await expect(src.get()).resolves.toBe('ghs_one');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://api.github.com/app/installations/987654/access_tokens');
    const auth = String((f.calls[0].init.headers as Record<string, string>).Authorization);
    const jwt = auth.replace(/^Bearer /, '');
    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');
    const claims = decodeJwt(jwt);
    expect(claims.iss).toBe('123456');
    expect(claims.iat).toBe(now / 1000 - 60);
    expect(claims.exp).toBe(now / 1000 + 9 * 60);
    const body = JSON.parse(String(f.calls[0].init.body));
    expect(body).toEqual({ repositories: PM_APP_REPOSITORIES, permissions: PM_APP_PERMISSIONS });
    expect(PM_APP_PERMISSIONS).toEqual({ contents: 'write', pull_requests: 'write', checks: 'read', actions_variables: 'read', metadata: 'read' });
    expect(PM_APP_REPOSITORIES).toEqual(['vitana-platform', 'vitana-v1']);
  });

  it('reuses the cached token and refreshes 5 min before expiry', async () => {
    let now = Date.UTC(2026, 9, 27, 18, 0, 0);
    const f = fakeFetch([ok('ghs_one', 60 * 60e3, now), ok('ghs_two', 60 * 60e3, now + 56 * 60e3)]);
    const src = createAppTokenSource(CFG, { fetch: f.fn, now: () => now, log: () => {} });
    expect(await src.get()).toBe('ghs_one');
    now += 54 * 60e3; // 6 min before expiry → still cached
    expect(await src.get()).toBe('ghs_one');
    now += 2 * 60e3; // 4 min before expiry → refresh
    expect(await src.get()).toBe('ghs_two');
    expect(f.calls).toHaveLength(2);
  });

  it('shares one exchange between concurrent callers', async () => {
    const now = Date.UTC(2026, 9, 27, 18, 0, 0);
    const f = fakeFetch([ok('ghs_one', 3600e3, now)]);
    const src = createAppTokenSource(CFG, { fetch: f.fn, now: () => now, log: () => {} });
    const all = await Promise.all([src.get(), src.get(), src.get()]);
    expect(all).toEqual(['ghs_one', 'ghs_one', 'ghs_one']);
    expect(f.calls).toHaveLength(1);
  });

  it.each([401, 500])('an exchange answered %i returns null and logs one line without secret material', async (status) => {
    const now = Date.UTC(2026, 9, 27, 18, 0, 0);
    const f = fakeFetch([{ status, body: { message: 'nope' } }]);
    const lines: string[] = [];
    const src = createAppTokenSource(CFG, { fetch: f.fn, now: () => now, log: (l) => lines.push(l) });
    await expect(src.get()).resolves.toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pm.github_app.token_failed');
    expect(lines[0]).toContain(String(status));
    expect(lines[0]).not.toContain('PRIVATE KEY');
    expect(lines[0]).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/); // no JWT
  });
});

describe('resolvePmToken (github-rest token resolution)', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it('without the App variables uses exactly today\'s token for each repo', async () => {
    delete process.env.PM_GITHUB_APP_ID;
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'pat-platform';
    process.env.FRONTEND_DEPLOY_TOKEN = 'pat-v1';
    await expect(resolvePmToken('exafyltd/vitana-platform')).resolves.toBe('pat-platform');
    await expect(resolvePmToken('exafyltd/vitana-v1')).resolves.toBe('pat-v1');
  });

  it('prefers the App token when the source yields one, else falls back to today\'s token', async () => {
    process.env.GITHUB_SAFE_MERGE_TOKEN = 'pat-platform';
    await expect(resolvePmToken('exafyltd/vitana-platform', { get: async () => 'ghs_app' })).resolves.toBe('ghs_app');
    await expect(resolvePmToken('exafyltd/vitana-platform', { get: async () => null })).resolves.toBe('pat-platform');
  });

  it('with no token at all still throws the existing error', async () => {
    delete process.env.GITHUB_SAFE_MERGE_TOKEN;
    await expect(resolvePmToken('exafyltd/vitana-platform', { get: async () => null })).rejects.toThrow('GITHUB_SAFE_MERGE_TOKEN is not set');
  });
});
