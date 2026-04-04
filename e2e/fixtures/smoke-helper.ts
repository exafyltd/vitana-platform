import { test, expect } from '@playwright/test';

/**
 * Creates smoke tests for a set of routes.
 * Each route is tested for: HTTP status, non-blank content, no 404, no fatal JS errors.
 */
export function createSmokeTests(suiteName: string, routes: string[]) {
  test.describe(suiteName, () => {
    for (const route of routes) {
      test(`loads ${route} without errors`, async ({ page }) => {
        const errors: string[] = [];
        page.on('console', msg => {
          if (msg.type() === 'error') errors.push(msg.text());
        });
        page.on('pageerror', err => errors.push(err.message));

        const response = await page.goto(route, { waitUntil: 'domcontentloaded' });

        // HTTP status < 500
        expect(response?.status()).toBeLessThan(500);

        // Not blank
        const bodyText = await page.locator('body').innerText();
        expect(bodyText.length).toBeGreaterThan(10);

        // No 404 text
        expect(bodyText.toLowerCase()).not.toContain('page not found');

        // No fatal JS errors (ignore common noise)
        const fatalErrors = errors.filter(e =>
          !e.includes('favicon') &&
          !e.includes('analytics') &&
          !e.includes('GTM') &&
          !e.includes('hotjar') &&
          !e.includes('ResizeObserver') &&
          !e.includes('hydration') &&
          !e.includes('Warning:') &&
          !e.includes('ERR_BLOCKED_BY_CLIENT') &&
          !e.includes('net::ERR_')
        );
        expect(fatalErrors).toHaveLength(0);
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

        const bodyText = await page.locator('body').innerText();
        expect(bodyText.length).toBeGreaterThan(10);
        expect(bodyText.toLowerCase()).not.toContain('page not found');

        // Check for horizontal overflow (common mobile bug)
        const hasOverflow = await page.evaluate(() => {
          return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        });
        expect(hasOverflow).toBe(false);

        const fatalErrors = errors.filter(e =>
          !e.includes('favicon') &&
          !e.includes('analytics') &&
          !e.includes('GTM') &&
          !e.includes('hotjar') &&
          !e.includes('ResizeObserver') &&
          !e.includes('hydration') &&
          !e.includes('Warning:') &&
          !e.includes('ERR_BLOCKED_BY_CLIENT') &&
          !e.includes('net::ERR_')
        );
        expect(fatalErrors).toHaveLength(0);
      });
    }
  });
}

/**
 * Creates redirect tests — verifies legacy routes resolve to new paths.
 * Each redirect is tested: navigate to old path, assert URL contains new path.
 */
export function createRedirectTests(suiteName: string, redirectMap: Record<string, string>) {
  test.describe(suiteName, () => {
    for (const [oldPath, newPath] of Object.entries(redirectMap)) {
      test(`redirects ${oldPath} → ${newPath}`, async ({ page }) => {
        await page.goto(oldPath, { waitUntil: 'domcontentloaded' });

        // Wait for redirect to settle
        await page.waitForTimeout(2000);

        const currentUrl = page.url();
        // Strip query params from expected path for matching
        const expectedBase = newPath.split('?')[0];
        expect(currentUrl).toContain(expectedBase);
      });
    }
  });
}

/**
 * Creates auth guard tests — verifies unauthenticated users are redirected to /auth.
 * Uses a fresh browser context with no stored session.
 */
export function createAuthGuardTests(suiteName: string, protectedRoutes: string[]) {
  test.describe(suiteName, () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    for (const route of protectedRoutes) {
      test(`${route} redirects to auth when not logged in`, async ({ page }) => {
        await page.goto(route, { waitUntil: 'domcontentloaded' });

        // Wait for auth guard redirect
        await page.waitForTimeout(3000);

        const currentUrl = page.url();
        // Should redirect to /auth or a tenant portal login
        const isAuthPage = currentUrl.includes('/auth') ||
          currentUrl.includes('/maxina') ||
          currentUrl.includes('/alkalma') ||
          currentUrl.includes('/earthlinks') ||
          currentUrl.includes('/dev/login');

        expect(isAuthPage).toBe(true);
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

          // Wait for role check to complete
          await page.waitForTimeout(2000);

          const bodyText = await page.locator('body').innerText();
          const currentUrl = page.url();

          // Either shows "Not Authorized" text or redirects away from the route
          const isBlocked =
            bodyText.toLowerCase().includes('not authorized') ||
            bodyText.toLowerCase().includes('unauthorized') ||
            bodyText.toLowerCase().includes('access denied') ||
            !currentUrl.includes(route);

          expect(isBlocked).toBe(true);
        });
      }
    }
  });
}
