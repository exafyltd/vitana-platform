/**
 * VTID-04696: a staging check that names a Command Hub asset version names
 * the version index.html loads.
 *
 * STAGING-VERIFY replays the change suite of every commit between production
 * and the verified commit. VTID-04661's suite asserted that the Command Hub
 * loads `app.js?v=20261017-vtid-04661`; VTID-04663 then bumped the version
 * (correctly — a new build is reached only through a new `?v=`, VTID-04659),
 * and every later gateway verification failed on a check about code that was
 * still there. A bump that leaves an older suite behind now fails here, in
 * the PR that bumps, instead of after the deploy.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INDEX_HTML = path.join(REPO_ROOT, 'services/gateway/src/frontend/command-hub/index.html');
const VALIDATION_DIR = path.join(REPO_ROOT, 'docs/validation');

function servedVersions(): Map<string, string> {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const out = new Map<string, string>();
  const re = /(?:src|href)="\/command-hub\/([^"?]+\.(?:js|css))\?v=([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) out.set(m[1], m[2]);
  return out;
}

describe('VTID-04696 staging checks follow Command Hub asset bumps', () => {
  it('every asset version named in a staging suite is the one index.html loads', () => {
    const served = servedVersions();
    expect(served.size).toBeGreaterThan(0);
    const stale: string[] = [];
    const re = /(?<![A-Za-z0-9_-])([a-z0-9_-]+\.(?:js|css))\?v=([A-Za-z0-9._-]+)/g;
    for (const dir of fs.readdirSync(VALIDATION_DIR)) {
      const file = path.join(VALIDATION_DIR, dir, 'staging-tests.json');
      if (!fs.existsSync(file)) continue;
      const raw = fs.readFileSync(file, 'utf8');
      let m: RegExpExecArray | null;
      while ((m = re.exec(raw)) !== null) {
        const want = served.get(m[1]);
        if (want && want !== m[2]) stale.push(`${dir}: ${m[1]}?v=${m[2]} (index.html loads ?v=${want})`);
      }
    }
    expect(stale).toEqual([]);
  });
});
