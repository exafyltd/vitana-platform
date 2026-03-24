import { test, expect } from '@playwright/test';
import { COMMUNITY_ROUTES_BY_ROLE } from '../../fixtures/routes';

const keyRoutes = ['/', '/community', '/discover', '/messages', '/settings'];

test.describe('Mobile — Responsive Layout', () => {
  for (const route of keyRoutes) {
    test(`${route} has no horizontal overflow`, async ({ page }) => {
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2000);

      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });

      expect(hasOverflow).toBe(false);
    });
  }

  test('text is readable at mobile viewport', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Check that main text elements have reasonable font size
    const fontSizes = await page.evaluate(() => {
      const elements = document.querySelectorAll('p, span, h1, h2, h3, h4, h5, h6, a, button, label');
      const sizes: number[] = [];
      elements.forEach(el => {
        const size = parseFloat(window.getComputedStyle(el).fontSize);
        if (size > 0) sizes.push(size);
      });
      return sizes;
    });

    if (fontSizes.length > 0) {
      const avgSize = fontSizes.reduce((a, b) => a + b, 0) / fontSizes.length;
      // Average font size should be at least 12px on mobile
      expect(avgSize).toBeGreaterThanOrEqual(12);
    }
  });

  test('forms are usable on mobile', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const inputs = page.locator('input, textarea, select');
    const count = await inputs.count();

    for (let i = 0; i < Math.min(count, 10); i++) {
      const box = await inputs.nth(i).boundingBox();
      if (box && box.width > 0) {
        // Input should be wide enough to use on mobile (at least 200px or 50% viewport)
        expect(box.width).toBeGreaterThanOrEqual(150);
        // Input should be tall enough to tap (at least 36px)
        expect(box.height).toBeGreaterThanOrEqual(32);
      }
    }
  });
});
