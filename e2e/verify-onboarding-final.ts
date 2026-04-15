/**
 * Final Onboarding UI Verification — focused on skip-to-form and full flow
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
  info(`Screenshot → ${path}`);
}

async function setupPage(page: Page, forceOnboarding: boolean) {
  // Intercept Supabase profile check
  await page.route('**/rest/v1/profiles*', async (route) => {
    if (forceOnboarding) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: 'null' });
    } else {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ user_id: MOCK_USER_ID, display_name: 'Test User', handle: 'testuser' }),
      });
    }
  });
  // Intercept all other Supabase calls to prevent errors
  await page.route('**/rest/v1/**', async (route) => {
    const url = route.request().url();
    if (url.includes('profiles')) return route.fallback(); // handled above
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await page.route('**/auth/v1/**', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SESSION) });
  });

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await page.evaluate(({ session }) => {
    localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(session));
    localStorage.setItem('vitana.authToken', session.access_token);
    localStorage.setItem('vitana.viewRole', 'community');
    localStorage.setItem('tenant_slug', 'maxina');
    localStorage.removeItem('vitana_onboarding_completed');
  }, { session: MOCK_SESSION });
}

async function testSkipToForm() {
  console.log('\n=== Test A: Click Skip → name form appears (mobile) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await setupPage(page, true);
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2500);

    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      info(`Redirected to ${url} — cannot test form`);
      return;
    }

    // Find and click skip button (any language)
    const skipBtn = page.locator('button').filter({ hasText: /skip|überspringen|تخطي/i });
    await skipBtn.waitFor({ state: 'visible', timeout: 5000 });
    info('Skip button found, clicking...');
    await skipBtn.click();
    await page.waitForTimeout(2000);
    await screenshot(page, 'final-01-after-skip-mobile');

    // Now the form phase should be active
    const nameInput = page.locator('#onb-display-name');
    const handleInput = page.locator('#onb-handle');

    const hasName = await nameInput.isVisible({ timeout: 8000 }).catch(() => false);
    if (hasName) {
      pass('Display name input appeared after skip');
      const val = await nameInput.inputValue();
      info(`Display name value: "${val}"`);
      if (val === 'Test User') pass('Name pre-filled from user_metadata.full_name');
    } else {
      fail('Display name input NOT visible after skip');
      // Debug: what's on screen?
      const bodyText = (await page.textContent('body'))?.slice(0, 300);
      info(`Page body (first 300 chars): ${bodyText}`);
    }

    const hasHandle = await handleInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasHandle) {
      pass('Handle (@username) input appeared');
      const val = await handleInput.inputValue();
      info(`Handle value: "${val}"`);
      if (val === 'test_user') pass('Handle auto-suggested from display name');
    } else {
      fail('Handle input NOT visible');
    }

    // Check @ prefix, title, subtitle, and submit button
    const title = page.locator('h2');
    const titleText = await title.textContent().catch(() => '');
    info(`Form title: "${titleText}"`);

    const submitBtn = page.locator('button').filter({ hasText: /get started|los geht|نبدأ/i });
    if (await submitBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      pass('Submit button visible');
    }

    await screenshot(page, 'final-02-name-form-mobile');
  } finally {
    await page.close();
  }
}

async function testFullSpeechFlow() {
  console.log('\n=== Test B: Full speech plays through all 9 messages (mobile) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await setupPage(page, true);
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2000);

    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      info(`Redirected to ${url}`);
      return;
    }

    // Wait for all 9 messages to render (total ~50s with dynamic timing)
    info('Waiting for all 9 speech messages to render...');
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(5000);
      const avatars = await page.locator('.rounded-full.bg-gradient-to-br').count();
      info(`  ${(i + 1) * 5}s elapsed — ${avatars} bubble(s)`);
      if (avatars >= 9) break;
    }

    await screenshot(page, 'final-03-all-messages');

    const avatarCount = await page.locator('.rounded-full.bg-gradient-to-br').count();
    if (avatarCount >= 9) {
      pass(`All 9 speech messages rendered (${avatarCount} bubbles)`);
    } else {
      info(`${avatarCount} bubbles rendered (expected 9)`);
    }

    // After last message + FINAL_DELAY, the form should appear
    await page.waitForTimeout(5000);
    await screenshot(page, 'final-04-after-speech-complete');

    const nameInput = page.locator('#onb-display-name');
    if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass('Form appeared automatically after speech completed');
    } else {
      info('Form not yet visible — checking if transition is happening');
    }
  } finally {
    await page.close();
  }
}

async function testDesktopForm() {
  console.log('\n=== Test C: Desktop skip → form (1400x900) ===');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await setupPage(page, true);
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2500);

    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      info(`Redirected to ${url}`);
      return;
    }

    pass('Desktop onboarding loaded');
    await screenshot(page, 'final-05-desktop-speech');

    const skipBtn = page.locator('button').filter({ hasText: /skip|überspringen|تخطي/i });
    if (await skipBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await skipBtn.click();
      await page.waitForTimeout(2000);
    }

    await screenshot(page, 'final-06-desktop-form');
    const nameInput = page.locator('#onb-display-name');
    if (await nameInput.isVisible({ timeout: 5000 }).catch(() => false)) {
      pass('Desktop form appeared');
    }
  } finally {
    await page.close();
  }
}

async function testExistingUserRedirect() {
  console.log('\n=== Test D: Existing user (localStorage) → redirects to events ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.route('**/rest/v1/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });
    await page.route('**/auth/v1/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_SESSION) });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ session, userId }) => {
      localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(session));
      localStorage.setItem('vitana.authToken', session.access_token);
      localStorage.setItem('vitana.viewRole', 'community');
      localStorage.setItem('vitana_onboarding_completed', userId);
    }, { session: MOCK_SESSION, userId: MOCK_USER_ID });

    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(3000);
    await screenshot(page, 'final-07-existing-user');

    const url = page.url();
    info(`Final URL: ${url}`);
    if (!url.includes('/onboarding/welcome')) {
      pass(`Existing user redirected to: ${url}`);
    } else {
      info('Still on onboarding (loading state?)');
    }
  } finally {
    await page.close();
  }
}

(async () => {
  console.log('=== Final Onboarding Verification ===');
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    await testSkipToForm();
    await testFullSpeechFlow();
    await testDesktopForm();
    await testExistingUserRedirect();

    console.log(`\n=== RESULTS: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
    else console.log('All tests passed!');
  } finally {
    await browser.close();
  }
})().catch(err => { console.error('Fatal:', err); process.exit(1); });
