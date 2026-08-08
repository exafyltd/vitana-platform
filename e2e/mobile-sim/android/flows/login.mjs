/**
 * UI-driven login flow for Android — same intent as the iOS flow
 * (../../flows/login.mjs): drive the REAL login form via taps and
 * keystrokes, not a localStorage session injection.
 *
 * Chrome's first-run flow (ToS/"no thanks" prompts) is dismissed first —
 * a fresh AVD image hits this before any page content is reachable.
 */
import { label } from '../lib/uiautomator.mjs';
import { sleep } from '../../lib/device.mjs';

const CHROME_FIRSTRUN_RE = /accept\s*&?\s*continue|no\s*thanks|use\s*without\s*an?\s*account|got\s*it|^ok$/i;
const LOGIN_BUTTON_RE = /^(anmelden|einloggen|weiter|sign\s?in|log\s?in|login|continue)$/i;

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

  const passField = editTexts.find(e => e.password) || editTexts[1];
  const emailField = editTexts.find(e => e !== passField) || editTexts[0];

  await driver.tapEntry(emailField);
  await sleep(400);
  await driver.typeText(email);
  report.record({ label: 'typed email', ok: true, detail: email });

  if (!passField) {
    report.record({ label: 'password field', ok: false, detail: 'no password field found' });
    return false;
  }

  // Re-dump: the soft keyboard appearing can shift on-screen positions.
  const midEntries = (await driver.visibleEntries()).filter(e => e.className.includes('EditText'));
  const passNow = midEntries.find(e => e.password) || passField;
  await driver.tapEntry(passNow);
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
