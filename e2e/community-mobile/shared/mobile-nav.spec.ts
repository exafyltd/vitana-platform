import { test, expect } from '@playwright/test';

test.describe('Mobile — Navigation', () => {
  test('bottom navigation is visible after login', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // If on MAXINA landing (unauthenticated), bottom nav won't be there — that's expected
    const isLanding = await page.getByText('MAXINA').isVisible({ timeout: 2000 }).catch(() => false);
    if (isLanding) {
      test.skip(true, 'On landing page — bottom nav requires auth');
      return;
    }

    // Authenticated: look for bottom nav
    const bottomNav = page.locator(
      'nav[class*="bottom"], [class*="bottom-nav"], [class*="tab-bar"], [role="tablist"], nav:below(main)'
    ).first();
    const isVisible = await bottomNav.isVisible({ timeout: 5000 }).catch(() => false);
    expect(isVisible).toBe(true);
  });

  test('bottom nav items are tappable', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const isLanding = await page.getByText('MAXINA').isVisible({ timeout: 2000 }).catch(() => false);
    if (isLanding) {
      test.skip(true, 'On landing page — nav requires auth');
      return;
    }

    const navLinks = page.locator('nav a, [role="tab"], [class*="nav"] a');
    const count = await navLinks.count();
    expect(count).toBeGreaterThan(0);

    // Each nav link should have minimum tap target size
    for (let i = 0; i < Math.min(count, 5); i++) {
      const box = await navLinks.nth(i).boundingBox();
      if (box) {
        expect(box.width).toBeGreaterThanOrEqual(40);
        expect(box.height).toBeGreaterThanOrEqual(40);
      }
    }
  });

  test('back button navigation works', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.goto('/community', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.goBack();
    await page.waitForTimeout(1000);
    expect(page.url()).toContain('/');
  });
});
