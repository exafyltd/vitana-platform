/**
 * VTID-05023: the Aurora deploy gate must stop the register step when an
 * AURORA_ name survives, not only print a line. The strip tests check the
 * gate's query. These tests run the gate's own shell lines from each deploy
 * file and check the exit status and message. They also feed Aurora names in
 * through connected-apps.json, which the GitHub transform merges before its
 * final strip.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const GITLAB_DEPLOY = path.resolve(__dirname, '../../../infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml');
const GITHUB_DEPLOY = path.resolve(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');

const LEAKED = {
  containerDefinitions: [
    { name: 'gateway', environment: [{ name: 'SUPABASE_URL', value: 'u' }], secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: 'a' }] },
    { name: 'sidecar', environment: [], secrets: [{ name: 'AURORA_RLS_DATABASE_URL', valueFrom: 'arn:aurora-rls' }] },
  ],
};
const CLEAN = {
  containerDefinitions: [
    { name: 'gateway', environment: [{ name: 'SUPABASE_URL', value: 'u' }], secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: 'a' }] },
  ],
};

// The gate's shell lines: from the AURORA_LEAK_JQ assignment to the success echo,
// dedented to column 0 so bash can run them.
function gateSnippet(file: string): string {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => /^\s*AURORA_LEAK_JQ='/.test(l));
  const end = lines.findIndex((l, i) => i > start && l.includes('echo "Aurora gate: no AURORA_ names'));
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const indent = lines[start].match(/^\s*/)![0].length;
  return lines
    .slice(start, end + 1)
    .map(l => l.slice(Math.min(indent, l.match(/^\s*/)![0].length)))
    .join('\n');
}

function runSnippet(snippet: string, cwd: string, env: Record<string, string> = {}) {
  const r = spawnSync('bash', ['-c', snippet], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('VTID-05023: GitLab deploy gate stops the register step on a surviving AURORA_ name', () => {
  const snippet = gateSnippet(GITLAB_DEPLOY);

  function runWith(td: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05023-gl-gate-'));
    fs.writeFileSync(path.join(dir, 'new-td.json'), JSON.stringify(td));
    return runSnippet(snippet, dir);
  }

  it('exits 1 and refuses to register when an AURORA_ name is bound in any container', () => {
    const r = runWith(LEAKED);
    expect(r.status).toBe(1);
    expect(r.out).toContain('refusing to register');
    expect(r.out).toContain('AURORA_RLS_DATABASE_URL');
    expect(r.out).not.toContain('Aurora gate: no AURORA_ names');
  });

  it('exits 0 and prints the gate line when no AURORA_ name is bound', () => {
    const r = runWith(CLEAN);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Aurora gate: no AURORA_ names in any container environment or secrets');
  });
});

describe('VTID-05023: GitHub deploy gate stops the register step on a surviving AURORA_ name', () => {
  const snippet = gateSnippet(GITHUB_DEPLOY);

  function runWith(td: unknown) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05023-gh-gate-'));
    return runSnippet(snippet, dir, { NEW_DEF: JSON.stringify(td) });
  }

  it('exits 1 and refuses to register when an AURORA_ name is bound in any container', () => {
    const r = runWith(LEAKED);
    expect(r.status).toBe(1);
    expect(r.out).toContain('refusing to register');
    expect(r.out).toContain('AURORA_RLS_DATABASE_URL');
    expect(r.out).not.toContain('Aurora gate: no AURORA_ names');
  });

  it('exits 0 and prints the gate line when no AURORA_ name is bound', () => {
    const r = runWith(CLEAN);
    expect(r.status).toBe(0);
    expect(r.out).toContain("Aurora gate: no AURORA_ names in any container's environment or secrets");
  });
});

// The GitHub transform program, as in vtid-05023-aurora-strip-all.test.ts.
const GH_YML = fs.readFileSync(GITHUB_DEPLOY, 'utf8');
function transformProgram(): string {
  const start = GH_YML.indexOf('.containerDefinitions[0].image = $IMG');
  const endMarker = 'deregisteredAt)';
  const end = GH_YML.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return GH_YML.slice(start, end + endMarker.length);
}

const ARGS: Array<[string, string]> = [
  ['IMG', 'img'], ['SHA', 'sha'], ['SHORT', 'sh'], ['NOVA_ENABLED', 'false'],
  ['NOVA_USERS', ''], ['NOVA_TENANTS', ''], ['SEC_JWT', 'arn:jwt'], ['SEC_ANON', 'arn:anon'],
  ['SEC_GEMINI', 'arn:gem'], ['SEC_OPENAI', 'arn:oai'], ['SEC_DEEPSEEK', 'arn:ds'], ['SEC_FISH', 'arn:fish'],
  ['SEC_GITHUB_TOKEN', 'arn:gh'], ['SEC_ERP_BRIDGE', ''], ['ERP_BRIDGE_URL', ''], ['SEC_SQL_RO', ''],
  ['SEC_MACHINE_AUTH', ''], ['SEC_SERVICE_TOKEN', 'arn:st'], ['SEC_INTERNAL_TOKEN', ''],
  ['SCAN_TOKEN', 't'], ['GCP_CRED_CONFIG', 'c'], ['CLAUDE_AVAILABLE', 'false'], ['TASK_ROLE', 'arn:role'],
];

describe('VTID-05023: GitHub transform strips Aurora names that arrive through connected-apps.json', () => {
  it('removes AURORA_ names merged from the connected-apps file, in environment and secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05023-ca-'));
    const prog = path.join(dir, 'prog.jq');
    const input = path.join(dir, 'in.json');
    const ca = path.join(dir, 'ca.json');
    fs.writeFileSync(prog, transformProgram());
    fs.writeFileSync(input, JSON.stringify({
      family: 'vitana-gateway',
      taskDefinitionArn: 'x',
      revision: 1006,
      containerDefinitions: [{ name: 'gateway', image: 'old', environment: [], secrets: [] }],
    }));
    fs.writeFileSync(ca, JSON.stringify({
      env: [{ name: 'AURORA_CA_BUNDLE_PATH', value: '/app/certs/rds-combined-ca-bundle.pem' }],
      sec: [{ name: 'AURORA_DATABASE_URL', valueFrom: 'arn:aurora-prod-database-url' }],
    }));
    const args = ARGS.flatMap(([k, v]) => ['--arg', k, v]);
    const r = spawnSync('jq', [...args, '--slurpfile', 'CA', ca, '-f', prog, input], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    const names = out.containerDefinitions.flatMap((c: { environment?: Array<{ name: string }>; secrets?: Array<{ name: string }> }) =>
      [...(c.environment ?? []), ...(c.secrets ?? [])].map(x => x.name),
    );
    expect(names.filter((n: string) => n.startsWith('AURORA_'))).toEqual([]);
    expect(names).toContain('SUPABASE_JWT_SECRET');
  });
});
