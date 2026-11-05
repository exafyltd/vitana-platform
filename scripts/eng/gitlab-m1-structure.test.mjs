// Structure test for the self-hosted GitLab CI bundle of milestone 1 (plan eng-gitlab-m1, lane gitlab-infra).
//
// Reads the committed files under infra/gitlab-engineering/ and pins what the plan promises about them: no public IP,
// IMDSv2 only, encrypted storage, a load balancer as the only way in, a runner role that can read only its own token,
// secrets typed hidden, and central CI files that cannot run untrusted branches or deploy anything.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install (`node --test` over scripts/**/*.test.mjs).
// It is a structure test: it never calls AWS, GitLab or GitHub.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'gitlab-engineering');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const HOST_DIR = path.join(ROOT, 'host');

// The bundle is read when a case runs, never when the module loads, and a case reads only the names it destructures. On a tree
// without infra/gitlab-engineering (origin/main) every case therefore fails on its own with ENOENT instead of one crash hiding all 26.
const files = {
  get TF() { return read('terraform/main.tf'); },
  get SETUP() { return read('setup.sh'); },
  get CI() { return { platform: read('host/ci-platform.yml'), v1: read('host/ci-v1.yml') }; },
  get shellScripts() { return ['setup.sh', ...readdirSync(HOST_DIR).filter((f) => f.endsWith('.sh')).map((f) => `host/${f}`)]; },
};
const test = (name, fn) => nodeTest(name, () => fn(files));

/** Text of `<kind> "<label>" ... { ... }` found by brace matching (strings and comments skipped). */
function block(src, kind, ...labels) {
  const head = `^${kind}\\s+${labels.map((l) => `"${l}"`).join('\\s+')}\\s*\\{`;
  const m = new RegExp(head, 'm').exec(src);
  assert.ok(m, `${kind} ${labels.join('.')} not found in main.tf`);
  let depth = 0;
  let i = m.index + m[0].length - 1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) break;
  }
  return src.slice(m.index, i + 1);
}
const namesOf = (src, kind, type) => [...src.matchAll(new RegExp(`^${kind}\\s+"${type}"\\s+"([^"]+)"`, 'gm'))].map((m) => m[1]);
const stripComment = (line) => line.replace(/(^|\s)#.*$/, '');

// ------------------------------------------------------------------ Terraform
test('both machines: no public IP, IMDSv2 required with hop limit 1, encrypted root volume with the engineering key', ({ TF }) => {
  for (const name of ['gitlab', 'runner']) {
    const b = block(TF, 'resource', 'aws_instance', name);
    assert.match(b, /associate_public_ip_address\s*=\s*false/, `${name}: public IP`);
    assert.match(b, /http_endpoint\s*=\s*"enabled"/, `${name}: metadata endpoint`);
    assert.match(b, /http_tokens\s*=\s*"required"/, `${name}: IMDSv2`);
    assert.match(b, /http_put_response_hop_limit\s*=\s*1\b/, `${name}: hop limit`);
    const root = /root_block_device\s*\{([^}]*)\}/.exec(b);
    assert.ok(root, `${name}: root_block_device`);
    assert.match(root[1], /encrypted\s*=\s*true/, `${name}: volume encryption`);
    assert.match(root[1], /kms_key_id\s*=\s*aws_kms_key\.main\.arn/, `${name}: volume key`);
    assert.match(b, /subnet_id\s*=\s*aws_subnet\.private\[\d\]\.id/, `${name}: private subnet`);
  }
});

test('machine sizes are variables with the documented default', ({ TF }) => {
  for (const [machine, variable] of [['gitlab', 'gitlab_instance_type'], ['runner', 'runner_instance_type']]) {
    assert.match(block(TF, 'resource', 'aws_instance', machine), new RegExp(`instance_type\\s*=\\s*var\\.${variable}\\b`));
    assert.match(block(TF, 'variable', variable), /default\s*=\s*"m6i\.xlarge"/, `${variable} default`);
  }
});

test('volumes: 200 GB gp3 for GitLab, 100 GB gp3 for the runner', ({ TF }) => {
  for (const [machine, gigabytes] of [['gitlab', 200], ['runner', 100]]) {
    const root = /root_block_device\s*\{([^}]*)\}/.exec(block(TF, 'resource', 'aws_instance', machine))?.[1];
    assert.ok(root, `${machine}: root_block_device`);
    assert.match(root, /volume_type\s*=\s*"gp3"/, `${machine}: volume type`);
    assert.match(root, new RegExp(`volume_size\\s*=\\s*${gigabytes}\\b`), `${machine}: ${gigabytes} GB`);
  }
});

test('Terraform state: S3 backend with use_lockfile and encryption, supplied by setup.sh', ({ TF, SETUP }) => {
  assert.match(TF, /backend\s+"s3"\s*\{\s*\}/);
  assert.match(SETUP, /-backend-config="use_lockfile=true"/);
  assert.match(SETUP, /-backend-config="encrypt=true"/);
  assert.match(TF, /required_version\s*=\s*">= 1\.10\.0"/, 'use_lockfile needs Terraform 1.10 or newer');
  assert.match(TF, /version\s*=\s*">= 5\.60\.0, < 6\.0\.0"/, 'AWS provider 5.x');
});

test('backup bucket: KMS encryption, versioning, public access blocked, 30-day expiry, TLS only', ({ TF }) => {
  const sse = block(TF, 'resource', 'aws_s3_bucket_server_side_encryption_configuration', 'backups');
  assert.match(sse, /sse_algorithm\s*=\s*"aws:kms"/);
  assert.match(sse, /kms_master_key_id\s*=\s*aws_kms_key\.main\.arn/);
  assert.match(block(TF, 'resource', 'aws_s3_bucket_versioning', 'backups'), /status\s*=\s*"Enabled"/);
  const pab = block(TF, 'resource', 'aws_s3_bucket_public_access_block', 'backups');
  for (const k of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) {
    assert.match(pab, new RegExp(`${k}\\s*=\\s*true`), k);
  }
  assert.match(block(TF, 'resource', 'aws_s3_bucket_lifecycle_configuration', 'backups'), /expiration\s*\{\s*days\s*=\s*30\b/);
  const tls = block(TF, 'data', 'aws_iam_policy_document', 'backups_tls_only');
  assert.match(tls, /effect\s*=\s*"Deny"/);
  assert.match(tls, /aws:SecureTransport/);
  assert.match(TF, /bucket\s*=\s*local\.backup_bucket/);
  assert.match(TF, /backup_bucket\s*=\s*"vitana-engineering-gitlab-backups-\$\{data\.aws_caller_identity\.me\.account_id\}"/, 'bucket name carries the account id');
});

test('Secrets Manager: the three secrets use the engineering key and the documented names', ({ TF }) => {
  const expected = {
    root_password: 'vitana/engineering/gitlab/root-password',
    runner_token: 'vitana/engineering/gitlab/runner-token',
    github_token: 'vitana/engineering/gitlab/github-mirror-token',
  };
  assert.deepEqual(namesOf(TF, 'resource', 'aws_secretsmanager_secret').sort(), Object.keys(expected).sort(), 'no other secret');
  for (const [res, name] of Object.entries(expected)) {
    const b = block(TF, 'resource', 'aws_secretsmanager_secret', res);
    assert.ok(b.includes(`name                    = "${name}"`), `${res}: name`);
    assert.match(b, /kms_key_id\s*=\s*aws_kms_key\.main\.arn/, `${res}: key`);
  }
  const key = block(TF, 'resource', 'aws_kms_key', 'main');
  assert.match(key, /enable_key_rotation\s*=\s*true/);
  assert.match(block(TF, 'resource', 'aws_kms_alias', 'main'), /name\s*=\s*"alias\/vitana-engineering"/);
});

test('GitLab accepts only the load balancer; the runner accepts nothing; the load balancer accepts 443 only', ({ TF }) => {
  assert.equal(/^\s*ingress\s*\{/m.test(TF), false, 'no inline ingress blocks');
  assert.equal(/resource\s+"aws_security_group_rule"/.test(TF), false, 'no legacy rule resources');
  const byGroup = {};
  for (const name of namesOf(TF, 'resource', 'aws_vpc_security_group_ingress_rule')) {
    const b = block(TF, 'resource', 'aws_vpc_security_group_ingress_rule', name);
    const g = /security_group_id\s*=\s*aws_security_group\.(\w+)\.id/.exec(b)?.[1];
    assert.ok(g, `${name}: group`);
    (byGroup[g] ??= []).push({ name, b });
  }
  assert.deepEqual(Object.keys(byGroup).sort(), ['alb', 'gitlab'], 'ingress exists for the load balancer and GitLab only');
  assert.equal(byGroup.gitlab.length, 1);
  assert.match(byGroup.gitlab[0].b, /referenced_security_group_id\s*=\s*aws_security_group\.alb\.id/);
  assert.match(byGroup.gitlab[0].b, /from_port\s*=\s*80\b[\s\S]*to_port\s*=\s*80\b/);
  assert.equal(/cidr_ipv[46]/.test(byGroup.gitlab[0].b), false, 'GitLab ingress has no CIDR');
  assert.equal(byGroup.alb.length, 1);
  assert.match(byGroup.alb[0].b, /from_port\s*=\s*443\b[\s\S]*to_port\s*=\s*443\b/);
});

test('IAM: no wildcard action or resource, except the TLS-only deny on the backup bucket', ({ TF }) => {
  for (const doc of namesOf(TF, 'data', 'aws_iam_policy_document')) {
    const b = block(TF, 'data', 'aws_iam_policy_document', doc);
    assert.equal(/resources\s*=\s*\[[^\]]*"\*"\s*[\],]/.test(b), false, `${doc}: wildcard resource`);
    if (doc !== 'backups_tls_only') assert.equal(/actions\s*=\s*\[[^\]]*"[\w-]*:?\*"/.test(b), false, `${doc}: wildcard action`);
  }
  assert.equal(/"AWSAdministratorAccess"|AdministratorAccess|PowerUserAccess/.test(TF), false, 'no broad managed policy');
  const attached = [...TF.matchAll(/policy_arn\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(attached)], ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore'], 'only the SSM core policy is attached');
});

test('the runner role may read only its own registration token and use the key to decrypt it', ({ TF }) => {
  const b = block(TF, 'data', 'aws_iam_policy_document', 'runner');
  const statements = [...b.matchAll(/statement\s*\{([\s\S]*?)\n  \}/g)].map((m) => m[1]);
  assert.equal(statements.length, 2);
  const flat = statements.map((s) => ({
    actions: /actions\s*=\s*\[([^\]]*)\]/.exec(s)[1].replace(/\s/g, ''),
    resources: /resources\s*=\s*\[([^\]]*)\]/.exec(s)[1].replace(/\s/g, ''),
  }));
  assert.deepEqual(flat, [
    { actions: '"secretsmanager:GetSecretValue"', resources: 'aws_secretsmanager_secret.runner_token.arn' },
    { actions: '"kms:Decrypt"', resources: 'aws_kms_key.main.arn' },
  ]);
});

test('the GitLab role: backups bucket, writes only the two generated secrets, reads only the mirror token', ({ TF }) => {
  const b = block(TF, 'data', 'aws_iam_policy_document', 'gitlab');
  assert.match(b, /sid\s*=\s*"WriteGeneratedSecrets"[\s\S]*?"secretsmanager:PutSecretValue"[\s\S]*?resources\s*=\s*\[aws_secretsmanager_secret\.root_password\.arn, aws_secretsmanager_secret\.runner_token\.arn\]/);
  assert.match(b, /sid\s*=\s*"ReadMirrorToken"[\s\S]*?"secretsmanager:GetSecretValue"[\s\S]*?resources\s*=\s*\[aws_secretsmanager_secret\.github_token\.arn\]/);
  assert.equal(/secretsmanager:GetSecretValue[\s\S]{0,200}root_password/.test(b), false, 'GitLab cannot read the root password back');
});

test('load balancer: HTTPS 443 with the TLS 1.3 policy and no port-80 listener; health check on /users/sign_in', ({ TF }) => {
  assert.deepEqual(namesOf(TF, 'resource', 'aws_lb_listener'), ['https']);
  const l = block(TF, 'resource', 'aws_lb_listener', 'https');
  assert.match(l, /port\s*=\s*443\b/);
  assert.match(l, /protocol\s*=\s*"HTTPS"/);
  assert.match(l, /ssl_policy\s*=\s*"ELBSecurityPolicy-TLS13-1-2-2021-06"/);
  assert.match(block(TF, 'resource', 'aws_lb_target_group', 'gitlab'), /path\s*=\s*"\/users\/sign_in"/);
  const lb = block(TF, 'resource', 'aws_lb', 'gitlab');
  assert.match(lb, /internal\s*=\s*false/);
  assert.match(lb, /drop_invalid_header_fields\s*=\s*true/);
});

test('network: own VPC 10.20.0.0/16 in two availability zones, one NAT gateway, an S3 endpoint, no peering', ({ TF }) => {
  assert.match(TF, /vpc_cidr\s*=\s*"10\.20\.0\.0\/16"/);
  assert.match(TF, /azs\s*=\s*slice\(data\.aws_availability_zones\.az\.names, 0, 2\)/);
  assert.equal(namesOf(TF, 'resource', 'aws_nat_gateway').length, 1);
  assert.match(block(TF, 'resource', 'aws_vpc_endpoint', 's3'), /service_name\s*=\s*"com\.amazonaws\.\$\{var\.region\}\.s3"/);
  assert.equal(/aws_vpc_peering_connection|aws_ec2_transit_gateway|aws_vpn_/.test(TF), false, 'no link to the production network');
  assert.match(TF, /ubuntu\/server\/24\.04\/stable/);
});

test('every host file the machines are built from exists', ({ TF }) => {
  const found = /host_files\s*=\s*\[([^\]]*)\]/.exec(TF);
  assert.ok(found, 'host_files list not found in main.tf');
  const list = found[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1));
  assert.ok(list.length >= 6);
  for (const f of [...list, 'runner-install.sh']) assert.ok(existsSync(path.join(HOST_DIR, f)), `host/${f}`);
});

// -------------------------------------------------------------------- scripts
test('every shell script passes bash -n', ({ shellScripts }) => {
  assert.ok(shellScripts.length >= 7, `setup.sh and the six host scripts, found ${shellScripts.length}`);
  for (const f of shellScripts) {
    assert.match(read(f), /^#!\/bin\/bash\n/, `${f}: a bash script (an empty file would pass bash -n)`);
    const r = spawnSync('bash', ['-n', path.join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('no script turns on xtrace (it would write secrets into logs)', ({ shellScripts }) => {
  assert.ok(shellScripts.length >= 7, `setup.sh and the six host scripts, found ${shellScripts.length}`);
  for (const f of shellScripts) {
    assert.match(read(f), /^#!\/bin\/bash\n/, `${f}: a bash script (an empty file has no xtrace either)`);
    for (const [i, raw] of read(f).split('\n').entries()) {
      const line = stripComment(raw);
      assert.equal(/\bset\s+-[A-Za-z]*x|\bset\s+-o\s+xtrace|\bbash\s+-[A-Za-z]*x\b/.test(line), false, `${f}:${i + 1}`);
    }
  }
});

test('the Cloudflare token is typed hidden, handed to curl on stdin, and used nowhere else', ({ SETUP }) => {
  assert.match(SETUP, /read -rsp "Cloudflare API token: " CF_TOKEN/);
  const allowed = [
    /^CF_TOKEN="\$\{CLOUDFLARE_API_TOKEN:-\}"$/,
    /^printf 'header = "Authorization: Bearer %s"\\n' "\$CF_TOKEN" \| curl [^|>]*--config - /,
    /^if \[ -z "\$CF_TOKEN" \] && \[ "\$CF_ASKED" = 0 \]; then$/,
    /^read -rsp "Cloudflare API token: " CF_TOKEN; echo$/,
    /^\[ -n "\$CF_TOKEN" \] \|\| return 1$/,
    /^CF_TOKEN=""$/,
  ];
  const uses = SETUP.split('\n').map((l) => l.trim()).filter((l) => /CF_TOKEN/.test(stripComment(l)));
  assert.ok(uses.length >= 5);
  for (const l of uses) assert.ok(allowed.some((re) => re.test(l)), `unreviewed use of the Cloudflare token: ${l}`);
});

test('the GitHub mirror token is typed hidden and goes to Secrets Manager only', ({ SETUP }) => {
  assert.match(SETUP, /read -rsp "Paste the token \(Enter to skip for now\): " t/);
  const puts = SETUP.split('\n').filter((l) => /put-secret-value/.test(l) && /github-mirror-token/.test(l));
  assert.equal(puts.length, 1);
  assert.match(puts[0], /--secret-string "\$t"/);
  // The variable is read in exactly two lines: the emptiness test and the one put-secret-value call, which does nothing else
  // with it (no second command, no `$` in the messages it prints).
  const allowed = [
    /^if \[ -n "\$t" \]; then$/,
    /^aws secretsmanager put-secret-value --secret-id vitana\/engineering\/gitlab\/github-mirror-token --secret-string "\$t" >\/dev\/null && echo "[^"$`\\]*" \|\| echo "[^"$`\\]*"$/,
  ];
  const uses = SETUP.split('\n').map((l) => l.trim()).filter((l) => /\$t\b|\$\{t\}/.test(stripComment(l)));
  assert.equal(uses.length, allowed.length, `the GitHub token is read in ${uses.length} lines: ${uses.join(' | ')}`);
  for (const l of uses) assert.ok(allowed.some((re) => re.test(l)), `unreviewed use of the GitHub token: ${l}`);
});

test('setup.sh exports AWS_REGION as well as AWS_DEFAULT_REGION (CloudShell sets AWS_REGION and the CLI prefers it)', ({ SETUP }) => {
  assert.match(SETUP, /^export AWS_PAGER="" AWS_REGION=eu-central-1 AWS_DEFAULT_REGION=eu-central-1$/m);
});

test('files that hold a secret on a machine are created with umask 077; the mirror scrubs credentials from git output', () => {
  const cfg = read('host/gitlab-configure.sh');
  assert.match(cfg, /\(umask 077; echo "\$PAT" > "\$PAT_FILE"\)/);
  assert.match(cfg, /\(umask 077; echo "\$MT" > \/etc\/vitana\/mirror-token\)/);
  assert.match(cfg, /expires_at: 7\.days\.from_now/, 'the bootstrap admin token expires');
  const mirror = read('host/mirror.sh');
  assert.match(mirror, /scrub\(\) \{ sed -e "s\/\$GH\/\*\*\*\/g" -e "s\/\$GL\/\*\*\*\/g"; \}/);
  const gitLines = mirror.split('\n').filter((l) => /git -C "\$d" (fetch|push)/.test(l));
  assert.equal(gitLines.length, 3);
  for (const l of gitLines) assert.match(l, /\| scrub/, 'git output goes through scrub');
});

test('instance settings: sign-up off, two-factor required, usage ping off, private by default', () => {
  const cfg = read('host/gitlab-configure.sh');
  for (const s of ['signup_enabled=false', 'require_two_factor_authentication=true', 'two_factor_grace_period=48', 'usage_ping_enabled=false', 'default_project_visibility=private', 'default_group_visibility=private']) {
    assert.ok(cfg.includes(s), s);
  }
  const install = read('host/gitlab-install.sh');
  assert.match(install, /external_url 'https:\/\/\$DOMAIN'/);
  assert.match(install, /\['nginx'\]\['listen_port'\] = 80/);
  assert.match(install, /\['nginx'\]\['listen_https'\] = false/);
  assert.match(install, /fallocate -l 4G \/swapfile/);
});

test('the nightly backup runs at 02:15 UTC, encrypted copy to the backup bucket', () => {
  assert.match(read('host/gitlab-configure.sh'), /'15 2 \* \* \* root \/opt\/vitana\/backup\.sh/);
  const b = read('host/backup.sh');
  assert.match(b, /^set -euo pipefail$/m, 'a failed step must fail the backup');
  assert.match(b, /gitlab-backup create CRON=1 STRATEGY=copy/);
  assert.match(b, /^aws s3 cp "\$latest" "s3:\/\/\$BACKUP_BUCKET\/backups\/\$\(basename "\$latest"\)"$/m, 'the backup archive is uploaded');
  assert.match(b, /^tar -czf "\/tmp\/gitlab-config-\$d\.tgz" -C \/ etc\/gitlab$/m, 'etc/gitlab (gitlab-secrets.json, which a restore needs) is archived');
  assert.match(b, /^aws s3 cp "\/tmp\/gitlab-config-\$d\.tgz" "s3:\/\/\$BACKUP_BUCKET\/config\/gitlab-config-\$d\.tgz"$/m, 'the configuration archive is uploaded');
});

// ----------------------------------------------------------------- central CI

test('central CI: only main and manual, API or schedule runs; stage check only', ({ CI }) => {
  for (const [name, y] of Object.entries(CI)) {
    const rules = /workflow:\s*\n\s*rules:\n((?:\s+- if: .*\n)+)/.exec(y)?.[1];
    assert.ok(rules, `${name}: workflow rules`);
    assert.deepEqual(rules.trim().split('\n').map((l) => l.trim()), [
      '- if: $CI_COMMIT_BRANCH == "main"',
      '- if: $CI_PIPELINE_SOURCE =~ /^(web|api|schedule)$/',
    ], `${name}: rules`);
    assert.match(y, /^stages: \[check\]$/m, `${name}: stages`);
    assert.equal(/merge_request_event|CI_MERGE_REQUEST|when:\s*(always|manual)/.test(y), false, `${name}: other triggers`);
  }
});

test('central CI: every job runs on the vitana-eng runner; no AWS credential, no deploy', ({ CI }) => {
  for (const [name, y] of Object.entries(CI)) {
    assert.match(y, /^default:\n  tags: \[vitana-eng\]$/m, `${name}: default tag`);
    const tags = y.split('\n').filter((l) => /^\s*tags:/.test(l));
    assert.ok(tags.every((l) => l.trim() === 'tags: [vitana-eng]'), `${name}: a job overrides the tag`);
    const code = y.split('\n').map(stripComment).join('\n');
    assert.equal(/\bAWS_[A-Z_]+|\baws\s+(sts|s3|ecr|ssm|secretsmanager|ecs)\b|assume-?role|id_tokens|\benvironment:/i.test(code), false, `${name}: AWS or environment`);
    assert.equal(/^\s*deploy[\w:-]*:/m.test(code) || /\bkubectl\b|\bterraform\s+apply\b/.test(code), false, `${name}: deploy`);
    assert.match(y, /image: public\.ecr\.aws\/docker\/library\/node:20-bookworm/);
  }
});

/** Lines of the `script:` list of one job, comments dropped. */
function jobScript(y, job) {
  const m = new RegExp(`^${job}:\\n((?:  .*\\n|\\n)*)`, 'm').exec(y);
  assert.ok(m, `job ${job} not found`);
  const body = m[1];
  const s = /^  script:\n((?:    .*\n|\n)*)/m.exec(body);
  assert.ok(s, `job ${job}: script`);
  return s[1].split('\n').map(stripComment).map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2));
}

test('central CI platform: gateway type check and four Jest shards with pnpm 9.0.0 (as CICDL-GATEWAY-CI and TEST-SUITE)', ({ CI }) => {
  const y = CI.platform;
  assert.match(y, /npm install -g pnpm@9\.0\.0/);
  const before = /^\.gateway:\n[\s\S]*?before_script:\n((?:    - .*\n)+)/m.exec(y)[1];
  assert.match(before, /- cd services\/gateway/);
  assert.equal(/npm ci|pnpm install/.test(before), false, 'the install is explicit in each job, not shared');
  // CICDL-GATEWAY-CI.yml:86-92: the gateway is installed with npm ci and only the script runs through pnpm. A pnpm install here
  // fails the type check with TS2664 on two `declare module 'express-serve-static-core'` blocks (checked on the base commit).
  assert.deepEqual(jobScript(y, 'typecheck'), ['npm ci --no-audit --no-fund', 'pnpm run typecheck']);
  // TEST-SUITE.yml:68-75: pnpm install --frozen-lockfile in services/gateway, then the shard.
  assert.deepEqual(jobScript(y, 'gateway-jest'), [
    'pnpm install --frozen-lockfile',
    'npx jest --silent --maxWorkers=2 --shard=$CI_NODE_INDEX/$CI_NODE_TOTAL',
  ]);
  assert.match(y, /^gateway-jest:[\s\S]*?parallel: 4\b/m);
  assert.match(y, /^typecheck:[\s\S]*?NODE_OPTIONS: "--max-old-space-size=6144"/m);
  assert.equal(/prisma/i.test(y), false, 'no Prisma step: the gateway type check does not import @prisma/client');
});

test('central CI vitana-v1: npm test and npm run build gate the pipeline; lint is reported only', ({ CI }) => {
  const y = CI.v1;
  assert.match(y, /npm ci --no-audit --no-fund --prefer-offline/);
  assert.match(y, /^unit-tests:[\s\S]*?script:\n\s+- npm test\n/m);
  assert.match(y, /^build:[\s\S]*?script:\n\s+- npm run build\n/m);
  assert.match(y, /^lint:[\s\S]*?allow_failure: true[\s\S]*?- npm run lint/m);
  assert.equal((y.match(/allow_failure:/g) ?? []).length, 1, 'lint is the only job allowed to fail');
});

test('RUNBOOK section 6 embeds the platform central CI file exactly', () => {
  const md = read('RUNBOOK.md');
  const m = /Step 0[\s\S]*?```yaml\n([\s\S]*?)\n```/.exec(md);
  assert.ok(m, 'the yaml block of step 0');
  assert.equal(m[1], read('host/ci-platform.yml').replace(/\n+$/, ''), 'the RUNBOOK copy differs from host/ci-platform.yml');
});
