/**
 * Device-level smoke flow: open the Vitana web app in the device browser,
 * optionally log in through the real form, then walk the bottom navigation —
 * tapping every tab, verifying the screen actually changes, and capturing a
 * screenshot + accessibility outline of each state.
 *
 * The tab walk is label-agnostic on purpose: it discovers tappable elements
 * in the bottom band of the live accessibility tree instead of hardcoding
 * nav labels, so it survives i18n (DE default) and nav reorganisation.
 */
import { outlineUtils } from '../lib/simuse.mjs';
import { openUrl, sleep } from '../lib/device.mjs';
import { loginFlow } from './login.mjs';

const TAPPABLE_RE = /Button|Link|Tab|Cell/i;

export async function smokeFlow({ sim, report, device, platform, url, email, password }) {
  // 1. Open the app in the device browser
  await openUrl({ device, platform, url });
  await sleep(6000); // browser launch + SPA boot
  const first = await sim.ui();
  const firstShot = report.screenshotPath('app loaded');
  await sim.screenshot(firstShot);
  const blank = first.outline.split('\n').length < 4;
  report.record({
    label: 'app loaded',
    ok: !blank,
    outline: first.outline,
    screenshot: firstShot,
    detail: blank ? 'outline nearly empty — page may not have rendered' : url,
  });

  // 2. Login through the real form (skipped if no credentials)
  await loginFlow({ sim, report, email, password });

  // 3. Discover bottom navigation from the live accessibility tree
  await sleep(1500);
  const home = await sim.ui();
  const bottom = outlineUtils
    .bottomBandEntries(home.data)
    .filter(e => TAPPABLE_RE.test(e.role || e.type || ''))
    .filter(e => (e.label || '').trim().length > 0);
  report.record({
    label: 'bottom nav discovery',
    ok: bottom.length > 0,
    outline: home.outline,
    detail: `${bottom.length} tappable bottom-band elements: ${bottom.map(e => e.label).join(', ')}`,
  });

  // 4. Walk each tab: tap → wait → verify the screen changed → screenshot
  let prevOutline = home.outline;
  for (const entry of bottom) {
    const label = entry.label;
    try {
      await sim.tap({ label }, { waitTimeout: 5, preDelay: 0.2 });
      await sleep(2500);
      const { outline } = await sim.ui();
      const shot = report.screenshotPath(`tab ${label}`);
      await sim.screenshot(shot);
      const changed = outline !== prevOutline;
      report.record({
        label: `tab: ${label}`,
        ok: changed,
        outline,
        screenshot: shot,
        detail: changed ? 'screen updated' : 'outline identical to previous screen',
      });
      prevOutline = outline;
    } catch (err) {
      report.record({ label: `tab: ${label}`, ok: false, detail: err.message });
    }
  }

  // 5. Crash check — sim-use flags the browser process disappearing
  try {
    const state = await sim.appState();
    report.record({ label: 'app-state check', ok: true, detail: state.split('\n')[0] });
  } catch (err) {
    report.record({ label: 'app-state check', ok: false, detail: err.message });
  }
}

/**
 * Observe-only flow: open the URL and dump outline + screenshot. Useful as a
 * quick "eyes on the app" check without any interaction.
 */
export async function observeFlow({ sim, report, device, platform, url }) {
  await openUrl({ device, platform, url });
  await sleep(6000);
  const { outline } = await sim.ui();
  const shot = report.screenshotPath('observe');
  await sim.screenshot(shot);
  report.record({ label: 'observe', ok: outline.length > 0, outline, screenshot: shot, detail: url });
}
