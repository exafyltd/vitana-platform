/**
 * eng-platform-p01 / stage-oidc-platform — every vitana-platform workflow that used the staging static keys takes the
 * plan §3 shape: OIDC through vars.AWS_STAGING_ROLE_ARN, the keys only while that variable is unset; and the drift
 * check moves to a read-only role and secret when vars.AWS_DRIFT_ROLE_ARN is set. Reads workflow text only.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF_DIR = path.resolve(__dirname, '../../../.github/workflows');
const files = fs.readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f));
const read = (f: string) => fs.readFileSync(path.join(WF_DIR, f), 'utf8');

// Found by grep, not by a fixed list, so a new static-key workflow cannot slip past.
const keyUsers = files.filter((f) => read(f).includes('secrets.AWS_STAGING_ACCESS_KEY_ID'));

// Plan §10: production workflows are out of scope.
const PROD = /^AWS-PROD-/;
// Plan §4 / sparring R1-F3: the identity-drift alert reads production Aurora read-only, so it takes the drift role.
const roleVar = (f: string) => (f === 'ALERT-APP-USERS-IDENTITY-DRIFT.yml' ? 'AWS_DRIFT_ROLE_ARN' : 'AWS_STAGING_ROLE_ARN');

function credentialSteps(text: string): string[] {
  // Each `uses: aws-actions/configure-aws-credentials` plus its `with:` block (up to the next step or blank line).
  const out: string[] = [];
  const re = /uses: aws-actions\/configure-aws-credentials@v\d+\n\s+with:\n((?:\s{10,}.*\n)+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
}

function topPermissions(text: string): string {
  const m = text.match(/^permissions:\n((?:  .*\n|\s*\n)*?)(?=^\S)/m);
  return m ? m[1] : '';
}

describe('staging static keys sit behind the OIDC role variable', () => {
  it('covers the eight known static-key workflows', () => {
    const expected = [
      'ALERT-APP-USERS-IDENTITY-DRIFT.yml',
      'AWS-PROVISION-APPILIX-SECRETS.yml',
      'AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml',
      'AWS-STAGE-DEPLOY-ERP-BRIDGE.yml',
      'AWS-STAGE-DEPLOY-GATEWAY.yml',
      'AWS-STAGE-DEPLOY-KIRO-RUNNER.yml',
      'AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml',
      'I18N-DB-SEED.yml',
    ];
    for (const f of expected) expect(keyUsers).toContain(f);
    expect(keyUsers.filter((f) => PROD.test(f))).toEqual([]);
  });

  for (const f of keyUsers) {
    describe(f, () => {
      const text = read(f);

      it('every credential step that names the staging keys uses the role variable and the key guard', () => {
        const steps = credentialSteps(text).filter((s) => s.includes('AWS_STAGING_ACCESS_KEY_ID'));
        expect(steps.length).toBeGreaterThan(0);
        const v = roleVar(f);
        for (const s of steps) {
          expect(s).toContain(`role-to-assume: \${{ vars.${v} }}`);
          expect(s).toContain(`aws-access-key-id: \${{ !vars.${v} && secrets.AWS_STAGING_ACCESS_KEY_ID || '' }}`);
          expect(s).toContain(`aws-secret-access-key: \${{ !vars.${v} && secrets.AWS_STAGING_SECRET_ACCESS_KEY || '' }}`);
        }
      });

      it('no unguarded static key remains', () => {
        expect(text).not.toMatch(/aws-access-key-id: \$\{\{ secrets\.AWS_STAGING_ACCESS_KEY_ID \}\}/);
        expect(text).not.toMatch(/aws-secret-access-key: \$\{\{ secrets\.AWS_STAGING_SECRET_ACCESS_KEY \}\}/);
      });

      it('grants id-token: write at the top level', () => {
        expect(topPermissions(text)).toMatch(/^  id-token: write/m);
      });
    });
  }

  it('AWS-PROVISION-APPILIX-SECRETS keeps its production leg on AWS_PROD_ROLE_ARN', () => {
    const steps = credentialSteps(read('AWS-PROVISION-APPILIX-SECRETS.yml'));
    expect(steps.some((s) => /role-to-assume: \$\{\{ secrets\.AWS_PROD_ROLE_ARN \}\}/.test(s))).toBe(true);
  });
});

describe('MIGRATION-DRIFT-CHECK reads Aurora with the read-only role and secret when configured', () => {
  const text = read('MIGRATION-DRIFT-CHECK.yml');

  it('assumes vars.AWS_DRIFT_ROLE_ARN, falling back to the prod role while it is unset', () => {
    expect(text).toContain('role-to-assume: ${{ vars.AWS_DRIFT_ROLE_ARN || secrets.AWS_PROD_ROLE_ARN }}');
  });

  it('uses the claude-readonly secret, not the master secret, on the drift-role path', () => {
    expect(text).toContain('DRIFT_ROLE: ${{ vars.AWS_DRIFT_ROLE_ARN }}');
    expect(text).toMatch(
      /if \[ -n "\$DRIFT_ROLE" \]; then\s+SECRET_ARN=\$\(aws secretsmanager describe-secret[^\n]*vitana\/aurora\/prod\/claude-readonly/,
    );
    expect(text).toMatch(/else\s+SECRET_ARN=\$\(aws rds describe-db-clusters[\s\S]*?MasterUserSecret\.SecretArn/);
  });
});
