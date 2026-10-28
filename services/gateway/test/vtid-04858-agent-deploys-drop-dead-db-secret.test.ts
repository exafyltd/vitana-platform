/**
 * VTID-04858 — the orb-agent and verification-engine production deploys drop
 * the dead DB_PASSWORD secret reference.
 *
 * Both live task definitions loaded DB_PASSWORD from the Aurora managed secret
 * rds!cluster-eba8a4f2-…, which no longer exists (vitana-aurora-prod has no
 * managed master secret). ECS cannot start a task whose secret is missing, so a
 * redeploy or task restart of either service would fail — the same outage
 * VTID-04849 fixed for the gateway. Neither service reads DB_PASSWORD. Each
 * workflow clones the live task definition forward, so the drop happens there.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { load } from 'js-yaml';

const ROOT = join(__dirname, '../../..');

const SERVICES = [
  { workflow: 'AWS-PROD-DEPLOY-ORB-AGENT.yml', source: 'services/agents/orb-agent' },
  { workflow: 'AWS-PROD-DEPLOY-VERIFICATION-ENGINE.yml', source: 'services/agents/vitana-orchestrator' },
];

function registerFilter(workflow: string): string {
  const wf = load(readFileSync(join(ROOT, '.github/workflows', workflow), 'utf8')) as {
    jobs: Record<string, { steps: Array<{ run?: string }> }>;
  };
  for (const job of Object.values(wf.jobs)) {
    for (const step of job.steps || []) {
      const m = /jq --arg IMG "\$IMAGE" '([\s\S]*?)'\)/.exec(step.run || '');
      if (m) return m[1];
    }
  }
  throw new Error(`no register jq filter in ${workflow}`);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === '__pycache__' || f.startsWith('.')) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe.each(SERVICES)('VTID-04858: $workflow', ({ workflow, source }) => {
  const filter = registerFilter(workflow);

  it('the register filter drops DB_PASSWORD, keeps every other secret, sets the image and strips read-only fields', () => {
    const live = {
      taskDefinitionArn: 'arn:td:1',
      revision: 1,
      containerDefinitions: [
        {
          image: 'old',
          secrets: [
            { name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:eu-central-1:1:secret:rds!cluster-x' },
            { name: 'SUPABASE_URL', valueFrom: 'arn:a' },
            { name: 'SUPABASE_SERVICE_ROLE', valueFrom: 'arn:b' },
          ],
        },
      ],
    };
    const out = JSON.parse(
      execFileSync('jq', ['--arg', 'IMG', 'new-image', filter], { input: JSON.stringify(live) }).toString(),
    );
    expect(out.containerDefinitions[0].image).toBe('new-image');
    expect(out.containerDefinitions[0].secrets.map((s: { name: string }) => s.name)).toEqual([
      'SUPABASE_URL',
      'SUPABASE_SERVICE_ROLE',
    ]);
    expect(out.taskDefinitionArn).toBeUndefined();
    expect(out.revision).toBeUndefined();
  });

  it('works when the task definition has no secrets at all', () => {
    const out = JSON.parse(
      execFileSync('jq', ['--arg', 'IMG', 'x', filter], {
        input: JSON.stringify({ containerDefinitions: [{ image: 'old' }] }),
      }).toString(),
    );
    expect(out.containerDefinitions[0].secrets).toEqual([]);
  });

  it(`${source} never reads DB_PASSWORD`, () => {
    const hits = walk(join(ROOT, source)).filter((f) => readFileSync(f, 'utf8').includes('DB_PASSWORD'));
    expect(hits).toEqual([]);
  });
});
