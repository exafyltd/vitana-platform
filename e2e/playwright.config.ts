import { defineConfig, devices } from '@playwright/test';

const COMMUNITY_URL = process.env.COMMUNITY_URL || 'https://vitanaland.com';
const HUB_URL = process.env.HUB_URL || 'https://gateway-q74ibpv6ia-uc.a.run.app';

/** Roles that use the Lovable frontend (Desktop + Mobile) */
const LOVABLE_ROLES = ['community', 'patient', 'professional', 'staff', 'admin'] as const;
/** Roles that use Command Hub */
const HUB_ROLES = ['developer', 'admin', 'staff'] as const;

/** Desktop browser config */
const desktopChrome = {
  ...devices['Desktop Chrome'],
};

/** Mobile emulation — iPhone 14 viewport on Chromium (real app uses Appilix WebView = Chromium) */
const mobileIPhone = {
  ...devices['iPhone 14'],
  defaultBrowserType: 'chromium' as const,
  isMobile: true as const,
  hasTouch: true as const,
};

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 1,
  reporter: [['html'], ['json', { outputFile: 'results.json' }]],
  use: {
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },

  projects: [
    // ── Auth setup per role (run first) ──────────────────
    ...(['community', 'patient', 'professional', 'staff', 'admin', 'developer'] as const).map(role => ({
      name: `auth-${role}`,
      testDir: './auth',
      testMatch: `${role}-role.setup.ts`,
    })),

    // ── UI 1: Lovable Desktop (per role) ──────────────────
    ...LOVABLE_ROLES.map(role => ({
      name: `desktop-${role}`,
      testDir: `./community-desktop/roles/${role}`,
      use: {
        baseURL: COMMUNITY_URL,
        storageState: `.auth/${role}.json`,
        ...desktopChrome,
      },
      dependencies: [`auth-${role}`],
    })),
    {
      name: 'desktop-shared',
      testDir: './community-desktop/shared',
      use: { baseURL: COMMUNITY_URL, ...desktopChrome },
    },

    // ── UI 2: Lovable Mobile (per role) ──────────────────
    ...LOVABLE_ROLES.map(role => ({
      name: `mobile-${role}`,
      testDir: `./community-mobile/roles/${role}`,
      use: {
        baseURL: COMMUNITY_URL,
        storageState: `.auth/${role}.json`,
        ...mobileIPhone,
      },
      dependencies: [`auth-${role}`],
    })),
    {
      name: 'mobile-shared',
      testDir: './community-mobile/shared',
      use: {
        baseURL: COMMUNITY_URL,
        storageState: '.auth/community.json',
        ...mobileIPhone,
      },
      dependencies: ['auth-community'],
    },

    // ── UI 3: Command Hub (per role) ─────────────────────
    ...HUB_ROLES.map(role => ({
      name: `hub-${role}`,
      testDir: `./command-hub/roles/${role}`,
      use: {
        baseURL: HUB_URL,
        storageState: `.auth/${role}.json`,
        ...desktopChrome,
      },
      dependencies: [`auth-${role}`],
    })),
    {
      name: 'hub-shared',
      testDir: './command-hub/shared',
      use: { baseURL: HUB_URL, ...desktopChrome },
    },
  ],
});
