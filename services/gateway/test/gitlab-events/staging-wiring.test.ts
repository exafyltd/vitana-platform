/**
 * VTID-05541 (plan eng-gitlab-m2 §3.5, tasks.md W3/W4) — how the signing key reaches staging.
 *
 *   W3  AWS-STAGE-DEPLOY-GATEWAY.yml resolves vitana/gateway/staging/gitlab-webhook-signing-token into
 *       GITLAB_WEBHOOK_SIGNING_TOKEN only when the secret exists; absent, it is not wired and the deploy
 *       never fails. The step is RUN here against a stubbed `aws` in both cases.
 *       AWS-PROD-DEPLOY-GATEWAY.yml is intentionally not wired (protected gate file; no hook before cutover).
 *   W4  scripts/aws/setup-gitlab-webhook-secret.sh is a dry run by default; --apply copies the value from
 *       the engineering account into the staging secret. RUN here against a stubbed `aws` that records
 *       every call: no write without --apply, the value never printed or put on a command line.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import * as yaml from 'js-yaml';

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const STAGE = path.join(ROOT, '.github', 'workflows', 'AWS-STAGE-DEPLOY-GATEWAY.yml');
const PROD = path.join(ROOT, '.github', 'workflows', 'AWS-PROD-DEPLOY-GATEWAY.yml');
const SCRIPT = path.join(ROOT, 'scripts', 'aws', 'setup-gitlab-webhook-secret.sh');
const STEP_NAME = 'Resolve GitLab webhook signing token';
const TARGET = 'vitana/gateway/staging/gitlab-webhook-signing-token';
const SOURCE = 'vitana/engineering/gitlab/webhook-signing-token';
const SOURCE_VALUE = `whsec_${Buffer.from('engineering-account-signing-key-0123456789').toString('base64')}`;

// A stand-in for the AWS CLI: records argv + whether assumed-role credentials were in the environment,
// answers from STUB_* variables, and for a write records what a file:// parameter pointed at.
// (A plain template literal: \${ is bash's ${, and JS fills in only ${SOURCE} / ${TARGET}.)
const STUB_AWS = `#!/usr/bin/env bash
set -u
creds="none"; [ -n "\${AWS_ACCESS_KEY_ID:-}" ] && creds="\${AWS_ACCESS_KEY_ID}"
printf '%s|%s\\n' "$creds" "$*" >> "$STUB_LOG"
args=" $* "
fail_nf() { echo "An error occurred (ResourceNotFoundException) when calling the $1 operation: Secrets Manager can't find the specified secret." >&2; exit 254; }
case "$args" in
  *" sts get-caller-identity "*) echo "\${STUB_ACCOUNT:-472838866351}" ;;
  *" organizations list-accounts "*) echo "\${STUB_ENG_ACCOUNT-841276716213}" ;;
  *" sts assume-role "*)
    [ "\${STUB_ASSUME_FAIL:-0}" = 1 ] && { echo "AccessDenied" >&2; exit 254; }
    printf 'ASIASTUBKEY\\tstub-secret-key\\tstub-session-token\\n' ;;
  *" describe-secret "*)
    if [[ "$args" == *" ${SOURCE} "* ]]; then
      [ "$creds" = ASIASTUBKEY ] && [ "\${STUB_SOURCE_EXISTS:-1}" = 1 ] && { echo "arn:aws:secretsmanager:eu-central-1:841276716213:secret:${SOURCE}-AbCdEf"; exit 0; }
      fail_nf DescribeSecret
    elif [[ "$args" == *" ${TARGET} "* ]]; then
      [ "$creds" = none ] && [ "\${STUB_TARGET_EXISTS:-0}" = 1 ] && { echo "arn:aws:secretsmanager:eu-central-1:472838866351:secret:${TARGET}-XyZ123"; exit 0; }
      fail_nf DescribeSecret
    fi
    fail_nf DescribeSecret ;;
  *" get-secret-value "*)
    if [[ "$args" == *" ${SOURCE} "* ]] && [ "$creds" = ASIASTUBKEY ]; then echo "\${STUB_SOURCE_VALUE}"; exit 0; fi
    if [[ "$args" == *" ${TARGET} "* ]] && [ "$creds" = none ]; then echo "\${STUB_TARGET_VALUE:-}"; exit 0; fi
    fail_nf GetSecretValue ;;
  *" create-secret "*|*" put-secret-value "*)
    for a in "$@"; do case "$a" in file://*) f="\${a#file://}"; printf '%s' "$f" > "$STUB_LOG.path"; cat "$f" > "$STUB_LOG.value";; esac; done
    echo '{"ARN":"arn:aws:secretsmanager:eu-central-1:472838866351:secret:x"}' ;;
  *) echo "stub aws: unexpected call: $*" >&2; exit 99 ;;
esac
`;

// A stand-in for env(1) found first on PATH: records its argument list, then runs the real one. A script
// that handed credentials to the CLI as `env VAR=value aws …` would leave them in this log.
const STUB_ENV = `#!/bin/bash
printf '%s\\n' "$*" >> "$STUB_LOG.env"
exec /usr/bin/env "$@"
`;

function makeStub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05541-aws-'));
  fs.writeFileSync(path.join(dir, 'aws'), STUB_AWS, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'env'), STUB_ENV, { mode: 0o755 });
  return { dir, log: path.join(dir, 'calls.log') };
}

function cleanEnv(extra: Record<string, string>) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('AWS_')) env[k] = v;
  return { ...env, ...extra };
}

function runScript(args: string[], stubEnv: Record<string, string> = {}) {
  const stub = makeStub();
  const r = spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: cleanEnv({ PATH: `${stub.dir}:${process.env.PATH}`, STUB_LOG: stub.log, STUB_SOURCE_VALUE: SOURCE_VALUE, ...stubEnv }),
  });
  const calls = fs.existsSync(stub.log) ? fs.readFileSync(stub.log, 'utf8').trim().split('\n').filter(Boolean) : [];
  const envCalls = fs.existsSync(`${stub.log}.env`) ? fs.readFileSync(`${stub.log}.env`, 'utf8').trim().split('\n').filter(Boolean) : [];
  const written = fs.existsSync(`${stub.log}.value`) ? fs.readFileSync(`${stub.log}.value`, 'utf8') : null;
  const writtenPath = fs.existsSync(`${stub.log}.path`) ? fs.readFileSync(`${stub.log}.path`, 'utf8') : null;
  return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, envCalls, written, writtenPath };
}

const isWrite = (c: string) => / (create-secret|put-secret-value|delete-secret|update-secret|tag-resource) /.test(` ${c.split('|')[1]} `);
const isSecretsCall = (c: string) => / secretsmanager /.test(` ${c.split('|')[1]} `);

function stepText(workflow: string): string {
  const at = workflow.indexOf(`- name: ${STEP_NAME}`);
  expect(at).toBeGreaterThan(0);
  const next = workflow.indexOf('\n      - name: ', at + 1);
  return workflow.slice(at, next === -1 ? undefined : next);
}

function parsedStep(): { name: string; run: string; if?: string } {
  const doc = yaml.load(fs.readFileSync(STAGE, 'utf8')) as { jobs: Record<string, { steps?: any[] }> };
  const steps = Object.values(doc.jobs).flatMap((j) => j.steps || []);
  const found = steps.filter((s) => s.name === STEP_NAME);
  expect(found).toHaveLength(1);
  return found[0];
}

describe('W3 — AWS-STAGE-DEPLOY-GATEWAY.yml wires the key only when the secret exists', () => {
  const stage = fs.readFileSync(STAGE, 'utf8');

  it('the workflow parses and the step resolves the staging secret by name, tolerating its absence', () => {
    const step = parsedStep();
    expect(step.if).toBeUndefined();
    expect(step.run).toContain(`NAME="${TARGET}"`);
    expect(step.run).toMatch(/describe-secret[^\n]*\|\| true\)/);
    expect(step.run).not.toMatch(/exit 1/);
    expect(stepText(stage)).not.toContain('secrets.');
  });

  it('wires a secret reference into connected-apps.json, never a plain value, before the task definition is built', () => {
    const step = parsedStep();
    expect(step.run).toContain('F="$RUNNER_TEMP/connected-apps.json"');
    expect(step.run).toContain('.sec += [{name:"GITLAB_WEBHOOK_SIGNING_TOKEN", valueFrom:$a}]');
    expect(stage).not.toMatch(/name:"GITLAB_WEBHOOK_SIGNING_TOKEN", value:/);
    const created = stage.indexOf('- name: Resolve Connected Apps sign-in config');
    const mine = stage.indexOf(`- name: ${STEP_NAME}`);
    const merged = stage.indexOf('--slurpfile CA "$RUNNER_TEMP/connected-apps.json"');
    expect(created).toBeGreaterThan(-1);
    expect(created).toBeLessThan(mine);
    expect(mine).toBeLessThan(merged);
  });

  function runStep(describeAnswer: 'missing' | 'present' | 'denied') {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-05541-step-'));
    const stub = [
      '#!/usr/bin/env bash',
      `case "${describeAnswer}" in`,
      `  present) echo "arn:aws:secretsmanager:eu-central-1:472838866351:secret:${TARGET}-XyZ123" ;;`,
      '  missing) echo "An error occurred (ResourceNotFoundException) when calling the DescribeSecret operation" >&2; exit 254 ;;',
      '  denied) echo "An error occurred (AccessDeniedException) when calling the DescribeSecret operation: not authorized" >&2; exit 254 ;;',
      'esac',
    ].join('\n');
    fs.writeFileSync(path.join(dir, 'aws'), stub, { mode: 0o755 });
    const before = { env: [{ name: 'APP_URL', value: 'https://preview-aws.vitanaland.com' }], sec: [{ name: 'DAILY_API_KEY', valueFrom: 'arn:x' }] };
    fs.writeFileSync(path.join(dir, 'connected-apps.json'), JSON.stringify(before));
    const r = spawnSync('bash', ['-c', parsedStep().run], {
      encoding: 'utf8',
      env: cleanEnv({ PATH: `${dir}:${process.env.PATH}`, RUNNER_TEMP: dir }),
    });
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'connected-apps.json'), 'utf8'));
    return { status: r.status, out: `${r.stdout}${r.stderr}`, before, after };
  }

  it('secret absent: the step succeeds, says so, and wires nothing', () => {
    const r = runStep('missing');
    expect(r.status).toBe(0);
    expect(r.out).toContain(`${TARGET} not found - GITLAB_WEBHOOK_SIGNING_TOKEN not wired`);
    expect(r.after).toEqual(r.before);
  });

  it('lookup denied: the step succeeds with a warning and wires nothing', () => {
    const r = runStep('denied');
    expect(r.status).toBe(0);
    expect(r.out).toContain('::warning::');
    expect(r.after).toEqual(r.before);
  });

  it('secret present: the step adds exactly one secret reference and keeps everything else', () => {
    const r = runStep('present');
    expect(r.status).toBe(0);
    expect(r.after.env).toEqual(r.before.env);
    expect(r.after.sec).toEqual([
      ...r.before.sec,
      { name: 'GITLAB_WEBHOOK_SIGNING_TOKEN', valueFrom: `arn:aws:secretsmanager:eu-central-1:472838866351:secret:${TARGET}-XyZ123` },
    ]);
  });

  it('sibling sweep: AWS-PROD-DEPLOY-GATEWAY.yml is intentionally not wired in this milestone', () => {
    const prod = fs.readFileSync(PROD, 'utf8');
    expect(prod).not.toContain('GITLAB_WEBHOOK_SIGNING_TOKEN');
    expect(prod).not.toContain('gitlab-webhook-signing-token');
  });
});

describe('W4 — scripts/aws/setup-gitlab-webhook-secret.sh', () => {
  it('passes bash -n', () => {
    const r = spawnSync('bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.status).toBe(0);
  });

  it('dry run by default: reads only, writes nothing, never reads a secret value', () => {
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/dry run/i);
    expect(r.out).toContain(TARGET);
    expect(r.calls.some((c) => c.includes('sts get-caller-identity'))).toBe(true);
    expect(r.calls.some((c) => c.includes('sts assume-role') && c.includes('arn:aws:iam::841276716213:role/OrganizationAccountAccessRole'))).toBe(true);
    expect(r.calls.some((c) => c.startsWith('ASIASTUBKEY|') && c.includes(`describe-secret`) && c.includes(SOURCE))).toBe(true);
    expect(r.calls.filter(isWrite)).toEqual([]);
    expect(r.calls.filter((c) => c.includes('get-secret-value'))).toEqual([]);
    expect(r.written).toBeNull();
  });

  it('--apply, target missing: creates the staging secret from the engineering value, through a file, as the workload account', () => {
    const r = runScript(['--apply']);
    expect(r.status).toBe(0);
    const writes = r.calls.filter(isWrite);
    expect(writes).toHaveLength(1);
    const [creds, argv] = writes[0].split('|');
    expect(creds).toBe('none'); // the write runs with the caller's own (workload-account) credentials
    expect(argv).toContain('secretsmanager create-secret');
    expect(argv).toContain(`--name ${TARGET}`);
    expect(argv).toContain('--region eu-central-1');
    expect(argv).toMatch(/--secret-string file:\/\//);
    expect(r.calls.some((c) => c.startsWith('ASIASTUBKEY|') && c.includes('get-secret-value') && c.includes(SOURCE))).toBe(true);
    expect(r.written).toBe(SOURCE_VALUE);
    expect(fs.existsSync(r.writtenPath!)).toBe(false); // the value file is removed on exit
    expect(r.out).not.toContain(SOURCE_VALUE);
    expect(r.calls.join('\n')).not.toContain(SOURCE_VALUE);
  });

  it('the engineering session credentials reach the CLI only through its environment, never an argument list', () => {
    const r = runScript(['--apply']);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('ASIASTUBKEY|'))).toBe(true); // the source reads ran with them
    const argLists = [...r.calls.map((c) => c.split('|').slice(1).join('|')), ...r.envCalls].join('\n');
    for (const s of ['ASIASTUBKEY', 'stub-secret-key', 'stub-session-token']) expect(argLists).not.toContain(s);
  });

  it('--apply, target holds another value: updates it with put-secret-value', () => {
    const r = runScript(['--apply'], { STUB_TARGET_EXISTS: '1', STUB_TARGET_VALUE: 'whsec_b2xkLXZhbHVl' });
    expect(r.status).toBe(0);
    const writes = r.calls.filter(isWrite);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('secretsmanager put-secret-value');
    expect(writes[0]).toContain(`--secret-id ${TARGET}`);
    expect(r.written).toBe(SOURCE_VALUE);
    expect(r.out).not.toContain(SOURCE_VALUE);
  });

  it('--apply, target already holds the same value: writes nothing', () => {
    const r = runScript(['--apply'], { STUB_TARGET_EXISTS: '1', STUB_TARGET_VALUE: SOURCE_VALUE });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/unchanged/i);
    expect(r.calls.filter(isWrite)).toEqual([]);
  });

  it('refuses outside the workload account 472838866351, before any Secrets Manager call', () => {
    const r = runScript(['--apply'], { STUB_ACCOUNT: '111122223333' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('472838866351');
    expect(r.calls.filter(isSecretsCall)).toEqual([]);
  });

  it('refuses a source value that is not whsec_<base64>, and an empty one, writing nothing', () => {
    for (const bad of ['plain-token-without-prefix', 'whsec_', '']) {
      const r = runScript(['--apply'], { STUB_SOURCE_VALUE: bad });
      expect(r.status).not.toBe(0);
      expect(r.out).toContain('is not in whsec_<base64> form');
      expect(r.calls.some((c) => c.includes('get-secret-value') && c.includes(SOURCE))).toBe(true);
      expect(r.calls.filter(isWrite)).toEqual([]);
      if (bad === 'plain-token-without-prefix') expect(r.out).not.toContain(bad);
    }
  });

  it('refuses when the source secret does not exist yet, writing nothing', () => {
    const r = runScript(['--apply'], { STUB_SOURCE_EXISTS: '0' });
    expect(r.status).not.toBe(0);
    expect(r.out).toContain(SOURCE);
    expect(r.calls.filter(isWrite)).toEqual([]);
  });

  it('refuses when the engineering account cannot be found or assumed', () => {
    const notFound = runScript([], { STUB_ENG_ACCOUNT: '' });
    expect(notFound.status).not.toBe(0);
    expect(notFound.out).toContain('--source-account');
    const denied = runScript(['--apply'], { STUB_ASSUME_FAIL: '1' });
    expect(denied.status).not.toBe(0);
    expect(denied.calls.filter(isWrite)).toEqual([]);
  });

  it('--source-account skips the Organizations lookup and must be another 12-digit account', () => {
    const r = runScript(['--source-account', '123456789012']);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes('organizations'))).toBe(false);
    expect(r.calls.some((c) => c.includes('arn:aws:iam::123456789012:role/OrganizationAccountAccessRole'))).toBe(true);
    for (const bad of ['12345', '472838866351']) {
      const x = runScript(['--source-account', bad]);
      expect(x.status).not.toBe(0);
      expect(x.calls.filter(isSecretsCall)).toEqual([]);
    }
  });

  it('rejects an unknown argument (there is no production mode) before any AWS call', () => {
    const r = runScript(['--env', 'prod']);
    expect(r.status).toBe(2);
    expect(r.out).toContain('Unknown argument: --env');
    expect(r.calls).toEqual([]);
  });
});
