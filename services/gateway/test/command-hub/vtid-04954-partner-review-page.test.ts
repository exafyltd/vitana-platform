/**
 * VTID-04954: the supplier review page (VTID-04933) scrolls, keeps the outcome
 * of an action in view, cannot be double-clicked, and says plainly when the
 * Command Hub sign-in is missing or expired.
 */
import * as fs from 'fs';
import * as path from 'path';

const dir = path.resolve(__dirname, '../../src/frontend/command-hub');
const html = fs.readFileSync(path.join(dir, 'partner-review.html'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'partner-review.css'), 'utf8');
const js = fs.readFileSync(path.join(dir, 'partner-review.js'), 'utf8');
const shared = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');

describe('VTID-04954 supplier review page', () => {
  test('stays CSP-compliant and cache-busted for this change', () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/style="/);
    expect(html).not.toMatch(/<style/);
    expect(html).toContain('src="/command-hub/partner-review.js?v=20261007-VTID-04954"');
    expect(html).toContain('href="/command-hub/partner-review.css?v=20261007-VTID-04954"');
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  test('the page scrolls: it overrides the shared body lock for itself only', () => {
    // The app shell keeps its rule; this page opts out with its own class.
    expect(shared).toMatch(/body\s*\{[^}]*overflow:\s*hidden/);
    expect(html).toContain('<body class="pr-page">');
    expect(css).toMatch(/body\.pr-page\s*\{[^}]*height:\s*auto;[^}]*overflow:\s*auto;/);
  });

  test('the outcome of an action stays in view', () => {
    expect(html).toMatch(/id="pr-status"[^>]*role="status"[^>]*aria-live="polite"/);
    expect(css).toMatch(/\.pr-status\s*\{[^}]*position:\s*sticky;[^}]*top:\s*0;/);
    expect(js).toContain("'Approved — verification level 1.'");
    expect(js).toContain('scrollIntoView');
  });

  test('every button in the detail panel is disabled while an action runs', () => {
    expect(js).toMatch(/detailRoot\.querySelectorAll\('button'\)/);
    const act = js.slice(js.indexOf('function act('), js.indexOf('function loadDetail('));
    expect(act.indexOf('setButtons(true)')).toBeGreaterThan(-1);
    expect(act.indexOf('setButtons(true)')).toBeLessThan(act.indexOf("call('POST'"));
    expect(act).toContain('setButtons(false)');
  });

  test('reads only the Command Hub token and explains a missing or expired sign-in', () => {
    expect(js).toContain("localStorage.getItem('vitana.authToken')");
    expect(js).not.toContain('vitana.command_hub.token');
    expect(js).toContain("_auth: 'missing'");
    expect(js).toMatch(/r\.status === 401\) j\._auth = 'expired'/);
    expect(js).toContain('Your Command Hub sign-in has expired.');
    expect(js).toContain('Sign in to the Command Hub in this browser first');
    // List, detail and actions all report through the same helper.
    expect((js.match(/problem\(j, /g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
