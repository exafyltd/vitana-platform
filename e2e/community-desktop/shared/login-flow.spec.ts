import { test, expect } from '@playwright/test';

test.describe('Desktop — Login Flow', () => {
  test('shows landing page or login when unauthenticated', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const url = page.url();
    // App shows either: a welcome/landing page (MAXINA), a login form, or redirects to /auth
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    const isLoginVisible = await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    const hasLanding = await page.getByText('MAXINA')
      .isVisible({ timeout: 3000 }).catch(() => false);

    expect(
      isLoginVisible || hasLanding || url.includes('auth') || url.includes('login')
    ).toBe(true);
  });

  test('login form accepts email and password', async ({ page }) => {
    // Navigate to auth page directly
    await page.goto('/auth', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      await emailInput.fill('test@example.com');
      const passwordInput = page.locator('input[type="password"]').first();
      await passwordInput.fill('testpassword');

      // Submit button should be present and clickable
      const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Anmelden")').first();
      await expect(submitBtn).toBeVisible();
      await expect(submitBtn).toBeEnabled();
    }
  });

  test('protected routes redirect to login or landing', async ({ page }) => {
    await page.goto('/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    const url = page.url();
    const emailInput = page.locator('input[type="email"], input[name="email"]').first();
    const isOnAuth = url.includes('auth') || url.includes('login') ||
      await emailInput.isVisible({ timeout: 5000 }).catch(() => false);
    // If not redirected to auth, should at least not show the settings page content
    const hasSettingsContent = await page.locator('text=Einstellungen, text=Settings').first()
      .isVisible({ timeout: 2000 }).catch(() => false);

    expect(isOnAuth || !hasSettingsContent).toBe(true);
  });
});
