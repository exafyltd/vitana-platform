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
          !e.includes('hotjar')
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
          !e.includes('favicon') && !e.includes('analytics')
        );
        expect(fatalErrors).toHaveLength(0);
      });
    }
  });
}
