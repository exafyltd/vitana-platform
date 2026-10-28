/**
 * VTID-05127: phone verification (VTID-05095) can be switched on without a
 * code change. Staging wires the HMAC secret when it exists (the secret's
 * presence is the switch); production wires it from two repository variables
 * through scripts/ci/phone-verify-wiring.sh and refuses "on" without the
 * secret. Both default to PHONE_VERIFY_ENABLED=false.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const root = path.resolve(__dirname, '../../..');
const prod = fs.readFileSync(path.join(root, '.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml'), 'utf8');
const stage = fs.readFileSync(path.join(root, '.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml'), 'utf8');
const wiringScript = path.join(root, 'scripts/ci/phone-verify-wiring.sh');
const setupScript = path.join(root, 'scripts/aws/setup-phone-verify-sms.sh');

const GOOD_ARN = 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/prod/phone-verify-hmac-Ab12Cd';

function stepBlock(src: string, name: string): string {
  const start = src.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = src.indexOf('\n      - name:', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('VTID-05127 production wiring step', () => {
  const step = stepBlock(prod, 'Build task-definition (phone verification)');

  test('reads both repository variables and calls the shared wiring script on the partial task definition', () => {
    expect(step).toContain('PHONE_VERIFY_ARN: ${{ vars.PHONE_VERIFY_HMAC_SECRET_PROD_ARN }}');
    expect(step).toContain('PHONE_VERIFY_ENABLED_VAR: ${{ vars.PHONE_VERIFY_PROD_ENABLED }}');
    expect(step).toContain('bash scripts/ci/phone-verify-wiring.sh /tmp/vitana-new-task-def.json');
    expect(fs.existsSync(wiringScript)).toBe(true);
  });

  test('runs after the checkout and before step 2/2, so env_overrides can still switch it off', () => {
    const checkout = prod.indexOf('uses: actions/checkout@v4');
    const phone = prod.indexOf('- name: Build task-definition (phone verification)');
    const step2 = prod.indexOf('- name: Build task-definition (2/2');
    expect(checkout).toBeGreaterThan(-1);
    expect(checkout).toBeLessThan(phone);
    expect(phone).toBeLessThan(step2);
  });

  test('step 2/2 never strips the phone settings by name', () => {
    const step2 = prod.slice(prod.indexOf('- name: Build task-definition (2/2'));
    expect(step2).not.toMatch(/"PHONE_VERIFY_ENABLED"/);
    expect(step2).not.toMatch(/"PHONE_VERIFY_HMAC_SECRET"/);
  });

  test('the secret is only ever a valueFrom reference, never a plain value', () => {
    const script = fs.readFileSync(wiringScript, 'utf8');
    expect(script).toContain('{name:"PHONE_VERIFY_HMAC_SECRET", valueFrom:$A}');
    expect(prod + stage + script).not.toMatch(/name:"PHONE_VERIFY_HMAC_SECRET", value:/);
  });

  test('pins the exact anchored ARN pattern', () => {
    const script = fs.readFileSync(wiringScript, 'utf8');
    expect(script).toContain(
      "RE='^arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/prod/phone-verify-hmac-[A-Za-z0-9]{6}$'",
    );
  });
});

describe('VTID-05127 wiring decision (scripts/ci/phone-verify-wiring.sh)', () => {
  const hasJq = spawnSync('jq', ['--version']).status === 0;
  const run = (arn: string, enabled: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv-wiring-'));
    const file = path.join(dir, 'td.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        containerDefinitions: [
          {
            environment: [{ name: 'KEEP', value: '1' }, { name: 'PHONE_VERIFY_ENABLED', value: 'stale' }],
            secrets: [{ name: 'PHONE_VERIFY_HMAC_SECRET', valueFrom: 'arn:stale' }, { name: 'OTHER', valueFrom: 'arn:other' }],
          },
        ],
      }),
    );
    const res = spawnSync('bash', [wiringScript, file], {
      env: { ...process.env, PHONE_VERIFY_ARN: arn, PHONE_VERIFY_ENABLED_VAR: enabled },
      encoding: 'utf8',
    });
    const td = JSON.parse(fs.readFileSync(file, 'utf8'));
    const c = td.containerDefinitions[0];
    return {
      status: res.status,
      out: `${res.stdout}${res.stderr}`,
      enabled: c.environment.filter((e: { name: string }) => e.name === 'PHONE_VERIFY_ENABLED').map((e: { value: string }) => e.value),
      secret: c.secrets.filter((s: { name: string }) => s.name === 'PHONE_VERIFY_HMAC_SECRET').map((s: { valueFrom: string }) => s.valueFrom),
      keep: c.environment.some((e: { name: string }) => e.name === 'KEEP') && c.secrets.some((s: { name: string }) => s.name === 'OTHER'),
    };
  };
  const t = hasJq ? test : test.skip;

  t('ARN + enabled → secret wired, PHONE_VERIFY_ENABLED=true, other entries kept', () => {
    const r = run(GOOD_ARN, 'true');
    expect(r.status).toBe(0);
    expect(r.enabled).toEqual(['true']);
    expect(r.secret).toEqual([GOOD_ARN]);
    expect(r.keep).toBe(true);
  });

  t('ARN + not enabled → secret wired, PHONE_VERIFY_ENABLED=false', () => {
    const r = run(GOOD_ARN, '');
    expect(r.status).toBe(0);
    expect(r.enabled).toEqual(['false']);
    expect(r.secret).toEqual([GOOD_ARN]);
  });

  t('no ARN + enabled → fails (on without its secret)', () => {
    const r = run('', 'true');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('PHONE_VERIFY_PROD_ENABLED=true but PHONE_VERIFY_HMAC_SECRET_PROD_ARN is empty');
  });

  t('no ARN + not enabled → PHONE_VERIFY_ENABLED=false and the stale secret ref removed', () => {
    const r = run('', '');
    expect(r.status).toBe(0);
    expect(r.enabled).toEqual(['false']);
    expect(r.secret).toEqual([]);
    expect(r.keep).toBe(true);
  });

  t.each([
    ['wrong prefix', 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/staging/phone-verify-hmac-Ab12Cd'],
    ['other account', 'arn:aws:secretsmanager:eu-central-1:111111111111:secret:vitana/gateway/prod/phone-verify-hmac-Ab12Cd'],
    ['suffix too short', 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/prod/phone-verify-hmac-Ab12C'],
    ['trailing text', `${GOOD_ARN}x`],
    ['another secret with the same prefix', 'arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/prod/phone-verify-hmac-extra-Ab12Cd'],
  ])('rejects an ARN with %s', (_label, arn) => {
    const r = run(arn, '');
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('is not the ARN of vitana/gateway/prod/phone-verify-hmac');
  });

  t.each(['TRUE', ' true', 'true ', '1', 'yes'])('enabled value %j is off', (v) => {
    const r = run(GOOD_ARN, v);
    expect(r.status).toBe(0);
    expect(r.enabled).toEqual(['false']);
  });
});

describe('VTID-05127 staging wiring step', () => {
  const step = stepBlock(stage, 'Resolve phone verification config');

  test('looks up the staging secret and never fails the deploy when it is absent', () => {
    expect(step).toContain('NAME="vitana/gateway/staging/phone-verify-hmac"');
    expect(step).toContain('describe-secret --secret-id "$NAME"');
    expect(step).toContain('|| true)');
    expect(step).not.toMatch(/exit 1/);
  });

  test('absent → PHONE_VERIFY_ENABLED=false; present → secret ref + true (merged by name via connected-apps.json)', () => {
    expect(step).toContain(`.env += [{name:"PHONE_VERIFY_ENABLED", value:"false"}]`);
    expect(step).toContain(`.env += [{name:"PHONE_VERIFY_ENABLED", value:"true"}] | .sec += [{name:"PHONE_VERIFY_HMAC_SECRET", valueFrom:$a}]`);
    expect(step).toContain('F="$RUNNER_TEMP/connected-apps.json"');
  });

  test('runs before the roll step, which merges connected-apps.json by name and does not strip the phone settings itself', () => {
    const phone = stage.indexOf('- name: Resolve phone verification config');
    const roll = stage.indexOf('- name: Register task-definition revision + roll the service');
    expect(phone).toBeGreaterThan(-1);
    expect(phone).toBeLessThan(roll);
    const rollStep = stage.slice(roll, stage.indexOf('\n      - name:', roll + 1));
    expect(rollStep).toContain('--slurpfile CA "$RUNNER_TEMP/connected-apps.json"');
    expect(rollStep).not.toMatch(/"PHONE_VERIFY_ENABLED"/);
    expect(rollStep).not.toMatch(/"PHONE_VERIFY_HMAC_SECRET"/);
  });
});

describe('VTID-05127 setup script', () => {
  const script = fs.readFileSync(setupScript, 'utf8');

  test('grants only SendTextMessage, scoped to this account and region', () => {
    expect(script).toContain('"Action": ["sms-voice:SendTextMessage"]');
    expect(script).toContain('"Resource": "arn:aws:sms-voice:${REGION}:${ACCOUNT_ID}:*"');
    expect(script).toContain('ACCOUNT_ID="472838866351"');
    expect(script).toContain('REGION="eu-central-1"');
  });

  test('dry run without credentials stops at the account check and changes nothing', () => {
    const res = spawnSync('bash', [setupScript, '--env', 'prod', '--monthly-limit-usd', '50', '--sender-id', 'Vitana'], {
      env: { PATH: '/usr/bin:/bin', HOME: os.tmpdir() },
      encoding: 'utf8',
    });
    expect(res.status).not.toBe(0);
    expect(`${res.stdout}${res.stderr}`).toContain('nothing was changed');
  });

  test('never prints the secret value', () => {
    expect(script).not.toMatch(/echo[^\n]*openssl rand/);
    expect(script).toMatch(/--secret-string "\$\(openssl rand -hex 32\)"/);
  });
});
