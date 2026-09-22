/**
 * VTID-04220: the verifying-stage /alive probe and the self-healing probe
 * resolve THIS environment's gateway, never a dead GCP host and never
 * production from a staging process.
 */
import * as fs from 'fs';
import * as path from 'path';
import { gatewayBaseUrl, GATEWAY_URLS } from '../src/env';
import { probeEndpoint } from '../src/services/self-healing-probe';

const SRC = (p: string) => fs.readFileSync(path.resolve(__dirname, '../src', p), 'utf8');

describe('VTID-04220: gatewayBaseUrl', () => {
  it('follows VITANA_ENV when GATEWAY_URL is unset', () => {
    expect(gatewayBaseUrl({ VITANA_ENV: 'staging' })).toBe('https://preview-aws-gateway.vitanaland.com');
    expect(gatewayBaseUrl({ VITANA_ENV: 'production' })).toBe('https://gateway.vitanaland.com');
    expect(gatewayBaseUrl({})).toBe(GATEWAY_URLS.production);
  });

  it('prefers an explicit GATEWAY_URL and strips a trailing slash', () => {
    expect(gatewayBaseUrl({ VITANA_ENV: 'staging', GATEWAY_URL: 'https://example.test/' })).toBe('https://example.test');
    expect(gatewayBaseUrl({ GATEWAY_URL: '   ' })).toBe(GATEWAY_URLS.production);
  });

  it('never names a GCP Cloud Run host', () => {
    for (const u of Object.values(GATEWAY_URLS)) expect(u).not.toMatch(/run\.app/);
  });
});

describe('VTID-04220: the two probe sites use it (source contract)', () => {
  it('dev-autopilot-execute.ts no longer carries the dead run.app default', () => {
    const src = SRC('services/dev-autopilot-execute.ts');
    expect(src).not.toMatch(/run\.app/);
    expect(src).toMatch(/const gatewayUrl = gatewayBaseUrl\(\);/);
  });

  it('self-healing-probe.ts defaults through gatewayBaseUrl at call time', () => {
    const src = SRC('services/self-healing-probe.ts');
    expect(src).not.toMatch(/DEFAULT_GATEWAY_URL/);
    expect(src).toMatch(/opts\.gatewayUrl \?\? gatewayBaseUrl\(\)/);
  });
});

describe('VTID-04220: probeEndpoint on a staging process targets staging', () => {
  const ORIGINAL_FETCH = global.fetch;
  const saved = { VITANA_ENV: process.env.VITANA_ENV, GATEWAY_URL: process.env.GATEWAY_URL };
  afterEach(() => {
    global.fetch = ORIGINAL_FETCH;
    if (saved.VITANA_ENV === undefined) delete process.env.VITANA_ENV; else process.env.VITANA_ENV = saved.VITANA_ENV;
    if (saved.GATEWAY_URL === undefined) delete process.env.GATEWAY_URL; else process.env.GATEWAY_URL = saved.GATEWAY_URL;
  });

  it('joins a relative endpoint onto preview-aws-gateway when VITANA_ENV=staging and GATEWAY_URL is unset', async () => {
    process.env.VITANA_ENV = 'staging';
    delete process.env.GATEWAY_URL;
    const urls: string[] = [];
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      urls.push(String(url));
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: () => Promise.resolve('{}') };
    }) as unknown as typeof fetch;
    await probeEndpoint('/api/v1/admin/health');
    expect(urls[0]).toBe('https://preview-aws-gateway.vitanaland.com/api/v1/admin/health');
  });
});
