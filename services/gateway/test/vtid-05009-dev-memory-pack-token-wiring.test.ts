// VTID-05009 — DEV_MEMORY_PACK_TOKEN (developer morning pack, VTID-04408) is
// wired only when its secret exists, so neither deploy can fail or point a
// task at a missing secret; and the SessionStart hook that uses it is registered.
import { readFileSync } from 'fs';
import { join } from 'path';

const root = join(__dirname, '../../..');
const wf = (n: string) => readFileSync(join(root, '.github/workflows', n), 'utf8');

function stepRun(workflow: string, stepName: string): string {
  const at = workflow.indexOf(`- name: ${stepName}`);
  expect(at).toBeGreaterThan(0);
  const next = workflow.indexOf('\n      - name: ', at + 1);
  return workflow.slice(at, next === -1 ? undefined : next);
}

describe('VTID-05009 DEV_MEMORY_PACK_TOKEN wiring', () => {
  it('staging resolves the secret by name and wires it only when it exists', () => {
    const step = stepRun(wf('AWS-STAGE-DEPLOY-GATEWAY.yml'), 'Resolve dev-memory pack token');
    expect(step).toContain('NAME="vitana/gateway/staging/dev-memory-pack-token"');
    expect(step).toContain('|| true)');
    expect(step).toContain('{name:"DEV_MEMORY_PACK_TOKEN", valueFrom:$a}');
    expect(step).not.toMatch(/exit 1/);
  });

  it('staging resolves it before the task definition is built (it rides connected-apps.json)', () => {
    const s = wf('AWS-STAGE-DEPLOY-GATEWAY.yml');
    expect(s.indexOf('Resolve dev-memory pack token')).toBeLessThan(s.indexOf('--slurpfile CA "$RUNNER_TEMP/connected-apps.json"'));
  });

  it('prod wires it only from the repo variable, strips any old ref, and rejects a foreign ARN', () => {
    const step = stepRun(wf('AWS-PROD-DEPLOY-GATEWAY.yml'), 'Build task-definition (dev-memory pack token)');
    expect(step).toContain('${{ vars.DEV_MEMORY_PACK_TOKEN_PROD_ARN }}');
    expect(step).toContain('secret:vitana/gateway/prod/dev-memory-pack-token-*) ;;');
    expect(step).toContain('select(.name != "DEV_MEMORY_PACK_TOKEN")');
    expect(step).toContain('if $T == "" then [] else');
    expect(step).not.toContain('vitana/gateway/staging/');
  });

  it('the SessionStart hook is registered and the hook never fails the session', () => {
    const settings = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    const commands: string[] = (settings.hooks.SessionStart as any[]).flatMap((e) => e.hooks.map((h: any) => h.command));
    expect(commands.some((c) => c.includes('.claude/hooks/session-start-dev-memory-pack.sh'))).toBe(true);
    const hook = readFileSync(join(root, '.claude/hooks/session-start-dev-memory-pack.sh'), 'utf8');
    expect(hook).toContain('curl -sS -m 8');
    expect(hook.trimEnd().endsWith('exit 0')).toBe(true);
  });
});
