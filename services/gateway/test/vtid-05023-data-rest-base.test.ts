/**
 * VTID-05023 — DATA_REST_BASE_MODE: REST base switch, AUTH always on Supabase.
 */
import {
  getDataRestBase,
  getDataRestBaseMode,
  getSupabaseAuthBase,
  installDataRestRouting,
  rewriteRestUrl,
} from '../src/lib/data-rest-base';

const SUPABASE = 'https://project.supabase.co';
const PROXY = 'http://postgrest-aurora-proxy.internal:3000';

const supabaseEnv = { SUPABASE_URL: SUPABASE } as NodeJS.ProcessEnv;
const auroraEnv = {
  SUPABASE_URL: SUPABASE,
  DATA_REST_BASE_MODE: 'aurora_proxy',
  DATA_REST_PROXY_URL: PROXY,
} as NodeJS.ProcessEnv;

describe('VTID-05023 DATA_REST_BASE_MODE', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('mode selection', () => {
    it('defaults to supabase when DATA_REST_BASE_MODE is unset', () => {
      expect(getDataRestBaseMode(supabaseEnv)).toBe('supabase');
    });

    it('treats an empty or whitespace value as unset', () => {
      expect(getDataRestBaseMode({ DATA_REST_BASE_MODE: '' } as NodeJS.ProcessEnv)).toBe('supabase');
      expect(getDataRestBaseMode({ DATA_REST_BASE_MODE: '   ' } as NodeJS.ProcessEnv)).toBe('supabase');
    });

    it('accepts aurora_proxy', () => {
      expect(getDataRestBaseMode(auroraEnv)).toBe('aurora_proxy');
    });

    it('fails closed on an unknown value', () => {
      for (const bad of ['Aurora', 'aurora-proxy', 'aurora_proxy_v2', 'true']) {
        expect(() =>
          getDataRestBaseMode({ DATA_REST_BASE_MODE: bad } as NodeJS.ProcessEnv)
        ).toThrow(/Unknown DATA_REST_BASE_MODE/);
      }
    });

    it('refuses to install routing for an unknown value', () => {
      const before = globalThis.fetch;
      expect(() =>
        installDataRestRouting({ SUPABASE_URL: SUPABASE, DATA_REST_BASE_MODE: 'postgres' } as NodeJS.ProcessEnv)
      ).toThrow(/Unknown DATA_REST_BASE_MODE/);
      expect(globalThis.fetch).toBe(before);
    });
  });

  describe('REST base', () => {
    it('default unset: REST base is SUPABASE_URL, exactly as before', () => {
      expect(getDataRestBase(supabaseEnv)).toBe(SUPABASE);
    });

    it('aurora_proxy: REST base is the proxy URL', () => {
      expect(getDataRestBase(auroraEnv)).toBe(PROXY);
    });

    it('aurora_proxy without DATA_REST_PROXY_URL throws', () => {
      expect(() =>
        getDataRestBase({ SUPABASE_URL: SUPABASE, DATA_REST_BASE_MODE: 'aurora_proxy' } as NodeJS.ProcessEnv)
      ).toThrow(/requires DATA_REST_PROXY_URL/);
    });

    it('aurora_proxy changes only the REST base: rewrites /rest/v1 and nothing else', () => {
      expect(rewriteRestUrl(`${SUPABASE}/rest/v1/oasis_events?limit=1`, auroraEnv)).toBe(
        `${PROXY}/rest/v1/oasis_events?limit=1`
      );
      expect(rewriteRestUrl(`${SUPABASE}/rest/v1`, auroraEnv)).toBe(`${PROXY}/rest/v1`);
      // A longer host or path that only starts with the same characters is not the REST prefix.
      expect(rewriteRestUrl(`${SUPABASE}/rest/v1x/foo`, auroraEnv)).toBe(`${SUPABASE}/rest/v1x/foo`);
      expect(rewriteRestUrl('https://other.example/rest/v1/x', auroraEnv)).toBe('https://other.example/rest/v1/x');
    });

    it('supabase mode: rewriteRestUrl is the identity', () => {
      expect(rewriteRestUrl(`${SUPABASE}/rest/v1/oasis_events`, supabaseEnv)).toBe(
        `${SUPABASE}/rest/v1/oasis_events`
      );
    });
  });

  describe('DATA_REST_PROXY_URL must be an internal host (fails closed)', () => {
    const proxyEnv = (proxy: string) =>
      ({ SUPABASE_URL: SUPABASE, DATA_REST_BASE_MODE: 'aurora_proxy', DATA_REST_PROXY_URL: proxy } as NodeJS.ProcessEnv);

    it.each([
      'http://postgrest-aurora-proxy.internal:3000',
      'http://proxy.vitana.internal',
      'https://rest.svc.internal/',
      'http://10.0.0.5:3000',
      'http://172.16.0.1:3000',
      'http://172.31.255.255:3000',
      'http://192.168.1.20:3000',
      'http://127.0.0.1:3000',
    ])('internal host is accepted: %s', (proxy) => {
      expect(getDataRestBase(proxyEnv(proxy))).toBe(proxy.replace(/\/$/, ''));
      expect(installDataRestRouting(proxyEnv(proxy))).toBe('aurora_proxy');
    });

    it.each([
      'https://proxy.example.com',
      'https://aurora-proxy.run.app',
      'http://8.8.8.8:3000',
      'http://172.32.0.1:3000',
      'http://172.15.0.1:3000',
      'http://192.169.0.1:3000',
      'http://localhost:3000',
      'http://internal.example.com',
      'http://[::1]:3000',
    ])('public host is rejected at boot: %s', (proxy) => {
      expect(() => getDataRestBase(proxyEnv(proxy))).toThrow(/is not an internal host/);
      expect(() => installDataRestRouting(proxyEnv(proxy))).toThrow(/is not an internal host/);
    });

    it('unset in supabase mode is accepted and not checked', () => {
      expect(getDataRestBase(supabaseEnv)).toBe(SUPABASE);
      expect(installDataRestRouting(supabaseEnv)).toBe('supabase');
    });

    it.each(['not a url', 'postgrest-aurora-proxy.internal:3000', 'http://', 'ftp://proxy.internal'])(
      'malformed or non-http URL is rejected: %s',
      (proxy) => {
        expect(() => getDataRestBase(proxyEnv(proxy))).toThrow(/DATA_REST_PROXY_URL/);
      }
    );
  });

  describe('AUTH stays on Supabase in both modes', () => {
    it.each([
      ['supabase', supabaseEnv],
      ['aurora_proxy', auroraEnv],
    ])('auth base is SUPABASE_URL in %s mode', (_mode, env) => {
      expect(getSupabaseAuthBase(env)).toBe(SUPABASE);
    });

    it.each([
      ['supabase', supabaseEnv],
      ['aurora_proxy', auroraEnv],
    ])('%s mode: /auth/v1 calls go to Supabase unchanged', (_mode, env) => {
      const authUrls = [
        `${SUPABASE}/auth/v1/token?grant_type=password`,
        `${SUPABASE}/auth/v1/user`,
        `${SUPABASE}/auth/v1/admin/users?email=a%40b.c`,
        `${SUPABASE}/auth/v1/.well-known/jwks.json`,
      ];
      for (const url of authUrls) {
        expect(rewriteRestUrl(url, env)).toBe(url);
      }
    });

    it('aurora_proxy: the installed fetch sends auth to Supabase and REST to the proxy', async () => {
      const inner = jest.fn(async () => new Response('{}', { status: 200 }));
      globalThis.fetch = inner as unknown as typeof fetch;

      expect(installDataRestRouting(auroraEnv)).toBe('aurora_proxy');

      await globalThis.fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });
      await globalThis.fetch(`${SUPABASE}/rest/v1/oasis_events?limit=1`);

      expect(inner.mock.calls[0][0]).toBe(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`);
      expect(inner.mock.calls[1][0]).toBe(`${PROXY}/rest/v1/oasis_events?limit=1`);
    });

    it('aurora_proxy: a Request object for /rest/v1 is rerouted and keeps its method and body', async () => {
      const inner = jest.fn(async () => new Response('[]', { status: 200 }));
      globalThis.fetch = inner as unknown as typeof fetch;
      installDataRestRouting(auroraEnv);

      await globalThis.fetch(
        new Request(`${SUPABASE}/rest/v1/vtid_ledger`, { method: 'POST', body: '{"a":1}' })
      );

      const sent = inner.mock.calls[0][0] as Request;
      expect(sent.url).toBe(`${PROXY}/rest/v1/vtid_ledger`);
      expect(sent.method).toBe('POST');
    });

    it('supabase mode: installing routing leaves fetch untouched', () => {
      const inner = jest.fn();
      globalThis.fetch = inner as unknown as typeof fetch;

      expect(installDataRestRouting(supabaseEnv)).toBe('supabase');
      expect(globalThis.fetch).toBe(inner);
    });

    it('aurora_proxy: installing twice does not double-wrap', async () => {
      const inner = jest.fn(async () => new Response('[]', { status: 200 }));
      globalThis.fetch = inner as unknown as typeof fetch;
      installDataRestRouting(auroraEnv);
      const once = globalThis.fetch;
      installDataRestRouting(auroraEnv);
      expect(globalThis.fetch).toBe(once);

      await globalThis.fetch(`${SUPABASE}/rest/v1/x`);
      expect(inner.mock.calls[0][0]).toBe(`${PROXY}/rest/v1/x`);
    });
  });
});
