/**
 * VTID-04352 — `--only <name-prefix>` on the EventBridge cron migration script.
 *
 * The script creates all 27 schedules in one pass, several of which push to
 * real members. `--only` lets one group (the nightly memory / learning jobs,
 * AP-0906..AP-0913) be switched on by itself. These tests run the real script
 * in --dry-run, which exits before any AWS call.
 */

import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-eventbridge-cron-migration.sh');

function run(args: string[]) {
  const r = spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, DEFAULT_TENANT_ID: '00000000-0000-0000-0000-000000000001' },
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function scheduledNames(out: string): string[] {
  return out
    .split('\n')
    .filter((l) => /^ {2}\S+ {2}\(/.test(l))
    .map((l) => l.trim().split(/\s+/)[0]);
}

describe('VTID-04352: --only filter on setup-eventbridge-cron-migration.sh', () => {
  it('without --only, the dry run still lists all 27 jobs', () => {
    const r = run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(scheduledNames(r.out)).toHaveLength(27);
  });

  it('--only autopilot-memory- selects exactly the 8 learning jobs AP-0906..AP-0913', () => {
    const r = run(['--only', 'autopilot-memory-', '--dry-run']);
    expect(r.status).toBe(0);
    const names = scheduledNames(r.out);
    expect(names).toHaveLength(8);
    expect(names.every((n) => n.startsWith('autopilot-memory-'))).toBe(true);
    for (const ap of ['0906', '0907', '0908', '0909', '0910', '0911', '0912', '0913']) {
      expect(r.out).toContain(`/api/v1/automations/cron/AP-${ap}`);
    }
    expect(r.out).toContain('Jobs:     8  (--only autopilot-memory-)');
  });

  it('is repeatable, and a full job name is a valid prefix', () => {
    const r = run([
      '--only', 'autopilot-memory-user-model-synthesis',
      '--only', 'autopilot-memory-routine-pattern-extraction',
      '--dry-run',
    ]);
    expect(r.status).toBe(0);
    expect(scheduledNames(r.out).sort()).toEqual([
      'autopilot-memory-routine-pattern-extraction',
      'autopilot-memory-user-model-synthesis',
    ]);
  });

  it('a prefix that matches nothing fails loudly instead of doing nothing', () => {
    const r = run(['--only', 'no-such-job-', '--dry-run']);
    expect(r.status).toBe(1);
    expect(r.out).toContain('matches none of the 27 jobs');
  });

  it('--only with no value is rejected', () => {
    expect(run(['--only']).status).toBe(1);
    expect(run(['--only', '--dry-run']).status).toBe(1);
  });

  it('--delete with --only removes only matching schedules and keeps the shared Lambda and roles', () => {
    const r = run(['--delete', '--only', 'autopilot-memory-', '--dry-run']);
    expect(r.status).toBe(0);
    expect((r.out.match(/would delete /g) || []).length).toBe(8);
    expect(r.out).toContain('shared Lambda and IAM roles kept');
    expect(r.out).not.toContain('Deleting all');
  });
});
