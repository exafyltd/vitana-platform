/**
 * VTID-04037 — Operator agent staging enablement. The four owner-gated
 * flags the operator-agent plan left for the platform owner are now pinned
 * on the AWS STAGING gateway workflow only (owner-approved in conversation
 * 2026-09-18), and the read-only SQL tool is wired the optional, ERP-bridge
 * way: present secret => enabled, absent secret => untouched, never a
 * failed deploy. Prod stays exactly as it was.
 */

import * as fs from 'fs';
import * as path from 'path';

const WF = path.resolve(__dirname, '../../../.github/workflows');
const staging = fs.readFileSync(path.join(WF, 'AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const prod = fs.readFileSync(path.join(WF, 'AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');

const FLAGS = [
  'OPERATOR_VTID_SELF_ALLOCATE_ENABLED',
  'OPERATOR_PR_APPROVAL_REQUIRED',
  'OPERATOR_THREADS_ENABLED',
  'OPERATOR_TURN_MEMORY_ENABLED',
];

function envStripList(): string {
  const block = staging.slice(
    staging.indexOf('.containerDefinitions[0].environment |='),
    staging.indexOf('.containerDefinitions[0].secrets |='),
  );
  return block.slice(0, block.indexOf('| not) ]'));
}

function secretsStripList(): string {
  const start = staging.indexOf('.containerDefinitions[0].secrets |=');
  const block = staging.slice(start);
  return block.slice(0, block.indexOf('| not) ]'));
}

describe('VTID-04037: staging pins the four operator-agent flags to exact "true"', () => {
  it.each(FLAGS)('pins %s=true on the staging gateway task def', (flag) => {
    expect(staging).toContain(`{name:"${flag}", value:"true"}`);
  });

  it.each(FLAGS)('strips an inherited %s first, so a stale value cannot survive a deploy', (flag) => {
    expect(envStripList()).toContain(`"${flag}"`);
  });

  it.each(FLAGS)('does NOT pin %s on the prod gateway deploy workflow', (flag) => {
    expect(prod).not.toContain(flag);
  });

  it('keeps the on-ramp, agent executor and ECS dispatch the flags depend on', () => {
    expect(staging).toMatch(/\{name:"OPERATOR_EXECUTION_ONRAMP_ENABLED", value:"true"\}/);
    expect(staging).toMatch(/\{name:"OPERATOR_ONRAMP_EXECUTOR", value:"agent"\}/);
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_USE_JOB", value:"true"\}/);
    expect(staging).toMatch(/\{name:"DEV_AUTOPILOT_WATCHER_LIVE", value:"true"\}/);
  });

  it('every pinned flag is read by its module with the exact-string check (a typo is off)', () => {
    const src = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../src/services', rel), 'utf8');
    expect(src('operator-execution-onramp.ts')).toContain("process.env.OPERATOR_VTID_SELF_ALLOCATE_ENABLED === 'true'");
    expect(src('operator-execution-onramp.ts')).toContain("process.env.OPERATOR_PR_APPROVAL_REQUIRED === 'true'");
    expect(src('operator-threads.ts')).toContain("env.OPERATOR_THREADS_ENABLED === 'true'");
    expect(src('operator-turn-memory.ts')).toContain("env.OPERATOR_TURN_MEMORY_ENABLED === 'true'");
  });
});

describe('VTID-04037: read-only SQL is wired optionally, the ERP-bridge way', () => {
  it('resolves the URL secret with describe-secret and tolerates its absence (never exit 1)', () => {
    const i = staging.indexOf('SEC_SQL_RO=$(aws secretsmanager describe-secret --secret-id vitana/gateway/staging/operator-sql-readonly-url');
    expect(i).toBeGreaterThan(0);
    const around = staging.slice(i, i + 700);
    expect(around).toContain('|| true');
    expect(around).toContain('SEC_SQL_RO=""');
    expect(around).not.toContain('exit 1');
  });

  it('is NOT in the hard-fail secret-resolution loop', () => {
    const loopStart = staging.indexOf('for pair in \\');
    const loopEnd = staging.indexOf('done', loopStart);
    expect(staging.slice(loopStart, loopEnd)).not.toContain('operator-sql-readonly-url');
  });

  it('enables the tool and injects the URL as a secret only when the secret exists', () => {
    expect(staging).toContain('if $SEC_SQL_RO != "" then');
    expect(staging).toContain('{name:"OPERATOR_SQL_READONLY_ENABLED", value:"true"}');
    expect(staging).toContain('{name:"OPERATOR_SQL_READONLY_DATABASE_URL", valueFrom:$SEC_SQL_RO}');
    expect(staging).toContain('--arg SEC_SQL_RO "$SEC_SQL_RO"');
  });

  it('strips a stale switch and URL first', () => {
    expect(envStripList()).toContain('"OPERATOR_SQL_READONLY_ENABLED"');
    expect(secretsStripList()).toContain('"OPERATOR_SQL_READONLY_DATABASE_URL"');
  });

  it('prod carries none of it', () => {
    expect(prod).not.toContain('OPERATOR_SQL_READONLY');
  });
});
