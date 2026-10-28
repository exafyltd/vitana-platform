// VTID-05009 — AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml creates the STAGING
// morning-pack secret only: dispatch-only, staging keys only, never rotates,
// and the generated value is masked and never printed.
import { readFileSync } from 'fs';
import { join } from 'path';

const wf = readFileSync(
  join(__dirname, '../../../.github/workflows/AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml'),
  'utf8',
);

describe('VTID-05009 provisioning workflow for the dev-memory pack token', () => {
  it('runs only on manual dispatch with a required reason', () => {
    expect(wf).toMatch(/^on:\n {2}workflow_dispatch:/m);
    expect(wf).not.toMatch(/^\s+(push|pull_request|schedule):/m);
    expect(wf).toMatch(/reason:\n\s+description:[^\n]*\n\s+required: true/);
  });

  it('targets the staging secret with staging keys only (no prod role, no prod name)', () => {
    expect(wf).toContain('SECRET_NAME: vitana/gateway/staging/dev-memory-pack-token');
    expect(wf).toContain('secrets.AWS_STAGING_ACCESS_KEY_ID');
    expect(wf).not.toContain('AWS_PROD_ROLE_ARN');
    expect(wf).not.toContain('vitana/gateway/prod/');
    expect(wf).not.toContain('id-token: write');
  });

  it('never rotates an existing secret', () => {
    expect(wf).not.toContain('put-secret-value');
    expect(wf.indexOf('describe-secret')).toBeLessThan(wf.indexOf('create-secret'));
    expect(wf).toContain('no-op, never rotated');
  });

  it('masks the value before use and never prints it', () => {
    const mask = wf.indexOf('::add-mask::$TOKEN');
    expect(mask).toBeGreaterThan(0);
    expect(mask).toBeLessThan(wf.indexOf('create-secret'));
    const echoes = wf.split('\n').filter((l) => /echo/.test(l) && /\$TOKEN|\$\{TOKEN/.test(l) && !l.includes('::add-mask::'));
    expect(echoes).toEqual([]);
    expect(wf).not.toMatch(/set -x/);
  });
});
