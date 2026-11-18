// Structure test for the autoscaling CI fleet of milestone 2 (plan eng-gitlab-m2, lane fleet, plan section 3.2).
//
// Reads the committed files of the lane under infra/gitlab-engineering/ and pins what the plan promises about them: a group that
// grows from zero and returns to zero, one job per throw-away machine, machines that hold no AWS permission and no secret, a manager
// whose role lists exactly the plan's actions, a config.toml with the plan's values, a quota check that prints the exact commands,
// and an image build whose failure stops the apply before any fleet exists.
// The config.toml is rendered by host/fleet-manager-install.sh --render-config through child_process (no network, no AWS, no root).
// Dependency-free Node (node:test), so UNIT.yml runs it with no install (`node --test` over scripts/**/*.test.mjs).
// It never calls AWS, GitLab or GitHub.
import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'infra', 'gitlab-engineering');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const INSTALL_SH = path.join(ROOT, 'host', 'fleet-manager-install.sh');

// Files are read when a case runs, never when the module loads, and a case reads only the names it destructures. On a tree without
// the lane's files every case therefore fails on its own with ENOENT instead of one crash hiding all of them.
const files = {
  get MAIN() { return read('terraform/main.tf'); },
  get FLEET() { return read('terraform/fleet.tf'); },
  get AMI() { return read('terraform/fleet-ami.tf'); },
  get TF() { return `${read('terraform/fleet.tf')}\n${read('terraform/fleet-ami.tf')}`; },
  get COMPONENT() { return read('host/fleet-image/component.yml'); },
  get INSTALL() { return read('host/fleet-manager-install.sh'); },
  get RUNBOOK() { return read('RUNBOOK-m2-fleet.md'); },
};
const test = (name, fn) => nodeTest(name, () => fn(files));

// ------------------------------------------------------------------ HCL helpers
/** Index of the brace that closes the one at `open`; strings and # comments are skipped (no double quote inside ${} in the files). */
function closeOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') { i++; while (i < src.length && src[i] !== '"') { if (src[i] === '\\') i++; i++; } continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  throw new Error('unbalanced braces');
}
/** Text of `<kind> "<label>" ... { ... }` found by brace matching. */
function block(src, kind, ...labels) {
  const head = `^${kind}\\s+${labels.map((l) => `"${l}"`).join('\\s+')}\\s*\\{`;
  const m = new RegExp(head, 'm').exec(src);
  assert.ok(m, `${kind} ${labels.join('.')} not found`);
  return src.slice(m.index, closeOf(src, m.index + m[0].length - 1) + 1);
}
const has = (src, kind, ...labels) => new RegExp(`^${kind}\\s+${labels.map((l) => `"${l}"`).join('\\s+')}\\s*\\{`, 'm').test(src);
/** Bodies of every nested `name { ... }` (any depth) inside a block text. */
function subs(src, name) {
  const out = [];
  const re = new RegExp(`(^|[\\s{])${name}\\s*\\{`, 'g');
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1;
    out.push(src.slice(open, closeOf(src, open) + 1));
    re.lastIndex = open + 1;
  }
  return out;
}
const namesOf = (src, kind, type) => [...src.matchAll(new RegExp(`^${kind}\\s+"${type}"\\s+"([^"]+)"`, 'gm'))].map((m) => m[1]);
const str = (src, key) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm').exec(src)?.[1];
const raw = (src, key) => new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*$`, 'm').exec(src)?.[1];
const strList = (text) => (text.match(/"[^"]*"/g) ?? []).map((s) => s.slice(1, -1));
const stripComment = (line) => line.replace(/(^|\s)#.*$/, '');
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Every security group rule resource of the fleet files, parsed. */
function sgRules(TF) {
  const out = [];
  for (const kind of ['ingress', 'egress']) {
    const type = `aws_vpc_security_group_${kind}_rule`;
    for (const name of namesOf(TF, 'resource', type)) {
      const b = block(TF, 'resource', type, name);
      const group = /security_group_id\s*=\s*aws_security_group\.(\w+)\.id/.exec(b)?.[1];
      assert.ok(group, `${name}: security_group_id`);
      out.push({
        kind, name, group,
        proto: str(b, 'ip_protocol'),
        from: raw(b, 'from_port'),
        to: raw(b, 'to_port'),
        cidr: raw(b, 'cidr_ipv4'),
        ref: /referenced_security_group_id\s*=\s*aws_security_group\.(\w+)\.id/.exec(b)?.[1],
      });
    }
  }
  return out;
}
const shape = (r) => `${r.proto}/${r.from}-${r.to} -> ${r.ref ? `group:${r.ref}` : r.cidr}`;

/** Statements of an aws_iam_policy_document block. */
function statements(doc) {
  return subs(doc, 'statement').map((s) => ({
    sid: str(s, 'sid'),
    effect: str(s, 'effect') ?? 'Allow',
    actions: strList(/actions\s*=\s*\[([^\]]*)\]/.exec(s)?.[1] ?? ''),
    resources: (/resources\s*=\s*\[([^\]]*)\]/.exec(s)?.[1] ?? '').replace(/\s+/g, ' ').trim(),
    condition: subs(s, 'condition').map((c) => c.replace(/\s+/g, ' ')).join(' | '),
  }));
}

// ----------------------------------------------------------------- TOML helper
/** A small reader for the subset of TOML the rendered config.toml uses (tables, arrays of tables, strings, integers, booleans, string arrays). */
function parseToml(text) {
  const root = {};
  let cur = root;
  const walk = (parts, last) => {
    let o = root;
    parts.forEach((p, k) => {
      if (k === parts.length - 1) last(o, p);
      else o = Array.isArray(o[p]) ? o[p].at(-1) : (o[p] ??= {});
    });
  };
  text.split('\n').forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) return;
    let m;
    if ((m = /^\[\[([A-Za-z0-9_.]+)\]\]$/.exec(line))) {
      walk(m[1].split('.'), (o, p) => { (o[p] ??= []).push((cur = {})); });
    } else if ((m = /^\[([A-Za-z0-9_.]+)\]$/.exec(line))) {
      walk(m[1].split('.'), (o, p) => {
        const t = Array.isArray(o[p]) ? o[p].at(-1) : o[p];
        assert.equal(Array.isArray(o[p]) || o[p] === undefined, o[p] === undefined || Array.isArray(o[p]), 'table');
        cur = t ?? (o[p] = {});
      });
    } else if ((m = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line))) {
      assert.equal(m[1] in cur, false, `config.toml line ${i + 1}: key ${m[1]} is set twice in one table`);
      const v = m[2].trim();
      if (/^"(?:[^"\\]|\\.)*"$/.test(v)) cur[m[1]] = JSON.parse(v);
      else if (v === 'true' || v === 'false') cur[m[1]] = v === 'true';
      else if (/^-?\d+$/.test(v)) cur[m[1]] = Number(v);
      else if (/^\[[^\]]*\]$/.test(v)) cur[m[1]] = JSON.parse(v);
      else assert.fail(`config.toml line ${i + 1}: value I do not understand: ${v}`);
    } else {
      assert.fail(`config.toml line ${i + 1} is not TOML I understand: ${line}`);
    }
  });
  return root;
}

// The token is built at run time so that no token-looking literal sits in this file (the secret scan looks for them).
const FAKE_TOKEN = ['glrt', 't1_TESTONLY'].join('-');
const FIXED = {
  DOMAIN: 'gitlab.vitanaland.com',
  REGION: 'eu-central-1',
  FLEET_ASG_NAME: 'vitana-eng-fleet',
  FLEET_MAX_INSTANCES: '24',
  FLEET_IDLE_COUNT: '0',
  FLEET_CACHE_BUCKET: 'vitana-engineering-ci-cache-111122223333',
  FLEET_CACHE_KMS_KEY_ARN: 'arn:aws:kms:eu-central-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab',
  FLEET_RUNNER_TOKEN: FAKE_TOKEN,
};
/** Runs the installer in render mode: environment in, config.toml text out. No network, no file read, no root. */
function render(env = {}) {
  const e = { PATH: process.env.PATH, LANG: 'C', ...FIXED, ...env };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync('bash', [INSTALL_SH, '--render-config'], { encoding: 'utf8', env: e, timeout: 20000 });
}
const rendered = (env) => {
  const r = render(env);
  assert.equal(r.status, 0, `render failed (${r.status}): ${r.stderr}`);
  return { text: r.stdout, toml: parseToml(r.stdout) };
};

const M1_VARIABLES = ['region', 'domain', 'certificate_arn', 'gitlab_version', 'runner_version', 'admin_email', 'gitlab_instance_type', 'runner_instance_type'];
const FLEET_TYPES = ['m6i.xlarge', 'm6a.xlarge', 'm5.xlarge', 'm5a.xlarge'];
const FLEET_TOKEN_NAME = 'vitana/engineering/gitlab/fleet-runner-token';

// ===================================================================== group
test('ASG vitana-eng-fleet: min 0, desired 0 (later changes ignored: the runner sets it), max fleet_max_instances, nothing else scales it', ({ FLEET }) => {
  const asg = block(FLEET, 'resource', 'aws_autoscaling_group', 'fleet');
  assert.equal(str(FLEET, 'fleet_asg_name'), 'vitana-eng-fleet', 'the group name of plan 3.2');
  assert.match(asg, /\bname\s*=\s*local\.fleet_asg_name\b/);
  assert.match(asg, /\bmin_size\s*=\s*0\b/);
  assert.match(asg, /\bdesired_capacity\s*=\s*0\b/);
  assert.match(asg, /\bmax_size\s*=\s*var\.fleet_max_instances\b/);
  const lifecycle = subs(asg, 'lifecycle').join('\n');
  assert.match(lifecycle, /ignore_changes\s*=\s*\[\s*desired_capacity\s*\]/, 'Terraform must never reset the desired size the runner sets');
  assert.equal(/ignore_changes[^\]]*\b(min_size|max_size)\b/.test(lifecycle), false, 'only desired_capacity is ignored');
  for (const type of ['aws_autoscaling_policy', 'aws_autoscaling_schedule', 'aws_appautoscaling_policy', 'aws_appautoscaling_target', 'aws_autoscaling_lifecycle_hook', 'aws_autoscaling_warm_pool']) {
    assert.deepEqual(namesOf(FLEET, 'resource', type), [], `${type}: the runner is the only thing that scales the group (scaling policy none)`);
  }
  assert.equal(/\btarget_tracking_configuration\b|\bpredictive_scaling\b|\bwarm_pool\b/.test(FLEET), false);
});

test('ASG: AZRebalance suspended, scale-in protection on, capacity rebalance off, forced delete so protected machines cannot block a destroy', ({ FLEET }) => {
  const asg = block(FLEET, 'resource', 'aws_autoscaling_group', 'fleet');
  assert.match(asg, /suspended_processes\s*=\s*\[\s*"AZRebalance"\s*\]/, 'exactly AZRebalance');
  assert.match(asg, /protect_from_scale_in\s*=\s*true\b/);
  assert.match(asg, /capacity_rebalance\s*=\s*false\b/);
  assert.match(asg, /force_delete\s*=\s*true\b/);
  assert.match(asg, /vpc_zone_identifier\s*=\s*aws_subnet\.private\[\*\]\.id/, 'the private subnets of M1, never a public one');
  assert.equal(/aws_subnet\.public/.test(asg), false);
  assert.match(asg, /health_check_type\s*=\s*"EC2"/);
});

test('ASG: mixed instances m6i, m6a, m5 and m5a .xlarge; spot share from fleet_spot_percent; the custom service-linked role', ({ FLEET }) => {
  const asg = block(FLEET, 'resource', 'aws_autoscaling_group', 'fleet');
  const locals = subs(FLEET, 'locals').join('\n');
  const types = strList(/fleet_instance_types\s*=\s*\[([^\]]*)\]/.exec(locals)?.[1] ?? '');
  assert.deepEqual(types, FLEET_TYPES, 'the four machine types of plan 3.2, in this order');
  const mixed = subs(asg, 'mixed_instances_policy').join('\n');
  assert.match(mixed, /for_each\s*=\s*local\.fleet_instance_types\b/, 'one override per machine type');
  assert.match(mixed, /instance_type\s*=\s*override\.value\b/);
  const dist = subs(mixed, 'instances_distribution').join('\n');
  assert.match(dist, /on_demand_base_capacity\s*=\s*0\b/);
  assert.match(dist, /on_demand_percentage_above_base_capacity\s*=\s*100\s*-\s*var\.fleet_spot_percent\b/, 'the spot share is fleet_spot_percent');
  assert.match(dist, /spot_allocation_strategy\s*=\s*"price-capacity-optimized"/, 'the strategy AWS recommends for short jobs');
  assert.match(mixed, /launch_template_id\s*=\s*aws_launch_template\.fleet\.id/);
  assert.match(asg, /service_linked_role_arn\s*=\s*aws_iam_service_linked_role\.fleet_autoscaling\.arn/, 'the role that holds the key grant');
});

test('fleet variables: documented defaults and validation; none of the M1 variables is declared again; every one has a default', ({ MAIN, FLEET, AMI }) => {
  const mine = [...new Set([...FLEET.matchAll(/^variable\s+"(\w+)"/gm), ...AMI.matchAll(/^variable\s+"(\w+)"/gm)].map((m) => m[1]))];
  const m1 = [...MAIN.matchAll(/^variable\s+"(\w+)"/gm)].map((m) => m[1]);
  assert.deepEqual(m1.filter((v) => M1_VARIABLES.includes(v)).sort(), [...M1_VARIABLES].sort(), 'main.tf still declares the variables setup.sh passes');
  for (const v of M1_VARIABLES) assert.equal(mine.includes(v), false, `${v} belongs to M1 and is not declared again`);
  assert.ok(mine.includes('fleet_max_instances') && mine.includes('fleet_idle_count') && mine.includes('fleet_spot_percent'), `found ${mine}`);
  const text = `${FLEET}\n${AMI}`;
  for (const v of mine) assert.match(block(text, 'variable', v), /\bdefault\s*=/, `${v}: setup.sh passes no new -var flag, so every variable needs a default`);
  assert.match(block(text, 'variable', 'fleet_max_instances'), /default\s*=\s*24\b/);
  assert.match(block(text, 'variable', 'fleet_idle_count'), /default\s*=\s*0\b/);
  assert.match(block(text, 'variable', 'fleet_spot_percent'), /default\s*=\s*80\b/);
  for (const v of ['fleet_max_instances', 'fleet_idle_count', 'fleet_spot_percent']) {
    assert.match(block(text, 'variable', v), /validation\s*\{/, `${v}: validated`);
    assert.match(block(text, 'variable', v), /type\s*=\s*number/, `${v}: a number`);
  }
});

// ============================================================ launch template
test('launch template: 100 GB encrypted gp3 with the M1 key, no public IP, IMDSv2 required with hop limit 1, the job group and the job profile', ({ FLEET }) => {
  const lt = block(FLEET, 'resource', 'aws_launch_template', 'fleet');
  const ebs = subs(lt, 'ebs').join('\n');
  assert.match(ebs, /volume_type\s*=\s*"gp3"/);
  assert.match(ebs, /volume_size\s*=\s*100\b/);
  assert.match(ebs, /encrypted\s*=\s*true\b/);
  assert.match(ebs, /kms_key_id\s*=\s*aws_kms_key\.main\.arn/, 'the key of M1, by reference');
  assert.match(ebs, /delete_on_termination\s*=\s*true\b/);
  const nic = subs(lt, 'network_interfaces').join('\n');
  assert.match(nic, /associate_public_ip_address\s*=\s*false\b/);
  assert.match(nic, /security_groups\s*=\s*\[\s*aws_security_group\.fleet_job\.id\s*\]/, 'only the job group');
  const imds = subs(lt, 'metadata_options').join('\n');
  assert.match(imds, /http_endpoint\s*=\s*"enabled"/);
  assert.match(imds, /http_tokens\s*=\s*"required"/);
  assert.match(imds, /http_put_response_hop_limit\s*=\s*1\b/, 'a job container cannot reach the metadata service');
  assert.match(subs(lt, 'iam_instance_profile').join('\n'), /name\s*=\s*aws_iam_instance_profile\.fleet_job\.name/);
  assert.match(lt, /image_id\s*=\s*one\(aws_imagebuilder_image\.fleet\.output_resources\[0\]\.amis\)\.image/, 'the AMI Image Builder built');
  assert.equal(/instance_market_options|\bkey_name\b|\buser_data\b/.test(lt), false, 'spot is the group policy; no key pair; nothing is injected at boot');
});

test('the job instance profile has no policy of any kind, and nothing else uses its role', ({ TF }) => {
  const role = block(TF, 'resource', 'aws_iam_role', 'fleet_job');
  assert.match(role, /name\s*=\s*"vitana-eng-fleet-job"/);
  assert.match(role, /assume_role_policy\s*=\s*data\.aws_iam_policy_document\.ec2_assume\.json/, 'the EC2 trust document of M1');
  const profile = block(TF, 'resource', 'aws_iam_instance_profile', 'fleet_job');
  assert.match(profile, /role\s*=\s*aws_iam_role\.fleet_job\.name/);
  assert.equal(/aws_iam_role\.fleet_job\.(name|id|arn)/.test(TF.replace(profile, '')), false, 'only the profile refers to the job role');
  for (const m of TF.matchAll(/^resource\s+"(aws_iam_role_policy|aws_iam_role_policy_attachment|aws_iam_policy_attachment|aws_iam_user_policy_attachment)"\s+"(\w+)"/gm)) {
    assert.equal(/fleet_job\b/.test(block(TF, 'resource', m[1], m[2])), false, `${m[1]}.${m[2]} must not attach anything to the job role`);
  }
  assert.equal(/permissions_boundary|inline_policy|managed_policy_arns/.test(role), false);
});

// ============================================================ security groups
test('job group: tcp 22 in from the manager group only; out only tcp 80, tcp 443 and DNS (tcp and udp 53, inside the VPC)', ({ TF }) => {
  const g = block(TF, 'resource', 'aws_security_group', 'fleet_job');
  assert.match(g, /name\s*=\s*"vitana-eng-fleet-job"/);
  assert.match(g, /vpc_id\s*=\s*aws_vpc\.main\.id/);
  const mine = sgRules(TF).filter((r) => r.group === 'fleet_job');
  assert.deepEqual(mine.filter((r) => r.kind === 'ingress').map(shape), ['tcp/22-22 -> group:fleet_manager']);
  assert.deepEqual(mine.filter((r) => r.kind === 'egress').map(shape).sort(), [
    'tcp/443-443 -> "0.0.0.0/0"', 'tcp/53-53 -> local.vpc_cidr', 'tcp/80-80 -> "0.0.0.0/0"', 'udp/53-53 -> local.vpc_cidr',
  ]);
});

test('manager group: nothing comes in; out only tcp 22 to the job group, tcp 80, tcp 443 and DNS', ({ TF }) => {
  const g = block(TF, 'resource', 'aws_security_group', 'fleet_manager');
  assert.match(g, /name\s*=\s*"vitana-eng-fleet-manager"/);
  assert.match(g, /vpc_id\s*=\s*aws_vpc\.main\.id/);
  const mine = sgRules(TF).filter((r) => r.group === 'fleet_manager');
  assert.deepEqual(mine.filter((r) => r.kind === 'ingress'), [], 'no inbound rule at all');
  assert.deepEqual(mine.filter((r) => r.kind === 'egress').map(shape).sort(), [
    'tcp/22-22 -> group:fleet_job', 'tcp/443-443 -> "0.0.0.0/0"', 'tcp/53-53 -> local.vpc_cidr', 'tcp/80-80 -> "0.0.0.0/0"', 'udp/53-53 -> local.vpc_cidr',
  ]);
});

test('no 0.0.0.0/0 or ::/0 ingress anywhere, no inline rules, no legacy rule resources, only the two fleet groups exist', ({ TF }) => {
  assert.equal(/^\s*ingress\s*\{/m.test(TF), false, 'no inline ingress blocks');
  assert.equal(/^\s*egress\s*\{/m.test(TF), false, 'no inline egress blocks');
  assert.equal(/resource\s+"aws_security_group_rule"/.test(TF), false);
  const rules = sgRules(TF);
  assert.ok(rules.length >= 10, `rules found: ${rules.length}`);
  for (const r of rules.filter((x) => x.kind === 'ingress')) {
    assert.equal(r.cidr, undefined, `${r.name}: an ingress rule names a group, never an address range`);
    assert.ok(r.ref, `${r.name}: ingress from a group`);
  }
  assert.equal(/cidr_ipv6|::\/0/.test(TF), false, 'no IPv6 anywhere');
  assert.deepEqual(namesOf(TF, 'resource', 'aws_security_group').sort(), ['fleet_job', 'fleet_manager']);
  for (const r of rules) assert.notEqual(r.proto, '-1', `${r.name}: no all-protocol rule`);
});

// ================================================================== manager
test('manager machine: t3.medium in a private subnet, no public IP, IMDSv2 hop limit 1, encrypted root with the M1 key, its own group and profile', ({ FLEET }) => {
  const b = block(FLEET, 'resource', 'aws_instance', 'fleet_manager');
  assert.match(b, /instance_type\s*=\s*"t3\.medium"/);
  assert.match(b, /ami\s*=\s*data\.aws_ssm_parameter\.ubuntu\.value/, 'the Ubuntu 24.04 data source of M1');
  assert.match(b, /subnet_id\s*=\s*aws_subnet\.private\[\d\]\.id/);
  assert.match(b, /associate_public_ip_address\s*=\s*false\b/);
  assert.match(b, /vpc_security_group_ids\s*=\s*\[\s*aws_security_group\.fleet_manager\.id\s*\]/);
  assert.match(b, /iam_instance_profile\s*=\s*aws_iam_instance_profile\.fleet_manager\.name/);
  const imds = subs(b, 'metadata_options').join('\n');
  assert.match(imds, /http_tokens\s*=\s*"required"/);
  assert.match(imds, /http_put_response_hop_limit\s*=\s*1\b/);
  const root = subs(b, 'root_block_device').join('\n');
  assert.match(root, /encrypted\s*=\s*true\b/);
  assert.match(root, /kms_key_id\s*=\s*aws_kms_key\.main\.arn/);
  assert.match(root, /volume_type\s*=\s*"gp3"/);
  assert.match(b, /user_data_base64\s*=\s*sensitive\(base64gzip\(local\.fleet_manager_userdata\)\)/);
  assert.equal(/\bkey_name\b/.test(b), false, 'no stored SSH key');
  assert.match(b, /Name\s*=\s*"vitana-eng-fleet-manager"/);
});

test('manager starts only after the group exists, so a failed image build leaves no manager and no group', ({ FLEET }) => {
  const b = block(FLEET, 'resource', 'aws_instance', 'fleet_manager');
  const deps = /depends_on\s*=\s*\[([^\]]*)\]/.exec(b)?.[1] ?? '';
  for (const d of ['aws_autoscaling_group.fleet', 'aws_iam_role_policy.fleet_manager', 'aws_secretsmanager_secret.fleet_runner_token', 'aws_nat_gateway.nat', 'aws_route_table_association.private']) {
    assert.ok(deps.includes(d), `the manager depends on ${d}`);
  }
  const asg = block(FLEET, 'resource', 'aws_autoscaling_group', 'fleet');
  const asgDeps = /depends_on\s*=\s*\[([^\]]*)\]/.exec(asg)?.[1] ?? '';
  for (const d of ['terraform_data.fleet_quota_check', 'aws_kms_grant.fleet_autoscaling', 'aws_kms_grant.fleet_spot']) {
    assert.ok(asgDeps.includes(d), `the group depends on ${d}`);
  }
  assert.match(block(FLEET, 'resource', 'aws_launch_template', 'fleet'), /aws_imagebuilder_image\.fleet/, 'the group needs the finished image through its launch template');
});

test('manager user data: env file, the installer, output to /var/log/vitana-bootstrap.log; carries no secret', ({ FLEET }) => {
  const locals = subs(FLEET, 'locals').join('\n');
  const ud = /fleet_manager_userdata\s*=\s*join\(/.exec(locals) ? locals.slice(locals.indexOf('fleet_manager_userdata')) : '';
  assert.ok(ud, 'local.fleet_manager_userdata');
  assert.match(ud, /#!\/bin\/bash/);
  assert.match(ud, /cat > \/etc\/vitana\/env <<'__ENV__'/, 'the env file, quoted heredoc: nothing expands');
  assert.match(ud, /file\("\$\{path\.module\}\/\.\.\/host\/fleet-manager-install\.sh"\)/);
  assert.match(ud, /bash \/opt\/vitana\/fleet-manager-install\.sh >> \/var\/log\/vitana-bootstrap\.log 2>&1/);
  for (const k of ['DOMAIN', 'REGION', 'RUNNER_VERSION', 'FLEET_ASG_NAME', 'FLEET_MAX_INSTANCES', 'FLEET_IDLE_COUNT', 'FLEET_CACHE_BUCKET', 'FLEET_CACHE_KMS_KEY_ARN', 'FLEET_TOKEN_SECRET']) {
    assert.match(ud, new RegExp(`"${k}=\\$\\{`), `${k} is written to the env file`);
  }
  assert.match(ud, /"RUNNER_VERSION=\$\{var\.runner_version\}"/, 'the pinned runner version of M1');
  assert.match(ud, /"FLEET_MAX_INSTANCES=\$\{var\.fleet_max_instances\}"/);
  assert.match(ud, /"FLEET_IDLE_COUNT=\$\{var\.fleet_idle_count\}"/);
  assert.equal(/glrt-|password|secret_string|SecretString|get-secret-value/i.test(ud), false, 'a name is allowed, a value is not');
});

test('manager role: exactly the actions of plan 3.2 and nothing more', ({ TF }) => {
  const doc = block(TF, 'data', 'aws_iam_policy_document', 'fleet_manager');
  const st = statements(doc);
  assert.equal(st.length, 6, `statements: ${st.map((s) => s.sid)}`);
  const by = Object.fromEntries(st.map((s) => [s.sid, s]));
  assert.deepEqual(Object.keys(by).sort(), ['CacheBucket', 'ConnectToJobMachines', 'DescribeGroupAndMachines', 'ReadRunnerToken', 'ScaleThisGroup', 'UseKey']);
  assert.deepEqual(by.ScaleThisGroup.actions.sort(), ['autoscaling:SetDesiredCapacity', 'autoscaling:SetInstanceProtection', 'autoscaling:TerminateInstanceInAutoScalingGroup']);
  assert.equal(by.ScaleThisGroup.resources, 'aws_autoscaling_group.fleet.arn', 'on this group only');
  assert.deepEqual(by.DescribeGroupAndMachines.actions.sort(), ['autoscaling:DescribeAutoScalingGroups', 'ec2:DescribeInstances', 'ec2:DescribeSpotInstanceRequests']);
  assert.equal(by.DescribeGroupAndMachines.resources, '"*"', 'describe calls take no resource');
  assert.deepEqual(by.ConnectToJobMachines.actions, ['ec2-instance-connect:SendSSHPublicKey']);
  assert.match(by.ConnectToJobMachines.resources, /^"arn:aws:ec2:\$\{var\.region\}:\$\{data\.aws_caller_identity\.me\.account_id\}:instance\/\*"$/);
  assert.match(by.ConnectToJobMachines.condition, /ec2:ResourceTag\/aws:autoscaling:groupName/);
  assert.match(by.ConnectToJobMachines.condition, /values = \[local\.fleet_asg_name\]/, 'only machines of this group');
  assert.match(by.ConnectToJobMachines.condition, /ec2:osuser/);
  assert.match(by.ConnectToJobMachines.condition, /values = \["ubuntu"\]/);
  assert.deepEqual(by.ReadRunnerToken.actions, ['secretsmanager:GetSecretValue']);
  assert.equal(by.ReadRunnerToken.resources, 'aws_secretsmanager_secret.fleet_runner_token.arn', 'only its own token');
  assert.deepEqual(by.UseKey.actions.sort(), ['kms:Decrypt', 'kms:GenerateDataKey']);
  assert.equal(by.UseKey.resources, 'aws_kms_key.main.arn', 'the M1 key');
  assert.deepEqual(by.CacheBucket.actions.sort(), ['s3:DeleteObject', 's3:GetObject', 's3:ListBucket', 's3:PutObject']);
  assert.match(by.CacheBucket.resources, /^aws_s3_bucket\.fleet_cache\.arn, "\$\{aws_s3_bucket\.fleet_cache\.arn\}\/\*"$/, 'the cache bucket and its objects');
});

test('IAM in the fleet files: no wildcard action, a wildcard resource only where the plan names one, no broad managed policy, policies are data documents', ({ TF }) => {
  const docs = namesOf(TF, 'data', 'aws_iam_policy_document');
  assert.ok(docs.includes('fleet_manager') && docs.includes('fleet_cache_tls_only'), `documents: ${docs}`);
  for (const d of docs) {
    for (const s of statements(block(TF, 'data', 'aws_iam_policy_document', d))) {
      // The one wildcard action allowed is the Deny of the TLS-only bucket policy: it removes access, it never grants it.
      const tlsDeny = d === 'fleet_cache_tls_only' && s.effect === 'Deny';
      for (const a of s.actions) assert.equal(a.includes('*') && !tlsDeny, false, `${d}/${s.sid}: wildcard action ${a}`);
      if (d === 'fleet_cache_tls_only') {
        assert.equal(s.effect, 'Deny', 'the bucket policy only denies');
        continue;
      }
      for (const item of s.resources.match(/"[^"]*"/g) ?? []) {
        if (!item.includes('*')) continue;
        const ok = (s.sid === 'DescribeGroupAndMachines' && item === '"*"')
          || (s.sid === 'ConnectToJobMachines' && /instance\/\*"$/.test(item))
          || (s.sid === 'CacheBucket' && item === '"${aws_s3_bucket.fleet_cache.arn}/*"');
        assert.ok(ok, `${d}/${s.sid}: wildcard resource ${item}`);
      }
    }
  }
  const attributes = [...TF.matchAll(/^\s*(policy|assume_role_policy)\s*=\s*(.+)$/gm)].map((m) => m[2].trim());
  assert.ok(attributes.length >= 4, `policy attributes: ${attributes.length}`);
  for (const rhs of attributes) assert.match(rhs, /^data\.aws_iam_policy_document\.\w+\.json$/, `a policy is a data document: ${rhs}`);
  assert.deepEqual(namesOf(TF, 'resource', 'aws_iam_policy'), []);
  assert.equal(/AdministratorAccess|PowerUserAccess|AmazonEC2FullAccess|SecretsManagerReadWrite|AmazonS3FullAccess/.test(TF), false);
  const attached = [...TF.matchAll(/policy_arn\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(attached, [
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
    'arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder',
  ], 'SSM for the manager, SSM and the Image Builder profile policy for the build role; nothing for the job role');
});

// ===================================================================== cache
test('cache bucket vitana-engineering-ci-cache-<account>: SSE-KMS with the M1 key, 7-day expiry, public access blocked, TLS only, no versioning', ({ FLEET }) => {
  assert.match(FLEET, /fleet_cache_bucket\s*=\s*"vitana-engineering-ci-cache-\$\{data\.aws_caller_identity\.me\.account_id\}"/);
  assert.match(block(FLEET, 'resource', 'aws_s3_bucket', 'fleet_cache'), /bucket\s*=\s*local\.fleet_cache_bucket/);
  const sse = block(FLEET, 'resource', 'aws_s3_bucket_server_side_encryption_configuration', 'fleet_cache');
  assert.match(sse, /sse_algorithm\s*=\s*"aws:kms"/);
  assert.match(sse, /kms_master_key_id\s*=\s*aws_kms_key\.main\.arn/);
  const pab = block(FLEET, 'resource', 'aws_s3_bucket_public_access_block', 'fleet_cache');
  for (const k of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) assert.match(pab, new RegExp(`${k}\\s*=\\s*true`), k);
  const life = block(FLEET, 'resource', 'aws_s3_bucket_lifecycle_configuration', 'fleet_cache');
  assert.match(life, /expiration\s*\{\s*days\s*=\s*7\b/, 'cache objects live 7 days');
  assert.match(life, /abort_incomplete_multipart_upload\s*\{\s*days_after_initiation\s*=\s*3\b/);
  const tls = block(FLEET, 'data', 'aws_iam_policy_document', 'fleet_cache_tls_only');
  assert.match(tls, /effect\s*=\s*"Deny"/);
  assert.match(tls, /aws:SecureTransport/);
  assert.match(block(FLEET, 'resource', 'aws_s3_bucket_policy', 'fleet_cache'), /data\.aws_iam_policy_document\.fleet_cache_tls_only\.json/);
  assert.deepEqual(namesOf(FLEET, 'resource', 'aws_s3_bucket_versioning'), [], 'a cache has no versions');
});

test('runner-token secret: the plan name, the M1 key, created empty (no secret version), no other secret', ({ TF }) => {
  assert.deepEqual(namesOf(TF, 'resource', 'aws_secretsmanager_secret'), ['fleet_runner_token']);
  const b = block(TF, 'resource', 'aws_secretsmanager_secret', 'fleet_runner_token');
  assert.match(b, new RegExp(`name\\s*=\\s*"${esc(FLEET_TOKEN_NAME)}"`));
  assert.match(b, /kms_key_id\s*=\s*aws_kms_key\.main\.arn/);
  assert.match(b, /recovery_window_in_days\s*=\s*0\b/);
  assert.deepEqual(namesOf(TF, 'resource', 'aws_secretsmanager_secret_version'), [], 'the settings sync writes the value, Terraform never does');
  assert.match(TF, new RegExp(`"FLEET_TOKEN_SECRET=\\$\\{aws_secretsmanager_secret\\.fleet_runner_token\\.name\\}"`), 'the installer is told the secret by name');
});

// ====================================================================== quota
test('quota check: both Standard vCPU quotas are read and compared with fleet_max_instances x 4; the failure prints the exact increase commands', ({ FLEET }) => {
  const od = block(FLEET, 'data', 'aws_servicequotas_service_quota', 'fleet_ondemand');
  assert.match(od, /service_code\s*=\s*"ec2"/);
  assert.match(od, /quota_code\s*=\s*"L-1216C47A"/, 'Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances, from the AWS CLI documentation');
  const spot = block(FLEET, 'data', 'aws_servicequotas_service_quota', 'fleet_spot');
  assert.match(spot, /service_code\s*=\s*"ec2"/);
  assert.match(spot, /quota_name\s*=\s*"All Standard \(A, C, D, H, I, M, R, T, Z\) Spot Instance Requests"/, 'looked up by the name AWS documents; the code in the message is the one AWS returns');
  assert.equal(/quota_code/.test(spot), false);
  assert.match(FLEET, /fleet_required_vcpus\s*=\s*var\.fleet_max_instances\s*\*\s*4\b/);
  const check = block(FLEET, 'resource', 'terraform_data', 'fleet_quota_check');
  const pre = subs(check, 'precondition');
  assert.equal(pre.length, 3, 'On-Demand quota, Spot quota, and the guard that the On-Demand code is the quota named in the message');
  const [pOd, pSpot] = pre;
  assert.match(pOd, /condition\s*=\s*data\.aws_servicequotas_service_quota\.fleet_ondemand\.value\s*>=\s*local\.fleet_required_vcpus/);
  assert.match(pSpot, /condition\s*=\s*data\.aws_servicequotas_service_quota\.fleet_spot\.value\s*>=\s*local\.fleet_required_vcpus/);
  assert.match(pOd, /aws service-quotas request-service-quota-increase --service-code ec2 --quota-code \$\{data\.aws_servicequotas_service_quota\.fleet_ondemand\.quota_code\} --desired-value \$\{local\.fleet_required_vcpus\} --region \$\{var\.region\}/);
  assert.match(pSpot, /aws service-quotas request-service-quota-increase --service-code ec2 --quota-code \$\{data\.aws_servicequotas_service_quota\.fleet_spot\.quota_code\} --desired-value \$\{local\.fleet_required_vcpus\} --region \$\{var\.region\}/);
  assert.match(pre[2], /condition\s*=\s*data\.aws_servicequotas_service_quota\.fleet_ondemand\.quota_name\s*==\s*"Running On-Demand Standard \(A, C, D, H, I, M, R, T, Z\) instances"/);
  // Terraform wraps a message line to the terminal width unless it starts with a space; a wrapped command cannot be pasted.
  for (const [name, text] of [['On-Demand', pOd], ['Spot', pSpot]]) {
    const lines = text.split('\n');
    const at = lines.findIndex((l) => l.includes('aws service-quotas request-service-quota-increase'));
    assert.ok(at > 0, `${name}: the command is on a line of its own`);
    const indent = (l) => /^ */.exec(l)[0].length;
    assert.ok(indent(lines[at]) > indent(lines[at - 1]), `${name}: the command line is indented, so Terraform does not wrap it`);
  }
  assert.equal(/^check\s+"/m.test(FLEET), false, 'a failed check stops the apply; a check block only warns');
});

// =============================================================== key grants
test('Auto Scaling and Spot can use the M1 key: custom-suffix service-linked role plus one grant each (the default key policy lets neither in)', ({ FLEET }) => {
  const slr = block(FLEET, 'resource', 'aws_iam_service_linked_role', 'fleet_autoscaling');
  assert.match(slr, /aws_service_name\s*=\s*"autoscaling\.amazonaws\.com"/);
  assert.match(slr, /custom_suffix\s*=\s*"vitana-eng-fleet"/);
  const spotSlr = block(FLEET, 'resource', 'aws_iam_service_linked_role', 'fleet_spot');
  assert.match(spotSlr, /aws_service_name\s*=\s*"spot\.amazonaws\.com"/);
  assert.match(spotSlr, /count\s*=\s*var\.fleet_create_spot_service_role\s*\?\s*1\s*:\s*0/);
  assert.match(block(FLEET, 'variable', 'fleet_create_spot_service_role'), /default\s*=\s*true/);
  assert.match(FLEET, /fleet_spot_role_arn\s*=\s*"arn:aws:iam::\$\{data\.aws_caller_identity\.me\.account_id\}:role\/aws-service-role\/spot\.amazonaws\.com\/AWSServiceRoleForEC2Spot"/);
  const ops = ['CreateGrant', 'Decrypt', 'DescribeKey', 'Encrypt', 'GenerateDataKey', 'GenerateDataKeyWithoutPlaintext', 'ReEncryptFrom', 'ReEncryptTo'];
  for (const [name, principal] of [['fleet_autoscaling', 'aws_iam_service_linked_role.fleet_autoscaling.arn'], ['fleet_spot', 'local.fleet_spot_role_arn']]) {
    const g = block(FLEET, 'resource', 'aws_kms_grant', name);
    assert.match(g, /key_id\s*=\s*aws_kms_key\.main\.arn/, `${name}: the M1 key`);
    assert.match(g, new RegExp(`grantee_principal\\s*=\\s*${esc(principal)}`), `${name}: grantee`);
    assert.deepEqual(strList(/operations\s*=\s*\[([^\]]*)\]/.exec(g)[1]).sort(), ops, `${name}: the operations AWS documents for encrypted volumes`);
  }
  assert.match(block(FLEET, 'resource', 'aws_kms_grant', 'fleet_spot'), /depends_on\s*=\s*\[\s*aws_iam_service_linked_role\.fleet_spot\s*\]/, 'the role exists before the grant names it');
});

// ============================================================ image (Image Builder)
test('image: Image Builder component, recipe, infrastructure configuration and image; the AMI is encrypted and a failed build stops the apply', ({ AMI }) => {
  for (const [type, name] of [['aws_imagebuilder_component', 'fleet'], ['aws_imagebuilder_image_recipe', 'fleet'], ['aws_imagebuilder_infrastructure_configuration', 'fleet'], ['aws_imagebuilder_image', 'fleet']]) {
    assert.ok(has(AMI, 'resource', type, name), `${type}.${name}`);
  }
  const image = block(AMI, 'resource', 'aws_imagebuilder_image', 'fleet');
  assert.match(image, /image_recipe_arn\s*=\s*aws_imagebuilder_image_recipe\.fleet\.arn/);
  assert.match(image, /infrastructure_configuration_arn\s*=\s*aws_imagebuilder_infrastructure_configuration\.fleet\.arn/);
  assert.match(subs(image, 'image_tests_configuration').join('\n'), /image_tests_enabled\s*=\s*true\b/, 'the component test phase runs on a machine started from the new image');
  assert.match(subs(image, 'timeouts').join('\n'), /create\s*=\s*"\d+m"/, 'a build that hangs fails the apply instead of waiting forever');
  assert.equal(/ignore_changes|prevent_destroy|depends_on/.test(image), false, 'nothing makes Terraform carry on after a failed build');
  const recipe = block(AMI, 'resource', 'aws_imagebuilder_image_recipe', 'fleet');
  assert.match(recipe, /parent_image\s*=\s*data\.aws_ssm_parameter\.ubuntu\.value/, 'the Ubuntu 24.04 image of M1');
  assert.match(subs(recipe, 'ebs').join('\n'), /encrypted\s*=\s*true\b/);
  assert.match(subs(recipe, 'ebs').join('\n'), /volume_type\s*=\s*"gp3"/);
  assert.match(subs(recipe, 'lifecycle').join('\n'), /ignore_changes\s*=\s*\[\s*parent_image\s*\]/, 'a new Canonical image never starts a rebuild by itself');
  assert.match(subs(recipe, 'lifecycle').join('\n'), /create_before_destroy\s*=\s*true/);
  assert.match(subs(block(AMI, 'resource', 'aws_imagebuilder_component', 'fleet'), 'lifecycle').join('\n'), /create_before_destroy\s*=\s*true/);
  assert.match(block(AMI, 'resource', 'aws_imagebuilder_component', 'fleet'), /data\s*=\s*file\("\$\{path\.module\}\/\.\.\/host\/fleet-image\/component\.yml"\)/);
  assert.match(block(AMI, 'resource', 'aws_imagebuilder_component', 'fleet'), /platform\s*=\s*"Linux"/);
  assert.match(AMI, /fleet_job_image\s*=\s*"public\.ecr\.aws\/docker\/library\/node:20-bookworm"/, 'the image the central CI uses');
  assert.match(AMI, /fleet_runner_helper_image\s*=\s*"registry\.gitlab\.com\/gitlab-org\/gitlab-runner\/gitlab-runner-helper:x86_64-v\$\{local\.fleet_runner_semver\}"/);
  assert.match(AMI, /fleet_runner_semver\s*=\s*regex\("\^\[0-9\]\+\\\\\.\[0-9\]\+\\\\\.\[0-9\]\+", var\.runner_version\)/, 'helper tag = the runner version of M1 without the package revision');
});

test('image build machine: private subnet, the job group, IMDSv2 hop 1, terminated on failure; its role is separate from the job role', ({ AMI }) => {
  const infra = block(AMI, 'resource', 'aws_imagebuilder_infrastructure_configuration', 'fleet');
  assert.match(infra, /subnet_id\s*=\s*aws_subnet\.private\[\d\]\.id/);
  assert.match(infra, /security_group_ids\s*=\s*\[\s*aws_security_group\.fleet_job\.id\s*\]/);
  assert.match(infra, /terminate_instance_on_failure\s*=\s*true\b/, 'a failed build leaves no machine running');
  const imds = subs(infra, 'instance_metadata_options').join('\n');
  assert.match(imds, /http_tokens\s*=\s*"required"/);
  assert.match(imds, /http_put_response_hop_limit\s*=\s*1\b/);
  assert.match(infra, /instance_profile_name\s*=\s*aws_iam_instance_profile\.fleet_image\.name/);
  assert.equal(/fleet_job\.name|fleet_manager/.test(infra.replace(/aws_security_group\.fleet_job\.id/, '')), false);
  assert.equal(/\bkey_pair\b/.test(infra), false, 'no key pair');
  const role = block(AMI, 'resource', 'aws_iam_role', 'fleet_image');
  assert.match(role, /name\s*=\s*"vitana-eng-fleet-image"/);
  assert.match(role, /assume_role_policy\s*=\s*data\.aws_iam_policy_document\.ec2_assume\.json/);
  const arns = [...AMI.matchAll(/policy_arn\s*=\s*"([^"]+)"/g)].map((m) => m[1]).sort();
  assert.deepEqual(arns, ['arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore', 'arn:aws:iam::aws:policy/EC2InstanceProfileForImageBuilder']);
  assert.equal(/aws_iam_role_policy"/.test(AMI), false, 'the two documented managed policies and nothing inline');
});

test('component: Docker Engine, EC2 Instance Connect, ubuntu in group docker, both images pre-pulled, no runner binary, a test phase', ({ COMPONENT }) => {
  assert.match(COMPONENT, /^schemaVersion: 1\.0$/m);
  assert.match(COMPONENT, /^  - name: build$/m);
  assert.match(COMPONENT, /^  - name: test$/m, 'a failed check fails the build');
  assert.match(COMPONENT, /apt-get[^\n]* install -y[^\n]*\bdocker\.io\b/);
  assert.match(COMPONENT, /apt-get[^\n]* install -y[^\n]*\bec2-instance-connect\b/);
  assert.match(COMPONENT, /usermod -aG docker ubuntu/);
  assert.match(COMPONENT, /systemctl enable docker/);
  assert.match(COMPONENT, /docker pull "\{\{ JobImage \}\}"/);
  assert.match(COMPONENT, /docker pull "\{\{ RunnerHelperImage \}\}"/);
  const build = COMPONENT.slice(COMPONENT.indexOf('- name: build'), COMPONENT.indexOf('- name: test'));
  const test_ = COMPONENT.slice(COMPONENT.indexOf('- name: test'));
  assert.equal(/gitlab-runner|packages\.gitlab\.com/.test(build), false, 'the runner binary is not on the machine image');
  assert.match(test_, /systemctl start docker/, 'the check does not race the daemon\'s start at boot');
  assert.match(test_, /id -nG ubuntu/);
  assert.match(test_, /docker image inspect "\{\{ JobImage \}\}"/);
  assert.match(test_, /docker image inspect "\{\{ RunnerHelperImage \}\}"/);
  assert.match(test_, /dpkg -s ec2-instance-connect/);
  assert.match(test_, /test ! -e \/usr\/bin\/gitlab-runner/);
  assert.equal(/AWS_(ACCESS|SECRET|SESSION)|aws configure|ssh-(rsa|ed25519)|PRIVATE KEY|\bglrt-/.test(COMPONENT), false, 'no key and no secret baked into the image');
  const recipe = block(files.AMI, 'resource', 'aws_imagebuilder_image_recipe', 'fleet');
  assert.match(recipe, /name\s*=\s*"JobImage"[\s\S]*?value\s*=\s*local\.fleet_job_image\b/);
  assert.match(recipe, /name\s*=\s*"RunnerHelperImage"[\s\S]*?value\s*=\s*local\.fleet_runner_helper_image\b/);
  assert.match(COMPONENT, /^parameters:\n  - JobImage:\n      type: string$/m);
  assert.match(COMPONENT, /^  - RunnerHelperImage:\n      type: string$/m);
});

// =================================================================== outputs
test('outputs carry names and ids, never a secret value; no key pair, no stored SSH key, no secret version anywhere in the fleet files', ({ TF }) => {
  const found = [...TF.matchAll(/^output\s+"([a-z_]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(found, ['fleet_ami_id', 'fleet_asg_name', 'fleet_cache_bucket', 'fleet_manager_instance_id', 'fleet_runner_token_secret'], 'the outputs of the fleet');
  for (const o of found) {
    const b = block(TF, 'output', o);
    assert.equal(/secret_string|secret_version|\.value\b.*token|sensitive\s*=\s*false/.test(b), false, `${o}: no secret value`);
  }
  assert.match(block(TF, 'output', 'fleet_runner_token_secret'), /value\s*=\s*aws_secretsmanager_secret\.fleet_runner_token\.name/, 'the secret NAME, for the settings sync');
  assert.equal(/aws_key_pair|\bkey_name\b|tls_private_key|ssh-(rsa|ed25519)|BEGIN [A-Z ]*PRIVATE KEY|public_key\s*=/.test(TF), false, 'no stored SSH key');
  assert.equal(/\b(AKIA|ASIA)[A-Z0-9]{16}\b|\bglrt-|\bglpat-|ghp_[A-Za-z0-9]/.test(TF), false, 'no credential value');
  const names = [...TF.matchAll(/^output\s+"([a-z_]+)"/gm)].map((m) => m[1]);
  const main = files.MAIN;
  for (const n of names) assert.equal(new RegExp(`^output\\s+"${n}"`, 'm').test(main), false, `${n} is not an M1 output`);
});

test('every resource and data source the fleet files take from M1 exists in main.tf, and the fleet files add no name main.tf already has', ({ MAIN, TF }) => {
  const have = (kind, type, name) => new RegExp(`^${kind}\\s+"${type}"\\s+"${name}"`, 'm').test(MAIN);
  for (const [kind, type, name] of [['resource', 'aws_kms_key', 'main'], ['resource', 'aws_vpc', 'main'], ['resource', 'aws_subnet', 'private'],
    ['resource', 'aws_nat_gateway', 'nat'], ['resource', 'aws_route_table_association', 'private'], ['data', 'aws_caller_identity', 'me'],
    ['data', 'aws_ssm_parameter', 'ubuntu'], ['data', 'aws_iam_policy_document', 'ec2_assume']]) {
    assert.ok(have(kind, type, name), `main.tf has ${type}.${name}`);
    const ref = `${kind === 'data' ? 'data.' : ''}${type}.${name}`;
    assert.ok(TF.includes(ref), `the fleet files use ${ref} of main.tf by reference instead of making their own`);
  }
  assert.match(MAIN, /vpc_cidr\s*=\s*"10\.20\.0\.0\/16"/);
  for (const kind of ['resource', 'data']) {
    for (const m of TF.matchAll(new RegExp(`^${kind}\\s+"(\\w+)"\\s+"(\\w+)"`, 'gm'))) {
      assert.equal(have(kind, m[1], m[2]), false, `${m[1]}.${m[2]} is already defined by main.tf`);
    }
  }
  assert.equal(/^terraform\s*\{|^provider\s+"aws"/m.test(TF), false, 'the fleet files add no terraform or provider block');
  assert.equal(/\baws_instance\.(gitlab|runner)\b|\baws_security_group\.(alb|gitlab|runner)\b|aws_iam_role\.(gitlab|runner)\b/.test(TF), false, 'M1 machines, groups and roles are not touched');
});

// ================================================================ installer
test('installer: bash, no xtrace, no Docker on the manager, pinned runner held back, plugin installed with gitlab-runner fleeting install', ({ INSTALL }) => {
  assert.match(INSTALL, /^#!\/bin\/bash\n/);
  const r = spawnSync('bash', ['-n', INSTALL_SH], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  for (const [i, line] of INSTALL.split('\n').entries()) {
    assert.equal(/\bset\s+-[A-Za-z]*x|\bset\s+-o\s+xtrace|\bbash\s+-[A-Za-z]*x\b/.test(stripComment(line)), false, `xtrace at line ${i + 1}`);
  }
  const code = INSTALL.split('\n').map(stripComment).join('\n');
  assert.equal(/apt(-get)?\s+install[^\n]*docker/.test(code), false, 'the manager has no Docker');
  assert.equal(/systemctl[^\n]*\bdocker\b|usermod[^\n]*docker/.test(code), false, 'and no Docker service or group');
  assert.match(code, /apt install -y "gitlab-runner-helper-images=\$RUNNER_VERSION" "gitlab-runner=\$RUNNER_VERSION" \|\| exit 1/, 'the runner version of M1, exactly, with its helper images at the same version');
  assert.match(code, /apt-mark hold gitlab-runner gitlab-runner-helper-images/);
  assert.match(code, /gitlab-runner fleeting install/);
  assert.match(code, /gitlab-runner fleeting list/, 'the plugin version that was installed is logged');
  assert.match(code, /FLEETING_PLUGIN_PATH=/, 'the service and the installer use the same plugin folder');
  assert.match(code, /echo "== fleet manager install start/);
  assert.match(code, /echo "== fleet manager install done/);
  assert.match(INSTALL, /\/var\/log\/vitana-bootstrap\.log/, 'the header names the log');
});

test('installer waits for a glrt- token in the fleet secret before it writes config.toml, and never prints the token', ({ INSTALL, FLEET }) => {
  assert.match(INSTALL, /aws secretsmanager get-secret-value --secret-id "\$FLEET_TOKEN_SECRET" --query SecretString --output text/);
  assert.match(INSTALL, /case "\$T" in glrt-\*\) TOKEN="\$T"; break ;; esac/, 'only a runner authentication token ends the wait');
  assert.match(INSTALL, /for i in \$\(seq 1 2880\)/, 'waits up to 24 hours in 30 s steps');
  assert.match(INSTALL, /sleep 30/);
  const code = INSTALL.split('\n').map(stripComment).join('\n');
  const waitAt = code.indexOf('get-secret-value');
  const writeAt = code.indexOf('/etc/gitlab-runner/config.toml');
  assert.ok(waitAt > 0 && writeAt > waitAt, 'config.toml is written after the token arrived');
  assert.match(INSTALL, /no runner token after/, 'giving up says so and exits non-zero');
  assert.match(INSTALL, /TMPCONF="\$\(umask 077; mktemp /, 'config.toml, which holds the token, is created private');
  assert.equal(/^\s*umask\b/m.test(INSTALL.split('\n').map(stripComment).join('\n')), false,
    'no umask for the whole script: it would make the package repository key unreadable for apt, which verifies packages as an unprivileged user');
  assert.match(INSTALL, /install -m 0600 -o root -g root/);
  // The token variables ($T, $TOKEN, $FLEET_RUNNER_TOKEN) appear on a short list of reviewed lines only; none of them prints.
  const allowed = [
    /^TOKEN=""$/,
    /^T="\$\(aws secretsmanager get-secret-value --secret-id "\$FLEET_TOKEN_SECRET" --query SecretString --output text 2>\/dev\/null \|\| true\)"$/,
    /^case "\$T" in glrt-\*\) TOKEN="\$T"; break ;; esac$/,
    /^\[ -n "\$TOKEN" \] \|\| \{ echo "no runner token after [^"$`]*"; exit 1; \}$/,
    /^FLEET_RUNNER_TOKEN="\$TOKEN" render_config > "\$TMPCONF" \|\| \{ echo "config\.toml could not be rendered"; exit 1; \}$/,
    /^token = "\$FLEET_RUNNER_TOKEN"$/,
  ];
  const uses = INSTALL.split('\n').map((l) => l.trim()).filter((l) => /\$\{?(T|TOKEN|FLEET_RUNNER_TOKEN)\b|\bT=|\bTOKEN=/.test(stripComment(l)) && !/^#/.test(l));
  assert.ok(uses.length >= 5, `token lines found: ${uses.length}`);
  for (const l of uses) assert.ok(allowed.some((re) => re.test(l)), `unreviewed use of the runner token: ${l}`);
  assert.equal(/echo[^\n]*\$\{?(T|TOKEN|FLEET_RUNNER_TOKEN)\b|printf[^\n]*\$\{?(T|TOKEN|FLEET_RUNNER_TOKEN)\b/.test(INSTALL.replace(/^token = .*$/m, '')), false, 'no line echoes the token');
  assert.match(INSTALL, /gitlab-runner verify 2>&1 \| sed -E 's\/runner=\[\^ \]\+\/runner=\*\*\*\/'/, 'verify output is scrubbed');
  assert.equal(/FLEET_RUNNER_TOKEN/.test(FLEET), false, 'Terraform never sees the token');
});

test('the env file Terraform writes defines every variable the installer reads', ({ INSTALL, FLEET }) => {
  const wholeCode = INSTALL.split('\n').map(stripComment).join('\n');
  const read_ = new Set([...wholeCode.matchAll(/\$\{?(DOMAIN|REGION|RUNNER_VERSION|FLEET_[A-Z_]+)\b/g)].map((m) => m[1]));
  read_.delete('FLEET_RUNNER_TOKEN');
  const locals = subs(FLEET, 'locals').join('\n');
  const written = new Set([...locals.matchAll(/"([A-Z_]+)=\$\{/g)].map((m) => m[1]));
  assert.ok(read_.size >= 8, `variables read: ${[...read_]}`);
  for (const v of read_) assert.ok(written.has(v), `${v} is read by fleet-manager-install.sh but not written to /etc/vitana/env by fleet.tf`);
  for (const v of written) assert.ok(read_.has(v), `${v} is written but never used by the installer`);
});

// ============================================================== config.toml
test('config.toml (rendered): docker-autoscaler, plugin aws, one job per machine, max_instances = concurrent = fleet_max_instances, idle 0 for 10m0s', () => {
  const { toml } = rendered();
  assert.equal(toml.concurrent, 24, 'concurrent = fleet_max_instances');
  assert.equal(toml.runners.length, 1);
  const r = toml.runners[0];
  assert.equal(r.name, 'vitana-eng-fleet');
  assert.equal(r.url, 'https://gitlab.vitanaland.com');
  assert.equal(r.token, FAKE_TOKEN);
  assert.equal(r.executor, 'docker-autoscaler');
  const a = r.autoscaler;
  assert.equal(a.plugin, 'aws', 'installed with gitlab-runner fleeting install');
  assert.equal(a.capacity_per_instance, 1);
  assert.equal(a.max_use_count, 1, 'a machine is deleted after one job');
  assert.equal(a.max_instances, 24, 'max_instances = concurrent = fleet_max_instances');
  assert.deepEqual(a.plugin_config, { name: 'vitana-eng-fleet', region: 'eu-central-1' });
  assert.deepEqual(a.connector_config, { username: 'ubuntu', use_external_addr: false });
  assert.deepEqual(a.policy, [{ idle_count: 0, idle_time: '10m0s' }]);
});

test('config.toml (rendered): job containers are not privileged, no Docker socket, images pulled only when missing', () => {
  const { text, toml } = rendered();
  const d = toml.runners[0].docker;
  assert.equal(d.privileged, false);
  assert.deepEqual(d.pull_policy, ['if-not-present']);
  assert.equal(d.image, 'public.ecr.aws/docker/library/node:20-bookworm');
  assert.equal(/docker\.sock|privileged\s*=\s*true|\/var\/run|host_network|network_mode|cap_add|devices\s*=/.test(text), false, 'no socket mount, no extra power');
  assert.deepEqual(d.volumes ?? ['/cache'], ['/cache'], 'only the cache volume the executor itself creates');
  assert.equal(/0\.0\.0\.0/.test(text), false);
});

test('config.toml (rendered): cache in the S3 bucket of the account, SSE-KMS with the M1 key, regional endpoint, instance-profile credentials', () => {
  const { text, toml } = rendered();
  const c = toml.runners[0].cache;
  assert.equal(c.Type, 's3');
  const s3 = c.s3;
  assert.equal(s3.BucketName, 'vitana-engineering-ci-cache-111122223333');
  assert.equal(s3.BucketLocation, 'eu-central-1');
  assert.equal(s3.ServerAddress, 's3.eu-central-1.amazonaws.com', 'the regional endpoint, which the S3 gateway endpoint of M1 serves');
  assert.equal(s3.AuthenticationType, 'iam', 'the manager signs the URLs; the job machines hold no credential');
  assert.equal(s3.ServerSideEncryption, 'KMS');
  assert.equal(s3.ServerSideEncryptionKeyID, FIXED.FLEET_CACHE_KMS_KEY_ARN);
  assert.equal(/AccessKey|SecretKey|SessionToken/.test(text), false, 'no stored AWS credential');
  assert.equal(s3.Insecure, undefined, 'TLS stays on');
});

test('config.toml (rendered): every size comes from the inputs: max_instances and concurrent move together, idle_count follows fleet_idle_count', () => {
  const { toml } = rendered({ FLEET_MAX_INSTANCES: '7', FLEET_IDLE_COUNT: '2', FLEET_ASG_NAME: 'other-fleet', DOMAIN: 'ci.example.org', REGION: 'eu-west-1' });
  assert.equal(toml.concurrent, 7);
  const a = toml.runners[0].autoscaler;
  assert.equal(a.max_instances, 7);
  assert.equal(a.policy[0].idle_count, 2);
  assert.equal(a.plugin_config.name, 'other-fleet');
  assert.equal(a.plugin_config.region, 'eu-west-1');
  assert.equal(toml.runners[0].url, 'https://ci.example.org');
  assert.equal(toml.runners[0].cache.s3.BucketLocation, 'eu-west-1');
  assert.equal(toml.runners[0].cache.s3.ServerAddress, 's3.eu-west-1.amazonaws.com');
});

test('config.toml (rendered): the token appears once, in the runner section, and nowhere else', () => {
  const { text } = rendered();
  assert.equal(text.split(FAKE_TOKEN).length - 1, 1, 'exactly one occurrence');
  assert.match(text, new RegExp(`^\\s*token = "${esc(FAKE_TOKEN)}"$`, 'm'));
  const r = render();
  assert.equal(r.stderr.includes(FAKE_TOKEN), false, 'nothing on stderr either');
});

test('rendering fails closed: a bad size, token, bucket, key or name prints no config and exits non-zero without echoing the token', () => {
  const bad = [
    ['FLEET_MAX_INSTANCES', '0'], ['FLEET_MAX_INSTANCES', '-3'], ['FLEET_MAX_INSTANCES', 'many'], ['FLEET_MAX_INSTANCES', '24; rm -rf /'], ['FLEET_MAX_INSTANCES', ''],
    ['FLEET_IDLE_COUNT', '-1'], ['FLEET_IDLE_COUNT', '25'], ['FLEET_IDLE_COUNT', 'x'],
    ['FLEET_RUNNER_TOKEN', 'glpat-wrongkind'], ['FLEET_RUNNER_TOKEN', ''], ['FLEET_RUNNER_TOKEN', `${FAKE_TOKEN}"\nconcurrent = 999`],
    ['FLEET_CACHE_BUCKET', 'Bad Bucket"'], ['FLEET_CACHE_BUCKET', ''],
    ['FLEET_CACHE_KMS_KEY_ARN', 'alias/vitana-engineering'], ['FLEET_CACHE_KMS_KEY_ARN', ''],
    ['DOMAIN', 'gitlab.example.com/evil'], ['DOMAIN', ''], ['REGION', 'eu central'], ['FLEET_ASG_NAME', 'a b'], ['FLEET_ASG_NAME', ''],
  ];
  assert.equal(render().status, 0, 'control: the same inputs, unspoiled, render');
  for (const [k, v] of bad) {
    const r = render({ [k]: v });
    assert.notEqual(r.status, 0, `${k}=${JSON.stringify(v)} must be refused`);
    assert.equal(r.stdout, '', `${k}=${JSON.stringify(v)}: no config text`);
    assert.ok(r.stderr.includes(k), `${k}=${JSON.stringify(v)}: the refusal names the input (stderr: ${r.stderr.slice(0, 120)})`);
    assert.equal((r.stdout + r.stderr).includes(FAKE_TOKEN), false, `${k}: the token is never echoed`);
  }
  const unset = render({ FLEET_RUNNER_TOKEN: undefined });
  assert.notEqual(unset.status, 0, 'a missing token is refused');
  assert.equal(unset.stdout, '');
  assert.ok(unset.stderr.includes('FLEET_RUNNER_TOKEN'));
});

// ================================================================== scripts
test('the installer and the component pass the syntax checks the lane can run: bash -n, and the yaml is plain', ({ INSTALL, COMPONENT }) => {
  assert.ok(statSync(INSTALL_SH).size > 2000, 'the installer is not a stub');
  assert.match(INSTALL, /^set -u$/m);
  assert.equal(/^\t/m.test(COMPONENT), false, 'no tab in the yaml');
  assert.ok(COMPONENT.split('\n').length > 30);
  const list = readdirSync(path.join(ROOT, 'host', 'fleet-image')).sort();
  assert.deepEqual(list, ['component.yml'], 'the image folder holds the component only');
});

// ================================================================== runbook
test('RUNBOOK-m2-fleet: quota commands, the apply, what to read when a job waits, how to drain, the monthly cost estimate', ({ RUNBOOK, FLEET }) => {
  for (const h of [/^## .*[Qq]uota/m, /^## .*[Aa]pply/m, /^## .*job waits/m, /^## .*[Dd]rain/m, /^## .*[Cc]ost/m]) assert.match(RUNBOOK, h);
  assert.match(RUNBOOK, /aws service-quotas request-service-quota-increase --service-code ec2 --quota-code L-1216C47A --desired-value 96 --region eu-central-1/);
  assert.match(RUNBOOK, /aws service-quotas list-service-quotas --service-code ec2/, 'how to find the Spot quota code');
  assert.match(RUNBOOK, /bash ~\/vitana-eng\/setup\.sh/, 'the owner\'s existing apply, with no new flag');
  assert.match(RUNBOOK, /journalctl -u gitlab-runner/);
  assert.match(RUNBOOK, /aws autoscaling describe-scaling-activities --auto-scaling-group-name vitana-eng-fleet/);
  assert.match(RUNBOOK, /gitlab-runner fleeting list/);
  assert.match(RUNBOOK, /\/var\/log\/vitana-bootstrap\.log/);
  assert.match(RUNBOOK, /terminate-instance-in-auto-scaling-group[^\n]*--should-decrement-desired-capacity/, 'the drain command works on protected machines');
  // The row the owner reads when a job waits: the symptom, what it means, and the command that shows the grants.
  const row = RUNBOOK.split('\n').find((l) => l.startsWith('|') && l.includes('Client.InternalError'));
  assert.ok(row, 'the troubleshooting table has a row for the key-grant symptom');
  assert.match(row, /Client\.InvalidKMSKey\.InvalidState/);
  assert.match(row, /aws kms list-grants --key-id/);
  assert.match(row, /AWSServiceRoleForAutoScaling_vitana-eng-fleet/);
  assert.match(row, /AWSServiceRoleForEC2Spot/);
  assert.match(RUNBOOK, /Client\.InternalError` \(section 4\)/, 'the apply section points at the troubleshooting section by its real number');
  assert.match(RUNBOOK, /^## 4\. When a job waits/m);
  assert.match(RUNBOOK, /AmazonEC2 .*20261104210305|20261104210305/, 'the price list version the estimate was made from');
  assert.match(RUNBOOK, /https:\/\/pricing\.us-east-1\.amazonaws\.com\/offers\/v1\.0\/aws\/AmazonEC2\//);
  assert.match(RUNBOOK, /\$\d+(\.\d+)? per month|per month/i);
  assert.equal(/glrt-[A-Za-z0-9_]{6,}|AKIA[A-Z0-9]{16}/.test(RUNBOOK), false, 'no secret in the document');
  assert.equal(RUNBOOK.includes(FLEET_TOKEN_NAME), true, 'names the token secret');
  assert.equal(/aws_servicequotas_service_quota/.test(FLEET), true);
});

test('names agree across the files: group, secret, bucket, region, images', ({ FLEET, AMI, INSTALL, COMPONENT, RUNBOOK }) => {
  assert.equal(str(FLEET, 'fleet_asg_name'), 'vitana-eng-fleet');
  assert.ok(RUNBOOK.includes('vitana-eng-fleet'));
  assert.ok(FLEET.includes(FLEET_TOKEN_NAME) && RUNBOOK.includes(FLEET_TOKEN_NAME));
  assert.match(INSTALL, /vitana-eng-fleet|FLEET_ASG_NAME/);
  const job = /fleet_job_image\s*=\s*"([^"]+)"/.exec(AMI)[1];
  assert.equal(rendered().toml.runners[0].docker.image, job, 'the image the config pulls is the image the machine image carries');
  assert.ok(COMPONENT.includes('{{ JobImage }}'));
  assert.ok(RUNBOOK.includes('vitana-engineering-ci-cache-'));
  assert.ok(existsSync(path.join(ROOT, 'host', 'fleet-image', 'component.yml')));
});

// ========================================================= installer, run for real
// The main flow of the installer runs here against stub commands in a temporary folder: apt, aws, curl, install, systemctl and gitlab-runner
// are small scripts that write down how they were called. The absolute paths of the script (/etc/..., /opt/..., /root/...) are pointed at
// the temporary folder; nothing outside it is touched and nothing needs root or a network.
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import os from 'node:os';

const NOT_FOUND = null;   // the secret has no value yet: the CLI fails with ResourceNotFoundException
function runInstaller({ answers }) {
  const T = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'fleet-inst-'));
  try {
    for (const d of ['bin', 'etc/vitana', 'etc/gitlab-runner', 'etc/systemd/system', 'opt/vitana', 'root']) mkdirSync(path.join(T, d), { recursive: true });
    writeFileSync(path.join(T, 'etc/vitana/env'), [
      'DOMAIN=gitlab.vitanaland.com', 'REGION=eu-central-1', 'RUNNER_VERSION=19.5.2-1', 'FLEET_ASG_NAME=vitana-eng-fleet', 'FLEET_MAX_INSTANCES=24',
      'FLEET_IDLE_COUNT=0', 'FLEET_CACHE_BUCKET=vitana-engineering-ci-cache-111122223333', `FLEET_CACHE_KMS_KEY_ARN=${FIXED.FLEET_CACHE_KMS_KEY_ARN}`,
      `FLEET_TOKEN_SECRET=${FLEET_TOKEN_NAME}`, ''].join('\n'));
    const log = path.join(T, 'calls.log');
    const stub = (name, body) => { writeFileSync(path.join(T, 'bin', name), `#!/bin/bash\n${body}\n`); chmodSync(path.join(T, 'bin', name), 0o755); };
    stub('apt-get', `echo "apt-get $*" >> "${log}"`);
    stub('apt-mark', `echo "apt-mark $*" >> "${log}"`);
    stub('curl', `echo "curl $*" >> "${log}"; exit 0`);
    stub('unzip', `echo "unzip $*" >> "${log}"`);
    stub('sleep', `echo "sleep $*" >> "${log}"`);
    stub('seq', 'echo 1; echo 2; echo 3; echo 4');
    stub('id', 'echo 0');
    stub('systemctl', `echo "systemctl $*" >> "${log}"`);
    stub('install', `echo "install $*" >> "${log}"; mode=""; args=(); while [ $# -gt 0 ]; do case "$1" in -m) mode="$2"; shift 2 ;; -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done; cp "\${args[0]}" "\${args[1]}"; chmod "\${mode:-0644}" "\${args[1]}"`);
    // aws: answers the n-th call with the n-th entry of the list (the last one repeats). The token is built at run time and lives in the temp folder only.
    writeFileSync(path.join(T, 'answers.txt'), answers.map((a) => (a === NOT_FOUND ? '@ERR@' : a)).join('\n') + '\n');
    stub('aws', `n=$(cat "${T}/aws.n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${T}/aws.n"; echo "aws $1 $2" >> "${log}"; `
      + `a=$(sed -n "\${n}p" "${T}/answers.txt"); [ -n "$a" ] || a=$(tail -n1 "${T}/answers.txt"); `
      + `if [ "$a" = @ERR@ ]; then echo "An error occurred (ResourceNotFoundException)" >&2; exit 254; else echo "$a"; fi`);
    stub('gitlab-runner', `echo "gitlab-runner $* | FLEETING_PLUGIN_PATH=$FLEETING_PLUGIN_PATH CONFIG_FILE=\${CONFIG_FILE:-} config_present=$([ -f "${T}/etc/gitlab-runner/config.toml" ] && echo yes || echo no)" >> "${log}"; `
      + `if [ "$1" = verify ]; then echo "Verifying runner... is alive runner=t1_ABCDEFGH"; fi; if [ "$1" = fleeting ] && [ "$2" = list ]; then echo "aws  1.2.3"; fi`);
    let script = readFileSync(INSTALL_SH, 'utf8');
    for (const [from, to] of [['/etc/vitana/env', 'etc/vitana/env'], ['/etc/systemd/system/gitlab-runner.service.d', 'etc/systemd/system/gitlab-runner.service.d'],
      ['/opt/vitana/fleeting-plugins', 'opt/vitana/fleeting-plugins'], ['/etc/gitlab-runner/config.toml', 'etc/gitlab-runner/config.toml'], ['/root/config.toml.XXXXXX', 'root/config.toml.XXXXXX']]) {
      assert.ok(script.includes(from), `the installer uses ${from}`);
      script = script.split(from).join(path.join(T, to));
    }
    writeFileSync(path.join(T, 'installer.sh'), script);
    mkdirSync(path.join(T, 'etc/systemd/system/gitlab-runner.service.d'), { recursive: true });
    const r = spawnSync('bash', [path.join(T, 'installer.sh')], { encoding: 'utf8', env: { PATH: `${path.join(T, 'bin')}:${process.env.PATH}`, LANG: 'C' }, timeout: 30000 });
    const readIf = (rel) => (existsSync(path.join(T, rel)) ? readFileSync(path.join(T, rel), 'utf8') : null);
    return {
      T, status: r.status, stdout: r.stdout, stderr: r.stderr, calls: readIf('calls.log') ?? '',
      config: readIf('etc/gitlab-runner/config.toml'), dropin: readIf('etc/systemd/system/gitlab-runner.service.d/fleeting.conf'),
      mode: existsSync(path.join(T, 'etc/gitlab-runner/config.toml')) ? statSync(path.join(T, 'etc/gitlab-runner/config.toml')).mode & 0o777 : null,
      leftovers: readdirSync(path.join(T, 'root')),
    };
  } finally {
    if (!process.env.FLEET_KEEP_TMP) rmSync(T, { recursive: true, force: true });
  }
}

test('installer, run against stub commands: waits for the token, installs the pinned runner, writes config.toml private, installs the plugin, restarts, prints no token', () => {
  const r = runInstaller({ answers: [NOT_FOUND, NOT_FOUND, FAKE_TOKEN] });
  assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /== fleet manager install start/);
  assert.match(out, /== fleet manager install done/);
  assert.match(out, /waiting for the runner token in vitana\/engineering\/gitlab\/fleet-runner-token/);
  assert.equal(out.includes(FAKE_TOKEN) || r.calls.includes(FAKE_TOKEN), false, 'the token is in neither the output nor any command line');
  assert.equal(r.calls.split('\n').filter((l) => l.startsWith('aws secretsmanager')).length, 3, 'asked three times: two empty answers, then the token');
  assert.equal(r.calls.split('\n').filter((l) => l === 'sleep 30').length, 2, 'one 30 s pause after each empty answer');
  // the pinned runner, held back; no Docker
  assert.match(r.calls, /apt-get -o DPkg::Lock::Timeout=900 install -y gitlab-runner-helper-images=19\.5\.2-1 gitlab-runner=19\.5\.2-1$/m);
  assert.match(r.calls, /^apt-mark hold gitlab-runner gitlab-runner-helper-images$/m);
  assert.equal(/docker/.test(r.calls.replace(/docker-autoscaler/g, '')), false, 'nothing about Docker is installed on the manager');
  // config.toml: private, from the env file, with the token
  assert.equal(r.mode, 0o600, 'config.toml holds the token and is mode 0600');
  assert.match(r.calls, /^install -m 0600 -o root -g root \S+\/root\/config\.toml\.\S+ \S+\/etc\/gitlab-runner\/config\.toml$/m);
  const toml = parseToml(r.config);
  assert.equal(toml.runners[0].token, FAKE_TOKEN);
  assert.equal(toml.concurrent, 24);
  assert.equal(toml.runners[0].autoscaler.max_instances, 24);
  assert.equal(toml.runners[0].autoscaler.plugin_config.name, 'vitana-eng-fleet');
  assert.deepEqual(r.leftovers, [], 'the temporary copy of config.toml is removed');
  // the plugin: installed after config.toml exists, with the same folder the service uses
  const fleeting = r.calls.split('\n').find((l) => l.startsWith('gitlab-runner fleeting install'));
  assert.ok(fleeting, 'gitlab-runner fleeting install ran');
  assert.match(fleeting, /config_present=yes/, 'it ran after config.toml was written');
  assert.match(fleeting, new RegExp(`FLEETING_PLUGIN_PATH=${esc(r.T)}/opt/vitana/fleeting-plugins CONFIG_FILE=${esc(r.T)}/etc/gitlab-runner/config\\.toml`));
  assert.match(r.dropin, new RegExp(`Environment=FLEETING_PLUGIN_PATH=${esc(r.T)}/opt/vitana/fleeting-plugins`), 'the service gets the same plugin folder');
  assert.match(r.dropin, /Environment=HOME=\/root/);
  const order = ['apt-mark hold gitlab-runner', 'systemctl daemon-reload', 'install -m 0600', 'gitlab-runner fleeting install', 'gitlab-runner fleeting list', 'systemctl enable gitlab-runner', 'systemctl restart gitlab-runner', 'gitlab-runner verify']
    .map((needle) => r.calls.indexOf(needle));
  assert.ok(order.every((i) => i >= 0), `every step ran: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in this order');
  // the verify line is scrubbed, the plugin version is logged
  assert.match(out, /Verifying runner\.\.\. is alive runner=\*\*\*/);
  assert.equal(out.includes('t1_ABCDEFGH'), false);
  assert.match(out, /aws\s+1\.2\.3/, 'the installed plugin version is in the log');
});

test('installer, run against stub commands: no token means no config.toml, no plugin, a non-zero exit and a plain message', () => {
  const r = runInstaller({ answers: [NOT_FOUND] });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /no runner token after 24 hours/);
  assert.equal(r.config, null, 'config.toml is not written');
  assert.equal(/fleeting install/.test(r.calls), false);
  assert.equal(/systemctl restart gitlab-runner/.test(r.calls), false, 'the runner is not started without a token');
  assert.match(r.calls, /apt-mark hold gitlab-runner/, 'but the pinned runner is installed, so a repeat only has the rest to do');
});

test('installer, run against stub commands: a secret value that is not a runner token is waited out, never written', () => {
  const wrong = ['glpat', 'NOT-A-RUNNER-TOKEN-0000'].join('-');
  const r = runInstaller({ answers: [wrong, 'null', NOT_FOUND, FAKE_TOKEN] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.calls.split('\n').filter((l) => l.startsWith('aws secretsmanager')).length, 4, 'three answers that are not a glrt- token were refused');
  assert.equal(r.calls.split('\n').filter((l) => l === 'sleep 30').length, 3);
  assert.equal(parseToml(r.config).runners[0].token, FAKE_TOKEN, 'only the real token reaches config.toml');
  assert.equal(r.config.includes(wrong), false);
  assert.equal((r.stdout + r.stderr + r.calls).includes(wrong), false, 'a wrong value is not echoed either');
});

// eng-gitlab-m2/runner-pin-jq: apt took the newest gitlab-runner-helper-images (19.5.3-1) next to gitlab-runner 19.5.2-1 and refused
// ("held broken packages"), so the fleet manager never installed the runner (bootstrap log 2026-11-06T21:55Z). Both installers pin
// and hold the helper with the runner, in the same apt call.
nodeTest('both runner installers pin and hold gitlab-runner-helper-images at the runner version, in the same apt install', () => {
  for (const f of ['host/fleet-manager-install.sh', 'host/runner-install.sh']) {
    const code = read(f).split('\n').map((l) => l.replace(/(^|\s)#.*$/, '')).join('\n');
    assert.match(code, /apt install -y "gitlab-runner-helper-images=\$RUNNER_VERSION" "gitlab-runner=\$RUNNER_VERSION" \|\| exit 1/, `${f}: helper and runner pinned together`);
    assert.match(code, /apt-mark hold gitlab-runner gitlab-runner-helper-images/, `${f}: both held`);
    assert.equal(/apt install -y "gitlab-runner=\$RUNNER_VERSION" \|\| exit 1/.test(code), false, `${f}: no runner install without the helper`);
  }
});
