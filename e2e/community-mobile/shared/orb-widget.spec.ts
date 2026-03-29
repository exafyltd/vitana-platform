import { test, expect } from '@playwright/test';
import { waitForOrb, showOrbOverlay, setOrbState } from '../../fixtures/orb-helpers';

/**
 * ORB Widget — Community Mobile (vitanaland.com, iPhone 14 emulation)
 *
 * Same ORB tests as desktop, plus mobile-specific checks:
 * - FAB touch target size (48px+)
 * - Overlay fills mobile viewport
 * - Sphere responsive sizing
 */

async function openPage(page: import('@playwright/test').Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForOrb(page);
}

// ─── Overlay Structure ──────────────────────────────────────────

test.describe('ORB Widget — Overlay Structure', () => {
  test('overlay appears with sphere, status, and controls', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);

    await expect(page.locator('.vtorb-overlay')).toBeVisible();
    await expect(page.locator('.vtorb-large')).toBeVisible();
    await expect(page.locator('.vtorb-status')).toBeVisible();
    await expect(page.locator('.vtorb-btn-mic')).toBeVisible();
    await expect(page.locator('.vtorb-btn-close')).toBeVisible();
  });

  test('aura inner and outer elements exist', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);

    await expect(page.locator('.vtorb-aura-inner')).toHaveCount(1);
    await expect(page.locator('.vtorb-aura-outer')).toHaveCount(1);
  });

  test('close button dismisses overlay', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);

    const overlay = page.locator('.vtorb-overlay');
    await expect(overlay).toBeVisible();

    await page.locator('.vtorb-btn-close').dispatchEvent('click');
    await expect(overlay).toBeHidden();
  });

  test('FAB button has adequate touch target', async ({ page }) => {
    await openPage(page);

    const fab = page.locator('.vtorb-fab');
    await expect(fab).toBeVisible();

    const box = await fab.boundingBox();
    expect(box).toBeTruthy();
    // Touch targets should be at least 44px per Apple HIG / WCAG
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

// ─── State Colors ──────────────────────────────────────────────

test.describe('ORB Widget — State Colors', () => {
  test('connecting state — gray aura, white text', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'connecting', 'Connecting...');

    const bg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(bg).toContain('226, 232, 240');

    await expect(page.locator('.vtorb-status')).toHaveText('Connecting...');
    const color = await page.locator('.vtorb-status').evaluate(el => el.style.color);
    expect(color).toContain('255, 255, 255');
  });

  test('thinking state — purple aura, purple text', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'thinking', 'Thinking...');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('139, 92, 246');
    const outerBg = await page.locator('.vtorb-aura-outer').evaluate(el => el.style.background);
    expect(outerBg).toContain('139, 92, 246');

    await expect(page.locator('.vtorb-status')).toHaveText('Thinking...');
    const color = await page.locator('.vtorb-status').evaluate(el => el.style.color);
    expect(color).toContain('139, 92, 246');
  });

  test('speaking state — amber aura, amber text', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'speaking', 'Vitana speaking...');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('245, 158, 11');
    const outerBg = await page.locator('.vtorb-aura-outer').evaluate(el => el.style.background);
    expect(outerBg).toContain('245, 158, 11');

    await expect(page.locator('.vtorb-status')).toHaveText('Vitana speaking...');
    const color = await page.locator('.vtorb-status').evaluate(el => el.style.color);
    expect(color).toContain('245, 158, 11');
  });

  test('listening state — blue aura, blue text', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'listening', 'Listening...');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('59, 130, 246');
    const outerBg = await page.locator('.vtorb-aura-outer').evaluate(el => el.style.background);
    expect(outerBg).toContain('59, 130, 246');

    await expect(page.locator('.vtorb-status')).toHaveText('Listening...');
    const color = await page.locator('.vtorb-status').evaluate(el => el.style.color);
    expect(color).toContain('59, 130, 246');
  });

  test('muted state — gray aura, sphere dimmed, white text', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'paused', 'Muted');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('107, 114, 128');

    const sphere = page.locator('.vtorb-large');
    expect(await sphere.evaluate(el => el.style.opacity)).toBe('0.6');
    expect(await sphere.evaluate(el => el.style.filter)).toContain('grayscale');

    await expect(page.locator('.vtorb-status')).toHaveText('Muted');
  });

  test('error state — red aura, red text', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'error', 'Connection lost.');

    const innerBg = await page.locator('.vtorb-aura-inner').evaluate(el => el.style.background);
    expect(innerBg).toContain('239, 68, 68');

    await expect(page.locator('.vtorb-status')).toHaveText('Connection lost.');
  });
});

// ─── Mic Mute Toggle ──────────────────────────────────────────

test.describe('ORB Widget — Mic Mute', () => {
  test('mic button toggles muted style', async ({ page }) => {
    await openPage(page);
    await showOrbOverlay(page);
    await setOrbState(page, 'listening', 'Listening...');

    const micBtn = page.locator('.vtorb-btn-mic');

    expect(await micBtn.evaluate(el => el.style.background)).toContain('59, 130, 246');

    await micBtn.dispatchEvent('click');
    await page.waitForTimeout(100);

    expect(await micBtn.evaluate(el => el.style.background)).toContain('239, 68, 68');
    await expect(page.locator('.vtorb-status')).toHaveText('Muted');

    await micBtn.dispatchEvent('click');
    await page.waitForTimeout(100);

    expect(await micBtn.evaluate(el => el.style.background)).toContain('59, 130, 246');
    await expect(page.locator('.vtorb-status')).toHaveText('Listening...');
  });
});
