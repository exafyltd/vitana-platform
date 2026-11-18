/**
 * VTID-05023: the staging deploy that actually runs on GitLab
 * (infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml) copies the
 * previous task definition and changes only the image. It must strip the
 * production Aurora bindings from every container, in both lists, and refuse to
 * register a revision that still has one. These tests run the job's own jq.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const DEPLOY = path.resolve(__dirname, '../../../infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml');
const src = fs.readFileSync(DEPLOY, 'utf8');
const AURORA = ['AURORA_DATABASE_URL', 'AURORA_RLS_DATABASE_URL', 'AURORA_CA_BUNDLE_PATH'];

// The jq program: the text between "--arg SHA \"$SHA\" '" and "' > new-td.json".
function jqProgram(): string {
  const start = src.indexOf('--arg SHA "$SHA" \'') + '--arg SHA "$SHA" \''.length;
  const end = src.indexOf("' > new-td.json", start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function run(args: string[], input: unknown): string {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vtid-05023-gl-'));
  const f = path.join(dir, 'in.json');
  fs.writeFileSync(f, JSON.stringify(input));
  return execFileSync('jq', [...args, f], { encoding: 'utf8' });
}

const TD = {
  family: 'vitana-gateway',
  taskDefinitionArn: 'x',
  revision: 1009,
  containerDefinitions: [
    {
      name: 'gateway',
      image: 'old',
      environment: [
        { name: 'GIT_COMMIT_SHA', value: 'old' },
        { name: 'AURORA_CA_BUNDLE_PATH', value: '/app/certs/rds-combined-ca-bundle.pem' },
      ],
      secrets: [
        { name: 'SUPABASE_JWT_SECRET', valueFrom: 'arn:jwt' },
        { name: 'AURORA_DATABASE_URL', valueFrom: 'arn:aurora-prod' },
        { name: 'AURORA_RLS_DATABASE_URL', valueFrom: 'arn:aurora-rls' },
      ],
    },
    {
      name: 'sidecar',
      image: 'sidecar',
      environment: [{ name: 'AURORA_DATABASE_URL', value: 'x' }],
      secrets: [{ name: 'AURORA_RLS_DATABASE_URL', valueFrom: 'arn:aurora-rls' }],
    },
  ],
};

describe('VTID-05023: GitLab staging deploy strips production Aurora bindings', () => {
  it('removes the three Aurora names from environment and secrets of every container', () => {
    const out = JSON.parse(run(['--arg', 'IMG', 'img', '--arg', 'SHA', 'sha', '-f', writeProg(), ], TD));
    const names = out.containerDefinitions.flatMap((c: any) => [...(c.environment ?? []), ...(c.secrets ?? [])].map((x: any) => x.name));
    expect(names.filter((n: string) => AURORA.includes(n))).toEqual([]);
    expect(out.containerDefinitions[0].secrets.map((s: any) => s.name)).toContain('SUPABASE_JWT_SECRET');
  });

  it('gate prints any AURORA_ name still bound in any container, and nothing for a clean task definition', () => {
    const m = src.match(/AURORA_LEAK_JQ='([^']+)'/);
    expect(m).not.toBeNull();
    const gate = m![1];
    const leaked = run(['-r', gate], TD).trim();
    expect(leaked).toContain('AURORA_DATABASE_URL');
    expect(leaked).toContain('AURORA_RLS_DATABASE_URL');
    const clean = { containerDefinitions: [{ name: 'g', environment: [{ name: 'SUPABASE_URL', value: 'u' }], secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: 'a' }] }] };
    expect(run(['-r', gate], clean).trim()).toBe('');
  });
});

function writeProg(): string {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vtid-05023-prog-'));
  const f = path.join(dir, 'prog.jq');
  fs.writeFileSync(f, jqProgram());
  return f;
}
