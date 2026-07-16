/**
 * Device-level smoke flow: open the Vitana web app in the device browser,
 * log in through the real form, then walk the bottom navigation — tapping
 * every tab, verifying the screen actually changes, and capturing a
 * screenshot + accessibility outline of each state.
 *
 * The tab walk discovers tappable elements from the [Bottom] band of the
 * live text outline (label-agnostic, so it survives i18n and nav changes).
 * The raw --json envelope of the first screen is saved to artifacts as
 * ground truth for debugging outline parsing.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sectionEntries, parseEntries } from '../lib/outline.mjs';
import { openUrl, sleep } from '../lib/device.mjs';
import { loginFlow } from './login.mjs';

const TAPPABLE_RE = /Button|Link|Tab|Cell|Image/i;

async function observe(sim, report, label, { screenshot = true, retries = 0 } = {}) {
  const outline = await sim.outline({
    retries,
    onRetry: (n, err) => report.record({
      label: `${label} (retry ${n})`,
      ok: true,
      detail: `sim-use ui timed out, retrying: ${err.message}`,
    }),
  });
  let shot;
  if (screenshot) {
    shot = report.screenshotPath(label);
    await sim.screenshot(shot);
  }
  return { outline, shot };
}

export async function smokeFlow(ctx) {
  const { sim, report, device, platform, url } = ctx;

  // 1. Open the app in the device browser
  await openUrl({ device, platform, url });
  // MaxinaPortal is a heavy animated SPA (framer-motion, video preload) —
  // give it real time to paint before the first observe, on top of that
  // observe's own retry/timeout headroom below.
  await sleep(20_000);
  // First observe pays for the daemon's cold FBSimulatorControl + AX init on
  // a just-booted simulator — retry through transient timeouts here so a
  // slow (not broken) daemon doesn't fail the whole run.
  const first = await observe(sim, report, 'app loaded', { retries: 2 });
  const blank = first.outline.split('\n').length < 4;
  report.record({
    label: 'app loaded',
    ok: !blank,
    outline: first.outline,
    screenshot: first.shot,
    detail: blank ? 'outline nearly empty — page may not have rendered' : url,
  });

  // Ground truth for debugging: raw JSON envelope of the first screen
  try {
    const envelope = await sim.json(['ui']);
    writeFileSync(join(report.outDir, 'app-loaded.envelope.json'), JSON.stringify(envelope, null, 2));
  } catch { /* diagnostic only */ }

  // 2. Login through the real form
  const authed = await loginFlow(ctx);

  // 3. Discover bottom navigation from the live outline's [Bottom] band
  await sleep(2000);
  const home = await observe(sim, report, 'home', { screenshot: false });
  let bottom = sectionEntries(home.outline, 'Bottom')
    .filter(e => TAPPABLE_RE.test(e.role) && e.label.trim().length > 0);
  if (bottom.length === 0) {
    // Fallback: some layouts render nav without a [Bottom] band — look for a
    // TabBar-ish cluster anywhere in the outline.
    bottom = parseEntries(home.outline)
      .filter(e => /Tab/i.test(e.role) && e.label.trim().length > 0);
  }
  report.record({
    label: 'bottom nav discovery',
    // Without auth there may legitimately be no bottom nav — informational.
    ok: bottom.length > 0 || !authed,
    outline: home.outline,
    detail: bottom.length > 0
      ? `${bottom.length} tappable bottom-band elements: ${bottom.map(e => e.label).join(', ')}`
      : (authed ? 'no bottom-band elements found while authenticated'
                : 'no bottom nav (unauthenticated) — walked nothing'),
  });

  // 4. Walk each tab: tap → wait → verify the screen changed → screenshot
  let prevOutline = home.outline;
  for (const entry of bottom) {
    const label = entry.label;
    try {
      // Fresh outline before each tap — aliases go stale after navigation,
      // so tap by label (scoped to the bottom of the screen via the outline
      // re-discovery) rather than by cached alias.
      await sim.tap({ label }, { waitTimeout: 5, preDelay: 0.2 });
      await sleep(2500);
      const { outline, shot } = await observe(sim, report, `tab ${label}`);
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
  await sleep(20_000);
  const outline = await sim.outline({
    retries: 2,
    onRetry: (n, err) => report.record({
      label: `observe (retry ${n})`,
      ok: true,
      detail: `sim-use ui timed out, retrying: ${err.message}`,
    }),
  });
  const shot = report.screenshotPath('observe');
  await sim.screenshot(shot);
  try {
    const envelope = await sim.json(['ui']);
    writeFileSync(join(report.outDir, 'observe.envelope.json'), JSON.stringify(envelope, null, 2));
  } catch { /* diagnostic only */ }
  report.record({ label: 'observe', ok: outline.length > 0, outline, screenshot: shot, detail: url });
}
