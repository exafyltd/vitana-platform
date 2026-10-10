/**
 * VTID-04930 — the autopilot executor deploy drops the dead DB_PASSWORD secret
 * reference.
 *
 * Live on staging (2026-10-06 22:01 UTC): execution 971de3de was dispatched to
 * the one-shot executor task and ECS stopped it before the container ran —
 * TaskFailedToStart / ResourceInitializationError, "Secrets Manager can't find
 * the specified secret" rds!cluster-eba8a4f2-…. vitana-autopilot-executor:27
 * loaded DB_PASSWORD from that deleted Aurora managed secret; the other four
 * secrets exist. VTID-04849 (gateway) and VTID-04858 (orb-agent, verification
 * engine) made the same drop; the executor workflow was missed. The executor
 * image is built from services/gateway (Dockerfile.job), which never reads it.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { load } from 'js-yaml';

const ROOT = join(__dirname, '../../..');
const WORKFLOW = 'AWS-PROD-DEPLOY-AUTOPILOT-EXECUTOR.yml';

/**
 * The executor's register step passes four --arg values across a line
 * continuation, so the single-arg extractor of vtid-04858 does not match it.
 */
function registerFilter(): string {
  const wf = load(readFileSync(join(ROOT, '.github/workflows', WORKFLOW), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  for (const job of Object.values(wf.jobs)) {
    for (const step of job.steps || []) {
      const run = step.run || '';
      if (!run.includes('register-task-definition')) continue;
      const m = /--arg DS "\$DEEPSEEK_ARN" '([\s\S]*?)'\)/.exec(run);
      if (m) return m[1];
    }
  }
  throw new Error(`no register jq filter found in ${WORKFLOW}`);
}

function runFilter(input: unknown): any {
  return JSON.parse(
    execFileSync(
      'jq',
      ['--arg', 'IMG', 'new-image', '--arg', 'TASK_ROLE', 'arn:role', '--arg', 'REGION', 'eu-central-1', '--arg', 'DS', 'arn:deepseek-new', registerFilter()],
      { input: JSON.stringify(input) },
    ).toString(),
  );
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'test', 'dist', 'coverage'].includes(f) || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('VTID-04930: autopilot executor register filter', () => {
  it('finds the register filter', () => {
    expect(registerFilter()).toContain('select(.name != "DB_PASSWORD")');
  });

  it('drops DB_PASSWORD, keeps the other secrets, re-adds DEEPSEEK_API_KEY once, sets the image', () => {
    const out = runFilter({
      taskDefinitionArn: 'arn:td:27',
      revision: 27,
      registeredAt: 'x',
      containerDefinitions: [
        {
          image: 'old',
          environment: [],
          secrets: [
            { name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:eu-central-1:1:secret:rds!cluster-eba8a4f2' },
            { name: 'SUPABASE_URL', valueFrom: 'arn:a' },
            { name: 'SUPABASE_SERVICE_ROLE', valueFrom: 'arn:b' },
            { name: 'GITHUB_SAFE_MERGE_TOKEN', valueFrom: 'arn:c' },
            { name: 'DEEPSEEK_API_KEY', valueFrom: 'arn:deepseek-old' },
          ],
        },
      ],
    });
    const secrets = out.containerDefinitions[0].secrets as Array<{ name: string; valueFrom: string }>;
    expect(secrets.map((s) => s.name)).toEqual([
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE',
      'GITHUB_SAFE_MERGE_TOKEN',
      'DEEPSEEK_API_KEY',
    ]);
    expect(secrets.find((s) => s.name === 'DEEPSEEK_API_KEY')!.valueFrom).toBe('arn:deepseek-new');
    expect(out.containerDefinitions[0].image).toBe('new-image');
    expect(out.taskDefinitionArn).toBeUndefined();
    expect(out.revision).toBeUndefined();
    expect(out.registeredAt).toBeUndefined();
  });

  it('works when the task definition has no secrets at all', () => {
    const out = runFilter({ containerDefinitions: [{ image: 'old' }] });
    expect(out.containerDefinitions[0].secrets.map((s: { name: string }) => s.name)).toEqual(['DEEPSEEK_API_KEY']);
  });

  it('services/gateway (outside tests) never reads DB_PASSWORD', () => {
    const hits = walk(join(ROOT, 'services/gateway')).filter((f) => readFileSync(f, 'utf8').includes('DB_PASSWORD'));
    expect(hits).toEqual([]);
  });
});
