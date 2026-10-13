/**
 * VTID-05080 — the generated Command Hub spec is well-formed. Wraps the CI
 * validator so the standing screens-catalog VTID's STAGING-VERIFY suite can
 * run it without depending on whether a later catalog sync has landed yet.
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const GATEWAY = path.resolve(__dirname, '..');

describe('VTID-05080 dev frontend spec validator', () => {
  it('validate-dev-frontend-spec.mjs passes on the committed catalog', () => {
    const r = spawnSync('node', [path.join(GATEWAY, 'scripts/validate-dev-frontend-spec.mjs')], { encoding: 'utf8' });
    expect(r.stderr).not.toContain('FRONTEND SPEC VIOLATION');
    expect(r.status).toBe(0);
  });
});
