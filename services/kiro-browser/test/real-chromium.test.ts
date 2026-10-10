/**
 * VTID-05070: the guard against a REAL Chromium (headless shell), a local HTTP server standing
 * in for the staging host via Chromium's own host-resolver-rules. Runs where a Playwright
 * Chromium is installed and KIRO_BROWSER_REAL_CHROMIUM=1 (the Docker image's build check and
 * the first staging deploy cover the container itself). Evidence: docs/validation/VTID-05070.
 *
 *   - a server-side 302 to production never reaches production (the redirect is not seen by
 *     the route handler; Chromium cannot resolve the production host) and nothing is returned;
 *   - a page's fetch POST is aborted before it leaves the browser;
 *   - a meta refresh to another host is aborted;
 *   - a normal page is screenshotted at the asked viewport.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { hostResolverRules } from '../src/guard';
import { takeShot, ShotError, type BrowserLike } from '../src/shooter';

const RUN = process.env.KIRO_BROWSER_REAL_CHROMIUM === '1';
const HOST = 'preview-aws.vitanaland.com';

describe.runIf(RUN)('real Chromium', () => {
  let server: http.Server;
  let browser: any;
  const seen: string[] = [];
  const hosts = new Set([HOST]);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url === '/redirect-to-prod') { res.writeHead(302, { Location: 'http://vitanaland.com/' }); res.end(); return; }
      if (req.url === '/meta') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<meta http-equiv="refresh" content="0;url=http://example.com/"><p>x</p>'); return; }
      if (req.url === '/writes') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<h1>hi</h1><script>fetch("/api/write",{method:"POST",body:"x"}).catch(()=>{});</script>');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body style="background:#0a0"><h1 id="t">staging page</h1></body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    const { chromium } = await import('playwright-core');
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-dev-shm-usage', `--host-resolver-rules=MAP ${HOST}:80 127.0.0.1:${port}, ${hostResolverRules()}`],
    });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await new Promise((r) => server.close(() => r(null))); });

  const req = (path: string) => ({ url: `http://${HOST}${path}`, viewports: ['desktop' as const], full_page: false, wait_for_selector: null, click_selector: null, sign_in: false });

  it('a normal staging page is screenshotted at 1400x900', async () => {
    const s = await takeShot(browser as BrowserLike, { ...req('/'), wait_for_selector: '#t' }, 'desktop', { hosts, timeoutMs: 15_000 });
    expect([s.width, s.height]).toEqual([1400, 900]);
    expect(s.png.subarray(1, 4).toString('ascii')).toBe('PNG');
  });

  it('a server redirect to production is never followed to production, and nothing is returned', async () => {
    await expect(takeShot(browser as BrowserLike, req('/redirect-to-prod'), 'desktop', { hosts, timeoutMs: 15_000 })).rejects.toBeInstanceOf(ShotError);
  });

  it("a page's POST is aborted in the browser and never reaches the server", async () => {
    const s = await takeShot(browser as BrowserLike, req('/writes'), 'mobile', { hosts, timeoutMs: 15_000 });
    expect(s.blocked.some((b) => b.startsWith(`POST http://${HOST}/api/write`))).toBe(true);
    expect(seen).not.toContain('POST /api/write');
    expect(s.width).toBe(780); // 390 css px at 2x; the height may round by 1 px on mobile emulation
    expect(Math.abs(s.height - 1688)).toBeLessThanOrEqual(1);
  });

  it('a meta refresh to another host is aborted at the network level', async () => {
    const s = await takeShot(browser as BrowserLike, req('/meta'), 'desktop', { hosts, timeoutMs: 15_000 }).catch((e) => e);
    // Either the refresh was aborted and the staging page is shown, or the shot is refused — never example.com.
    if (s instanceof Error) expect(s).toBeInstanceOf(ShotError);
    else { expect(s.page_url).toContain(HOST); expect(s.blocked.join(' ')).toContain('example.com'); }
  });
});
