/**
 * CI Visual Verification — runs after every gateway deploy.
 *
 * 1. Logs into Command Hub with the E2E test user
 * 2. Screenshots key pages (overview, self-healing, health)
 * 3. Checks for error states (stale badges, broken layouts, JS errors)
 * 4. Exits non-zero if critical problems are found
 *
 * Usage:
 *   GATEWAY_URL=https://... npx playwright test ci-visual-verify.ts
 *   OR: npx tsx ci-visual-verify.ts
 *
 * Environment:
 *   GATEWAY_URL  — deployed gateway URL (required)
 *   SCREENSHOT_DIR — where to save screenshots (default: /tmp/visual-verify)
 */
import { chromium, type Page } from '@playwright/test';

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/visual-verify';
const TEST_EMAIL = 'e2e-test@vitana.dev';
const TEST_PASSWORD = 'VitanaE2eTest2026!';

// Pages to screenshot after deploy — add new entries here to expand coverage
const PAGES_TO_VERIFY = [
  {
    name: 'overview',
    path: '/command-hub/',
    mustContain: ['VITANA DEV', 'AUTOPILOT'],
    mustNotContain: ['error', 'undefined'],
  },
  {
    name: 'self-healing',
    path: '/command-hub/infrastructure/self-healing/',
    mustContain: ['Self-Healing System'],
    mustNotContain: ['still pending'],
  },
  {
    name: 'services-health',
    path: '/command-hub/infrastructure/services/',
    mustContain: ['Services'],
    mustNotContain: [],
  },
];

interface VerifyResult {
  page: string;
  path: string;
  screenshot: string;
  pass: boolean;
  errors: string[];
  consoleErrors: string[];
}

async function login(page: Page): Promise<boolean> {
  await page.goto(`${GATEWAY_URL}/command-hub/`, { waitUntil: 'networkidle', timeout: 20_000 });
  await page.waitForTimeout(1500);

  const emailInput = page.locator('input[type="email"], input[placeholder*="email" i]');
  if (await emailInput.count() === 0) {
    // Already logged in or no login required
    return true;
  }

  await emailInput.fill(TEST_EMAIL);
  await page.locator('input[type="password"]').fill(TEST_PASSWORD);
  await page.locator('button:has-text("Login")').click();
  await page.waitForTimeout(3000);

  // Verify login succeeded — should not still be on login page
  const stillOnLogin = await page.locator('input[type="password"]').count();
  return stillOnLogin === 0;
}

async function verifyPage(page: Page, config: typeof PAGES_TO_VERIFY[0]): Promise<VerifyResult> {
  const errors: string[] = [];
  const consoleErrors: string[] = [];

  // Capture console errors
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter known noise
      if (!text.includes('favicon') && !text.includes('analytics') && !text.includes('GTM')) {
        consoleErrors.push(text.substring(0, 200));
      }
    }
  });

  // Navigate
  await page.goto(`${GATEWAY_URL}${config.path}`, {
    waitUntil: 'networkidle',
    timeout: 20_000,
  });
  await page.waitForTimeout(3000);

  // Screenshot
  const screenshotPath = `${SCREENSHOT_DIR}/${config.name}.png`;
  await page.screenshot({ path: screenshotPath, fullPage: false });

  // Content checks
  const bodyText = await page.textContent('body') || '';

  for (const expected of config.mustContain) {
    if (!bodyText.includes(expected)) {
      errors.push(`Missing expected text: "${expected}"`);
    }
  }

  for (const forbidden of config.mustNotContain) {
    // Case-insensitive check, but skip if the word appears in a normal context
    const regex = new RegExp(forbidden, 'i');
    if (regex.test(bodyText)) {
      errors.push(`Found forbidden text: "${forbidden}"`);
    }
  }

  // Check for blank page
  if (bodyText.trim().length < 50) {
    errors.push('Page appears blank (< 50 chars of text content)');
  }

  return {
    page: config.name,
    path: config.path,
    screenshot: screenshotPath,
    pass: errors.length === 0,
    errors,
    consoleErrors,
  };
}

async function main() {
  console.log(`Visual Verification: ${GATEWAY_URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  console.log('');

  // Ensure screenshot dir exists
  const { mkdirSync } = await import('fs');
  mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  // Login
  console.log('Logging into Command Hub...');
  const loggedIn = await login(page);
  if (!loggedIn) {
    console.error('FAIL: Could not log into Command Hub');
    await browser.close();
    process.exit(1);
  }
  console.log('Login successful\n');

  // Verify each page
  const results: VerifyResult[] = [];
  let anyFailed = false;

  for (const pageConfig of PAGES_TO_VERIFY) {
    console.log(`--- Verifying: ${pageConfig.name} (${pageConfig.path}) ---`);
    const result = await verifyPage(page, pageConfig);
    results.push(result);

    if (result.pass) {
      console.log(`  PASS: ${result.screenshot}`);
    } else {
      console.error(`  FAIL:`);
      for (const err of result.errors) {
        console.error(`    - ${err}`);
      }
      anyFailed = true;
    }

    if (result.consoleErrors.length > 0) {
      console.log(`  Console errors (${result.consoleErrors.length}):`);
      for (const err of result.consoleErrors.slice(0, 5)) {
        console.log(`    - ${err}`);
      }
    }
    console.log('');
  }

  await browser.close();

  // Summary
  console.log('===========================================');
  if (anyFailed) {
    console.error('VISUAL VERIFICATION FAILED');
    console.log('Check screenshots in: ' + SCREENSHOT_DIR);
    process.exit(1);
  } else {
    console.log(`VISUAL VERIFICATION PASSED (${results.length} pages)`);
    console.log('Screenshots saved to: ' + SCREENSHOT_DIR);
  }
}

main().catch(err => {
  console.error('Visual verification script error:', err.message);
  process.exit(1);
});
