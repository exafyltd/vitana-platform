import { test, expect } from '@playwright/test';

/**
 * ORB Widget — Overlay, States, Colors, Status Text
 *
 * Tests the VitanaOrb widget UI without a real voice session.
 * Uses VitanaOrb._test_setState() to simulate state transitions and
 * validates aura colors, status text, and mic mute styling.
 */

const HUB_PATH = '/command-hub/';

/** Helper: navigate to Command Hub and wait for VitanaOrb to be available */
async function openHub(page: import('@playwright/test').Page) {
  await page.goto(HUB_PATH, { waitUntil: 'domcontentloaded' });
  // Wait for VitanaOrb global to exist (loaded via orb-widget.js)
  await page.waitForFunction(() => !!(window as any).VitanaOrb, { timeout: 10_000 });
}

/** Helper: open overlay via VitanaOrb.show() and wait for it */
async function showOverlay(page: import('@playwright/test').Page) {
  // Show overlay (bypasses session start for testing)
  await page.evaluate(() => {
    const orb = (window as any).VitanaOrb;
    // Prevent actual session start — we only want the UI
    orb.show();
  });
  // Wait for overlay to be visible
  await page.waitForSelector('.vtorb-overlay[style*="display: flex"], .vtorb-overlay[style*="display:flex"]', { timeout: 5_000 });
}

// ─── Overlay Structure ──────────────────────────────────────────

test.describe('ORB Widget — Overlay Structure', () => {
  test('overlay appears with sphere, status, and controls', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);

    // Overlay is visible
    const overlay = page.locator('.vtorb-overlay');
    await expect(overlay).toBeVisible();

    // Sphere is visible
    const sphere = page.locator('.vtorb-large');
    await expect(sphere).toBeVisible();

    // Status text element exists
    const status = page.locator('.vtorb-status');
    await expect(status).toBeVisible();

    // Mic button exists
    const micBtn = page.locator('.vtorb-btn-mic');
    await expect(micBtn).toBeVisible();

    // Close button exists
    const closeBtn = page.locator('.vtorb-btn-close');
    await expect(closeBtn).toBeVisible();
  });

  test('aura inner and outer elements exist', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);

    const auraInner = page.locator('.vtorb-aura-inner');
    const auraOuter = page.locator('.vtorb-aura-outer');
    // Elements exist in the DOM (may be invisible when opacity=0)
    await expect(auraInner).toHaveCount(1);
    await expect(auraOuter).toHaveCount(1);
  });

  test('close button dismisses overlay', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);

    const overlay = page.locator('.vtorb-overlay');
    await expect(overlay).toBeVisible();

    // Click close (force: overlay z-index may intercept pointer events)
    await page.locator('.vtorb-btn-close').click({ force: true });
    // Overlay should be hidden
    await expect(overlay).toBeHidden();
  });
});

// ─── State Colors ──────────────────────────────────────────────

test.describe('ORB Widget — State Colors', () => {
  /** Sets a state via the test helper and returns aura/status info */
  async function setState(
    page: import('@playwright/test').Page,
    state: string,
    text: string
  ) {
    await page.evaluate(
      ({ state, text }) => (window as any).VitanaOrb._test_setState(state, text),
      { state, text }
    );
    // Small wait for style transitions
    await page.waitForTimeout(100);
  }

  test('connecting state — gray aura, white text', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);
    await setState(page, 'connecting', 'Connecting...');

    const aura = page.locator('.vtorb-aura-inner');
    const bg = await aura.evaluate(el => el.style.background);
    expect(bg).toContain('226, 232, 240'); // gray

    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Connecting...');
    const color = await status.evaluate(el => el.style.color);
    expect(color).toContain('255, 255, 255'); // white
  });

  test('thinking state — purple aura, purple text', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);
    await setState(page, 'thinking', 'Thinking...');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('139, 92, 246'); // purple

    const outerBg = await page.locator('.vtorb-aura-outer').evaluate(el => el.style.background);
    expect(outerBg).toContain('139, 92, 246'); // purple outer

    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Thinking...');
    const color = await status.evaluate(el => el.style.color);
    expect(color).toContain('139, 92, 246'); // purple
  });

  test('speaking state — amber aura, amber text', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);
    await setState(page, 'speaking', 'Vitana speaking...');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('245, 158, 11'); // amber

    const outerBg = await page.locator('.vtorb-aura-outer').evaluate(el => el.style.background);
    expect(outerBg).toContain('245, 158, 11'); // amber outer

    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Vitana speaking...');
    const color = await status.evaluate(el => el.style.color);
    expect(color).toContain('245, 158, 11'); // amber
  });

  test('listening state — blue aura, blue text', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);
    await setState(page, 'listening', 'Listening...');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('59, 130, 246'); // blue

    const outerBg = await page.locator('.vtorb-aura-outer').evaluate(el => el.style.background);
    expect(outerBg).toContain('59, 130, 246'); // blue outer

    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Listening...');
    const color = await status.evaluate(el => el.style.color);
    expect(color).toContain('59, 130, 246'); // blue
  });

  test('muted state — gray aura, sphere dimmed, white text', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);
    await setState(page, 'paused', 'Muted');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('107, 114, 128'); // gray

    // Sphere should be dimmed
    const sphere = page.locator('.vtorb-large');
    const opacity = await sphere.evaluate(el => el.style.opacity);
    expect(opacity).toBe('0.6');
    const filter = await sphere.evaluate(el => el.style.filter);
    expect(filter).toContain('grayscale');

    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Muted');
  });

  test('error state — red aura, red text', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);

    // Set error via _test_setState — need to set liveError flag too
    await page.evaluate(() => {
      const orb = (window as any).VitanaOrb;
      orb._test_setState('error', 'Connection lost.');
    });
    await page.waitForTimeout(100);

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('239, 68, 68'); // red

    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Connection lost.');
  });
});

// ─── Mic Mute Toggle ──────────────────────────────────────────

test.describe('ORB Widget — Mic Mute', () => {
  test('mic button toggles muted style', async ({ page }) => {
    await openHub(page);
    await showOverlay(page);

    // Set to listening first
    await page.evaluate(() => (window as any).VitanaOrb._test_setState('listening', 'Listening...'));

    const micBtn = page.locator('.vtorb-btn-mic');

    // Initially unmuted — blue background
    const bgBefore = await micBtn.evaluate(el => el.style.background);
    expect(bgBefore).toContain('59, 130, 246'); // blue

    // Click to mute
    await micBtn.click({ force: true });

    // After mute — red background
    await page.waitForTimeout(100);
    const bgAfter = await micBtn.evaluate(el => el.style.background);
    expect(bgAfter).toContain('239, 68, 68'); // red

    // Status should show "Muted"
    const status = page.locator('.vtorb-status');
    await expect(status).toHaveText('Muted');

    // Click again to unmute
    await micBtn.click({ force: true });

    // Back to blue
    await page.waitForTimeout(100);
    const bgUnmuted = await micBtn.evaluate(el => el.style.background);
    expect(bgUnmuted).toContain('59, 130, 246'); // blue

    // Status should show "Listening..."
    await expect(status).toHaveText('Listening...');
  });
});
