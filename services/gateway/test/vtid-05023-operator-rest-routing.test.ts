/**
 * VTID-05023: operator-service REST calls follow DATA_REST_BASE_MODE.
 *
 * In aurora_proxy mode, a REST call made by operator-service must reach the
 * proxy, while /auth/v1 calls stay on SUPABASE_URL. globalThis.fetch is mocked
 * so the test sees the final URL after the global wrapper has run.
 */
import type * as OperatorService from '../src/services/operator-service';
import { installDataRestRouting } from '../src/lib/data-rest-base';

const SUPABASE = 'https://project.supabase.co';
const PROXY = 'http://postgrest-aurora-proxy.internal:3000';

const auroraEnv = {
  SUPABASE_URL: SUPABASE,
  SUPABASE_SERVICE_ROLE: 'test-service-role-key',
  DATA_REST_BASE_MODE: 'aurora_proxy',
  DATA_REST_PROXY_URL: PROXY,
} as NodeJS.ProcessEnv;

describe('VTID-05023 operator-service in aurora_proxy mode', () => {
  const originalFetch = globalThis.fetch;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of Object.keys(auroraEnv)) {
      savedEnv[key] = process.env[key];
      process.env[key] = auroraEnv[key];
    }
  });

  afterAll(() => {
    for (const key of Object.keys(savedEnv)) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends the REST call to the proxy and the auth call to Supabase', async () => {
    const inner = jest.fn(async () => new Response('[]', { status: 201 }));
    globalThis.fetch = inner as unknown as typeof fetch;
    installDataRestRouting(auroraEnv);

    // operator-service reads SUPABASE_URL when it loads, so load it after the env is set.
    let operatorService: typeof OperatorService | undefined;
    jest.isolateModules(() => {
      operatorService = require('../src/services/operator-service');
    });

    await operatorService!.ingestOperatorEvent({
      vtid: 'VTID-05023',
      type: 'vtid.rest.routing.check',
      status: 'info',
      message: 'REST routing check',
    });
    await globalThis.fetch(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`, { method: 'POST' });

    const urls = inner.mock.calls.map((call) => String(call[0]));
    const restCalls = urls.filter((url) => url.includes('/rest/v1/'));
    expect(restCalls).toHaveLength(1);
    expect(restCalls[0]).toBe(`${PROXY}/rest/v1/oasis_events`);
    expect(urls.some((url) => url.startsWith(SUPABASE + '/rest/v1'))).toBe(false);
    expect(urls).toContain(`${SUPABASE}/auth/v1/token?grant_type=refresh_token`);
  });
});
