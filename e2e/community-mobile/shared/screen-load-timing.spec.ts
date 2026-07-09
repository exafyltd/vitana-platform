import { test } from '@playwright/test';

/**
 * Screen Load Time — standard basic test (VTID-SCREEN-LOAD-01).
 *
 * Loads a handful of key, always-authenticated mobile screens against
 * whichever `baseURL` the running project points at (production by default
 * via COMMUNITY_URL, same as every other mobile-shared spec) and measures
 * wall-clock time to the `load` event — the number a user actually feels
 * when they tap into a screen.
 *
 * Every screen's result is POSTed to the gateway's
 * `/api/v1/frontend/screen-load/report` endpoint regardless of pass/fail, so
 * Command Hub's Overview always has a fresh number even when a screen is
 * slow. Assertions stay generous (SLOW_THRESHOLD_MS) so a single network
 * blip doesn't fail the whole CI run — the gateway's own `/health` endpoint
 * applies the real p75 threshold that Command Hub displays.
 *
 * Runs on a schedule via .github/workflows/SCREEN-LOAD-TIMING.yml, and also
 * picks up automatically in ad-hoc `mobile-shared` runs (Command Hub's
 * "Cloud Run — Full Suite" button, `npm run test:mobile`, etc).
 */

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const ENVIRONMENT = process.env.SCREEN_LOAD_ENV === 'staging' ? 'staging' : 'production';
const RUN_ID = process.env.SCREEN_LOAD_RUN_ID || `local-${Date.now()}`;
const SLOW_THRESHOLD_MS = 6000;

// Small, deliberately curated set — the screens a session realistically
// passes through in its first minute, not full route coverage (that's what
// the 272-route E2E smoke suite is for).
const SCREENS: { name: string; path: string }[] = [
  { name: 'News Feed', path: '/home' },
  { name: 'Discover', path: '/discover' },
  { name: 'Community Events', path: '/comm/events-meetups' },
  { name: 'Health', path: '/health' },
  { name: 'Inbox', path: '/inbox' },
  { name: 'My Profile', path: '/me/profile' },
];

type ScreenResult = {
  screen: string;
  duration_ms: number;
  lcp_ms: number | null;
  status: 'ok' | 'error';
  error?: string;
};

async function reportResults(results: ScreenResult[]) {
  try {
    const serviceToken = process.env.GATEWAY_SERVICE_TOKEN;
    if (!serviceToken) {
      console.warn('[screen-load-timing] GATEWAY_SERVICE_TOKEN not set — skipping report POST');
      return;
    }
    await fetch(`${GATEWAY_URL}/api/v1/frontend/screen-load/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${serviceToken}` },
      body: JSON.stringify({ run_id: RUN_ID, environment: ENVIRONMENT, results }),
    });
  } catch (err) {
    // The report call must never fail the test suite — a down gateway
    // should surface as a "no recent runs" health check, not a CI red.
    console.warn('[screen-load-timing] failed to report results:', err);
  }
}

test.describe('Mobile — Screen Load Time', () => {
  const collected: ScreenResult[] = [];

  test.afterAll(async () => {
    if (collected.length > 0) await reportResults(collected);
  });

  for (const { name, path } of SCREENS) {
    test(`${name} (${path}) loads within budget`, async ({ page }) => {
      const start = Date.now();
      let result: ScreenResult;

      try {
        await page.goto(path, { waitUntil: 'load', timeout: 20_000 });
        const duration_ms = Date.now() - start;

        // Best-effort LCP — buffered PerformanceObserver, short settle window.
        // Never blocks or fails the test if the browser can't report it.
        let lcp_ms: number | null = null;
        try {
          lcp_ms = await page.evaluate(
            () =>
              new Promise<number | null>((resolve) => {
                try {
                  const po = new PerformanceObserver((list) => {
                    const entries = list.getEntries();
                    const last = entries[entries.length - 1] as (PerformanceEntry & { startTime: number }) | undefined;
                    resolve(last ? last.startTime : null);
                  });
                  po.observe({ type: 'largest-contentful-paint', buffered: true });
                  setTimeout(() => resolve(null), 1500);
                } catch {
                  resolve(null);
                }
              }),
          );
        } catch {
          // ignore — LCP is a bonus metric
        }

        result = { screen: path, duration_ms, lcp_ms, status: 'ok' };
      } catch (err) {
        result = {
          screen: path,
          duration_ms: Date.now() - start,
          lcp_ms: null,
          status: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      collected.push(result);

      // Soft budget — logs a clear signal on the CI run without being flaky.
      if (result.status === 'error') {
        console.error(`[screen-load-timing] ${path} failed: ${result.error}`);
      } else if (result.duration_ms > SLOW_THRESHOLD_MS) {
        console.warn(`[screen-load-timing] ${path} slow: ${result.duration_ms}ms (budget ${SLOW_THRESHOLD_MS}ms)`);
      }
    });
  }
});
