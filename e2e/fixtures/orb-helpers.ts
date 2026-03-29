/**
 * Shared ORB Widget test helpers
 *
 * Used by all 3 screen types (hub, desktop, mobile) to avoid duplication.
 */

import type { Page } from '@playwright/test';

/** Wait for VitanaOrb global to be available after page load */
export async function waitForOrb(page: Page) {
  await page.waitForFunction(() => !!(window as any).VitanaOrb, { timeout: 15_000 });
}

/** Open overlay via VitanaOrb.show() and wait for it to be visible */
export async function showOrbOverlay(page: Page) {
  await page.evaluate(() => (window as any).VitanaOrb.show());
  await page.waitForSelector(
    '.vtorb-overlay[style*="display: flex"], .vtorb-overlay[style*="display:flex"]',
    { timeout: 5_000 }
  );
}

/** Set ORB state via the test helper (no real voice session needed) */
export async function setOrbState(page: Page, state: string, text: string) {
  await page.evaluate(
    ({ s, t }) => (window as any).VitanaOrb._test_setState(s, t),
    { s: state, t: text }
  );
  await page.waitForTimeout(100);
}
