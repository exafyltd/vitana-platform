import { type Page } from '@playwright/test';

export const TEST_USER = {
  email: process.env.TEST_USER_EMAIL || 'dstevanovic@outlook.com',
  password: process.env.TEST_USER_PASSWORD || '',
};

/** Call at the start of auth setup to fail fast if credentials are missing */
export function validateTestCredentials() {
  if (!TEST_USER.password) {
    throw new Error(
      'TEST_USER_PASSWORD env var is required but empty. ' +
      'Set it in GitHub Actions secrets or export it locally.',
    );
  }
}

export const SUPABASE_CONFIG = {
  url: process.env.SUPABASE_URL || 'https://inmkhvwdcuyhnxkgfvsb.supabase.co',
  anonKey: process.env.SUPABASE_ANON_KEY || '',
};

export type UserRole = 'community' | 'patient' | 'professional' | 'staff' | 'admin' | 'developer';

/**
 * Login via the Lovable frontend's Supabase auth form, then switch to target role.
 * Stores auth state in localStorage for reuse.
 */
export async function loginAsRole(page: Page, role: UserRole): Promise<void> {
  const baseURL = role === 'developer'
    ? (process.env.HUB_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app')
    : (process.env.COMMUNITY_URL || 'https://vitanaland.com');

  // Navigate to the app
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  // Wait for auth page or redirect
  await page.waitForTimeout(2000);

  // Try to fill login form if present
  const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
  const passwordInput = page.locator('input[type="password"]').first();

  if (await emailInput.isVisible({ timeout: 5000 }).catch(() => false)) {
    await emailInput.fill(TEST_USER.email);
    await passwordInput.fill(TEST_USER.password);

    // Click submit
    const submitBtn = page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Anmelden")').first();
    await submitBtn.click();

    // Wait for navigation after login
    await page.waitForTimeout(3000);
  }

  // Switch to target role via API
  const token = await page.evaluate(() => {
    return localStorage.getItem('vitana.authToken')
      || localStorage.getItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token');
  });

  if (token) {
    // Parse JWT from Supabase storage if needed
    let jwt = token;
    try {
      const parsed = JSON.parse(token);
      jwt = parsed.access_token || token;
    } catch { /* already a raw JWT */ }

    // Switch role via gateway
    const gatewayUrl = process.env.HUB_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
    await page.evaluate(async ({ gatewayUrl, jwt, role }) => {
      await fetch(`${gatewayUrl}/api/v1/me/active-role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${jwt}`,
        },
        body: JSON.stringify({ role }),
      });
      // Store role in localStorage for the app to pick up
      localStorage.setItem('vitana.viewRole', role);
    }, { gatewayUrl, jwt, role });
  }

  // Reload to apply role
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
}
