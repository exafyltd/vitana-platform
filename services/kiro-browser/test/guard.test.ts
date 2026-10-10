/**
 * VTID-05070: the sidecar's network guard — staging hosts only, production refused, every
 * non-read aborted except the Supabase sign-in, and the STAGING-VERIFY rules kept verbatim.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  ALWAYS_ALLOWED_WRITES, GUARDED_HOST, PRODUCTION_HOST, PRODUCTION_HOSTS, READ_METHODS,
  checkTargetUrl, decide, hostResolverRules, stagingHosts,
} from '../src/guard';

const ROOT = path.join(__dirname, '../../..');
const hosts = stagingHosts('');
const nav = (url: string, method = 'GET') => decide({ method, url, isNavigation: true }, hosts);
const sub = (url: string, method = 'GET') => decide({ method, url, isNavigation: false }, hosts);

describe('the STAGING-VERIFY guard rules, reused verbatim (scripts/ci/staging-verify/staging-guard.ts)', () => {
  const canonical = fs.readFileSync(path.join(ROOT, 'scripts/ci/staging-verify/staging-guard.ts'), 'utf8');
  const line = (name: string) => canonical.split('\n').find((l) => l.startsWith(`const ${name} =`))!.replace(/^const /, '');
  const mine = fs.readFileSync(path.join(__dirname, '../src/guard.ts'), 'utf8');

  it.each(['READ_METHODS', 'GUARDED_HOST', 'PRODUCTION_HOST', 'ALWAYS_ALLOWED_WRITES'])('%s is identical', (name) => {
    expect(mine).toContain(`export const ${line(name)}`);
  });
  it('the values behave as the canonical guard', () => {
    expect([...READ_METHODS]).toEqual(['GET', 'HEAD', 'OPTIONS']);
    expect(GUARDED_HOST.test('inmkhvwdcuyhnxkgfvsb.supabase.co')).toBe(true);
    expect(ALWAYS_ALLOWED_WRITES[0].test('/auth/v1/token?grant_type=password')).toBe(true);
  });
  it('PRODUCTION_HOSTS lists exactly what PRODUCTION_HOST matches, and lib.cjs has the same set', () => {
    const inner = PRODUCTION_HOST.source.slice(2, -2).split('|').map((h) => h.replace(/\\\./g, '.'));
    expect(PRODUCTION_HOSTS).toEqual(inner);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const lib = require(path.join(ROOT, 'scripts/ci/staging-verify/lib.cjs'));
    expect([...lib.PRODUCTION_HOSTS].sort()).toEqual([...PRODUCTION_HOSTS].sort());
  });
});

describe('the URL Kiro asks for', () => {
  it('a staging page is allowed', () => {
    expect(checkTargetUrl('https://preview-aws.vitanaland.com/settings', hosts)).toEqual({ ok: true, url: 'https://preview-aws.vitanaland.com/settings' });
    expect(checkTargetUrl('https://preview-aws-gateway.vitanaland.com/command-hub/', hosts).ok).toBe(true);
  });
  it.each([
    'https://vitanaland.com/', 'https://www.vitanaland.com/settings', 'https://gateway.vitanaland.com/api/v1/admin/health',
    'https://dr-app.vitanaland.com/', 'https://dr-gateway.vitanaland.com/', 'https://VITANALAND.com./', 'https://vitanaland.com:8443/',
  ])('production %s is refused', (u) => {
    const r = checkTargetUrl(u, hosts);
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/production host/);
  });
  it.each([
    ['an arbitrary host', 'https://example.com/'],
    ['a look-alike', 'https://preview-aws.vitanaland.com.evil.io/'],
    ['plain http', 'http://preview-aws.vitanaland.com/'],
    ['credentials in the URL', 'https://u:p@preview-aws.vitanaland.com/'],
    ['another port', 'https://preview-aws.vitanaland.com:8443/'],
    ['supabase directly', 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/profiles'],
    ['a file URL', 'file:///etc/passwd'],
    ['not a URL', 'preview-aws.vitanaland.com'],
    ['not a string', 42],
  ])('%s is refused', (_l, u) => {
    expect(checkTargetUrl(u, hosts).ok).toBe(false);
  });
  it('KIRO_BROWSER_EXTRA_HOSTS adds exact preview hosts, never a production, gateway or Supabase host', () => {
    const h = stagingHosts('d1abc.cloudfront.net, gateway.vitanaland.com,vitanaland.com, x.supabase.co, not a host,');
    expect([...h]).toEqual(['preview-aws.vitanaland.com', 'preview-aws-gateway.vitanaland.com', 'd1abc.cloudfront.net']);
    expect(checkTargetUrl('https://d1abc.cloudfront.net/pr-12/', h).ok).toBe(true);
  });
});

describe('every request the page makes (browserContext.route)', () => {
  it('production hosts are aborted for every method, navigation or not', () => {
    for (const u of PRODUCTION_HOSTS.map((h) => `https://${h}/x`)) {
      expect(nav(u)).toMatchObject({ allow: false, reason: 'production host' });
      expect(sub(u)).toMatchObject({ allow: false, reason: 'production host' });
    }
  });
  it('a navigation (redirect target, meta refresh, clicked link) off staging is aborted', () => {
    expect(nav('https://example.com/')).toMatchObject({ allow: false, reason: 'navigation off staging (example.com)' });
    expect(nav('https://preview-aws.vitanaland.com/home')).toEqual({ allow: true });
  });
  it('reads of sub-resources are allowed (staging gateway, Supabase reads, fonts)', () => {
    expect(sub('https://preview-aws-gateway.vitanaland.com/api/v1/me')).toEqual({ allow: true });
    expect(sub('https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/profiles?id=eq.1')).toEqual({ allow: true });
    expect(sub('https://fonts.gstatic.com/a.woff2')).toEqual({ allow: true });
    expect(sub('data:image/png;base64,AAAA')).toEqual({ allow: true });
  });
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s is aborted everywhere — staging gateway, Supabase, third parties', (m) => {
    for (const u of ['https://preview-aws-gateway.vitanaland.com/api/v1/community/posts', 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/rest/v1/profile_posts', 'https://www.google-analytics.com/collect', 'https://preview-aws.vitanaland.com/x']) {
      expect(sub(u, m).allow).toBe(false);
    }
  });
  it('the one exception: the Supabase token grant (the test user sign-in)', () => {
    expect(sub('https://inmkhvwdcuyhnxkgfvsb.supabase.co/auth/v1/token?grant_type=password', 'POST')).toEqual({ allow: true });
    // ...on Supabase only: the same path elsewhere is a write like any other.
    expect(sub('https://preview-aws-gateway.vitanaland.com/auth/v1/token?grant_type=password', 'POST').allow).toBe(false);
    expect(sub('https://inmkhvwdcuyhnxkgfvsb.supabase.co/auth/v1/user', 'PUT').allow).toBe(false);
  });
  it('Chromium resolves no production host (covers server redirects the route handler never sees)', () => {
    expect(hostResolverRules()).toBe(PRODUCTION_HOSTS.map((h) => `MAP ${h} ~NOTFOUND`).join(', '));
    const index = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');
    expect(index).toContain('`--host-resolver-rules=${hostResolverRules()}`');
    expect(index).toContain("server.listen(port, '127.0.0.1'");
    expect(index).toContain('chromiumSandbox: !noSandbox');
    expect(index).toContain("process.env.KIRO_BROWSER_NO_SANDBOX === 'true'");
  });
});
