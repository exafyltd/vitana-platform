/**
 * VTID-04507 — Connected Apps sign-in on staging.
 *
 * Every connector except Android Contacts reported `not_configured` on
 * staging, because the gateway task definition carried none of
 * GOOGLE_OAUTH_CLIENT_ID/SECRET, MICROSOFT_OAUTH_CLIENT_ID/SECRET or
 * AI_CREDENTIALS_ENC_KEY. It also had no GATEWAY_PUBLIC_URL / APP_URL, so the
 * OAuth redirect URI and the post-consent return both fell back to
 * https://vitana.app — Google would have rejected the redirect even with a
 * client configured.
 *
 * The workflow now pins both URLs and wires each secret only when it exists
 * in Secrets Manager. These tests pin that shape, including that an absent
 * secret never fails the deploy and that production is untouched.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as os from 'os';

const WORKFLOW = path.resolve(__dirname, '../../../.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml');
const PROD_WORKFLOW = path.resolve(__dirname, '../../../.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml');
const SCRIPT = path.resolve(__dirname, '../../../scripts/aws/setup-connected-apps-oauth-secrets.sh');

const yml = fs.readFileSync(WORKFLOW, 'utf8');

const STEP_NAME = '- name: Resolve Connected Apps sign-in config';
const REGISTER_NAME = '- name: Register task-definition revision + roll the service';

function resolveStep(): string {
  const start = yml.indexOf(STEP_NAME);
  const end = yml.indexOf(REGISTER_NAME);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return yml.slice(start, end);
}

const SECRETS: Array<[string, string]> = [
  ['GOOGLE_OAUTH_CLIENT_ID', 'google-oauth-client-id'],
  ['GOOGLE_OAUTH_CLIENT_SECRET', 'google-oauth-client-secret'],
  ['MICROSOFT_OAUTH_CLIENT_ID', 'microsoft-oauth-client-id'],
  ['MICROSOFT_OAUTH_CLIENT_SECRET', 'microsoft-oauth-client-secret'],
  ['AI_CREDENTIALS_ENC_KEY', 'credentials-enc-key'],
];

describe('VTID-04507: staging wires Connected Apps sign-in', () => {
  it('resolves the config in its own step, before the task definition is registered', () => {
    resolveStep();
  });

  it('pins the public URLs the OAuth redirect and return are built from', () => {
    const step = resolveStep();
    expect(step).toContain('{name:"GATEWAY_PUBLIC_URL", value:"https://preview-aws-gateway.vitanaland.com"}');
    expect(step).toContain('{name:"APP_URL", value:"https://preview-aws.vitanaland.com"}');
  });

  it.each(SECRETS)('probes %s from vitana/gateway/staging/%s', (envName, suffix) => {
    expect(resolveStep()).toContain(`"${envName}:${suffix}"`);
  });

  it('probes with describe-secret and never exits when a secret is absent', () => {
    const step = resolveStep();
    expect(step).toContain('NAME="vitana/gateway/staging/${pair#*:}"');
    expect(step).toMatch(/aws secretsmanager describe-secret --secret-id "\$NAME"[^\n]*\|\| true/);
    expect(step).not.toMatch(/exit 1/);
  });

  it('merges the file into the task definition with one slurpfile clause', () => {
    expect(yml).toContain('--slurpfile CA "$RUNNER_TEMP/connected-apps.json"');
    expect(yml).toContain(
      '.containerDefinitions[0].environment |= ( [ .[] | select(.name as $n | ($CA[0].env + $CA[0].sec) | map(.name) | index($n) | not) ] + $CA[0].env )',
    );
    expect(yml).toContain(
      '.containerDefinitions[0].secrets |= ( [ .[] | select(.name as $n | $CA[0].sec | map(.name) | index($n) | not) ] + $CA[0].sec )',
    );
  });

  it('does not touch the production workflow', () => {
    const prod = fs.readFileSync(PROD_WORKFLOW, 'utf8');
    expect(prod).not.toContain('connected-apps.json');
    expect(prod).not.toContain('google-oauth-client-id');
  });

  it('ships an executable setup script covering the same five secrets', () => {
    const script = fs.readFileSync(SCRIPT, 'utf8');
    for (const [envName, suffix] of SECRETS) {
      expect(script).toContain(`"${envName}:${suffix}"`);
    }
    expect(script).toContain('openssl rand -hex 32');
    expect(fs.statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

// Runs the real merge clause through jq when jq is installed (it is on
// GitHub runners); skipped otherwise so a local run without jq stays green.
let hasJq = true;
try {
  execFileSync('jq', ['--version'], { stdio: 'ignore' });
} catch {
  hasJq = false;
}

(hasJq ? describe : describe.skip)('VTID-04507: the jq merge', () => {
  const filter = [
    '.containerDefinitions[0].environment |= ( [ .[] | select(.name as $n | ($CA[0].env + $CA[0].sec) | map(.name) | index($n) | not) ] + $CA[0].env )',
    '| .containerDefinitions[0].secrets |= ( [ .[] | select(.name as $n | $CA[0].sec | map(.name) | index($n) | not) ] + $CA[0].sec )',
  ].join('\n');

  function run(ca: unknown, td: unknown): any {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtid-04507-'));
    const caFile = path.join(dir, 'ca.json');
    fs.writeFileSync(caFile, JSON.stringify(ca));
    const out = execFileSync('jq', ['-c', '--slurpfile', 'CA', caFile, filter], { input: JSON.stringify(td) });
    return JSON.parse(out.toString());
  }

  const env = [
    { name: 'GATEWAY_PUBLIC_URL', value: 'https://preview-aws-gateway.vitanaland.com' },
    { name: 'APP_URL', value: 'https://preview-aws.vitanaland.com' },
  ];

  it('replaces stale values and keeps unrelated entries and absent secrets as they were', () => {
    const out = run(
      { env, sec: [{ name: 'GOOGLE_OAUTH_CLIENT_ID', valueFrom: 'arn:new' }, { name: 'AI_CREDENTIALS_ENC_KEY', valueFrom: 'arn:key' }] },
      {
        containerDefinitions: [
          {
            environment: [
              { name: 'APP_URL', value: 'https://vitana.app' },
              { name: 'AI_CREDENTIALS_ENC_KEY', value: 'plain' },
              { name: 'KEEP', value: '1' },
            ],
            secrets: [
              { name: 'GOOGLE_OAUTH_CLIENT_ID', valueFrom: 'arn:old' },
              { name: 'MICROSOFT_OAUTH_CLIENT_ID', valueFrom: 'arn:keep' },
            ],
          },
        ],
      },
    );
    const c = out.containerDefinitions[0];
    expect(c.environment).toEqual([{ name: 'KEEP', value: '1' }, ...env]);
    expect(c.secrets).toEqual([
      { name: 'MICROSOFT_OAUTH_CLIENT_ID', valueFrom: 'arn:keep' },
      { name: 'GOOGLE_OAUTH_CLIENT_ID', valueFrom: 'arn:new' },
      { name: 'AI_CREDENTIALS_ENC_KEY', valueFrom: 'arn:key' },
    ]);
  });

  it('with no secrets provisioned, only pins the two URLs', () => {
    const out = run({ env, sec: [] }, { containerDefinitions: [{ environment: [], secrets: [{ name: 'X', valueFrom: 'a' }] }] });
    expect(out.containerDefinitions[0].environment).toEqual(env);
    expect(out.containerDefinitions[0].secrets).toEqual([{ name: 'X', valueFrom: 'a' }]);
  });
});
