import { test, expect } from '@playwright/test';

test.describe('Mobile — Touch Interactions', () => {
  test('interactive elements have adequate tap target size (>= 44px)', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    // VTID-04620: wait for the SPA to render instead of a fixed 2 s sleep, so
    // the check measures the rendered screen and not a loading state.
    await expect
      .poll(async () => (await page.locator('body').innerText().catch(() => '')).length, { timeout: 20_000 })
      .toBeGreaterThan(10);

    // Check the first 20 visible buttons and links
    const interactiveElements = page.locator('button, a, [role="button"], input[type="submit"]');
    const count = await interactiveElements.count();

    let measured = 0;
    const tooSmall: string[] = [];
    for (let i = 0; i < count && measured < 20; i++) {
      const el = interactiveElements.nth(i);
      const box = await el.boundingBox();
      if (!box || box.width === 0 || box.height === 0) continue;
      measured++;
      // At least one dimension should be >= 44px (Apple HIG minimum)
      if (box.width < 44 && box.height < 44) {
        const label = await el.evaluate((node: Element) => {
          const h = node as HTMLElement;
          const name = h.getAttribute('aria-label') || h.innerText?.trim().slice(0, 30) || h.getAttribute('href') || '';
          const cls = (h.getAttribute('class') || '').split(/\s+/).slice(0, 3).join('.');
          return `<${node.tagName.toLowerCase()}${cls ? '.' + cls : ''}> "${name}"`;
        });
        tooSmall.push(`${label} ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }

    // Allow up to 20% to be small (icon buttons, etc.)
    const ratio = measured ? tooSmall.length / measured : 0;
    expect(ratio, `${tooSmall.length}/${measured} below 44px on ${page.url()}:\n${tooSmall.join('\n')}`).toBeLessThan(0.2);
  });

  test('page content is scrollable', async ({ page }) => {
    await page.goto('/community', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);

    const initialScroll = await page.evaluate(() => window.scrollY);

    // Scroll down
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(500);

    const afterScroll = await page.evaluate(() => window.scrollY);

    // If page has scrollable content, scroll position should change
    // (If page fits in viewport, this is acceptable too)
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = await page.evaluate(() => window.innerHeight);

    if (bodyHeight > viewportHeight) {
      expect(afterScroll).toBeGreaterThan(initialScroll);
    }
  });
});
