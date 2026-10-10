/**
 * VTID-05070: take one screenshot of one staging page at one viewport, behind the guard.
 *
 * Layers, each enough on its own for the case it covers:
 *   1. Chromium resolves no production host at all (--host-resolver-rules, set at launch in
 *      index.ts from PRODUCTION_HOSTS) — this also covers server redirects, which Playwright's
 *      route handler only sees for the first URL, WebSockets and service workers.
 *   2. browserContext.route('**\/*') applies guard.decide() to every request the page makes.
 *   3. Every WebSocket is closed (a socket could carry writes); service workers are blocked.
 *   4. After loading (and after the click) the page must still be on a staging host, else no
 *      screenshot is returned.
 * One page gets 30 s in total (KIRO_BROWSER_PAGE_TIMEOUT_MS); past that the context is closed.
 *
 * The types below are the small part of Playwright this file uses, so tests drive a fake.
 */
import { decide, hostOf } from './guard';

export const VIEWPORTS = {
  desktop: { width: 1400, height: 900, isMobile: false, hasTouch: false, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;

export const PAGE_TIMEOUT_MS_DEFAULT = 30_000;
const SELECTOR_MAX = 300;

export interface ShotRequest {
  url: string;
  viewports: ViewportName[];
  full_page: boolean;
  wait_for_selector: string | null;
  click_selector: string | null;
  sign_in: boolean;
}

// ---- the part of Playwright we use ----------------------------------------------------------
export interface RouteLike { request(): { method(): string; url(): string; isNavigationRequest(): boolean }; continue(): Promise<void>; abort(code?: string): Promise<void> }
export interface WsRouteLike { url(): string; close(opts?: { code?: number; reason?: string }): Promise<void> | void }
export interface PageLike {
  goto(url: string, opts: { timeout: number; waitUntil: 'load' | 'domcontentloaded' | 'networkidle' }): Promise<unknown>;
  waitForSelector(sel: string, opts: { timeout: number; state?: 'visible' }): Promise<unknown>;
  click(sel: string, opts: { timeout: number }): Promise<void>;
  waitForLoadState(state: 'load' | 'networkidle', opts: { timeout: number }): Promise<void>;
  screenshot(opts: { fullPage: boolean; type: 'png'; timeout: number }): Promise<Buffer>;
  url(): string;
  setDefaultTimeout(ms: number): void;
}
export interface ContextLike {
  route(pattern: string, handler: (route: RouteLike) => unknown): Promise<void>;
  routeWebSocket(pattern: RegExp, handler: (ws: WsRouteLike) => unknown): Promise<void>;
  addInitScript(script: { content: string }): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export interface BrowserLike {
  newContext(opts: Record<string, unknown>): Promise<ContextLike>;
}

export type ParseResult = { ok: true; req: Omit<ShotRequest, 'url'> & { url: unknown } } | { ok: false; error: string };

/** Validate the tool arguments (the URL itself is checked by guard.checkTargetUrl). */
export function parseShotRequest(body: any): ParseResult {
  if (!body || typeof body !== 'object') return { ok: false, error: 'arguments must be an object' };
  const vp = body.viewport ?? 'both';
  if (!['desktop', 'mobile', 'both'].includes(vp)) return { ok: false, error: 'viewport must be desktop, mobile or both' };
  const sel = (v: unknown, name: string): string | null | Error => {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || v.length > SELECTOR_MAX) return new Error(`${name} must be a CSS selector of at most ${SELECTOR_MAX} characters`);
    return v;
  };
  const wait = sel(body.wait_for_selector, 'wait_for_selector');
  const click = sel(body.click_selector, 'click_selector');
  if (wait instanceof Error) return { ok: false, error: wait.message };
  if (click instanceof Error) return { ok: false, error: click.message };
  return {
    ok: true,
    req: {
      url: body.url,
      viewports: vp === 'both' ? ['desktop', 'mobile'] : [vp],
      full_page: body.full_page === true,
      wait_for_selector: wait,
      click_selector: click,
      sign_in: body.sign_in === true,
    },
  };
}

/** Width and height from a PNG's IHDR chunk; null when the bytes are not a PNG. */
export function pngSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Browser storage for a signed-in test user, set before any page script runs, on staging hosts only. */
export function signInScript(hosts: Set<string>, entries: Record<string, string>): string {
  return `(() => { try {
    if (!${JSON.stringify([...hosts])}.includes(location.hostname)) return;
    const e = ${JSON.stringify(entries)};
    for (const k of Object.keys(e)) localStorage.setItem(k, e[k]);
  } catch (_) {} })();`;
}

export class ShotError extends Error {}

export interface ShotOptions {
  hosts: Set<string>;
  timeoutMs?: number;
  /** localStorage entries of a signed-in test user (null = signed out). */
  storage?: Record<string, string> | null;
}

export interface Shot { viewport: ViewportName; png: Buffer; width: number; height: number; page_url: string; blocked: string[] }

/** One viewport of one request. Throws ShotError with a message Kiro can act on. */
export async function takeShot(browser: BrowserLike, req: ShotRequest, viewport: ViewportName, o: ShotOptions): Promise<Shot> {
  const timeoutMs = o.timeoutMs ?? PAGE_TIMEOUT_MS_DEFAULT;
  const v = VIEWPORTS[viewport];
  const blocked: string[] = [];
  const context = await browser.newContext({
    viewport: { width: v.width, height: v.height },
    deviceScaleFactor: v.deviceScaleFactor,
    isMobile: v.isMobile,
    hasTouch: v.hasTouch,
    serviceWorkers: 'block',
    acceptDownloads: false,
    javaScriptEnabled: true,
  });
  let timer: NodeJS.Timeout | null = null;
  try {
    await context.route('**/*', (route) => {
      const r = route.request();
      const d = decide({ method: r.method(), url: r.url(), isNavigation: r.isNavigationRequest() }, o.hosts);
      if (d.allow) return route.continue();
      blocked.push(`${r.method()} ${r.url().slice(0, 200)} (${d.reason})`);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, (ws) => { blocked.push(`WebSocket ${ws.url().slice(0, 200)}`); return ws.close(); });
    if (o.storage) await context.addInitScript({ content: signInScript(o.hosts, o.storage) });

    const work = (async (): Promise<Shot> => {
      const page = await context.newPage();
      page.setDefaultTimeout(timeoutMs);
      const onStaging = (when: string) => {
        const h = hostOf(page.url());
        if (!h || !o.hosts.has(h)) throw new ShotError(`the page left staging ${when} (now on ${h ?? page.url().slice(0, 100)}); no screenshot taken`);
      };
      try {
        await page.goto(req.url, { timeout: timeoutMs, waitUntil: 'load' });
      } catch (e) {
        const why = blocked.length ? ` (blocked: ${blocked[0]})` : '';
        throw new ShotError(`could not open ${req.url}: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}${why}`);
      }
      onStaging('while loading');
      await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined);
      if (req.wait_for_selector) {
        await page.waitForSelector(req.wait_for_selector, { timeout: timeoutMs, state: 'visible' })
          .catch(() => { throw new ShotError(`selector ${req.wait_for_selector} did not appear`); });
      }
      if (req.click_selector) {
        await page.click(req.click_selector, { timeout: timeoutMs })
          .catch(() => { throw new ShotError(`could not click ${req.click_selector}`); });
        await page.waitForLoadState('networkidle', { timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined);
        onStaging('after the click');
      }
      const png = await page.screenshot({ fullPage: req.full_page, type: 'png', timeout: timeoutMs });
      const size = pngSize(png);
      if (!size) throw new ShotError('the browser returned no PNG');
      onStaging('before the screenshot');
      return { viewport, png, ...size, page_url: page.url(), blocked };
    })();
    work.catch(() => undefined); // the loser of the race below must not become an unhandled rejection
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ShotError(`the page did not finish within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    });
    return await Promise.race([work, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
    await context.close().catch(() => undefined);
  }
}
