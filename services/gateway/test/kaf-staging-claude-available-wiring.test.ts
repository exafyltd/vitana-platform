/**
 * VTID-05282 (kaf-fallback-env/ff-stage-env): the staging deploy writes
 * CLAUDE_AVAILABLE into the gateway task definition from the repository
 * variable (default 'true' when it is empty), so the staging Project Manager
 * can fall back to process.env.CLAUDE_AVAILABLE when the repo variable is
 * unreadable for its token. Staging only: production never gets it.
 */
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '../..', '..');
const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

function stepBlock(src: string, name: string): string {
  const start = src.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\n      - name:', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('VTID-05282 staging task definition carries CLAUDE_AVAILABLE', () => {
  const step = stepBlock(stage, 'Register task-definition revision + roll the service (1/2');
  const runAt = step.indexOf('\n        run: |');

  test('the step env reads the repo variable with a true default, outside run:', () => {
    const line = "CLAUDE_AVAILABLE_VALUE: ${{ vars.CLAUDE_AVAILABLE || 'true' }}";
    expect(runAt).toBeGreaterThan(-1);
    const at = step.indexOf(line);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(runAt);
  });

  test('the jq call passes it as an arg placed before --arg TASK_ROLE, which stays last', () => {
    const arg = step.indexOf('--arg CLAUDE_AVAILABLE "$CLAUDE_AVAILABLE_VALUE" \\');
    const taskRole = step.indexOf(`--arg TASK_ROLE "$TASK_ROLE_ARN" '`);
    expect(arg).toBeGreaterThan(-1);
    expect(taskRole).toBeGreaterThan(arg);
  });

  test('the strip list removes the old entry next to PM_MODE', () => {
    expect(step).toContain('"PM_AGENT_ENABLED","PM_MODE","CLAUDE_AVAILABLE") | not) ]');
  });

  test('the upsert appears exactly once, right after PM_MODE', () => {
    const upsert = '{name:"CLAUDE_AVAILABLE", value:$CLAUDE_AVAILABLE}';
    expect(stage.split(upsert).length - 1).toBe(1);
    expect(step).toContain(`{name:"PM_MODE", value:"live"}, ${upsert},`);
  });

  test('VTID-05414: a staging deploy keeps the PM paused (PM_AGENT_ENABLED false)', () => {
    expect(step).toContain('{name:"PM_AGENT_ENABLED", value:"false"},');
    expect(stage).not.toContain('{name:"PM_AGENT_ENABLED", value:"true"}');
  });

  test('production never gets CLAUDE_AVAILABLE', () => {
    expect(prod).not.toContain('CLAUDE_AVAILABLE');
  });
});
