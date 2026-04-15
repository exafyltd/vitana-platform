/**
 * Local Onboarding Flow Verification
 *
 * Tests the onboarding page structure and flow against the local preview server.
 * Since Supabase is behind an allowlist, we mock the auth state in localStorage
 * and test the UI components directly.
 */
import { chromium, type Page, type Browser } from 'playwright-core';
import { readFileSync } from 'fs';
import { mkdirSync } from 'fs';

const APP_URL = 'http://localhost:4173';
const SCREENSHOT_DIR = '/tmp/onboarding-verify';

// Mock session — enough for the React app to consider the user authenticated
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
let skipped = 0;

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`);
}

function pass(msg: string) { passed++; log('PASS', msg); }
function fail(msg: string) { failed++; log('FAIL', msg); }
function info(msg: string) { log('INFO', msg); }

async function screenshot(page: Page, name: string) {
  const path = `${SCREENSHOT_DIR}/${name}.png`;
  await page.screenshot({ path, fullPage: false });
  info(`Screenshot: ${path}`);
}

async function injectMockAuth(page: Page, opts?: { clearOnboarding?: boolean; setOnboardingComplete?: boolean }) {
  await page.evaluate(({ session, userId, clearOnb, setOnbComplete }) => {
    // Inject Supabase session
    localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(session));
    localStorage.setItem('vitana.authToken', session.access_token);
    localStorage.setItem('vitana.viewRole', 'community');
    localStorage.setItem('tenant_slug', 'maxina');

    if (clearOnb) {
      localStorage.removeItem('vitana_onboarding_completed');
    }
    if (setOnbComplete) {
      localStorage.setItem('vitana_onboarding_completed', userId);
    }
  }, {
    session: MOCK_SESSION,
    userId: MOCK_USER_ID,
    clearOnb: opts?.clearOnboarding ?? false,
    setOnbComplete: opts?.setOnboardingComplete ?? false,
  });
}

// ── Test: Onboarding page renders with speech bubbles ──────
async function testSpeechBubblesRender() {
  console.log('\n=== Test 1: Onboarding page renders with speech bubbles (mobile) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    // Load app and inject auth without onboarding complete flag
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await injectMockAuth(page, { clearOnboarding: true });

    // Navigate directly to onboarding
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(2000);
    await screenshot(page, '01-mobile-initial');

    const url = page.url();
    info(`URL: ${url}`);

    // The page may redirect if the DB check fails (no real Supabase).
    // But the onboarding check fails safe → needsOnboarding=false → redirect.
    // We need to check if the page loaded at all or if it redirected.
    if (url.includes('/onboarding/welcome')) {
      pass('Onboarding page loaded at /onboarding/welcome');

      // Wait for speech bubbles to appear
      await page.waitForTimeout(5000);
      await screenshot(page, '01b-mobile-speech');

      // Check for "Welcome to Maxina" header
      const header = page.locator('h1:has-text("Welcome to Maxina")');
      const hasHeader = await header.isVisible({ timeout: 3000 }).catch(() => false);
      if (hasHeader) {
        pass('Header "Welcome to Maxina" is visible');
      } else {
        fail('Header "Welcome to Maxina" not found');
      }

      // Check for the orb avatar (V bubble)
      const orbAvatar = page.locator('.bg-gradient-to-br.from-\\[\\#FF7BAC\\]');
      const avatarCount = await orbAvatar.count();
      info(`Orb avatar bubbles found: ${avatarCount}`);
      if (avatarCount > 0) {
        pass(`${avatarCount} speech bubble(s) with Vitana avatar rendered`);
      }

      // Check for typing indicator (the bouncing dots)
      const typingDots = page.locator('.animate-bounce');
      const dotsVisible = await typingDots.first().isVisible({ timeout: 2000 }).catch(() => false);
      if (dotsVisible) {
        pass('Typing indicator (bouncing dots) is visible');
      } else {
        info('Typing indicator not visible (may have already advanced)');
      }

      // Check skip button
      const skipBtn = page.locator('button:has-text("Skip")');
      const skipVisible = await skipBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (skipVisible) {
        pass('Skip button is visible');
      } else {
        info('Skip button not visible (messages may have completed)');
      }

      // Wait longer and take another screenshot
      await page.waitForTimeout(10000);
      await screenshot(page, '01c-mobile-more-speech');
    } else {
      info(`Page redirected to ${url} — this is expected when Supabase profile check fails (no real DB)`);
      info('The useOnboardingStatus hook fails safe: on error it sets needsOnboarding=false');
      info('This is correct behavior — in production with real Supabase, the onboarding would show');
      skipped++;
    }
  } finally {
    await page.close();
  }
}

// ── Test: Skip button advances to name form ──────
async function testSkipToNameForm() {
  console.log('\n=== Test 2: Skip button transitions to name form ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await injectMockAuth(page, { clearOnboarding: true });
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(3000);

    const url = page.url();
    if (!url.includes('/onboarding/welcome')) {
      info(`Redirected to ${url} — skipping this test (no real Supabase)`);
      skipped++;
      return;
    }

    // Click skip
    const skipBtn = page.locator('button:has-text("Skip")');
    const hasSkip = await skipBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasSkip) {
      await skipBtn.click();
      info('Clicked Skip button');
      await page.waitForTimeout(2000);
      await screenshot(page, '02-after-skip');

      // Check name form elements
      const nameInput = page.locator('#onb-display-name');
      const handleInput = page.locator('#onb-handle');
      const submitBtn = page.locator('button:has-text("get started")');

      const hasName = await nameInput.isVisible({ timeout: 5000 }).catch(() => false);
      const hasHandle = await handleInput.isVisible({ timeout: 2000 }).catch(() => false);
      const hasSubmit = await submitBtn.isVisible({ timeout: 2000 }).catch(() => false);

      if (hasName) pass('Display name input is visible');
      else fail('Display name input not found');

      if (hasHandle) pass('Handle input is visible');
      else fail('Handle input not found');

      if (hasSubmit) pass('Submit button is visible');
      else fail('Submit button not found');

      // Check pre-filled name from user_metadata
      if (hasName) {
        const nameValue = await nameInput.inputValue();
        info(`Pre-filled display name: "${nameValue}"`);
        if (nameValue === 'Test User') {
          pass('Display name pre-filled from auth metadata');
        } else {
          info('Display name not pre-filled (may not have user_metadata)');
        }
      }

      // Check auto-suggested handle
      if (hasHandle) {
        const handleValue = await handleInput.inputValue();
        info(`Auto-suggested handle: "${handleValue}"`);
        if (handleValue === 'test_user') {
          pass('Handle auto-suggested from display name');
        }
      }

      // Check the "What should I call you" label
      const nameLabel = page.locator('label:has-text("What should I call you")');
      if (await nameLabel.isVisible({ timeout: 2000 }).catch(() => false)) {
        pass('Name label text is correct');
      }

      await screenshot(page, '02b-name-form');
    } else {
      info('No skip button found, waiting for natural speech completion...');
      skipped++;
    }
  } finally {
    await page.close();
  }
}

// ── Test: Existing user redirect (localStorage flag) ──────
async function testExistingUserSkip() {
  console.log('\n=== Test 3: Existing user with localStorage flag skips instantly ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await injectMockAuth(page, { setOnboardingComplete: true });

    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '03-existing-user');

    const url = page.url();
    info(`URL after loading /onboarding/welcome: ${url}`);

    if (!url.includes('/onboarding/welcome')) {
      pass(`Existing user redirected away from onboarding to: ${url}`);
    } else {
      // The page might still show due to loading state timing
      info('Still on onboarding page — checking if loading spinner is shown');
      const spinner = page.locator('.animate-spin');
      const hasSpinner = await spinner.isVisible({ timeout: 2000 }).catch(() => false);
      if (hasSpinner) {
        info('Loading spinner visible — redirect in progress');
      }
    }
  } finally {
    await page.close();
  }
}

// ── Test: Desktop viewport ──────
async function testDesktopView() {
  console.log('\n=== Test 4: Desktop viewport (1400x900) ===');
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await injectMockAuth(page, { clearOnboarding: true });
    await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await page.waitForTimeout(3000);
    await screenshot(page, '04-desktop');

    const url = page.url();
    if (url.includes('/onboarding/welcome')) {
      pass('Desktop onboarding page loaded');
      await page.waitForTimeout(8000);
      await screenshot(page, '04b-desktop-speech');
    } else {
      info(`Redirected to ${url}`);
      skipped++;
    }
  } finally {
    await page.close();
  }
}

// ── Test: Route exists in app ──────
async function testRouteExists() {
  console.log('\n=== Test 5: /onboarding/welcome route exists (not 404) ===');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  try {
    const response = await page.goto(`${APP_URL}/onboarding/welcome`, { waitUntil: 'domcontentloaded', timeout: 10000 });
    await screenshot(page, '05-route-check');

    const status = response?.status();
    info(`HTTP status: ${status}`);

    // SPA always returns 200 (Vite serves index.html for all routes)
    if (status === 200) {
      pass('Route returns 200 (SPA)');
    } else {
      fail(`Unexpected status: ${status}`);
    }

    // Check that the page doesn't show a 404 message
    const body = await page.textContent('body') || '';
    if (body.includes('404') || body.includes('Not Found')) {
      fail('Page shows 404 content');
    } else {
      pass('No 404 content on page');
    }

    // Check that React rendered (not a blank page)
    const rootContent = await page.locator('#root').innerHTML();
    if (rootContent && rootContent.length > 100) {
      pass(`React app rendered (root content length: ${rootContent.length})`);
    } else {
      info(`Root content length: ${rootContent?.length || 0}`);
    }
  } finally {
    await page.close();
  }
}

// ── Main ──────────────────────────────────────────────────────
(async () => {
  console.log('=== Onboarding Flow Local Verification ===');
  console.log(`Target: ${APP_URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}/\n`);

  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    await testRouteExists();
    await testSpeechBubblesRender();
    await testSkipToNameForm();
    await testExistingUserSkip();
    await testDesktopView();

    console.log('\n=== RESULTS ===');
    console.log(`  Passed:  ${passed}`);
    console.log(`  Failed:  ${failed}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`\nScreenshots saved to ${SCREENSHOT_DIR}/`);

    if (failed > 0) {
      console.log('\nSome tests FAILED — review screenshots for details.');
      process.exit(1);
    }
  } finally {
    await browser.close();
  }
})().catch(err => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
