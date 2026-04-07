import { type Page } from '@playwright/test';

export const TEST_USER = {
  email: process.env.TEST_USER_EMAIL || 'e2e-test@vitana.dev',
  password: process.env.TEST_USER_PASSWORD || 'VitanaE2eTest2026!',
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
  anonKey: process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlubWtodndkY3V5aG54a2dmdnNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4NjY2MzcsImV4cCI6MjA3MTQ0MjYzN30._-QX8ZFgDsKgLM7eDlyc64vi73F-Hwc4ttnDPHjZgVw',
};

export type UserRole = 'community' | 'patient' | 'professional' | 'staff' | 'admin' | 'developer';

/**
 * Authenticate via Supabase REST API, then inject session into browser.
 * Much more reliable than browser-based form login — no selectors to break.
 */
export async function loginAsRole(page: Page, role: UserRole): Promise<void> {
  const baseURL = role === 'developer'
    ? (process.env.HUB_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app')
    : (process.env.COMMUNITY_URL || 'https://vitanaland.com');

  // Step 1: Sign in via Supabase REST API (no browser interaction needed)
  const signInRes = await fetch(
    `${SUPABASE_CONFIG.url}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_CONFIG.anonKey,
      },
      body: JSON.stringify({
        email: TEST_USER.email,
        password: TEST_USER.password,
      }),
    },
  );

  if (!signInRes.ok) {
    const body = await signInRes.text();
    throw new Error(`Supabase sign-in failed (${signInRes.status}): ${body}`);
  }

  const session = await signInRes.json();
  const jwt = session.access_token;

  if (!jwt) {
    throw new Error('Supabase sign-in returned no access_token');
  }

  // Step 2: Navigate to the app and inject auth tokens into localStorage
  await page.goto(baseURL, { waitUntil: 'domcontentloaded' });

  await page.evaluate(({ session: s }) => {
    // Supabase JS client storage key
    const storageKey = 'sb-inmkhvwdcuyhnxkgfvsb-auth-token';
    localStorage.setItem(storageKey, JSON.stringify(s));
    // App-level auth token (some code reads this directly)
    localStorage.setItem('vitana.authToken', s.access_token);
  }, { session });

  // Step 3: Switch to target role via gateway API
  const gatewayUrl = process.env.HUB_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';

  await page.evaluate(async ({ gatewayUrl: gw, jwt: token, role: r }) => {
    try {
      await fetch(`${gw}/api/v1/me/active-role`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ role: r }),
      });
    } catch { /* gateway may be unreachable in some test configs — role stays default */ }
    localStorage.setItem('vitana.viewRole', r);
  }, { gatewayUrl, jwt, role });

  // Step 4: Reload to apply auth + role
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
}
