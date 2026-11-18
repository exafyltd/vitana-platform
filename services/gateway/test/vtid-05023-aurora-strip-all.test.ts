/**
 * VTID-05023: the staging deploy must remove the production Aurora bindings from
 * EVERY container in the gateway task definition, in BOTH `environment` and
 * `secrets`, and must refuse to register a revision that still has one.
 *
 * Revision vitana-gateway:1007 (built from 5282e7815d) still carried the Aurora
 * names. The strip only touched containerDefinitions[0], and the gate only ran
 * in the smoke test. Both checks here run the workflow's own jq program.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const WORKFLOW = path.resolve(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');
const yml = fs.readFileSync(WORKFLOW, 'utf8');

const AURORA_NAMES = ['AURORA_DATABASE_URL', 'AURORA_RLS_DATABASE_URL', 'AURORA_CA_BUNDLE_PATH'];

// The jq program that builds the new task definition, copied from the workflow text.
function transformProgram(): string {
  const start = yml.indexOf('.containerDefinitions[0].image = $IMG');
  const endMarker = 'deregisteredAt)';
  const end = yml.indexOf(endMarker, start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return yml.slice(start, end + endMarker.length);
}

// Every $variable the program reads. Empty strings are fine: the program only needs them defined.
const ARGS: Array<[string, string]> = [
  ['IMG', 'img'], ['SHA', 'sha'], ['SHORT', 'sh'], ['NOVA_ENABLED', 'false'],
  ['NOVA_USERS', ''], ['NOVA_TENANTS', ''], ['SEC_JWT', 'arn:jwt'], ['SEC_ANON', 'arn:anon'],
  ['SEC_GEMINI', 'arn:gem'], ['SEC_OPENAI', 'arn:oai'], ['SEC_DEEPSEEK', 'arn:ds'], ['SEC_FISH', 'arn:fish'],
  ['SEC_GITHUB_TOKEN', 'arn:gh'], ['SEC_ERP_BRIDGE', ''], ['ERP_BRIDGE_URL', ''], ['SEC_SQL_RO', ''],
  ['SEC_MACHINE_AUTH', ''], ['SEC_SERVICE_TOKEN', 'arn:st'], ['SEC_INTERNAL_TOKEN', ''],
  ['SCAN_TOKEN', 't'], ['GCP_CRED_CONFIG', 'c'], ['CLAUDE_AVAILABLE', 'false'], ['TASK_ROLE', 'arn:role'],
];

function runJq(program: string, input: unknown, extraFilter?: string, raw = false): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05023-'));
  const progFile = path.join(dir, 'prog.jq');
  const inFile = path.join(dir, 'in.json');
  const caFile = path.join(dir, 'ca.json');
  fs.writeFileSync(progFile, extraFilter ? `${program} | ${extraFilter}` : program);
  fs.writeFileSync(inFile, JSON.stringify(input));
  fs.writeFileSync(caFile, JSON.stringify({ env: [], sec: [] }));
  const args = ARGS.flatMap(([k, v]) => ['--arg', k, v]);
  const flags = raw ? ['-r'] : [];
  return execFileSync('jq', [...flags, ...args, '--slurpfile', 'CA', caFile, '-f', progFile, inFile], { encoding: 'utf8' });
}

// Two containers. The Aurora names sit in both lists, in container 0 and in a sidecar.
const TASK_DEF = {
  family: 'vitana-gateway',
  taskDefinitionArn: 'arn:aws:ecs:eu-central-1:472838866351:task-definition/vitana-gateway:1006',
  revision: 1006,
  containerDefinitions: [
    {
      name: 'gateway',
      image: 'old',
      environment: [
        { name: 'SUPABASE_URL', value: 'https://inmkhvwdcuyhnxkgfvsb.supabase.co' },
        { name: 'AURORA_CA_BUNDLE_PATH', value: '/app/certs/rds-combined-ca-bundle.pem' },
      ],
      secrets: [
        { name: 'SUPABASE_JWT_SECRET', valueFrom: 'arn:old-jwt' },
        { name: 'AURORA_DATABASE_URL', valueFrom: 'arn:aurora-prod-database-url' },
        { name: 'AURORA_RLS_DATABASE_URL', valueFrom: 'arn:aurora-prod-rls' },
      ],
    },
    {
      name: 'sidecar',
      image: 'sidecar',
      environment: [{ name: 'AURORA_DATABASE_URL', value: 'x' }],
      secrets: [{ name: 'AURORA_RLS_DATABASE_URL', valueFrom: 'arn:aurora-prod-rls' }],
    },
  ],
};

function namesOf(td: { containerDefinitions: Array<{ environment?: Array<{ name: string }>; secrets?: Array<{ name: string }> }> }) {
  return td.containerDefinitions.flatMap(c => [...(c.environment ?? []), ...(c.secrets ?? [])].map(x => x.name));
}

describe('VTID-05023: strip production Aurora bindings from every container', () => {
  it('removes AURORA_DATABASE_URL, AURORA_RLS_DATABASE_URL and AURORA_CA_BUNDLE_PATH from environment and secrets of every container', () => {
    const out = JSON.parse(runJq(transformProgram(), TASK_DEF));
    const left = namesOf(out).filter(n => AURORA_NAMES.includes(n));
    expect(left).toEqual([]);
  });

  it('keeps the SUPABASE_* bindings unchanged', () => {
    const out = JSON.parse(runJq(transformProgram(), TASK_DEF));
    const secrets0 = out.containerDefinitions[0].secrets.map((s: { name: string; valueFrom: string }) => [s.name, s.valueFrom]);
    expect(secrets0).toContainEqual(['SUPABASE_JWT_SECRET', 'arn:jwt']);
    const env0 = out.containerDefinitions[0].environment.map((e: { name: string }) => e.name);
    expect(env0).toContain('SUPABASE_URL');
  });

  it('deploy gate: an Aurora name left in any container is reported, and a clean task definition is not', () => {
    // The gate is the AURORA_LEAK_JQ line in the workflow. It must print the leaked names.
    const m = yml.match(/AURORA_LEAK_JQ='([^']+)'/);
    expect(m).not.toBeNull();
    const gate = m![1];
    const leaked = runJq('.', TASK_DEF, gate, true).trim();
    expect(leaked).toContain('AURORA_DATABASE_URL');
    expect(leaked).toContain('AURORA_RLS_DATABASE_URL');
    const clean = {
      ...TASK_DEF,
      containerDefinitions: [{ name: 'gateway', image: 'x', environment: [{ name: 'SUPABASE_URL', value: 'u' }], secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: 'a' }] }],
    };
    expect(runJq('.', clean, gate, true).trim()).toBe('');
  });
});
