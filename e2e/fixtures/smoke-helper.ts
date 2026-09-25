import { test, expect, type Page } from '@playwright/test';

/**
 * VTID-04515: the app is a client-rendered SPA. At `domcontentloaded` the
 * body is still an empty shell, so reading `innerText()` right after
 * `page.goto` measured nothing and ~730 smoke tests failed with "received 0"
 * on every run (staging 2026-09-24, and production back to 2026-07-03).
 * These waits poll the real condition with a bounded timeout instead of
 * reading once or sleeping a fixed 2-3 s.
 */
const RENDER_TIMEOUT_MS = 20_000;
const NAVIGATION_TIMEOUT_MS = 15_000;

/** Waits until the page has rendered visible text, then returns it. */
async function renderedBodyText(page: Page, minLength = 10): Promise<string> {
  let text = '';
  await expect
    .poll(async () => {
      text = await page.locator('body').innerText().catch(() => '');
      return text.length;
    }, { timeout: RENDER_TIMEOUT_MS, message: 'page rendered no visible text' })
    .toBeGreaterThan(minLength);
  return text;
}

/**
 * Console noise that is not the app's own failure. `cloudflareinsights`:
 * Cloudflare injects its analytics beacon at the edge, outside the app's
 * code, and the app's own CSP (script-src 'self') blocks it.
 */
function isFatalError(e: string): boolean {
  return !e.includes('favicon') &&
    !e.includes('analytics') &&
    !e.includes('cloudflareinsights') &&
    !e.includes('GTM') &&
    !e.includes('hotjar') &&
    !e.includes('ResizeObserver') &&
    !e.includes('hydration') &&
    !e.includes('Warning:') &&
    !e.includes('ERR_BLOCKED_BY_CLIENT') &&
    !e.includes('net::ERR_');
}

/**
 * Chrome logs a failed request only as "Failed to load resource: the server
 * responded with a status of 400 ()", without the URL, which made the 400s in
 * the 2026-09-25 staging run untraceable. Record the response itself instead.
 */
function httpErrorEntry(status: number, method: string, url: string): string {
  const u = new URL(url);
  const query = u.search.length > 160 ? `${u.search.slice(0, 160)}…` : u.search;
  return `HTTP ${status} ${method} ${u.origin}${u.pathname}${query}`;
}

function isAppHttpError(entry: string): boolean {
  return !entry.includes('favicon') && !entry.includes('cloudflareinsights');
}

/**
 * Creates smoke tests for a set of routes.
 * Each route is tested for: HTTP status, non-blank content, no 404, no fatal JS errors.
 */
export function createSmokeTests(suiteName: string, routes: string[]) {
  test.describe(suiteName, () => {
    for (const route of routes) {
      test(`loads ${route} without errors`, async ({ page }) => {
        const errors: string[] = [];
        const httpErrors: string[] = [];
        page.on('console', msg => {
          if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('pageerror', err => errors.push(err.message));
        page.on('response', res => {
          if (res.status() >= 400) httpErrors.push(httpErrorEntry(res.status(), res.request().method(), res.url()));
        });
        const fatal = () => [
          // The URL-less console line is replaced by the httpErrors entry.
          ...errors.filter(e => !e.startsWith('Failed to load resource')).filter(isFatalError),
          ...httpErrors.filter(isAppHttpError),
        ];

        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });

        // HTTP status < 500
        expect(response?.status()).toBeLessThan(500);

        // Not blank (waits for the SPA to render). On failure, say where the
        // page ended up and what failed, so a blank screen is diagnosable.
        let bodyText: string;
        try {
          bodyText = await renderedBodyText(page);
        } catch (e) {
          throw new Error(`${(e as Error).message}\nlanded on: ${page.url()}\nerrors: ${JSON.stringify(fatal(), null, 1)}`);
        }

        // No 404 text
        expect(bodyText.toLowerCase()).not.toContain('page not found');

        // No fatal JS errors or failed app requests (ignore common noise)
        expect(fatal()).toHaveLength(0);
      });
    }
  });
}

/**
 * Creates mobile smoke tests — same as desktop but with additional
 * checks for horizontal overflow and content visibility.
 */
export function createMobileSmokeTests(suiteName: string, routes: string[]) {
  test.describe(suiteName, () => {
    for (const route of routes) {
      test(`loads ${route} without errors (mobile)`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', err => errors.push(err.message));

        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
        expect(response?.status()).toBeLessThan(500);

        const bodyText = await renderedBodyText(page);
        expect(bodyText.toLowerCase()).not.toContain('page not found');

        // Check for horizontal overflow (common mobile bug)
        const hasOverflow = await page.evaluate(() => {
          return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        });
        expect(hasOverflow).toBe(false);

        const fatalErrors = errors.filter(isFatalError);
        expect(fatalErrors).toHaveLength(0);
      });
    }
  });
}

/**
 * A mobile screen and its load-time budget (milliseconds).
 *   lcp  — Largest Contentful Paint ceiling.
 *   load — full `load` event ceiling (proxy for time-to-interactive).
 */
export interface MobilePerfTarget {
  name: string;
  route: string;
  lcp: number;
  load: number;
}

/**
 * Creates mobile performance-budget tests. Unlike the smoke tests (which only
 * assert a screen *renders*), these fail when a screen renders too *slowly* —
 * so a load-time regression on Events / Memory / Live Rooms / etc. breaks CI
 * instead of waiting for a user complaint.
 *
 * Measures LCP (via PerformanceObserver) and the navigation `load` event, then
 * asserts each against the per-screen budget. Run under the `mobile-*`
 * Playwright projects (iPhone-14 emulation) so the numbers reflect mobile.
 */
export function createMobilePerfTests(suiteName: string, targets: MobilePerfTarget[]) {
  test.describe(suiteName, () => {
    for (const target of targets) {
      test(`${target.name} (${target.route}) loads within budget`, async ({ page }) => {
        const response = await page.goto(target.route, { waitUntil: 'load' });
        expect(response?.status()).toBeLessThan(500);

        // LCP: read the last largest-contentful-paint entry the browser saw.
        // buffered:true replays entries from before the observer attached.
        const lcp = await page.evaluate<number>(() => {
          return new Promise<number>((resolve) => {
            let last = 0;
            try {
              const po = new PerformanceObserver((list) => {
                for (const e of list.getEntries()) last = (e as PerformanceEntry).startTime;
              });
              po.observe({ type: 'largest-contentful-paint', buffered: true });
              // LCP finalizes on the next frame after load; give it a beat.
              setTimeout(() => { po.disconnect(); resolve(last); }, 500);
            } catch {
              resolve(0);
            }
          });
        });

        const loadMs = await page.evaluate<number>(() => {
          const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
          return nav ? nav.loadEventEnd : 0;
        });

        // 0 means the metric wasn't captured (e.g. no contentful paint) — don't
        // fail the budget on a missing sample, only on a real over-budget value.
        if (lcp > 0) {
          expect(lcp, `${target.name} LCP ${Math.round(lcp)}ms > ${target.lcp}ms budget`).toBeLessThanOrEqual(target.lcp);
        }
        if (loadMs > 0) {
          expect(loadMs, `${target.name} load ${Math.round(loadMs)}ms > ${target.load}ms budget`).toBeLessThanOrEqual(target.load);
        }
      });
    }
  });
}

/** The path a navigation ended on, or the ?redirectTo= target of a sign-in page. */
function landedPath(url: string): string {
  const u = new URL(url);
  const redirectTo = u.searchParams.get('redirectTo');
  return redirectTo ? redirectTo.split('?')[0] : u.pathname;
}

/**
 * Creates redirect tests — verifies legacy routes resolve to new paths.
 * Each redirect is tested: navigate to old path, assert the page lands on the
 * new path. `signedOut` runs the suite in a fresh context with no session.
 */
export function createRedirectTests(
  suiteName: string,
  redirectMap: Record<string, string>,
  options: { signedOut?: boolean } = {},
) {
  test.describe(suiteName, () => {
    if (options.signedOut) test.use({ storageState: { cookies: [], origins: [] } });
    for (const [oldPath, newPath] of Object.entries(redirectMap)) {
      test(`redirects ${oldPath} → ${newPath}`, async ({ page }) => {
        await page.goto(oldPath, { waitUntil: 'domcontentloaded' });

        // Compare the landed pathname exactly (a substring match on the whole
        // URL passed trivially for '/'). A route the test user may not open
        // lands on a sign-in page that carries the target as ?redirectTo=,
        // which still proves the redirect resolved to the right place.
        const expectedBase = newPath.split('?')[0];
        await expect
          .poll(() => landedPath(page.url()), { timeout: NAVIGATION_TIMEOUT_MS })
          .toBe(expectedBase);
      });
    }
  });
}

const SIGNED_OUT_LANDING = /^\/($|auth\b|maxina\b|alkalma\b|earthlinks\b|exafy-admin\b|dev\/login\b)/;

/**
 * Creates auth guard tests — verifies unauthenticated users are redirected to
 * the landing page or a sign-in page.
 * Uses a fresh browser context with no stored session.
 */
export function createAuthGuardTests(suiteName: string, protectedRoutes: string[]) {
  test.describe(suiteName, () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const route of protectedRoutes) {
      test(`${route} redirects to auth when not logged in`, async ({ page }) => {
        await page.goto(route, { waitUntil: 'domcontentloaded' });

        // Wait for the auth guard redirect instead of sleeping a fixed 3 s.
        // A signed-out user is sent to the landing page '/' (the portal
        // selector, useSmartRouting) or to a tenant portal / sign-in page.
        // Poll the pathname so a failure prints where the page really landed.
        await expect
          .poll(() => new URL(page.url()).pathname, { timeout: NAVIGATION_TIMEOUT_MS })
          .toMatch(SIGNED_OUT_LANDING);
      });
    }
  });
}

/**
 * Creates role guard tests — verifies that a lower-privilege user
 * sees "Not Authorized" when accessing higher-privilege routes.
 */
export function createRoleGuardTests(
  suiteName: string,
  routesByRole: Record<string, string[]>,
) {
  test.describe(suiteName, () => {
    // Community user (lowest privilege) tries to access role-restricted routes
    for (const [role, routes] of Object.entries(routesByRole)) {
      for (const route of routes) {
        test(`community user blocked from ${role} route ${route}`, async ({ page }) => {
          const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
          expect(response?.status()).toBeLessThan(500);

          // Wait for the role check: either "Not Authorized" text or a redirect
          // away from the route, polled instead of a fixed 2 s sleep.
          await expect
            .poll(async () => {
              const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
              return bodyText.includes('not authorized') ||
                bodyText.includes('unauthorized') ||
                bodyText.includes('access denied') ||
                !page.url().includes(route);
            }, { timeout: NAVIGATION_TIMEOUT_MS })
            .toBe(true);
        });
      }
    }
  });
}
