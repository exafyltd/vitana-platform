/**
 * VTID-05803 staging cutover: the staging gateway deploy never carries production credentials.
 * AWS-STAGE-DEPLOY-GATEWAY.yml resolves only staging-named auth secrets, and its render step refuses a task definition
 * whose secrets or environment name a production Supabase/Aurora secret (the jq test() pattern is checked here as a
 * RegExp; scripts/ci/staging-db/stage-deploy-no-prod-secrets.test.mjs runs the exact jq).
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const wf = (f: string) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8');
const code = (y: string) => y.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const SM = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:';

describe('VTID-05803 staging gateway deploy: no production credentials', () => {
  const stage = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');

  it('resolves only staging-named auth secrets', () => {
    const ids = [...code(stage).matchAll(/"SEC_[A-Z_]+:([^"]+)"/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThanOrEqual(8);
    expect(ids.filter((id) => /^vitana\/(supabase|aurora)\/prod\//.test(id))).toEqual([]);
    expect(ids).toEqual(expect.arrayContaining([
      'vitana/supabase/staging/jwt-secret', 'vitana/supabase/staging/anon-key', 'vitana/gateway/staging/service-token',
    ]));
  });

  it('refuses production credentials before the task definition is written', () => {
    const gate = stage.indexOf('PROD_LEAK=$(');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(stage.indexOf('> "$RUNNER_TEMP/new-task-def.json"'));
    expect(stage).toMatch(/refusing to register: production credentials on a staging task definition/);
    const m = stage.slice(gate).match(/select\(\.v \| test\("([^"]+)"\)\)/);
    expect(m).not.toBeNull();
    const re = new RegExp(m![1]);
    for (const bad of [
      `${SM}vitana/supabase/prod/service-role-key-AbCdEf`, `${SM}vitana/supabase/prod/jwt-secret-AbCdEf`,
      `${SM}vitana/aurora/prod/database-url-AbCdEf`, 'vitana-aurora-prod.cluster-x.eu-central-1.rds.amazonaws.com',
      `${SM}rds!cluster-4dab93b8-1111-2222-3333-444444444444-AbCdEf`,
    ]) expect(re.test(bad)).toBe(true);
    for (const ok of [
      `${SM}vitana/supabase/staging/jwt-secret-AbCdEf`, `${SM}vitana/gateway/staging/service-token-AbCdEf`,
      'https://inmkhvwdcuyhnxkgfvsb.supabase.co',
    ]) expect(re.test(ok)).toBe(false);
  });

  it('leaves the production deploy unchanged', () => {
    const prod = wf('AWS-PROD-DEPLOY-GATEWAY.yml');
    expect(prod).toMatch(/vitana\/supabase\/prod\//);
    expect(prod).not.toMatch(/Production-credential gate/);
  });
});
