/**
 * VTID-04659: a staging check must read a Command Hub asset at a versioned URL.
 *
 * The /command-hub static mount serves .js/.css as `public, max-age=31536000,
 * immutable` (VTID-04074) and Cloudflare keeps each URL for a year. A new build is
 * reached only through a new `?v=` in index.html. A STAGING-VERIFY http check on the
 * BARE URL therefore reads whatever copy Cloudflare cached first, which is how
 * STAGING-VERIFY gateway @ c7f2c06 failed on VTID-04644 while the source was
 * correct: the check read a copy cached a day before the change.
 *
 * Also pins the orb-widget cache bust itself: VTID-04644 changed orb-widget.js
 * without bumping its `?v=`, so the Command Hub kept loading the old widget.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const INDEX_HTML = path.join(
  REPO_ROOT,
  'services/gateway/src/frontend/command-hub/index.html',
);
const VALIDATION_DIR = path.join(REPO_ROOT, 'docs/validation');

function versionedAssets(): Map<string, string> {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const assets = new Map<string, string>();
  const re = /(?:src|href)="(\/command-hub\/[^"?]+\.(?:js|css))\?v=([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) assets.set(m[1], m[2]);
  return assets;
}

type StagingTest = { kind?: string; path?: string; name?: string };

function stagingChecks(): Array<{ suite: string; test: StagingTest }> {
  const out: Array<{ suite: string; test: StagingTest }> = [];
  for (const dir of fs.readdirSync(VALIDATION_DIR)) {
    const file = path.join(VALIDATION_DIR, dir, 'staging-tests.json');
    if (!fs.existsSync(file)) continue;
    const suite = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const test of suite.tests ?? []) out.push({ suite: dir, test });
  }
  return out;
}

describe('VTID-04659 Command Hub asset URLs in staging checks', () => {
  it('index.html loads orb-widget.js with the VTID-04659 cache bust', () => {
    expect(versionedAssets().get('/command-hub/orb-widget.js')).toBe(
      '20260926-vtid-04659-after-turn',
    );
  });

  it('no staging http check reads a versioned Command Hub asset at its bare URL', () => {
    const assets = versionedAssets();
    expect(assets.size).toBeGreaterThan(0);
    const bare = stagingChecks()
      .filter(({ test }) => test.kind === 'http' && typeof test.path === 'string')
      .filter(({ test }) => assets.has(test.path as string))
      .map(({ suite, test }) => `${suite}: ${test.path}`);
    expect(bare).toEqual([]);
  });
});
