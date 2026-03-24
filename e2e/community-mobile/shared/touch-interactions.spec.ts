import { test, expect } from '@playwright/test';

test.describe('Mobile — Touch Interactions', () => {
  test('interactive elements have adequate tap target size (>= 44px)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Check all buttons and links
    const interactiveElements = page.locator('button, a, [role="button"], input[type="submit"]');
    const count = await interactiveElements.count();

    let tooSmall = 0;
    for (let i = 0; i < Math.min(count, 20); i++) {
      const box = await interactiveElements.nth(i).boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        // At least one dimension should be >= 44px (Apple HIG minimum)
        if (box.width < 44 && box.height < 44) {
          tooSmall++;
        }
      }
    }

    // Allow up to 20% to be small (icon buttons, etc.)
    const ratio = tooSmall / Math.min(count, 20);
    expect(ratio).toBeLessThan(0.2);
  });

  test('page content is scrollable', async ({ page }) => {
    await page.goto('/community', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const initialScroll = await page.evaluate(() => window.scrollY);

    // Scroll down
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);

    const afterScroll = await page.evaluate(() => window.scrollY);

    // If page has scrollable content, scroll position should change
    // (If page fits in viewport, this is acceptable too)
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = await page.evaluate(() => window.innerHeight);

    if (bodyHeight > viewportHeight) {
      expect(afterScroll).toBeGreaterThan(initialScroll);
    }
  });
});
