/**
 * VTID-04352 — `--only <name-prefix>` on the EventBridge cron migration script.
 *
 * The script creates every schedule in one pass, several of which push to
 * real members. `--only` lets one group (the nightly memory / learning jobs)
 * be switched on by itself. These tests run the real script in --dry-run,
 * which exits before any AWS call.
 *
 * Job counts are read from the script's own job table, not hardcoded: jobs
 * are added on main regularly (AP-0914 and the dev-memory handoff sweep
 * arrived after this test was written), and the property under test is the
 * filter, not the size of the table.
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';

const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-eventbridge-cron-migration.sh');

// One job per `"name|cron|tz|path|body|opts"` line in the script's job table.
const JOB_LINES = fs
  .readFileSync(SCRIPT, 'utf8')
  .split('\n')
  .filter((l) => /^\s*"[a-z0-9-]+\|/.test(l));
const ALL_JOBS = JOB_LINES.length;
const MEMORY_JOBS = JOB_LINES.filter((l) => /^\s*"autopilot-memory-/.test(l));
const MEMORY_APS = MEMORY_JOBS.map((l) => (l.match(/AP-(\d+)/) || [])[1]).filter(Boolean) as string[];

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
  it('the job table is what the test reads it to be', () => {
    expect(ALL_JOBS).toBeGreaterThanOrEqual(27);
    // The nightly learning group: AP-0906..AP-0913 at least (AP-0914 since main).
    for (const ap of ['0906', '0907', '0908', '0909', '0910', '0911', '0912', '0913']) {
      expect(MEMORY_APS).toContain(ap);
    }
  });

  it('without --only, the dry run still lists every job', () => {
    const r = run(['--dry-run']);
    expect(r.status).toBe(0);
    expect(scheduledNames(r.out)).toHaveLength(ALL_JOBS);
  });

  it('--only autopilot-memory- selects exactly the learning jobs', () => {
    const r = run(['--only', 'autopilot-memory-', '--dry-run']);
    expect(r.status).toBe(0);
    const names = scheduledNames(r.out);
    expect(names).toHaveLength(MEMORY_JOBS.length);
    expect(names.every((n) => n.startsWith('autopilot-memory-'))).toBe(true);
    for (const ap of MEMORY_APS) {
      expect(r.out).toContain(`/api/v1/automations/cron/AP-${ap}`);
    }
    expect(r.out).toContain(`Jobs:     ${MEMORY_JOBS.length}  (--only autopilot-memory-)`);
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
    expect(r.out).toContain(`matches none of the ${ALL_JOBS} jobs`);
  });

  it('--only with no value is rejected', () => {
    expect(run(['--only']).status).toBe(1);
    expect(run(['--only', '--dry-run']).status).toBe(1);
  });

  it('--delete with --only removes only matching schedules and keeps the shared Lambda and roles', () => {
    const r = run(['--delete', '--only', 'autopilot-memory-', '--dry-run']);
    expect(r.status).toBe(0);
    expect((r.out.match(/would delete /g) || []).length).toBe(MEMORY_JOBS.length);
    expect(r.out).toContain('shared Lambda and IAM roles kept');
    expect(r.out).not.toContain('Deleting all');
  });
});
