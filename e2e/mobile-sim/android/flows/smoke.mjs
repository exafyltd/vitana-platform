/**
 * Device-level smoke flow for Android — open the app in Chrome, log in
 * through the real form, then walk the bottom navigation, verifying each
 * screen actually changes and capturing a screenshot + element dump per
 * step. Mirrors ../../flows/smoke.mjs (iOS/sim-use); see that file for the
 * shared design rationale.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { label } from '../lib/uiautomator.mjs';
import { sleep } from '../../lib/device.mjs';
import { loginFlow } from './login.mjs';

async function observe(driver, report, stepLabel, { screenshot = true } = {}) {
  const entries = await driver.visibleEntries();
  let shot;
  if (screenshot) {
    shot = report.screenshotPath(stepLabel);
    await driver.screenshot(shot);
  }
  return { entries, shot };
}

function entrySummary(entries) {
  return entries.map(e => `${e.className.split('.').pop()} "${label(e)}"`).join('\n');
}

export async function smokeFlow(ctx) {
  const { driver, report, url, beginRecording } = ctx;

  // 1. Open the app in Chrome
  await driver.openUrl(url);
  await sleep(20_000); // Chrome launch + SPA boot — same rationale as the iOS flow
  const first = await observe(driver, report, 'app loaded');
  beginRecording?.(); // start recording once the device has proven responsive
  const blank = first.entries.length < 2;
  report.record({
    label: 'app loaded',
    ok: !blank,
    outline: entrySummary(first.entries),
    screenshot: first.shot,
    detail: blank ? 'almost no elements found — page may not have rendered' : url,
  });

  try {
    const size = await driver.screenSize();
    writeFileSync(join(report.outDir, 'screen-size.json'), JSON.stringify(size, null, 2));
  } catch { /* diagnostic only */ }

  // 2. Login through the real form
  const authed = await loginFlow(ctx);

  // 3. Discover bottom navigation — elements in the bottom band of the screen
  await sleep(2000);
  const home = await observe(driver, report, 'home', { screenshot: false });
  const size = await driver.screenSize().catch(() => null);
  let bottom = [];
  if (size) {
    const bandTop = size.height * 0.85;
    bottom = home.entries.filter(
      e => e.clickable && e.bounds && e.bounds.y1 >= bandTop && label(e).trim().length > 0,
    );
  }
  report.record({
    label: 'bottom nav discovery',
    ok: bottom.length > 0 || !authed,
    outline: entrySummary(home.entries),
    detail: bottom.length > 0
      ? `${bottom.length} tappable bottom-band elements: ${bottom.map(label).join(', ')}`
      : (authed ? 'no bottom-band elements found while authenticated'
                : 'no bottom nav (unauthenticated) — walked nothing'),
  });

  // 4. Walk each tab: tap → wait → verify the screen changed → screenshot
  let prevSummary = entrySummary(home.entries);
  for (const entry of bottom) {
    const tabLabel = label(entry);
    try {
      await driver.tapLabel(tabLabel, { optional: false });
      await sleep(2500);
      const { entries, shot } = await observe(driver, report, `tab ${tabLabel}`);
      const summary = entrySummary(entries);
      const changed = summary !== prevSummary;
      report.record({
        label: `tab: ${tabLabel}`,
        ok: changed,
        outline: summary,
        screenshot: shot,
        detail: changed ? 'screen updated' : 'element dump identical to previous screen',
      });
      prevSummary = summary;
    } catch (err) {
      report.record({ label: `tab: ${tabLabel}`, ok: false, detail: err.message });
    }
  }

  // 5. Crash check — foreground package should still be Chrome
  try {
    const pkg = await driver.foregroundPackage();
    const ok = pkg === 'com.android.chrome' || pkg === null;
    report.record({ label: 'foreground check', ok, detail: pkg || 'unknown' });
  } catch (err) {
    report.record({ label: 'foreground check', ok: false, detail: err.message });
  }
}

/** Observe-only flow — open the URL and dump elements + screenshot. */
export async function observeFlow({ driver, report, url, beginRecording }) {
  await driver.openUrl(url);
  await sleep(20_000);
  const entries = await driver.visibleEntries();
  beginRecording?.();
  const shot = report.screenshotPath('observe');
  await driver.screenshot(shot);
  report.record({
    label: 'observe',
    ok: entries.length > 0,
    outline: entrySummary(entries),
    screenshot: shot,
    detail: url,
  });
}
