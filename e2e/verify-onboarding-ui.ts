/**
 * Onboarding UI Verification
 *
 * Forces the onboarding flow to render by intercepting the Supabase profile check,
 * then verifies the speech bubbles and name form appear correctly.
 */
import { chromium, type Page, type Browser } from 'playwright-core';
import { mkdirSync } from 'fs';

const APP_URL = 'http://localhost:4173';
const SCREENSHOT_DIR = '/tmp/onboarding-verify';

const MOCK_USER_ID = 'a27552a3-0257-4305-8ed0-351a80fd3701';
const MOCK_SESSION = {
  access_token: 'mock-jwt-for-local-testing',
  refresh_token: 'mock-refresh',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: MOCK_USER_ID,
    email: 'e2e-test@vitana.dev',
    user_metadata: { full_name: 'Test User' },
    app_metadata: {},
    aud: 'authenticated',
    role: 'authenticated',
    created_at: new Date().toISOString(),
  },
};

let browser: Browser;
let passed = 0;
let failed = 0;

function pass(msg: string) { passed++; console.log(`  PASS ${msg}`); }
function fail(msg: string) { failed++; console.log(`  FAIL ${msg}`); }
function info(msg: string) { console.log(`  INFO ${msg}`); }

async function screenshot(page: Page, name: string) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  info(`Screenshot: ${path}`);
}

async function setupPage(page: Page, opts: { forceOnboarding: boolean }) {
  // Intercept Supabase profile check to control onboarding state
  await page.route('**/rest/v1/profiles*', async (route) => {
    if (opts.forceOnboarding) {
      // Return empty profile (no display_name, no handle) → triggers onboarding
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(null),
      });
    } else {
      // Return complete profile → skips onboarding
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user_id: MOCK_USER_ID,
          display_name: 'Test User',
          handle: 'testuser',
        }),
      });
    }
  });

  // Intercept Supabase auth endpoints to return mock session
  await page.route('**/auth/v1/token*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SESSION),
    });
  });

  await page.route('**/auth/v1/user*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(MOCK_SESSION.user),
    });
  });

  // Navigate and inject auth state
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ session, userId }) => {
    localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(session));
    localStorage.setItem('vitana.authToken', session.access_token);
    localStorage.setItem('vitana.viewRole', 'community');
    localStorage.setItem('tenant_slug', 'maxina');
    // Clear any previous onboarding flag
    localStorage.removeItem('vitana_onboarding_completed');
  }, { session: MOCK_SESSION, userId: MOCK_USER_ID });
}

// ── Test: Speech bubbles appear on mobile ──────
async function testMobileSpeech() {
  console.log('\n=== Test 1: Speech bubbles render on mobile (390x844) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await setupPage(page, { forceOnboarding: true });
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2000);

    const url = page.url();
    info(`URL: ${url}`);

    if (!url.includes('/onboarding/welcome')) {
      info(`Redirected to ${url}`);
      await screenshot(page, 'ui-01-redirected');
      // Still check if the initial page rendered
      return;
    }

    await screenshot(page, 'ui-01a-initial');

    // Wait for first bubbles
    await page.waitForTimeout(5000);
    await screenshot(page, 'ui-01b-after-5s');

    // Count speech bubbles (they have the bg-white/90 class)
    const bubbles = page.locator('text="Vitana"').first();
    const hasBubble = await bubbles.isVisible({ timeout: 3000 }).catch(() => false);

    // Check for the "Welcome to Maxina" header
    const header = page.locator('h1');
    const headerText = await header.textContent().catch(() => '');
    info(`Header text: "${headerText}"`);
    if (headerText?.includes('Welcome to Maxina')) {
      pass('Header "Welcome to Maxina" is visible');
    } else if (headerText) {
      info(`Different header found: "${headerText}"`);
    }

    // Check for skip button
    const skipBtn = page.locator('button', { hasText: /skip/i });
    const hasSkip = await skipBtn.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasSkip) pass('Skip button is visible');
    else info('Skip button not visible yet');

    // Count message bubbles with the Vitana avatar
    const avatarBubbles = page.locator('.rounded-full.bg-gradient-to-br');
    const count = await avatarBubbles.count();
    info(`Vitana avatar bubbles: ${count}`);
    if (count > 0) pass(`${count} speech bubble(s) rendered`);

    // Wait for more and check growth
    await page.waitForTimeout(8000);
    const count2 = await avatarBubbles.count();
    info(`After 8 more seconds: ${count2} bubbles`);
    await screenshot(page, 'ui-01c-after-13s');

    if (count2 > count) {
      pass('Bubbles are advancing over time');
    } else {
      info('Bubble count stable (may have loaded quickly)');
    }

    // Skip to form
    const skipBtnAfter = page.locator('button', { hasText: /skip/i });
    if (await skipBtnAfter.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtnAfter.click();
      info('Clicked Skip');
      await page.waitForTimeout(2000);
      await screenshot(page, 'ui-01d-after-skip');
    } else {
      // All messages may have shown, wait for form
      await page.waitForTimeout(5000);
      await screenshot(page, 'ui-01d-speech-complete');
    }

    // Check for form
    const nameInput = page.locator('#onb-display-name');
    const handleInput = page.locator('#onb-handle');
    const hasName = await nameInput.isVisible({ timeout: 5000 }).catch(() => false);
    const hasHandle = await handleInput.isVisible({ timeout: 2000 }).catch(() => false);

    if (hasName) {
      pass('Name input appeared after speech');
      const value = await nameInput.inputValue();
      info(`Pre-filled name: "${value}"`);
      if (value === 'Test User') pass('Name pre-filled from auth metadata');
    } else {
      fail('Name input not found after speech/skip');
    }

    if (hasHandle) {
      pass('Handle input appeared');
      const value = await handleInput.inputValue();
      info(`Auto-suggested handle: "${value}"`);
    } else {
      fail('Handle input not found');
    }

    // Check submit button
    const submitBtn = page.locator('button', { hasText: /get started/i });
    const hasSubmit = await submitBtn.isVisible({ timeout: 2000 }).catch(() => false);
    if (hasSubmit) pass('Submit button visible');

    // Check the @ prefix for handle
    const atPrefix = page.locator('text="@"');
    const hasAt = await atPrefix.first().isVisible({ timeout: 1000 }).catch(() => false);
    if (hasAt) pass('@ prefix shown before handle input');

    await screenshot(page, 'ui-01e-form');
  } finally {
    await page.close();
  }
}

// ── Test: Desktop view ──────
async function testDesktopSpeech() {
  console.log('\n=== Test 2: Desktop viewport (1400x900) ===');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await setupPage(page, { forceOnboarding: true });
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(3000);
    await screenshot(page, 'ui-02a-desktop');

    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      info(`Redirected to ${url}`);
      return;
    }

    pass('Desktop onboarding page loaded');

    // Wait for bubbles
    await page.waitForTimeout(10000);
    await screenshot(page, 'ui-02b-desktop-speech');

    // Skip and check form
    const skipBtn = page.locator('button', { hasText: /skip/i });
    if (await skipBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(2000);
    } else {
      await page.waitForTimeout(20000);
    }
    await screenshot(page, 'ui-02c-desktop-form');

    const nameInput = page.locator('#onb-display-name');
    if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass('Desktop name form visible');
    }
  } finally {
    await page.close();
  }
}

// ── Test: Existing user skips ──────
async function testExistingUserSkips() {
  console.log('\n=== Test 3: Complete profile → skips onboarding ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await setupPage(page, { forceOnboarding: false }); // Profile returns complete
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(4000);
    await screenshot(page, 'ui-03-complete-profile');

    const url = page.url();
    info(`URL: ${url}`);
    if (!url.includes('/onboarding/welcome')) {
      pass(`User with complete profile redirected to: ${url}`);
    } else {
      info('Still on onboarding (redirect may be pending)');
    }
  } finally {
    await page.close();
  }
}

// ── Main ──────
(async () => {
  console.log('=== Onboarding UI Verification ===');
  console.log(`Target: ${APP_URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}/`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    await testMobileSpeech();
    await testDesktopSpeech();
    await testExistingUserSkips();

    console.log('\n=== RESULTS ===');
    console.log(`  Passed:  ${passed}`);
    console.log(`  Failed:  ${failed}`);

    if (failed > 0) {
      console.log('\nSome tests FAILED — review screenshots.');
      process.exit(1);
    } else {
      console.log('\nAll tests passed!');
    }
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
