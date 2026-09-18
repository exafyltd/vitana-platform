/**
 * UI-driven login flow for Android — same intent as the iOS flow
 * (../../flows/login.mjs): drive the REAL login form via taps and
 * keystrokes, not a localStorage session injection.
 *
 * Chrome's first-run flow (ToS/"no thanks" prompts) is dismissed first —
 * a fresh AVD image hits this before any page content is reachable.
 *
 * `uiautomator dump` reflects the CURRENT layout snapshot, not the full
 * scrollable DOM — on a small emulator viewport a field below the fold
 * genuinely isn't in the dump yet (confirmed live: the email field was
 * found and typed into correctly, but the password field was absent from
 * that same dump). Scroll-and-retry before giving up on a missing field.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { label } from '../lib/uiautomator.mjs';
import { sleep } from '../../lib/device.mjs';

const CHROME_FIRSTRUN_RE = /accept\s*&?\s*continue|no\s*thanks|use\s*without\s*an?\s*account|got\s*it|^ok$/i;
const LOGIN_BUTTON_RE = /^(anmelden|einloggen|weiter|sign\s?in|log\s?in|login|continue)$/i;

function entrySummary(entries) {
  return entries.map(e => `${e.className.split('.').pop()} "${label(e)}" pw=${e.password} bounds=${JSON.stringify(e.bounds)}`).join('\n');
}

async function dismissChromeFirstRun(driver, report, maxHops = 3) {
  for (let i = 0; i < maxHops; i++) {
    const entries = await driver.visibleEntries();
    const hit = entries.find(e => e.clickable && CHROME_FIRSTRUN_RE.test(label(e)));
    if (!hit) return;
    report.record({ label: `chrome first-run dismiss`, ok: true, detail: label(hit) });
    await driver.tapEntry(hit);
    await sleep(1500);
  }
}

/** Re-dump, scrolling down up to `maxScrolls` times, until a password EditText appears. */
async function findPasswordField(driver, report, maxScrolls = 3) {
  for (let i = 0; i <= maxScrolls; i++) {
    const entries = await driver.visibleEntries();
    const found = entries.filter(e => e.className.includes('EditText')).find(e => e.password);
    if (found) return found;
    if (i === maxScrolls) return null;
    report.record({ label: `scroll for password field (${i + 1}/${maxScrolls})`, ok: true, detail: 'password EditText not in current dump — scrolling' });
    await driver.scroll({ direction: 'down' });
    await sleep(600);
  }
  return null;
}

export async function loginFlow({ driver, report, email, password }, depth = 0) {
  await dismissChromeFirstRun(driver, report);

  if (!password) {
    report.record({
      label: 'login skipped',
      ok: true,
      detail: 'no password configured — continuing unauthenticated',
    });
    return false;
  }

  const entries = await driver.visibleEntries();
  report.record({ label: 'login screen observe', ok: true, outline: entrySummary(entries) });
  try {
    writeFileSync(join(report.outDir, 'login-screen.dump.txt'), entrySummary(entries) + '\n');
  } catch { /* diagnostic only */ }

  const editTexts = entries.filter(e => e.className.includes('EditText'));

  if (editTexts.length === 0) {
    const entryBtn = entries.find(e => e.clickable && LOGIN_BUTTON_RE.test(label(e).trim()));
    if (entryBtn && depth < 2) {
      await driver.tapEntry(entryBtn);
      await sleep(2000);
      return loginFlow({ driver, report, email, password }, depth + 1);
    }
    report.record({
      label: 'login form',
      ok: true,
      detail: 'no login form found on screen — continuing (may already be authenticated)',
    });
    return false;
  }

  const emailField = editTexts.find(e => !e.password) || editTexts[0];

  await driver.tapEntry(emailField);
  await sleep(400);
  await driver.typeText(email);
  report.record({ label: 'typed email', ok: true, detail: email });

  // Tapping the email field opens the soft keyboard, which can occupy roughly
  // half the viewport and push a short below-the-fold field (like password,
  // on this compact single-card form) out of the visible/dumped layout
  // entirely. KEYCODE_BACK dismisses only the keyboard here (the page itself
  // has no back-navigable history yet), restoring the full viewport before
  // we even try scrolling — confirmed live: a run needing 3 failed scroll
  // retries still couldn't find the password field, consistent with the
  // keyboard covering it rather than it being further down a scrollable page.
  await driver.pressBack();
  await sleep(500);

  // The password field may not have been in the *initial* dump if it sits
  // below the fold — re-check (with scroll-retry) after typing the email,
  // rather than relying on the pre-typing snapshot.
  const passField = await findPasswordField(driver, report);
  if (!passField) {
    report.record({ label: 'password field', ok: false, detail: 'no password field found after scrolling' });
    return false;
  }

  await driver.tapEntry(passField);
  await sleep(400);
  await driver.typeText(password);
  report.record({ label: 'typed password', ok: true });

  await driver.pressKeyevent(66); // KEYCODE_ENTER — submits most single-line forms; harmless if not
  const submitted = await driver.tapLabel(LOGIN_BUTTON_RE, { optional: true });
  if (!submitted) report.record({ label: 'submit button', ok: true, detail: 'no explicit submit button found — relied on Enter key' });
  await sleep(4000); // auth round-trip + redirect

  const after = await driver.visibleEntries();
  const stillOnLogin = after.some(e => e.className.includes('EditText') && e.password);
  const shot = report.screenshotPath('after login');
  await driver.screenshot(shot);
  report.record({
    label: 'login submitted',
    ok: !stillOnLogin,
    screenshot: shot,
    detail: stillOnLogin ? 'password field still visible — login may have failed' : 'redirected',
  });
  return !stillOnLogin;
}
