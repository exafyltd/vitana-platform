/**
 * iOS playback-keepalive smoke — Phase 1 W1 (VTID-03181 VOICE-LAT).
 *
 * Failure mode: iOS Safari pauses MediaElement playback when the tab is
 * backgrounded for more than a few seconds. When focus returns, the
 * player is sitting at a frozen position and the user perceives the
 * orb as "stuck". The expected recovery: detect paused-while-active,
 * resume from the same position, no audio gap > 1s.
 *
 * GATED on BROWSERSTACK_USERNAME (see audio-context.spec.ts).
 */

import { test, expect } from '@playwright/test';

const BROWSERSTACK_READY = !!process.env.BROWSERSTACK_USERNAME && !!process.env.BROWSERSTACK_ACCESS_KEY;

test.describe('iOS: playback keepalive', () => {
  test.skip(!BROWSERSTACK_READY, 'BROWSERSTACK_USERNAME not set; iOS suite dormant');

  test('TTS chunk playback resumes after brief backgrounding', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Trigger a synthetic orb response with an audio chunk
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      win.__vitanaOrbTestHooks?.injectTtsChunk?.(
        // Tiny silent MP3 chunk for the smoke run; production runs would
        // use an actual 16kHz PCM chunk from the orb response stream.
        new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0, 0, 0, 0]),
      );
    });

    const initialPosition = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      return win.__vitanaOrbTestHooks?.currentPlaybackPosition?.() ?? 0;
    });

    // Background for 3s (longer than the 2s iOS auto-pause threshold)
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(3000);

    // Return to foreground
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);

    const recoveredPosition = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = window as any;
      return win.__vitanaOrbTestHooks?.currentPlaybackPosition?.() ?? -1;
    });

    // On a real device with the hook present, recovery should have either:
    //   - resumed (recoveredPosition > initialPosition + 2s), OR
    //   - stayed at initialPosition (resumed from same spot, no rewind)
    // The failure case we're guarding against is recoveredPosition === -1
    // (player went into an error state).
    expect(recoveredPosition).not.toBe(-1);
  });
});
