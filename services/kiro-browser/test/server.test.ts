/**
 * VTID-05070: the sidecar end to end over HTTP, with a fake browser and a fake gateway:
 * registry auth, the guard applied at the network level, the per-run cap, the 30 s page
 * budget, sign-in, and the upload with the session's gateway pass.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'net';
import { createBrowserServer, type BrowserStatus } from '../src/server';
import { GatewayClient, LIMIT_REACHED } from '../src/gateway';
import { stagingHosts } from '../src/guard';
import { pngSize, type BrowserLike, type ContextLike, type PageLike, type RouteLike } from '../src/shooter';
import { SignIn } from '../src/auth';

const REG = 'registry-token-0123456789abcdef';
const SESSION = 'S'.repeat(43);
const PASS = 'eyJ1IjoidSJ9.c2ln';

function png(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii'); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
}

/** What one fake page load does: sub-requests it makes, where it ends up, whether it hangs. */
interface Scenario { requests?: Array<{ method: string; url: string; nav?: boolean }>; finalUrl?: string; hang?: boolean; afterClick?: { url: string; nav?: boolean } }

class FakeBrowser implements BrowserLike {
  contexts: Array<{ opts: Record<string, unknown>; outcomes: string[]; ws: string[]; init: string[]; closed: boolean }> = [];
  constructor(public scenario: Scenario = {}) {}
  async newContext(opts: Record<string, unknown>): Promise<ContextLike> {
    const rec = { opts, outcomes: [] as string[], ws: [] as string[], init: [] as string[], closed: false };
    this.contexts.push(rec);
    let handler: ((r: RouteLike) => unknown) | null = null;
    let wsHandler: ((w: any) => unknown) | null = null;
    const sc = this.scenario;
    const fire = async (method: string, url: string, nav: boolean) => {
      let out = 'none';
      await handler!({
        request: () => ({ method: () => method, url: () => url, isNavigationRequest: () => nav }),
        continue: async () => { out = 'continue'; },
        abort: async () => { out = 'abort'; },
      });
      rec.outcomes.push(`${out} ${method} ${url}`);
      return out;
    };
    let current = 'about:blank';
    const page: PageLike = {
      async goto(url) {
        if ((await fire('GET', url, true)) === 'abort') throw new Error('net::ERR_BLOCKED_BY_CLIENT');
        for (const r of sc.requests ?? []) await fire(r.method, r.url, r.nav ?? false);
        await wsHandler?.({ url: () => 'wss://preview-aws-gateway.vitanaland.com/api/v1/orb/live', close: () => { rec.ws.push('closed'); } });
        if (sc.hang) await new Promise(() => {});
        current = sc.finalUrl ?? url;
        return null;
      },
      async waitForSelector() { return null; },
      async click() { if (sc.afterClick) { if ((await fire('GET', sc.afterClick.url, sc.afterClick.nav ?? true)) === 'continue') current = sc.afterClick.url; } },
      async waitForLoadState() {},
      async screenshot() { const v = opts.viewport as { width: number; height: number }; return png(v.width * (opts.deviceScaleFactor as number), v.height * (opts.deviceScaleFactor as number)); },
      url: () => current,
      setDefaultTimeout() {},
    };
    return {
      async route(_p, h) { handler = h; },
      async routeWebSocket(_p, h) { wsHandler = h; },
      async addInitScript(s) { rec.init.push(s.content); },
      async newPage() { return page; },
      async close() { rec.closed = true; },
    };
  }
}

class FakeGateway {
  calls: Array<{ method: string; url: string; auth: string; type?: string; bytes?: number }> = [];
  used = 0;
  limit = 10;
  fetch = (async (input: any, init: any = {}) => {
    const url = String(input);
    const auth = init.headers?.Authorization ?? '';
    this.calls.push({ method: init.method ?? 'GET', url, auth, type: init.headers?.['Content-Type'], bytes: init.body?.length });
    const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (auth !== `Bearer ${PASS}`) return j(401, { ok: false, error: 'invalid token' });
    if (url.endsWith('/media/quota')) return j(200, { ok: true, run_id: 'run-1', used: this.used, limit: this.limit, remaining: this.limit - this.used });
    if (this.used >= this.limit) return j(429, { ok: false, error: LIMIT_REACHED });
    this.used++;
    return j(201, { ok: true, media_id: `m${this.used}`, run_id: 'run-1', url: `https://signed/${this.used}` });
  }) as unknown as typeof fetch;
}

let server: ReturnType<typeof createBrowserServer> | null = null;
let base = '';
async function start(o: { browser?: FakeBrowser | null; gw?: FakeGateway; status?: BrowserStatus; signIn?: (() => Promise<Record<string, string>>) | null; pageTimeoutMs?: number } = {}) {
  const gw = o.gw ?? new FakeGateway();
  const browser = o.browser === undefined ? new FakeBrowser() : o.browser;
  server = createBrowserServer({
    registryToken: REG,
    gateway: new GatewayClient('https://preview-aws-gateway.vitanaland.com', gw.fetch),
    hosts: stagingHosts(''),
    browser: () => browser,
    status: () => o.status ?? { ok: !!browser, sandbox: true, error: browser ? null : 'chromium missing' },
    signIn: o.signIn ?? null,
    pageTimeoutMs: o.pageTimeoutMs ?? 30_000,
    log: () => {},
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { gw, browser };
}
afterEach(async () => { if (server) await new Promise((r) => server!.close(() => r(null))); server = null; });

const call = (method: string, p: string, body: unknown, token: string) =>
  fetch(`${base}${p}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() as any }));
const register = () => call('POST', '/sessions', { session_token: SESSION, gateway_pass: PASS }, REG);
const shoot = (args: unknown) => call('POST', '/screenshot', args, SESSION);

describe('registry', () => {
  it('only the runner (registry token) registers sessions; an unknown session token is refused', async () => {
    await start();
    expect((await call('POST', '/sessions', { session_token: SESSION, gateway_pass: PASS }, 'wrong-token-0123456789')).status).toBe(401);
    expect((await shoot({ url: 'https://preview-aws.vitanaland.com/' })).body).toEqual({ ok: false, error: 'unknown browser session' });
    expect((await register()).status).toBe(200);
    expect((await call('POST', '/sessions', { session_token: 'short', gateway_pass: PASS }, REG)).status).toBe(400);
    expect((await call('POST', '/sessions', { session_token: SESSION, gateway_pass: 'not a pass' }, REG)).status).toBe(400);
    expect((await call('DELETE', '/sessions', { session_token: SESSION }, REG)).status).toBe(200);
    expect((await shoot({ url: 'https://preview-aws.vitanaland.com/' })).status).toBe(401);
  });
  it('/alive is open and reports the browser state, never a token', async () => {
    await start({ browser: null });
    const r = await fetch(`${base}/alive`).then((x) => x.json() as any);
    expect(r).toEqual({ ok: true, service: 'kiro-browser', browser: { ok: false, sandbox: true, error: 'chromium missing' }, sessions: 0 });
  });
});

describe('screenshots', () => {
  it('both viewports: two PNGs stored on the gateway with the session pass, sizes reported', async () => {
    const { gw, browser } = await start();
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/settings' });
    expect(r.status).toBe(200);
    expect(r.body.images).toEqual([
      { media_id: 'm1', run_id: 'run-1', viewport: 'desktop', width: 1400, height: 900, page_url: 'https://preview-aws.vitanaland.com/settings', url: 'https://signed/1' },
      { media_id: 'm2', run_id: 'run-1', viewport: 'mobile', width: 780, height: 1688, page_url: 'https://preview-aws.vitanaland.com/settings', url: 'https://signed/2' },
    ]);
    const uploads = gw.calls.filter((c) => c.method === 'POST');
    expect(uploads).toHaveLength(2);
    expect(uploads[0]).toMatchObject({ auth: `Bearer ${PASS}`, type: 'image/png' });
    expect(uploads[0].url).toContain('https://preview-aws-gateway.vitanaland.com/api/v1/operator/kiro/media?viewport=desktop&page_url=');
    expect(browser!.contexts.map((c) => c.opts)).toEqual([
      expect.objectContaining({ viewport: { width: 1400, height: 900 }, serviceWorkers: 'block', acceptDownloads: false }),
      expect.objectContaining({ viewport: { width: 390, height: 844 }, isMobile: true, serviceWorkers: 'block' }),
    ]);
    expect(browser!.contexts.every((c) => c.closed)).toBe(true);
  });

  it.each([
    ['production', 'https://gateway.vitanaland.com/api/v1/admin/health', /production host/],
    ['an arbitrary host', 'https://example.com/', /not a staging host/],
  ])('%s is refused before any page opens', async (_l, url, err) => {
    const { gw, browser } = await start();
    await register();
    const r = await shoot({ url });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(err);
    expect(browser!.contexts).toHaveLength(0);
    expect(gw.calls).toHaveLength(0);
  });

  it('at the network level: writes aborted (except the sign-in), production aborted, WebSockets closed', async () => {
    const browser = new FakeBrowser({
      requests: [
        { method: 'GET', url: 'https://preview-aws-gateway.vitanaland.com/api/v1/me' },
        { method: 'POST', url: 'https://preview-aws-gateway.vitanaland.com/api/v1/rum/beacon' },
        { method: 'POST', url: 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/profile_posts' },
        { method: 'POST', url: 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/auth/v1/token?grant_type=password' },
        { method: 'GET', url: 'https://gateway.vitanaland.com/api/v1/me' },
        { method: 'GET', url: 'https://example.com/', nav: true },
      ],
    });
    await start({ browser });
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'desktop' });
    expect(r.status).toBe(200);
    expect(r.body.blocked_requests).toBe(5); // 4 requests + 1 WebSocket
    expect(browser.contexts[0].outcomes).toEqual([
      'continue GET https://preview-aws.vitanaland.com/',
      'continue GET https://preview-aws-gateway.vitanaland.com/api/v1/me',
      'abort POST https://preview-aws-gateway.vitanaland.com/api/v1/rum/beacon',
      'abort POST https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/profile_posts',
      'continue POST https://inmkhvwdcuyhnxkgfvsb.supabase.co/auth/v1/token?grant_type=password',
      'abort GET https://gateway.vitanaland.com/api/v1/me',
      'abort GET https://example.com/',
    ]);
    expect(browser.contexts[0].ws).toEqual(['closed']);
  });

  it('a redirect that lands off staging (e.g. to production) is never screenshotted', async () => {
    const { gw } = await start({ browser: new FakeBrowser({ finalUrl: 'https://vitanaland.com/' }) });
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/go', viewport: 'desktop' });
    expect(r.status).toBe(422);
    expect(r.body.error).toMatch(/left staging while loading \(now on vitanaland\.com\)/);
    expect(gw.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('a click that navigates to production is aborted at the network level', async () => {
    const browser = new FakeBrowser({ afterClick: { url: 'https://vitanaland.com/settings' } });
    await start({ browser });
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'desktop', click_selector: '#go' });
    expect(r.status).toBe(200);
    expect(browser.contexts[0].outcomes).toContain('abort GET https://vitanaland.com/settings');
    expect(r.body.images[0].page_url).toBe('https://preview-aws.vitanaland.com/');
  });

  it('10 per run: the 11th call gets "screenshot limit reached for this run" and opens no page', async () => {
    const gw = new FakeGateway();
    const { browser } = await start({ gw });
    await register();
    for (let i = 0; i < 5; i++) expect((await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'both' })).status).toBe(200);
    expect(gw.used).toBe(10);
    const opened = browser!.contexts.length;
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'desktop' });
    expect(r).toEqual({ status: 429, body: { ok: false, error: LIMIT_REACHED } });
    expect(browser!.contexts.length).toBe(opened);
  });

  it('one left and both viewports asked: the limit error says how many are left', async () => {
    const gw = new FakeGateway();
    gw.used = 9;
    await start({ gw });
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/' });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe(`${LIMIT_REACHED} (1 left: ask for one viewport)`);
  });

  it('the gateway is the authority: its refusal at store time is passed through', async () => {
    const gw = new FakeGateway();
    const orig = gw.fetch;
    gw.fetch = (async (u: any, i: any) => (String(u).endsWith('/quota') ? new Response(JSON.stringify({ ok: true, run_id: 'r', used: 0, limit: 10, remaining: 10 })) : new Response(JSON.stringify({ ok: false, error: LIMIT_REACHED }), { status: 429 }))) as any;
    void orig;
    await start({ gw });
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'mobile' });
    expect(r).toEqual({ status: 429, body: { ok: false, error: LIMIT_REACHED } });
  });

  it('30 s per page: a page that never finishes is cut off and its context closed', async () => {
    const browser = new FakeBrowser({ hang: true });
    await start({ browser, pageTimeoutMs: 50 });
    await register();
    const t = Date.now();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'desktop' });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe('the page did not finish within 0 s');
    expect(browser.contexts[0].closed).toBe(true);
  });

  it('the default page budget is 30 s', async () => {
    const { PAGE_TIMEOUT_MS_DEFAULT } = await import('../src/shooter');
    expect(PAGE_TIMEOUT_MS_DEFAULT).toBe(30_000);
  });

  it('no browser: a clear error, nothing stored', async () => {
    const { gw } = await start({ browser: null });
    await register();
    const r = await shoot({ url: 'https://preview-aws.vitanaland.com/' });
    expect(r).toEqual({ status: 503, body: { ok: false, error: 'the browser is not available: chromium missing' } });
    expect(gw.calls).toHaveLength(0);
  });

  it('sign-in: refused when not configured; when configured the session goes into localStorage on staging hosts only', async () => {
    await start();
    await register();
    expect((await shoot({ url: 'https://preview-aws.vitanaland.com/', sign_in: true })).body.error).toMatch(/sign-in is not configured/);
    await new Promise((r) => server!.close(() => r(null)));
    const browser = new FakeBrowser();
    await start({ browser, signIn: async () => ({ 'sb-ref-auth-token': '{"access_token":"at"}', 'vitana.authToken': 'at' }) });
    await register();
    expect((await shoot({ url: 'https://preview-aws.vitanaland.com/', sign_in: true, viewport: 'mobile' })).status).toBe(200);
    expect(browser.contexts[0].init[0]).toContain('["preview-aws.vitanaland.com","preview-aws-gateway.vitanaland.com"].includes(location.hostname)');
    expect(browser.contexts[0].init[0]).toContain('"vitana.authToken":"at"');
  });

  it('bad arguments are refused with a message Kiro can act on', async () => {
    await start();
    await register();
    expect((await shoot({ url: 'https://preview-aws.vitanaland.com/', viewport: 'tablet' })).body.error).toBe('viewport must be desktop, mobile or both');
    expect((await shoot({ url: 'https://preview-aws.vitanaland.com/', click_selector: 'x'.repeat(301) })).body.error).toMatch(/click_selector/);
  });
});

describe('sign-in (password only in this container)', () => {
  it('password grant with the anon key; storage keyed by the project ref; reused until near expiry; never echoes the password', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    let now = 1_000_000;
    const f = (async (u: any, i: any = {}) => {
      calls.push({ url: String(u), body: String(i.body ?? '') });
      return new Response(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_at: now / 1000 + 3600 }), { status: 200 });
    }) as any;
    const s = new SignIn({ supabaseUrl: 'https://inmkhvwdcuyhnxkgfvsb.supabase.co', email: 'e2e-test@vitana.dev', password: 'pw', anonKey: 'anon', frontendUrl: 'https://preview-aws.vitanaland.com' }, f, () => now);
    const st = await s.storage();
    expect(Object.keys(st)).toEqual(['sb-inmkhvwdcuyhnxkgfvsb-auth-token', 'vitana.authToken', 'vitana.viewRole']);
    expect(calls[0].url).toBe('https://inmkhvwdcuyhnxkgfvsb.supabase.co/auth/v1/token?grant_type=password');
    await s.storage();
    expect(calls).toHaveLength(1);
    now += 3_600_000;
    await s.storage();
    expect(calls).toHaveLength(2);
  });
  it('a rejection names the status and code only', async () => {
    const f = (async () => new Response(JSON.stringify({ error_code: 'invalid_credentials', msg: 'Invalid login for e2e-test@vitana.dev' }), { status: 400 })) as any;
    const s = new SignIn({ supabaseUrl: 'https://inmkhvwdcuyhnxkgfvsb.supabase.co', email: 'e', password: 'secret-pw', anonKey: 'anon', frontendUrl: 'https://preview-aws.vitanaland.com' }, f);
    await expect(s.storage()).rejects.toThrow(/^sign-in rejected: HTTP 400 invalid_credentials$/);
  });
  it('pngSize reads the IHDR', () => {
    expect(pngSize(png(12, 34))).toEqual({ width: 12, height: 34 });
    expect(pngSize(Buffer.from('not a png at all, really not'))).toBeNull();
  });
});
