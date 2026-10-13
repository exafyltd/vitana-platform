/**
 * VTID-05122: Command Hub spec-approve calls.
 *  - Self-Healing → Active Repairs APPROVE posted to a route that does not
 *    exist (POST /api/v1/specs/approve → HTML 404), without a Bearer token,
 *    and showed "Spec approved" no matter what came back. It now calls the
 *    real POST /api/v1/specs/:vtid/approve with buildContextHeaders() and
 *    shows success only after an ok check.
 *  - The Task drawer's Approve Spec no longer sends the dead x-user-id /
 *    x-user-role headers (the approver comes from the JWT since VTID-05048).
 */
import * as fs from 'fs';
import * as path from 'path';

const HUB = path.resolve(__dirname, '../../src/frontend/command-hub');
const APP_JS = fs.readFileSync(path.join(HUB, 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(HUB, 'index.html'), 'utf8');
const SPECS_TS = fs.readFileSync(path.resolve(__dirname, '../../src/routes/specs.ts'), 'utf8');

function fnBody(name: string): string {
  const start = APP_JS.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`no function ${name}`);
  const next = APP_JS.indexOf('\nfunction ', start + 1);
  return APP_JS.slice(start, next < 0 ? undefined : next);
}

const FETCH_ANCHOR = "fetch('/api/v1/specs/' + encodeURIComponent(task.vtid) + '/approve'";
const FETCH_INIT_AUTH = /fetch\('\/api\/v1\/specs\/' \+ encodeURIComponent\(task\.vtid\) \+ '\/approve',\s*\{[^}]*headers:\s*buildContextHeaders\(/;
const OK_BRANCH = /if\s*\(\s*[\w.]*\bok\b[^)]*\)\s*\{[^]*?showToast\('Spec approved for '/;

const BODY = fnBody('renderSelfHealingView');
const I = BODY.indexOf(FETCH_ANCHOR);
const CALL = I === -1 ? '' : BODY.slice(I, BODY.indexOf("showToast('Spec approved for '", I) + 200);

describe('VTID-05122 no dead approve path or identity headers anywhere in app.js', () => {
  it('app.js never calls POST /api/v1/specs/approve', () => {
    expect(APP_JS).not.toContain("'/api/v1/specs/approve'");
  });

  it('app.js sends no x-user-id / x-user-role headers', () => {
    expect(APP_JS).not.toContain("'x-user-id'");
    expect(APP_JS.toLowerCase()).not.toContain("'x-user-role'");
  });
});

describe('VTID-05122 Self-Healing Active Repairs APPROVE', () => {
  it('calls the real per-VTID approve route', () => {
    expect(I).not.toBe(-1);
    expect(BODY).not.toContain("'/api/v1/specs/approve'");
  });

  it('sends the Bearer helper inside that fetch init', () => {
    expect(CALL).toMatch(FETCH_INIT_AUTH);
  });

  it('shows the success toast only inside an ok-guarded branch, and a failure toast otherwise', () => {
    expect(CALL).toMatch(OK_BRANCH);
    const success = CALL.indexOf("showToast('Spec approved for '");
    const failure = CALL.indexOf("'Approve failed", success);
    expect(success).toBeGreaterThan(-1);
    expect(failure).toBeGreaterThan(success);
  });

  it('surfaces network errors with .catch(', () => {
    expect(CALL).toContain('.catch(');
  });

  it('mutation self-test: an unconditional success toast fails the ok-branch check', () => {
    const mutated = CALL.replace(/if\s*\(\s*[\w.]*\bok\b[^)]*\)\s*\{/g, '{');
    expect(mutated).not.toBe(CALL);
    expect(mutated).not.toMatch(OK_BRANCH);
  });
});

describe('VTID-05122 Task drawer spec approve', () => {
  it('still calls the per-VTID route with the Bearer helper', () => {
    const drawer = fnBody('renderTaskDrawer');
    expect(drawer).toContain("'/api/v1/specs/' + vtid + '/approve'");
    expect(drawer).toContain('buildContextHeaders(');
  });
});

describe('VTID-05122 cache-bust', () => {
  it("index.html loads app.js with a ?v= at or after the vtid-05122 marker", () => {
    const ver = (INDEX.match(/app\.js\?v=([^"]+)/) || [])[1] || '';
    expect(ver >= '20261118-vtid-05122').toBe(true);
  });
});

describe('VTID-05122 backend contract the frontend relies on', () => {
  it('POST /:vtid/approve stays behind requireServiceOrAdmin (fails loudly if auth is loosened)', () => {
    expect(SPECS_TS).toContain("router.post('/:vtid/approve', requireServiceOrAdmin");
  });

  it('there is no POST /approve route on the specs router', () => {
    expect(SPECS_TS).not.toContain("router.post('/approve'");
  });
});
