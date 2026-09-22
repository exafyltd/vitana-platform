/**
 * VTID-04259: Command Hub idle-logout/session-refresh extension.
 *
 * Reported live: the ~3 real people who use the Command Hub were getting
 * logged out every 10-20 minutes instead of staying in for a full workday.
 * Root cause, found by reading the code rather than guessing: a 6-hour
 * idle-logout + silent-refresh mechanism (BOOTSTRAP-DEV-6H-SESSION) already
 * existed, but was gated on `active_role === 'developer'` EXACTLY — while
 * Command Hub access itself is granted to a wider set
 * (developer/admin/infra/staff, per the "Access control" block in
 * app.js's boot sequence). Anyone whose active role resolved to
 * admin/infra/staff instead of literal 'developer' fell straight through
 * to the old strict "log out the instant the JWT exp passes, no refresh"
 * path — at whatever the Supabase project's raw JWT lifetime is (often
 * well under an hour), which is the actual mechanism behind the reported
 * repeated logouts.
 *
 * This is a static source-check test, matching the established pattern for
 * app.js elsewhere in this suite (a plain IIFE bundle with no module
 * export surface, so assertions read the shipped source text directly
 * rather than importing/executing it).
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../src/frontend/command-hub/app.js');
const INDEX_HTML_PATH = join(__dirname, '../src/frontend/command-hub/index.html');

describe('VTID-04259: Command Hub session timeout extended to Command Hub roles', () => {
  let src: string;

  beforeAll(() => {
    src = readFileSync(APP_JS_PATH, 'utf8');
  });

  it('the idle-logout window is 24 hours (a full day), not the old 6 hours', () => {
    expect(src).toMatch(/var DEV_IDLE_LOGOUT_MS = 24 \* 60 \* 60 \* 1000;/);
    expect(src).not.toMatch(/var DEV_IDLE_LOGOUT_MS = 6 \* 60 \* 60 \* 1000;/);
  });

  it('defines a shared EXTENDED_SESSION_ROLES list covering every Command Hub role', () => {
    expect(src).toMatch(
      /EXTENDED_SESSION_ROLES = \['developer', 'admin', 'infra', 'staff'\]/
    );
  });

  it('the fetch interceptor no longer short-circuits on a literal active_role !== \'developer\' check', () => {
    // The old, narrow gate must be gone from the 401-retry path.
    expect(src).not.toMatch(/if \(getActiveRole\(\) !== 'developer'\) return resp;/);
    // Replaced with a membership check against the shared role list.
    expect(src).toMatch(/if \(!isExtendedSessionRole\(getActiveRole\(\)\)\) return resp;/);
  });

  it('the idle-logout monitor (isDeveloperSession) checks role membership, not exact equality to \'developer\'', () => {
    // The old exact-equality gate must be gone.
    expect(src).not.toMatch(
      /function isDeveloperSession\(\) \{\s*return \(state\.meContext && state\.meContext\.active_role === 'developer'\);\s*\}/
    );
    // isDeveloperSession must now consult the shared extended-role list.
    const fnMatch = src.match(/function isDeveloperSession\(\) \{[\s\S]*?\n {8}\}/);
    expect(fnMatch).toBeTruthy();
    expect(fnMatch![0]).toMatch(/__VITANA_EXTENDED_SESSION_ROLES/);
    expect(fnMatch![0]).toMatch(/roles\.indexOf\(role\) !== -1/);
  });

  it('handles a cross-tab refresh-token rotation by picking up another tab\'s written tokens', () => {
    // Supabase rotates the refresh token on every use; two Command Hub tabs
    // sharing localStorage must not each try to reuse the same stale token.
    expect(src).toMatch(/window\.addEventListener\('storage', function \(ev\) \{/);
    expect(src).toMatch(/ev\.key === 'vitana\.authToken'/);
    expect(src).toMatch(/ev\.key === 'vitana\.refreshToken'/);
  });

  it('the Command Hub cache-buster on index.html was bumped for this change', () => {
    const indexHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
    const appVersion = (indexHtml.match(/app\.js\?v=([0-9]{8}-[^"]+)"/) || [])[1] || '';
    expect(appVersion >= '20260922-vtid-04259-session-timeout').toBe(true);
    expect(indexHtml).toContain('styles.css?v=' + appVersion);
  });
});
