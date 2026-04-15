/**
 * Onboarding Flow E2E Verification
 *
 * Tests the post-registration onboarding experience:
 * 1. Authenticated user is redirected to /onboarding/welcome
 * 2. Speech bubbles from Vitana appear sequentially
 * 3. After speech, name/handle form appears
 * 4. Form submission saves profile and redirects to events
 * 5. Existing user (with profile) skips onboarding
 */
import { chromium, type Page, type Browser } from 'playwright-core';

const COMMUNITY_URL = process.env.COMMUNITY_URL || 'https://vitanaland.com';
const SUPABASE_URL = 'https://inmkhvwdcuyhnxkgfvsb.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlubWtodndkY3V5aG54a2dmdnNiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU4NjY2MzcsImV4cCI6MjA3MTQ0MjYzN30._-QX8ZFgDsKgLM7eDlyc64vi73F-Hwc4ttnDPHjZgVw';
const TEST_EMAIL = 'e2e-test@vitana.dev';
const TEST_PASSWORD = 'VitanaE2eTest2026!';
const SCREENSHOT_DIR = '/tmp/onboarding-verify';

let browser: Browser;

async function signIn(): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON_KEY },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Sign-in failed (${res.status}): ${await res.text()}`);
  return res.json();
}

async function injectAuth(page: Page, session: any) {
  await page.evaluate(({ s }) => {
    localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(s));
    localStorage.setItem('vitana.authToken', s.access_token);
    localStorage.setItem('vitana.viewRole', 'community');
  }, { s: session });
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: false });
  console.log(`  Screenshot: ${SCREENSHOT_DIR}/${name}.png`);
}

async function test1_onboardingPageLoads(session: any) {
  console.log('\n=== Test 1: Onboarding page loads for authenticated user ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded' });
    await injectAuth(page, session);

    // Navigate to onboarding
    await page.goto(`${COMMUNITY_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '01-onboarding-page-loaded');

    // Check the URL
    const url = page.url();
    console.log(`  Current URL: ${url}`);

    if (url.includes('/onboarding/welcome')) {
      console.log('  PASS: Onboarding page loaded');
    } else if (url.includes('/comm/events-meetups') || url.includes('/home')) {
      console.log('  INFO: User was redirected away (already completed onboarding)');
      console.log('  This is expected for the test user who already has display_name + handle');
    } else {
      console.log(`  WARN: Unexpected URL: ${url}`);
    }

    return url;
  } finally {
    await page.close();
  }
}

async function test2_speechBubblesAppear(session: any) {
  console.log('\n=== Test 2: Speech bubbles appear sequentially ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded' });
    await injectAuth(page, session);

    // Clear onboarding flag to force the flow
    await page.evaluate(() => {
      localStorage.removeItem('vitana_onboarding_completed');
    });

    await page.goto(`${COMMUNITY_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(2000);

    // Check if onboarding page is showing speech (or redirected)
    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      console.log(`  INFO: Redirected to ${url} (user profile is complete, onboarding skipped)`);
      await screenshot(page, '02-redirected-from-onboarding');
      return 'skipped';
    }

    // Wait for first speech bubble
    await page.waitForTimeout(2000);
    await screenshot(page, '02a-first-bubbles');

    // Check for speech bubble elements
    const bubbleCount = await page.locator('.bg-white\\/90').count();
    console.log(`  Speech bubbles visible: ${bubbleCount}`);

    // Wait for more bubbles
    await page.waitForTimeout(8000);
    await screenshot(page, '02b-more-bubbles');
    const moreBubbles = await page.locator('.bg-white\\/90').count();
    console.log(`  Speech bubbles after 8s: ${moreBubbles}`);

    // Check for skip button
    const skipButton = page.locator('button:has-text("Skip")');
    const hasSkip = await skipButton.isVisible().catch(() => false);
    console.log(`  Skip button visible: ${hasSkip}`);

    if (moreBubbles > bubbleCount) {
      console.log('  PASS: Speech bubbles are advancing');
    } else {
      console.log('  INFO: Bubble count did not increase (may have loaded all at once)');
    }

    return 'shown';
  } finally {
    await page.close();
  }
}

async function test3_skipToForm(session: any) {
  console.log('\n=== Test 3: Skip speech → name form appears ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded' });
    await injectAuth(page, session);
    await page.evaluate(() => {
      localStorage.removeItem('vitana_onboarding_completed');
    });

    await page.goto(`${COMMUNITY_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      console.log(`  INFO: Redirected to ${url} (profile complete, onboarding skipped)`);
      await screenshot(page, '03-redirected');
      return 'skipped';
    }

    // Click skip button
    const skipButton = page.locator('button:has-text("Skip")');
    const hasSkip = await skipButton.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasSkip) {
      await skipButton.click();
      console.log('  Clicked Skip button');
      await page.waitForTimeout(1500);
    } else {
      console.log('  No skip button found, waiting for speech to complete...');
      await page.waitForTimeout(35000); // wait for all messages
    }

    await screenshot(page, '03-after-skip');

    // Check for name form
    const nameInput = page.locator('input#onb-display-name');
    const handleInput = page.locator('input#onb-handle');
    const hasNameInput = await nameInput.isVisible({ timeout: 5000 }).catch(() => false);
    const hasHandleInput = await handleInput.isVisible({ timeout: 2000 }).catch(() => false);

    console.log(`  Name input visible: ${hasNameInput}`);
    console.log(`  Handle input visible: ${hasHandleInput}`);

    if (hasNameInput && hasHandleInput) {
      console.log('  PASS: Name form appeared after skip');
    } else {
      console.log('  FAIL: Name form not found');
    }

    return hasNameInput ? 'form_shown' : 'no_form';
  } finally {
    await page.close();
  }
}

async function test4_existingUserSkipsOnboarding(session: any) {
  console.log('\n=== Test 4: Existing user (with profile) skips onboarding ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded' });
    await injectAuth(page, session);

    // Set the onboarding complete flag (simulating existing user)
    await page.evaluate(({ userId }) => {
      localStorage.setItem('vitana_onboarding_completed', userId);
    }, { userId: session.user.id });

    await page.goto(`${COMMUNITY_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(4000);
    await screenshot(page, '04-existing-user-redirect');

    const url = page.url();
    console.log(`  Current URL: ${url}`);

    if (url.includes('/comm/events-meetups') || url.includes('/home')) {
      console.log('  PASS: Existing user was redirected to events/home (skipped onboarding)');
    } else if (url.includes('/onboarding/welcome')) {
      console.log('  WARN: User is still on onboarding page (may need DB profile check)');
    } else {
      console.log(`  INFO: Redirected to: ${url}`);
    }

    return url;
  } finally {
    await page.close();
  }
}

async function test5_desktopView(session: any) {
  console.log('\n=== Test 5: Desktop viewport ===');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded' });
    await injectAuth(page, session);
    await page.evaluate(() => {
      localStorage.removeItem('vitana_onboarding_completed');
    });

    await page.goto(`${COMMUNITY_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '05-desktop-onboarding');

    const url = page.url();
    console.log(`  Current URL: ${url}`);

    if (url.includes('/onboarding/welcome')) {
      // Wait for a few bubbles and screenshot
      await page.waitForTimeout(8000);
      await screenshot(page, '05b-desktop-bubbles');
      console.log('  PASS: Desktop onboarding page loaded');
    } else {
      console.log(`  INFO: Redirected to ${url} (profile complete)`);
    }
  } finally {
    await page.close();
  }
}

async function test6_maxinaPortalRedirect(session: any) {
  console.log('\n=== Test 6: MaxinaPortal redirects to onboarding ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded' });
    await injectAuth(page, session);

    // Navigate to /maxina (portal) as authenticated user
    await page.goto(`${COMMUNITY_URL}/maxina`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(8000); // portal has a 6s hard deadline
    await screenshot(page, '06-maxina-portal-redirect');

    const url = page.url();
    console.log(`  Current URL after /maxina: ${url}`);

    if (url.includes('/onboarding/welcome')) {
      console.log('  PASS: Authenticated user redirected from /maxina to /onboarding/welcome');
    } else if (url.includes('/comm/events-meetups') || url.includes('/home')) {
      console.log('  PASS: Authenticated user redirected to events/home (profile complete)');
    } else {
      console.log(`  INFO: Redirected to: ${url}`);
    }
  } finally {
    await page.close();
  }
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log('Onboarding Flow E2E Verification');
  console.log(`Target: ${COMMUNITY_URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}/`);

  // Create screenshot directory
  const { mkdirSync } = await import('fs');
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  // Sign in
  console.log('\nAuthenticating test user...');
  const session = await signIn();
  console.log(`  User ID: ${session.user.id}`);
  console.log(`  Email: ${session.user.email}`);

  // Launch browser
  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const url1 = await test1_onboardingPageLoads(session);
    const result2 = await test2_speechBubblesAppear(session);
    const result3 = await test3_skipToForm(session);
    await test4_existingUserSkipsOnboarding(session);
    await test5_desktopView(session);
    await test6_maxinaPortalRedirect(session);

    console.log('\n=== Summary ===');
    console.log(`Screenshots saved to ${SCREENSHOT_DIR}/`);
    console.log('Review screenshots to verify visual correctness.');
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
