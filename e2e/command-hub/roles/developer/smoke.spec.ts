import { test, expect } from '@playwright/test';
import { ALL_HUB_ROUTES } from '../../../fixtures/routes';

test.describe('Command Hub — Developer Role (All 87 Screens)', () => {
  for (const route of ALL_HUB_ROUTES) {
    test(`loads ${route}`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', err => errors.push(err.message));

      await page.goto(route, { waitUntil: 'domcontentloaded' });

      // Root element rendered
      await expect(page.locator('#root')).not.toBeEmpty();

      // Sidebar present
      const sidebar = page.locator('.sidebar, [class*="sidebar"]').first();
      await expect(sidebar).toBeVisible({ timeout: 5000 });

      // Header present
      const header = page.locator('.header, [class*="header"], header').first();
      await expect(header).toBeVisible({ timeout: 5000 });

      // No fatal JS errors
      const fatalErrors = errors.filter(e => !e.includes('favicon'));
      expect(fatalErrors).toHaveLength(0);
    });
  }
});
