/**
 * UI-driven login flow — exercises the REAL login form with taps and
 * keystrokes (unlike the Playwright suites, which inject a Supabase session
 * into localStorage). This is deliberate: the point of the device layer is to
 * test the actual buttons a user touches.
 *
 * Works on the German-default UI: selectors match DE and EN label variants.
 * Credentials come from the same env vars as the Playwright fixtures
 * (TEST_USER_EMAIL / TEST_USER_PASSWORD, default e2e-test@vitana.dev).
 */
import { outlineUtils } from '../lib/simuse.mjs';
import { sleep } from '../lib/device.mjs';

const LOGIN_BUTTON_RE = /^(anmelden|einloggen|sign\s?in|log\s?in|login)$/i;
const TEXTFIELD_RE = /TextField|TextInput|EditText/i;
const SECURE_RE = /Secure/i;

export async function loginFlow({ sim, report, email, password }) {
  if (!password) {
    report.record({
      label: 'login skipped',
      ok: true,
      detail: 'TEST_USER_PASSWORD not set — continuing unauthenticated',
    });
    return false;
  }

  const { outline, data } = await sim.ui();
  report.record({ label: 'login screen observe', ok: true, outline });

  const fields = outlineUtils.entriesByRole(data, TEXTFIELD_RE);
  if (fields.length === 0) {
    // Already authenticated (session persisted in the browser) or login is
    // behind an entry button — try a visible login button first.
    const entryBtn = outlineUtils.findByLabel(data, LOGIN_BUTTON_RE);
    if (!entryBtn) {
      report.record({
        label: 'login form',
        ok: true,
        detail: 'no login form on screen — assuming already authenticated',
      });
      return true;
    }
    await sim.tap({ label: entryBtn.label }, { waitTimeout: 5 });
    await sleep(1200);
    return loginFlow({ sim, report, email, password });
  }

  const emailField = fields.find(f => !SECURE_RE.test(f.role || '')) || fields[0];
  const passField = fields.find(f => SECURE_RE.test(f.role || '')) || fields[1];

  // Email
  await sim.tap(
    emailField.aliases?.at ? { alias: emailField.aliases.at } : { point: center(emailField) },
  );
  await sleep(300);
  await sim.type(email);
  report.record({ label: 'typed email', ok: true, detail: email });

  // Password
  if (!passField) throw new Error('login: no password field found in outline');
  await sim.tap(
    passField.aliases?.at ? { alias: passField.aliases.at } : { point: center(passField) },
  );
  await sleep(300);
  await sim.type(password);
  report.record({ label: 'typed password', ok: true });

  // Submit
  await sim.tap({ labelRegex: LOGIN_BUTTON_RE.source }, { waitTimeout: 5 });
  await sleep(3000); // auth round-trip + redirect

  const after = await sim.ui();
  const stillOnLogin = outlineUtils
    .entriesByRole(after.data, TEXTFIELD_RE)
    .some(f => SECURE_RE.test(f.role || ''));
  const shot = report.screenshotPath('after login');
  await sim.screenshot(shot);
  report.record({
    label: 'login submitted',
    ok: !stillOnLogin,
    outline: after.outline,
    screenshot: shot,
    detail: stillOnLogin ? 'password field still visible — login may have failed' : 'redirected',
  });
  return !stillOnLogin;
}

function center(entry) {
  const f = entry.frame || {};
  const x = (f.x ?? f.minX ?? 0) + (f.width ?? f.w ?? 0) / 2;
  const y = (f.y ?? f.minY ?? 0) + (f.height ?? f.h ?? 0) / 2;
  return [Math.round(x), Math.round(y)];
}
