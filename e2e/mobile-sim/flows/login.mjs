/**
 * UI-driven login flow — exercises the REAL login form with taps and
 * keystrokes (unlike the Playwright suites, which inject a Supabase session
 * into localStorage). This is deliberate: the point of the device layer is to
 * test the actual buttons a user touches.
 *
 * Element discovery parses the sim-use text outline (lib/outline.mjs) —
 * the stable documented surface. Selectors match DE and EN label variants
 * (German-default UI). Credentials come from the same envs/fallback as the
 * Playwright fixtures (TEST_USER_EMAIL / TEST_USER_PASSWORD).
 *
 * Returns true when the app appears authenticated afterwards.
 */
import { textFieldEntries, isSecureField, parseEntries } from '../lib/outline.mjs';
import { sleep } from '../lib/device.mjs';

const LOGIN_BUTTON_RE = /^(anmelden|einloggen|weiter|sign\s?in|log\s?in|login|continue)$/i;

export async function loginFlow({ sim, report, email, password }, depth = 0) {
  if (!password) {
    report.record({
      label: 'login skipped',
      ok: true,
      detail: 'no password configured — continuing unauthenticated',
    });
    return false;
  }

  // This runner class has shown 80-120s per `ui` call under load (heavy
  // animated React SPA, not the lightweight native-app case sim-use
  // benchmarks against) — give the login-screen observe the same timeout
  // retry as the first "app loaded" observe, not just a single shot.
  const outline = await sim.outline({
    retries: 2,
    onRetry: (n, err) => report.record({
      label: `login screen observe (retry ${n})`,
      ok: true,
      detail: `sim-use ui timed out, retrying: ${err.message}`,
    }),
  });
  report.record({ label: 'login screen observe', ok: true, outline });

  const fields = textFieldEntries(outline);
  if (fields.length === 0) {
    // No form on screen: either already authenticated, or login is behind an
    // entry button (e.g. landing page with "Anmelden"). Try that once.
    const entryBtn = parseEntries(outline).find(
      e => /Button|Link/i.test(e.role) && LOGIN_BUTTON_RE.test(e.label.trim()),
    );
    if (entryBtn && depth < 2) {
      await sim.tap({ alias: entryBtn.alias });
      await sleep(2000);
      return loginFlow({ sim, report, email, password }, depth + 1);
    }
    report.record({
      label: 'login form',
      ok: true,
      detail: 'no login form found on screen — continuing (may already be authenticated)',
    });
    return false;
  }

  const passField = fields.find(isSecureField) || fields[1];
  const emailField = fields.find(f => f !== passField) || fields[0];

  // Email
  await sim.tap({ alias: emailField.alias });
  await sleep(400);
  await sim.type(email);
  report.record({ label: 'typed email', ok: true, detail: email });

  if (!passField) {
    report.record({ label: 'password field', ok: false, detail: 'no password field in outline' });
    return false;
  }

  // Password — re-observe first: the keyboard may have shifted the layout
  const midOutline = await sim.outline();
  const passNow = textFieldEntries(midOutline).find(isSecureField) || passField;
  await sim.tap({ alias: passNow.alias });
  await sleep(400);
  await sim.type(password);
  report.record({ label: 'typed password', ok: true });

  // Submit
  await sim.tap({ labelRegex: LOGIN_BUTTON_RE.source }, { waitTimeout: 5 });
  await sleep(4000); // auth round-trip + SPA redirect

  const after = await sim.outline();
  const stillOnLogin = textFieldEntries(after).some(isSecureField);
  const shot = report.screenshotPath('after login');
  await sim.screenshot(shot);
  report.record({
    label: 'login submitted',
    ok: !stillOnLogin,
    outline: after,
    screenshot: shot,
    detail: stillOnLogin ? 'password field still visible — login may have failed' : 'redirected',
  });
  return !stillOnLogin;
}
