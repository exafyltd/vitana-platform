/**
 * VTID-04673: scripts/aws/setup-eventbridge-cron-migration.sh must turn a
 * unix cron into an EventBridge Scheduler cron() that AWS accepts AND that
 * fires on the same day. The first live apply (2026-09-26) failed all 11
 * schedules: the old converter only appended a year (`cron(0 8 * * * *)`,
 * rejected), would have shifted weekdays by one (EventBridge 1 = Sunday), and
 * discarded the AWS error. This runs the converter block embedded in the
 * script itself, so the test and the script can never drift.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-eventbridge-cron-migration.sh');
const src = fs.readFileSync(SCRIPT, 'utf8');
const block = src.slice(
  src.indexOf('# --- eventbridge-cron-converter:begin ---'),
  src.indexOf('# --- eventbridge-cron-converter:end ---'),
);

function convert(expr: string): string {
  return execFileSync('python3', ['-c', block, expr], { encoding: 'utf8' }).trim();
}

describe('VTID-04673 unix -> EventBridge cron conversion', () => {
  it('puts ? in day-of-week for daily and hourly jobs', () => {
    expect(convert('0 8 * * *')).toBe('cron(0 8 * * ? *)');
    expect(convert('0 21 * * *')).toBe('cron(0 21 * * ? *)');
    expect(convert('35 * * * *')).toBe('cron(35 * * * ? *)');
  });

  it('maps unix weekday numbers (0 = Sunday) to names, never to EventBridge numbers', () => {
    expect(convert('0 18 * * 0')).toBe('cron(0 18 ? * SUN *)');
    expect(convert('0 20 * * 5')).toBe('cron(0 20 ? * FRI *)');
    expect(convert('0 10 * * 1')).toBe('cron(0 10 ? * MON *)');
    expect(convert('0 10 * * 3')).toBe('cron(0 10 ? * WED *)');
    expect(convert('0 9 * * 1-5')).toBe('cron(0 9 ? * MON-FRI *)');
    expect(convert('0 9 * * 7')).toBe('cron(0 9 ? * SUN *)');
  });

  it('turns */N steps into EventBridge 0/N', () => {
    expect(convert('*/15 * * * *')).toBe('cron(0/15 * * * ? *)');
    expect(convert('*/5 * * * *')).toBe('cron(0/5 * * * ? *)');
  });

  it('refuses what EventBridge cannot express instead of guessing', () => {
    expect(() => convert('0 9 1 * 1')).toThrow();
    expect(() => convert('0 9 * *')).toThrow();
  });

  it('converts every job the script defines', () => {
    const jobs = [...src.matchAll(/^\s+"([a-z0-9-]+)\|([^|]+)\|/gm)].map((m) => [m[1], m[2]]);
    expect(jobs.length).toBeGreaterThan(20);
    for (const [, cron] of jobs) expect(convert(cron)).toMatch(/^cron\(\S+ \S+ (\?|\S+) \S+ (\?|\S+) \*\)$/);
  });

  it('never hides the AWS error and never stops at a pager', () => {
    expect(src).toContain('export AWS_PAGER=""');
    const loop = src.slice(src.indexOf('for JOB in "${JOBS[@]}"; do\n  IFS=\'|\' read -r NAME SCHEDULE'));
    expect(loop).not.toMatch(/--target "\$TARGET" > \/dev\/null 2>&1/);
  });
});
