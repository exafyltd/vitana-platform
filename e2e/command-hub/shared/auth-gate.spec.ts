import { test, expect } from '@playwright/test';

test.describe('Command Hub — Auth Gate', () => {
  test('shows login form when not authenticated', async ({ page }) => {
    // Clear any stored auth
    await page.goto('/command-hub/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('vitana.authToken'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    // Should see auth gate with email/password form
    const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    const hasAuthForm = (
      await emailInput.isVisible({ timeout: 5000 }).catch(() => false) ||
      await passwordInput.isVisible({ timeout: 5000 }).catch(() => false)
    );

    expect(hasAuthForm).toBe(true);
  });

  test('login form has submit button', async ({ page }) => {
    await page.goto('/command-hub/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.removeItem('vitana.authToken'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const submitBtn = page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign in")').first();
    const hasSubmit = await submitBtn.isVisible({ timeout: 5000 }).catch(() => false);

    expect(hasSubmit).toBe(true);
  });
});
