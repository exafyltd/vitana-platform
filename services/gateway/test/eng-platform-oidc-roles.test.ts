/**
 * eng-platform-p01 / oidc-roles — trust and permission files for the keyless GitHub Actions roles, and the owner-run
 * script that applies them (scripts/aws/setup-github-oidc-roles.sh). Reads files only; no AWS access in CI.
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../..');
const IAM = path.join(ROOT, 'scripts/aws/iam');
const SCRIPT = path.join(ROOT, 'scripts/aws/setup-github-oidc-roles.sh');
const PROVIDER = 'arn:aws:iam::472838866351:oidc-provider/token.actions.githubusercontent.com';

// Plan eng-platform-p01 §3 — the only accepted `sub` values per trust file.
const TRUSTS: Record<string, string[]> = {
  'eng-platform-oidc-staging-deploy-trust.json': [
    'repo:exafyltd/vitana-platform:ref:refs/heads/main',
    'repo:exafyltd/vitana-v1:ref:refs/heads/main',
  ],
  'eng-platform-oidc-v1-preview-trust.json': ['repo:exafyltd/vitana-v1:pull_request'],
  'eng-platform-oidc-drift-readonly-trust.json': [
    'repo:exafyltd/vitana-platform:pull_request',
    'repo:exafyltd/vitana-platform:ref:refs/heads/main',
  ],
  'eng-platform-oidc-prod-deploy-trust.json': ['repo:exafyltd/vitana-platform:ref:refs/heads/main'],
};
const POLICIES = ['eng-platform-oidc-v1-preview-policy.json', 'eng-platform-oidc-drift-readonly-policy.json'];
// Actions AWS only grants on Resource "*" (no resource-level permission) — the only wildcard resources allowed.
const STAR_OK = new Set(['ecr:GetAuthorizationToken','ecs:DescribeServices','ecs:DescribeTaskDefinition','ecs:DescribeTasks','ecs:DescribeClusters','ecs:ListServices','ecs:ListTasks','ecs:RegisterTaskDefinition']);

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(IAM, f), 'utf8'));
const asList = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : [v as string]);

describe('OIDC trust policies', () => {
  for (const [file, subs] of Object.entries(TRUSTS)) {
    it(`${file} trusts exactly the plan §3 subjects with StringEquals`, () => {
      const doc = read(file);
      expect(doc.Statement).toHaveLength(1);
      const st = doc.Statement[0];
      expect(st.Effect).toBe('Allow');
      expect(st.Action).toBe('sts:AssumeRoleWithWebIdentity');
      expect(st.Principal).toEqual({ Federated: PROVIDER });
      expect(Object.keys(st.Condition)).toEqual(['StringEquals']);
      const cond = st.Condition.StringEquals;
      expect(cond['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com');
      const got = asList(cond['token.actions.githubusercontent.com:sub']);
      expect([...got].sort()).toEqual([...subs].sort());
      for (const s of got) expect(s).not.toContain('*');
    });
  }
});

describe('scoped permission policies', () => {
  for (const file of POLICIES) {
    it(`${file} has no wildcard action or resource`, () => {
      const doc = read(file);
      for (const st of doc.Statement) {
        expect(st.Effect).toBe('Allow');
        for (const a of asList(st.Action)) expect(a).not.toMatch(/(^\*$|:\*$)/);
        for (const r of asList(st.Resource)) expect(r).not.toBe('*');
      }
    });
  }

  it('the drift role can read only the claude-readonly secret, never the master secret', () => {
    const doc = read('eng-platform-oidc-drift-readonly-policy.json');
    const secretRes = doc.Statement.filter((s: any) => asList(s.Action).some((a) => a.startsWith('secretsmanager:')))
      .flatMap((s: any) => asList(s.Resource));
    expect(secretRes).toEqual(['arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/aurora/prod/claude-readonly-*']);
  });
});

describe('setup-github-oidc-roles.sh', () => {
  const text = fs.readFileSync(SCRIPT, 'utf8');
  const code = text.split('\n').filter((l) => !/^\s*#/.test(l));

  it('runs in strict mode, guards the account and defaults to dry-run', () => {
    expect(text).toMatch(/^set -euo pipefail$/m);
    expect(text).toContain('EXPECTED_ACCOUNT="472838866351"');
    expect(text).toMatch(/^APPLY=0$/m);
  });

  it('reaches every IAM write only behind --apply', () => {
    const writes = /aws iam (create-role|update-assume-role-policy|put-role-policy|attach-role-policy|put-role-permissions-boundary)\b/;
    const lines = code.map((l, i) => ({ l, i })).filter(({ l }) => writes.test(l));
    expect(lines.length).toBeGreaterThanOrEqual(4);
    for (const { l, i } of lines) {
      const guarded = /if \[ "\$APPLY" = 1 \]/.test(l) || /if \[ "\$APPLY" = 1 \]; then\s*$/.test(code[i - 1] || '');
      expect({ line: l.trim(), guarded }).toEqual({ line: l.trim(), guarded: true });
    }
  });

  it('gives the staging role an explicit policy and never copies the static-key user', () => {
    const body = code.join('\n');
    for (const call of ['list-attached-user-policies', 'list-user-policies', 'get-user-policy', 'list-groups-for-user']) {
      expect(body).not.toContain(call);
    }
    expect(body).toContain('eng-platform-oidc-staging-deploy-policy.json');
  });

  it('fills PassRole from the five staging services and refuses a prod-named role', () => {
    const body = code.join('\n');
    expect(body).toContain('for svc in vitana-gateway vitana-kiro-runner vitana-erp-bridge vitana-postgrest-aurora-proxy vitana-community-app-staging; do');
    expect(body).toContain("taskDefinition.[taskRoleArn,executionRoleArn]");
    expect(body).toMatch(/case "\$ROLE_ARNS" in \*awsdr\*\|\*-prod-\*\)[^\n]*exit 7/);
    expect(body).toContain('"PassTaskRolesToEcsOnly"');
  });

  it('never creates access keys, deletes users or keys, or uses a wildcard trust', () => {
    const body = code.join('\n');
    for (const bad of ['create-access-key', 'delete-user', 'delete-access-key', 'update-access-key', 'StringLike']) {
      expect(body).not.toContain(bad);
    }
  });
});

describe('staging deploy policy', () => {
  const doc = read('eng-platform-oidc-staging-deploy-policy.json');
  const st = doc.Statement as any[];

  it('uses Resource "*" only for actions AWS cannot scope', () => {
    for (const s of st) if (asList(s.Resource).includes('*')) for (const a of asList(s.Action)) expect(STAR_OK.has(a)).toBe(true);
  });

  it('deploys only the five staging ECS services, never a prod (-awsdr) service', () => {
    const res = st.filter((s) => asList(s.Action).some((a) => a === 'ecs:UpdateService')).flatMap((s) => asList(s.Resource));
    expect(res.map((r) => r.split('/').pop()).sort()).toEqual(
      ['vitana-community-app-staging', 'vitana-erp-bridge', 'vitana-gateway', 'vitana-kiro-runner', 'vitana-postgrest-aurora-proxy'],
    );
    for (const r of res) expect(r).not.toMatch(/awsdr/);
  });

  it('has no IAM action except PassRole to ECS tasks, and cannot read secret values', () => {
    const actions = st.flatMap((s) => asList(s.Action));
    expect(actions.filter((a) => a.startsWith('iam:'))).toEqual(['iam:PassRole']);
    const pass = st.find((s) => asList(s.Action).includes('iam:PassRole'));
    expect(pass.Condition).toEqual({ StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } });
    // Filled at run time from the staging services' live task definitions; never a wildcard.
    expect(pass.Resource).toBe('${STAGING_TASK_ROLE_ARNS}');
    expect(actions).not.toContain('secretsmanager:GetSecretValue');
  });

  // Reviewer finding (2026-11-03): the staging deploys also DescribeSecret a few prod-named secrets to wire their
  // ARNs into task definitions (metadata only). Every literal secret name the staging workflows touch must be covered,
  // found by grep so a new one cannot slip past.
  it('covers every secret name the staging workflows describe, create or write', () => {
    const WF = path.join(ROOT, '.github/workflows');
    const files = ['AWS-PROVISION-APPILIX-SECRETS.yml', 'AWS-PROVISION-DEV-MEMORY-PACK-TOKEN.yml', 'AWS-STAGE-DEPLOY-ERP-BRIDGE.yml',
      'AWS-STAGE-DEPLOY-GATEWAY.yml', 'AWS-STAGE-DEPLOY-KIRO-RUNNER.yml', 'AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml', 'I18N-DB-SEED.yml'];
    const names = new Set<string>();
    for (const f of files) {
      // Comment lines are documentation, and the vitana/gateway-awsdr/* names belong to the Appilix workflow's prod leg,
      // which runs on AWS_PROD_ROLE_ARN, not on this role.
      const text = fs.readFileSync(path.join(WF, f), 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
      for (const m of text.matchAll(/\bvitana\/[a-z0-9_-]+(?:\/[a-z0-9_-]+)*/g)) {
        if (/^vitana\/(gateway|community-app|kiro-runner|erp-bridge|postgrest-aurora-proxy)$/.test(m[0])) continue; // ECR repo names
        if (m[0].startsWith('vitana/gateway-awsdr/')) continue;
        if (m[0].split('/').length < 3 && m[0] !== 'vitana/github/pat') continue;
        names.add(m[0]);
      }
    }
    expect(names.size).toBeGreaterThan(10);
    const res = st.filter((s) => asList(s.Action).includes('secretsmanager:DescribeSecret')).flatMap((s) => asList(s.Resource))
      .map((r) => new RegExp('^' + r.replace(/^arn:aws:secretsmanager:[^:]+:\d+:secret:/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));
    // A bare prefix such as vitana/gateway/staging comes from a name built at run time (NAME="vitana/gateway/staging/<suffix>").
    const missing = [...names].filter((n) => !res.some((re) => re.test(n) || re.test(n + '-x') || re.test(n + '/x')));
    expect(missing).toEqual([]);
  });
});

