/**
 * VTID-04849 — the production gateway task definition must not carry a
 * DB_PASSWORD secret.
 *
 * Rev 141 loaded DB_PASSWORD from the Aurora managed secret
 * rds!cluster-eba8a4f2-…. vitana-aurora-prod no longer has a managed master
 * secret, so that secret is gone and every new task failed with
 * ResourceInitializationError. No deploy, rollback or task restart could start
 * (2026-10-02, AWS-PROD-DEPLOY-GATEWAY run 37010010196). The gateway never
 * reads DB_PASSWORD, so the deploy drops it from the cloned task definition.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { load } from 'js-yaml';

const ROOT = join(__dirname, '../../..');
const RAW = readFileSync(join(ROOT, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const WF = load(RAW) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string; if?: string }> }> };

const steps = Object.values(WF.jobs).flatMap((j) => j.steps || []);
const names = steps.map((s) => s.name || '');
const drop = steps.find((s) => s.name === 'Build task-definition (drop dead secret refs)');

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js)$/.test(f)) out.push(p);
  }
  return out;
}

describe('VTID-04849: prod gateway deploy drops the dead DB_PASSWORD secret', () => {
  it('has a drop step that runs in every deploy mode, after the Jev step and before register/roll', () => {
    expect(drop).toBeDefined();
    expect(drop!.if).toBeUndefined();
    const i = names.indexOf('Build task-definition (drop dead secret refs)');
    expect(i).toBeGreaterThan(names.indexOf('Build task-definition (Jev gates)'));
    expect(i).toBeLessThan(names.findIndex((n) => n.startsWith('Build task-definition (2/2')));
  });

  it('removes DB_PASSWORD and keeps every other secret (runs the step\'s jq on a task def)', () => {
    const filter = /jq '([^']+)' \/tmp\/vitana-new-task-def\.json/.exec(drop!.run!)![1];
    const def = {
      containerDefinitions: [
        {
          secrets: [
            { name: 'DB_PASSWORD', valueFrom: 'arn:aws:secretsmanager:eu-central-1:1:secret:rds!cluster-x' },
            { name: 'SUPABASE_URL', valueFrom: 'arn:a' },
            { name: 'TYPESAFE_API_KEY', valueFrom: 'arn:b' },
          ],
        },
      ],
    };
    const out = JSON.parse(execFileSync('jq', [filter], { input: JSON.stringify(def) }).toString());
    expect(out.containerDefinitions[0].secrets.map((s: { name: string }) => s.name)).toEqual([
      'SUPABASE_URL',
      'TYPESAFE_API_KEY',
    ]);
  });

  it('no workflow step adds a DB_PASSWORD secret back, and no step references the deleted rds!cluster secret', () => {
    const code = RAW.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/name:\s*"DB_PASSWORD",\s*valueFrom/);
    expect(code).not.toContain('rds!cluster-eba8a4f2');
  });

  it('the gateway source never reads DB_PASSWORD', () => {
    const hits = walk(join(ROOT, 'services/gateway/src')).filter((f) => readFileSync(f, 'utf8').includes('DB_PASSWORD'));
    expect(hits).toEqual([]);
  });
});
