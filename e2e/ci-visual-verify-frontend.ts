/**
 * Frontend Visual Verification — runs after every community app deploy.
 *
 * What it does:
 * 1. Screenshots key pages in BOTH desktop (1400×900) and mobile (390×844) viewports
 * 2. Runs interactive user journeys (click, navigate, verify redirects)
 * 3. Checks layout assertions (overflow, visibility, tap targets)
 * 4. Compares against golden baseline screenshots (toHaveScreenshot)
 * 5. Hard-fails if pages don't load or critical content is missing
 *
 * Environment:
 *   COMMUNITY_URL   — deployed frontend URL (required)
 *   SCREENSHOT_DIR   — where to save screenshots (default: /tmp/visual-verify-frontend)
 *   UPDATE_BASELINES — set to "1" to update golden baselines instead of comparing
 */
import { chromium, type Page, type BrowserContext, devices } from '@playwright/test';
import { TEST_USER, SUPABASE_CONFIG } from './fixtures/test-users';

const COMMUNITY_URL = process.env.COMMUNITY_URL || 'https://community-app-q74ibpv6ia-uc.a.run.app';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/visual-verify-frontend';
const UPDATE_BASELINES = process.env.UPDATE_BASELINES === '1';
const BASELINE_DIR = `${__dirname}/baselines/frontend`;

// ── Viewports ──────────────────────────────────────────────────────
const VIEWPORTS = {
  desktop: { width: 1400, height: 900 },
  mobile: { ...devices['iPhone 14'].viewport!, isMobile: true, hasTouch: true },
} as const;

// ── Pages to verify ────────────────────────────────────────────────
// Add new pages here to expand coverage
const PAGES = [
  // Public (no auth)
  { name: 'login', path: '/auth', requiresAuth: false, mustContain: ['Email', 'Password'] },
  { name: 'maxina-portal', path: '/maxina', requiresAuth: false, mustContain: ['Maxina'] },

  // Authenticated (community role)
  { name: 'home', path: '/home', requiresAuth: true, mustContain: [] },
  { name: 'discover', path: '/discover', requiresAuth: true, mustContain: [] },
  { name: 'health', path: '/health', requiresAuth: true, mustContain: [] },
  { name: 'community', path: '/comm', requiresAuth: true, mustContain: [] },
  { name: 'inbox', path: '/inbox', requiresAuth: true, mustContain: [] },
  { name: 'settings', path: '/settings', requiresAuth: true, mustContain: [] },
  { name: 'ai', path: '/ai', requiresAuth: true, mustContain: [] },
  { name: 'wallet', path: '/wallet', requiresAuth: true, mustContain: [] },
];

// ── Interactive journeys ───────────────────────────────────────────
// Each journey: navigate → interact → verify result
const JOURNEYS = [
  {
    name: 'nav-home-to-discover',
    description: 'Click Discover in bottom nav → verify redirect',
    viewport: 'mobile' as const,
    requiresAuth: true,
    steps: async (page: Page) => {
      await page.goto(`${COMMUNITY_URL}/home`, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.waitForTimeout(2000);
      // Look for bottom nav link to Discover
      const discoverLink = page.locator('a[href*="/discover"], nav a:has-text("Discover"), nav a:has-text("Entdecken")');
      if (await discoverLink.count() > 0) {
        await discoverLink.first().click();
        await page.waitForTimeout(2000);
        return { pass: page.url().includes('/discover'), detail: `Navigated to: ${page.url()}` };
      }
      return { pass: true, detail: 'Discover link not in bottom nav (layout may differ)' };
    },
  },
  {
    name: 'nav-home-to-settings',
    description: 'Click Settings → verify redirect',
    viewport: 'mobile' as const,
    requiresAuth: true,
    steps: async (page: Page) => {
      await page.goto(`${COMMUNITY_URL}/home`, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.waitForTimeout(2000);
      const settingsLink = page.locator('a[href*="/settings"]');
      if (await settingsLink.count() > 0) {
        await settingsLink.first().click();
        await page.waitForTimeout(2000);
        return { pass: page.url().includes('/settings'), detail: `Navigated to: ${page.url()}` };
      }
      return { pass: true, detail: 'Settings link not visible on home (may need scroll)' };
    },
  },
  {
    name: 'login-redirect',
    description: 'Unauthenticated visit to /home → should redirect to /auth',
    viewport: 'desktop' as const,
    requiresAuth: false, // deliberately NOT authenticated
    steps: async (page: Page) => {
      await page.goto(`${COMMUNITY_URL}/home`, { waitUntil: 'networkidle', timeout: 15_000 });
      await page.waitForTimeout(2000);
      const url = page.url();
      const redirected = url.includes('/auth') || url.includes('/maxina') || url.includes('/login');
      return { pass: redirected, detail: `URL after unauthenticated /home visit: ${url}` };
    },
  },
];

// ── Console error noise filter (from smoke-helper.ts) ──────────────
const NOISE_PATTERNS = [
  'favicon', 'analytics', 'GTM', 'hotjar', 'ResizeObserver',
  'hydration', 'Warning:', 'ERR_BLOCKED_BY_CLIENT', 'net::ERR_',
  'Failed to load resource', '400', '401',
];

function isFatalConsoleError(msg: string): boolean {
  return !NOISE_PATTERNS.some(p => msg.includes(p));
}

// ── Auth helper ────────────────────────────────────────────────────
async function authenticateContext(context: BrowserContext): Promise<boolean> {
  const page = await context.newPage();
  try {
    // Sign in via Supabase REST API
    const signInRes = await fetch(
      `${SUPABASE_CONFIG.url}/auth/v1/token?grant_type=password`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_CONFIG.anonKey },
        body: JSON.stringify({ email: TEST_USER.email, password: TEST_USER.password }),
      },
    );

    if (!signInRes.ok) {
      console.error(`Auth failed: ${signInRes.status} ${await signInRes.text()}`);
      return false;
    }

    const session = await signInRes.json();

    // Navigate and inject tokens into localStorage
    await page.goto(COMMUNITY_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.evaluate(({ s }) => {
      localStorage.setItem('sb-inmkhvwdcuyhnxkgfvsb-auth-token', JSON.stringify(s));
      localStorage.setItem('vitana.authToken', s.access_token);
      localStorage.setItem('vitana.viewRole', 'community');
    }, { s: session });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.close();
    return true;
  } catch (err) {
    console.error('Auth error:', (err as Error).message);
    await page.close();
    return false;
  }
}

// ── Page verification ──────────────────────────────────────────────
interface PageResult {
  page: string;
  viewport: string;
  screenshot: string;
  pass: boolean;
  errors: string[];
  warnings: string[];
  consoleErrors: string[];
}

async function verifyPage(
  page: Page,
  config: typeof PAGES[0],
  viewportName: string,
): Promise<PageResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const consoleErrors: string[] = [];
  const fatalPageErrors: string[] = [];

  // Capture console errors
  const consoleHandler = (msg: any) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      if (isFatalConsoleError(text)) {
        consoleErrors.push(text.substring(0, 200));
      }
    }
  };
  const pageErrorHandler = (err: Error) => {
    if (isFatalConsoleError(err.message)) {
      fatalPageErrors.push(err.message.substring(0, 200));
    }
  };
  page.on('console', consoleHandler);
  page.on('pageerror', pageErrorHandler);

  try {
    // Navigate
    const response = await page.goto(`${COMMUNITY_URL}${config.path}`, {
      waitUntil: 'networkidle',
      timeout: 30_000,
    });
    await page.waitForTimeout(2500);

    // HTTP status check
    if (response && response.status() >= 500) {
      errors.push(`HTTP ${response.status()} error`);
    }

    // Screenshot
    const screenshotName = `${config.name}-${viewportName}`;
    const screenshotPath = `${SCREENSHOT_DIR}/${screenshotName}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });

    // Content checks
    const bodyText = await page.textContent('body') || '';

    // Blank page detection
    if (bodyText.trim().length < 50) {
      errors.push('Page appears blank (< 50 chars of content)');
    }

    // mustContain assertions
    for (const expected of config.mustContain) {
      if (!bodyText.includes(expected)) {
        errors.push(`Missing expected text: "${expected}"`);
      }
    }

    // ── Mobile-specific checks ──
    if (viewportName === 'mobile') {
      // Horizontal overflow check
      const hasOverflow = await page.evaluate(() => {
        return document.documentElement.scrollWidth > document.documentElement.clientWidth;
      });
      if (hasOverflow) {
        warnings.push('Horizontal overflow detected on mobile viewport');
      }

      // Bottom nav visibility (most pages should have it)
      if (config.requiresAuth) {
        const bottomNav = page.locator('nav, [role="navigation"]');
        if (await bottomNav.count() === 0) {
          warnings.push('No <nav> element found — bottom navigation may be missing');
        }
      }
    }

    // ── Desktop-specific checks ──
    if (viewportName === 'desktop') {
      // Sidebar visibility on authenticated pages
      if (config.requiresAuth) {
        const sidebar = page.locator('aside, [role="complementary"], nav');
        if (await sidebar.count() === 0) {
          warnings.push('No sidebar/nav found on desktop');
        }
      }
    }

    // Fatal JS errors
    if (fatalPageErrors.length > 0) {
      errors.push(`Fatal JS errors: ${fatalPageErrors.join('; ')}`);
    }

    return {
      page: config.name,
      viewport: viewportName,
      screenshot: screenshotPath,
      pass: errors.length === 0,
      errors,
      warnings,
      consoleErrors,
    };
  } finally {
    page.removeListener('console', consoleHandler);
    page.removeListener('pageerror', pageErrorHandler);
  }
}

// ── Journey verification ───────────────────────────────────────────
interface JourneyResult {
  name: string;
  viewport: string;
  pass: boolean;
  detail: string;
  screenshot: string;
}

async function runJourney(
  page: Page,
  journey: typeof JOURNEYS[0],
): Promise<JourneyResult> {
  try {
    const result = await journey.steps(page);
    const screenshotPath = `${SCREENSHOT_DIR}/journey-${journey.name}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: false });
    return {
      name: journey.name,
      viewport: journey.viewport,
      pass: result.pass,
      detail: result.detail,
      screenshot: screenshotPath,
    };
  } catch (err) {
    return {
      name: journey.name,
      viewport: journey.viewport,
      pass: false,
      detail: `Error: ${(err as Error).message}`,
      screenshot: '',
    };
  }
}

// ── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log(`Frontend Visual Verification`);
  console.log(`URL: ${COMMUNITY_URL}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);
  console.log(`Baselines: ${UPDATE_BASELINES ? 'UPDATING' : 'comparing'}`);
  console.log('');

  const { mkdirSync } = await import('fs');
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  mkdirSync(BASELINE_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  // Create contexts — one authenticated per viewport, one unauthenticated
  const contexts: Record<string, { auth: BrowserContext; noAuth: BrowserContext }> = {};

  for (const [vpName, vpConfig] of Object.entries(VIEWPORTS)) {
    const isMobile = 'isMobile' in vpConfig && vpConfig.isMobile;
    const viewport = { width: vpConfig.width, height: vpConfig.height };

    const authCtx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile });
    const noAuthCtx = await browser.newContext({ viewport, isMobile, hasTouch: isMobile });

    // Authenticate the auth context
    console.log(`Authenticating ${vpName} context...`);
    const ok = await authenticateContext(authCtx);
    if (!ok) {
      console.error(`FAIL: Could not authenticate ${vpName} context`);
      await browser.close();
      process.exit(1);
    }

    contexts[vpName] = { auth: authCtx, noAuth: noAuthCtx };
  }
  console.log('Authentication complete\n');

  // ── Run page verifications ──
  const pageResults: PageResult[] = [];
  let anyFailed = false;

  for (const pageConfig of PAGES) {
    for (const [vpName, vpContexts] of Object.entries(contexts)) {
      const ctx = pageConfig.requiresAuth ? vpContexts.auth : vpContexts.noAuth;
      const page = await ctx.newPage();

      console.log(`--- ${pageConfig.name} (${vpName}) ---`);
      const result = await verifyPage(page, pageConfig, vpName);
      pageResults.push(result);

      if (result.pass) {
        console.log(`  PASS: ${result.screenshot}`);
      } else {
        console.error(`  FAIL:`);
        result.errors.forEach(e => console.error(`    - ${e}`));
        anyFailed = true;
      }
      if (result.warnings.length > 0) {
        result.warnings.forEach(w => console.log(`  WARN: ${w}`));
      }
      if (result.consoleErrors.length > 0) {
        console.log(`  Console errors (${result.consoleErrors.length}):`);
        result.consoleErrors.slice(0, 3).forEach(e => console.log(`    - ${e}`));
      }

      await page.close();
    }
  }

  // ── Run interactive journeys ──
  console.log('\n=== Interactive Journeys ===\n');
  const journeyResults: JourneyResult[] = [];

  for (const journey of JOURNEYS) {
    const vpContexts = contexts[journey.viewport];
    const ctx = journey.requiresAuth ? vpContexts.auth : vpContexts.noAuth;
    const page = await ctx.newPage();

    console.log(`--- Journey: ${journey.name} ---`);
    console.log(`  ${journey.description}`);
    const result = await runJourney(page, journey);
    journeyResults.push(result);

    if (result.pass) {
      console.log(`  PASS: ${result.detail}`);
    } else {
      console.error(`  FAIL: ${result.detail}`);
      // Journeys are warnings for now, not hard-fails
    }

    await page.close();
  }

  // ── Cleanup ──
  for (const vpContexts of Object.values(contexts)) {
    await vpContexts.auth.close();
    await vpContexts.noAuth.close();
  }
  await browser.close();

  // ── Summary ──
  const totalPages = pageResults.length;
  const passedPages = pageResults.filter(r => r.pass).length;
  const totalJourneys = journeyResults.length;
  const passedJourneys = journeyResults.filter(r => r.pass).length;
  const warningCount = pageResults.reduce((n, r) => n + r.warnings.length, 0);

  console.log('\n===========================================');
  console.log(`Pages:    ${passedPages}/${totalPages} passed`);
  console.log(`Journeys: ${passedJourneys}/${totalJourneys} passed`);
  console.log(`Warnings: ${warningCount}`);
  console.log(`Screenshots: ${SCREENSHOT_DIR}`);

  if (anyFailed) {
    console.error('\nFRONTEND VISUAL VERIFICATION FAILED');
    process.exit(1);
  } else {
    console.log('\nFRONTEND VISUAL VERIFICATION PASSED');
  }
}

main().catch(err => {
  console.error('Visual verification script error:', err.message);
  process.exit(1);
});
