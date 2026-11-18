/**
 * VTID-05023: the staging deploy job prints its Aurora gate result on its own line,
 * with a fixed prefix, and writes that same line to the job artifact aurora-gate.txt.
 * Reads the job from infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml
 * and runs the gate block with bash and jq against a clean and a leaking task definition.
 */
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as yaml from 'js-yaml';

const FILE = path.resolve(__dirname, '../../../infra/gitlab-engineering/ci/staging-gateway-deploy.gitlab-ci.yml');
const PASS_LINE = 'VTID-05023 AURORA GATE: PASS no AURORA_ names';
const FAIL_PREFIX = 'VTID-05023 AURORA GATE: FAIL ';

const doc: any = yaml.load(fs.readFileSync(FILE, 'utf8'));
const job = doc['gateway-staging-deploy'];
const lines: string[] = (job.script as string[]).join('\n').split('\n');

// The gate block: from the AURORA_LEAK_JQ assignment through the PASS line.
function gateBlock(): string {
  const start = lines.findIndex((l) => l.trim().startsWith('AURORA_LEAK_JQ='));
  const end = lines.findIndex((l) => l.includes('AURORA GATE: PASS'));
  if (start < 0 || end < start) return '';
  return lines.slice(start, end + 1).join('\n');
}

function runGate(td: unknown): { status: number | null; stdout: string; artifact: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05023-gate-'));
  fs.writeFileSync(path.join(dir, 'new-td.json'), JSON.stringify(td));
  const r = spawnSync('bash', ['-c', gateBlock()], { cwd: dir, encoding: 'utf8' });
  const artifactPath = path.join(dir, 'aurora-gate.txt');
  const artifact = fs.existsSync(artifactPath) ? fs.readFileSync(artifactPath, 'utf8') : '';
  return { status: r.status, stdout: r.stdout, artifact };
}

const CLEAN_TD = {
  containerDefinitions: [
    {
      name: 'gateway',
      environment: [{ name: 'SUPABASE_URL', value: 'u' }],
      secrets: [{ name: 'SUPABASE_JWT_SECRET', valueFrom: 'arn:jwt' }],
    },
  ],
};

const LEAKING_TD = {
  containerDefinitions: [
    {
      name: 'gateway',
      environment: [{ name: 'AURORA_DATABASE_URL', value: 'x' }],
      secrets: [{ name: 'AURORA_RLS_DATABASE_URL', valueFrom: 'arn:aurora-rls' }],
    },
  ],
};

describe('VTID-05023: gateway-staging-deploy prints the Aurora gate line', () => {
  it('prints the PASS line with the fixed prefix and writes it to aurora-gate.txt', () => {
    expect(lines).toContain(`echo "${PASS_LINE}" | tee aurora-gate.txt`);
  });

  it('prints the FAIL line with the fixed prefix and the names, writes it to aurora-gate.txt, and exits 1', () => {
    expect(lines.some((l) => l.includes(`echo "${FAIL_PREFIX}$LEAK" | tee aurora-gate.txt`))).toBe(true);
    expect(lines.some((l) => l.includes('exit 1') && l.includes('LEAK'))).toBe(true);
  });

  it('prints the gate before the task definition is registered', () => {
    const gateAt = lines.findIndex((l) => l.includes('AURORA GATE: PASS'));
    const registerAt = lines.findIndex((l) => l.includes('register-task-definition'));
    expect(gateAt).toBeGreaterThanOrEqual(0);
    expect(registerAt).toBeGreaterThan(gateAt);
  });

  it('uploads aurora-gate.txt as a job artifact, also when the job fails', () => {
    expect(job.artifacts.paths).toContain('aurora-gate.txt');
    expect(job.artifacts.when).toBe('always');
  });

  it('a clean task definition passes: the PASS line is on stdout and in the artifact, exit 0', () => {
    const r = runGate(CLEAN_TD);
    expect(r.status).toBe(0);
    expect(r.stdout.split('\n')).toContain(PASS_LINE);
    expect(r.artifact).toBe(PASS_LINE + '\n');
  });

  it('a task definition that still binds AURORA_ names fails: the FAIL line lists them, exit 1', () => {
    const r = runGate(LEAKING_TD);
    const want = FAIL_PREFIX + 'AURORA_DATABASE_URL AURORA_RLS_DATABASE_URL';
    expect(r.status).not.toBe(0);
    expect(r.stdout.split('\n')).toContain(want);
    expect(r.artifact).toBe(want + '\n');
  });
});
