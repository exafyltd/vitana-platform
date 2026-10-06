/**
 * VTID-04914 — calendar loops and the Google sync switch in production.
 *
 * Owner decision 2026-10-06: CALENDAR_DEFAULT_REMINDERS_ENABLED,
 * CALENDAR_MAINTENANCE_ENABLED and CALENDAR_GOOGLE_SYNC_ENABLED are on in
 * production (staging already pinned the first two). The Google OAuth client
 * is wired from two repository variables holding full secret ARNs; an empty
 * variable must never produce a secret reference, because ECS cannot start a
 * task whose secret is missing (VTID-04849).
 *
 * These tests run the workflow step's own bash + jq against a fixture task
 * definition, so they prove behaviour, not just text.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { load } from 'js-yaml';

const ROOT = join(__dirname, '../../..');
type Step = { name?: string; run?: string; env?: Record<string, string> };

function steps(workflow: string): Step[] {
  const wf = load(readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8')) as {
    jobs: Record<string, { steps?: Step[] }>;
  };
  return Object.values(wf.jobs).flatMap((j) => j.steps || []);
}

const prodSteps = steps('AWS-PROD-DEPLOY-GATEWAY.yml');
const gateStep = prodSteps.find((s) => s.name === 'Build task-definition (calendar gates)');

function runGate(env: Record<string, string>, taskDef: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'vtid-04914-'));
  const file = join(dir, 'td.json');
  writeFileSync(file, JSON.stringify(taskDef));
  const script = (gateStep!.run as string).split('/tmp/vitana-new-task-def.json').join(file);
  const log = execFileSync('bash', ['-c', script], { env: { ...process.env, ...env } }).toString();
  return { def: JSON.parse(readFileSync(file, 'utf8')), log };
}

const LIVE = {
  containerDefinitions: [
    {
      environment: [
        { name: 'CALENDAR_DEFAULT_REMINDERS_ENABLED', value: 'false' },
        { name: 'KEEP_ME', value: '1' },
      ],
      secrets: [
        { name: 'SUPABASE_SERVICE_ROLE', valueFrom: 'arn:a' },
        { name: 'GOOGLE_OAUTH_CLIENT_ID', valueFrom: 'arn:old-id' },
      ],
    },
  ],
};

const envOf = (d: any) => Object.fromEntries(d.containerDefinitions[0].environment.map((e: any) => [e.name, e.value]));
const secretsOf = (d: any) => Object.fromEntries((d.containerDefinitions[0].secrets || []).map((s: any) => [s.name, s.valueFrom]));

describe('VTID-04914: production calendar gates', () => {
  it('the step exists, runs before the final register step, and wires the two repository variables', () => {
    expect(gateStep).toBeDefined();
    const names = prodSteps.map((s) => s.name || '');
    const final = names.findIndex((n) => n.startsWith('Build task-definition (2/2'));
    expect(names.indexOf('Build task-definition (calendar gates)')).toBeLessThan(final);
    expect(gateStep!.env).toEqual({
      GOOGLE_ID_ARN: '${{ vars.PROD_GOOGLE_OAUTH_CLIENT_ID_ARN }}',
      GOOGLE_SECRET_ARN: '${{ vars.PROD_GOOGLE_OAUTH_CLIENT_SECRET_ARN }}',
    });
  });

  it('pins all three calendar flags to "true" exactly once and keeps every other variable', () => {
    const { def } = runGate({ GOOGLE_ID_ARN: '', GOOGLE_SECRET_ARN: '' }, LIVE);
    const env = envOf(def);
    expect(env.CALENDAR_DEFAULT_REMINDERS_ENABLED).toBe('true');
    expect(env.CALENDAR_MAINTENANCE_ENABLED).toBe('true');
    expect(env.CALENDAR_GOOGLE_SYNC_ENABLED).toBe('true');
    expect(env.KEEP_ME).toBe('1');
    const names = def.containerDefinitions[0].environment.map((e: any) => e.name);
    expect(names.filter((n: string) => n.startsWith('CALENDAR_')).length).toBe(3);
  });

  it('with the repository variables unset, adds no Google secret reference and leaves existing secrets alone', () => {
    const { def, log } = runGate({ GOOGLE_ID_ARN: '', GOOGLE_SECRET_ARN: '' }, LIVE);
    expect(secretsOf(def)).toEqual({ SUPABASE_SERVICE_ROLE: 'arn:a', GOOGLE_OAUTH_CLIENT_ID: 'arn:old-id' });
    expect(secretsOf(def).GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(log).toMatch(/not wired/);
  });

  it('with only one variable set, wires nothing (both or neither)', () => {
    const { def } = runGate({ GOOGLE_ID_ARN: 'arn:id', GOOGLE_SECRET_ARN: '' }, LIVE);
    expect(secretsOf(def).GOOGLE_OAUTH_CLIENT_SECRET).toBeUndefined();
    expect(secretsOf(def).GOOGLE_OAUTH_CLIENT_ID).toBe('arn:old-id');
  });

  it('with both variables set, wires both secrets from them, replacing any old reference', () => {
    const { def } = runGate({ GOOGLE_ID_ARN: 'arn:new-id', GOOGLE_SECRET_ARN: 'arn:new-secret' }, LIVE);
    expect(secretsOf(def)).toEqual({
      SUPABASE_SERVICE_ROLE: 'arn:a',
      GOOGLE_OAUTH_CLIENT_ID: 'arn:new-id',
      GOOGLE_OAUTH_CLIENT_SECRET: 'arn:new-secret',
    });
  });

  it('works when the task definition has no secrets array', () => {
    const { def } = runGate(
      { GOOGLE_ID_ARN: 'arn:i', GOOGLE_SECRET_ARN: 'arn:s' },
      { containerDefinitions: [{ environment: [] }] },
    );
    expect(Object.keys(secretsOf(def)).sort()).toEqual(['GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET']);
  });
});

describe('VTID-04914: staging pins the Google sync switch next to the other calendar loops', () => {
  const stage = readFileSync(join(ROOT, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
  it('pins and strips CALENDAR_GOOGLE_SYNC_ENABLED', () => {
    expect(stage).toMatch(/\{name:"CALENDAR_GOOGLE_SYNC_ENABLED", value:"true"\}/);
    expect(stage).toContain('"CALENDAR_MAINTENANCE_ENABLED","CALENDAR_GOOGLE_SYNC_ENABLED"');
    expect(stage).toMatch(/\{name:"CALENDAR_DEFAULT_REMINDERS_ENABLED", value:"true"\}/);
  });
});
