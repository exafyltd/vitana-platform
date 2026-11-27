// Static contract tests for the PostgREST-Aurora proxy route profiles (route isolation, phase 1).
// They read repository files and render templates. They run no Docker and no AWS command and read no secret value.
// The behavior of the built staging image under real nginx is tested by behavior.test.mjs (Docker).
//   node --test services/postgrest-aurora-proxy/test-route-isolation/config-contract.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { render, ALLOWLIST } from './render.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.resolve(HERE, '..');
const ROOT = path.resolve(PROXY, '..', '..');
const FX = path.join(HERE, 'fixtures');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));

const LEGACY = read(path.join(PROXY, 'nginx.conf.template'));
const STAGING = read(path.join(PROXY, 'nginx.staging.conf.template'));
const DOCKERFILE = read(path.join(PROXY, 'Dockerfile'));
const TASK_TEXT = read(path.join(PROXY, 'task-definition.template.json'));
const TASK = JSON.parse(TASK_TEXT);
const SETUP = read(path.join(ROOT, 'scripts/aws/setup-postgrest-aurora-proxy-staging.sh'));
const DEPLOY = read(path.join(ROOT, '.github/workflows/AWS-STAGE-DEPLOY-POSTGREST-AURORA-PROXY.yml'));
const IMAGE_FX = readJson(path.join(FX, 'image-contract.json'));
const TASK_FX = readJson(path.join(FX, 'task-contract.json'));

// Tripwire values. The production Supabase project ref and the staging probe value must never reach a staging render.
const PROD_HOST = 'inmkhvwdcuyhnxkgfvsb.supabase.co';
const PROBE = 'probe.invalid';
const PUBLIC_HOST = 'data.vitanaland.com';

// Probe paths. Keep this list in step with the B2 and B3 requests in route-isolation.sh.
const PRODUCTION_PROBES = [
  '/auth/v1/health',
  '/auth/v1/token?grant_type=password',
  '/auth/v1/user',
  '/auth/v1',
  '//auth/v1/health',
  '/%61uth/v1/health',
  '/rest/v1/../../auth/v1/health',
  '/AUTH/v1/health',
  '/storage/v1/object/public/a/b.png',
  '/storage/v1/object/b/a.bin',
  '/storage/v1',
  '/functions/v1/ai-chat?x=1',
  '/functions/v1/x',
  '/functions/v1',
  '/realtime/v1/websocket?vsn=1.0.0',
  '/realtime/v1/',
];
const AUTHORIZED_PROBES = [
  ['/alive', 'prefix /alive'],
  ['/rest/v1/profiles', 'prefix /rest/v1/'],
  ['/rest/v1/profiles?limit=1', 'prefix /rest/v1/'],
  ['/rest/v1/rpc/fn', 'prefix /rest/v1/rpc/'],
  ['/nope', 'prefix /'],
];

// Model of nginx URI handling for the internal server: decode %XX once, merge repeated slashes, then remove dot
// segments. The request path is matched after this step, and the query string is not part of the path.
function nginxPath(uri) {
  const raw = uri.split('?')[0];
  const decoded = raw.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  const parts = decoded.replace(/\/{2,}/g, '/').split('/');
  const out = [];
  for (let i = 1; i < parts.length; i++) {
    if (parts[i] === '.') continue;
    if (parts[i] === '..') { out.pop(); continue; }
    out.push(parts[i]);
  }
  return `/${out.join('/')}`;
}

// Location model built from the internal server of a template: regex locations first, in file order, then the
// longest matching prefix. It returns the name of the location that nginx would select.
function locationModel(template) {
  const start = template.indexOf('listen 8080 default_server;');
  const end = template.indexOf('# ---------------- PUBLIC');
  assert.ok(start > 0 && end > start, 'internal server block found');
  const internal = template.slice(start, end);
  const regex = [...internal.matchAll(/^\s*location ~(\*?) (\S+) \{/gm)]
    .map((m) => ({ name: `regex ${m[2]}`, re: new RegExp(m[2], m[1] ? 'i' : '') }));
  const prefix = [...internal.matchAll(/^\s*location (\/\S*) \{/gm)].map((m) => ({ name: `prefix ${m[1]}`, p: m[1] }));
  return (uri) => {
    const p = nginxPath(uri);
    const hit = regex.find((r) => r.re.test(p));
    if (hit) return hit.name;
    const best = prefix.filter((x) => p.startsWith(x.p)).sort((a, b) => b.p.length - a.p.length)[0];
    return best ? best.name : 'none';
  };
}

// Text of a template from the line equal to `start` up to (not including) the first later line equal to `end`.
// With end === null the text runs to the end of the template.
function slice(text, start, end) {
  const lines = text.split('\n');
  const i = lines.indexOf(start);
  assert.notEqual(i, -1, `start line not found: ${start}`);
  let j = lines.length;
  if (end !== null) {
    j = lines.indexOf(end, i + 1);
    assert.notEqual(j, -1, `end line not found after ${start}: ${end}`);
  }
  return lines.slice(i, j).join('\n');
}

// ---- S4: the production profile is pinned
test('S4 nginx.conf.template (production profile) matches the pinned sha256', () => {
  const sha = crypto.createHash('sha256').update(LEGACY).digest('hex');
  assert.equal(sha, read(path.join(FX, 'legacy-nginx.conf.template.sha256')).trim());
});

// ---- S5: characterization. The production rendering passes SUPABASE_AUTH_HOST into the Supabase upstream, so a
// route gate has to check the rendered text, not only the environment.
for (const host of ['127.0.0.1', PROD_HOST]) {
  test(`S5 production profile, SUPABASE_AUTH_HOST=${host}: the rendered upstream and Host header are that value`, () => {
    const out = render(LEGACY, { SUPABASE_AUTH_HOST: host, PUBLIC_HOST });
    const esc = host.replace(/\./g, '\\.');
    assert.match(out, new RegExp(`upstream supabase_origin \\{\\n\\s+server ${esc}:443;`));
    assert.match(out, new RegExp(`proxy_set_header Host ${esc};`));
  });
}

// ---- S1: the staging profile renders one upstream, every proxy_pass targets postgrest_local, and no Supabase target
const ENV_CASES = [
  ['unset', {}],
  ['empty', { SUPABASE_AUTH_HOST: '' }],
  ['127.0.0.1', { SUPABASE_AUTH_HOST: '127.0.0.1' }],
  ['production host', { SUPABASE_AUTH_HOST: PROD_HOST }],
  ['probe value', { SUPABASE_AUTH_HOST: PROBE }],
];
for (const [label, env] of ENV_CASES) {
  test(`S1 staging profile, SUPABASE_AUTH_HOST ${label}: one upstream, postgrest_local only, no Supabase target`, () => {
    const out = render(STAGING, { PUBLIC_HOST, ...env });
    const upstreams = out.split('\n').filter((l) => /^\s*upstream\s/.test(l)).map((l) => l.trim());
    assert.deepEqual(upstreams, ['upstream postgrest_local {']);
    const targets = [...out.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1].trim());
    assert.ok(targets.length >= 2, 'the rest and rpc routes proxy to PostgREST');
    assert.deepEqual([...new Set(targets)], ['http://postgrest_local']);
    assert.doesNotMatch(out, /https:\/\//);
    assert.equal(out.includes(PROD_HOST), false, 'production host absent');
    assert.equal(out.includes(PROBE), false, 'probe value absent');
    assert.equal(out.includes('127.0.0.1:443'), false, 'no TLS upstream on loopback');
    assert.doesNotMatch(out, /\$\{?(SUPABASE_AUTH_HOST|PUBLIC_HOST)\}?/, 'no unrendered allowlisted variable');
  });
}

test('S1b staging template directives reference no Supabase upstream, resolver, map or TLS upstream', () => {
  const directives = STAGING.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  assert.doesNotMatch(directives, /supabase_origin|SUPABASE_AUTH_HOST/);
  assert.doesNotMatch(directives, /\bresolver\b|\bmap\s+\$|proxy_ssl_|listen\s+443|https:\/\//);
  assert.deepEqual([...new Set([...directives.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)].map((m) => m[1].trim()))],
    ['http://postgrest_local']);
});

// ---- S2: route gate. The model reads the regex and prefix locations from the staging template.
test('S2 model self-check: nginx URI normalization decodes %XX, merges slashes and removes dot segments', () => {
  assert.equal(nginxPath('/rest/v1/../../auth/v1/health'), '/auth/v1/health');
  assert.equal(nginxPath('/%61uth/v1/health'), '/auth/v1/health');
  assert.equal(nginxPath('//auth/v1/health?x=1'), '/auth/v1/health');
  assert.equal(nginxPath('/rest/v1/../auth/v1/health'), '/rest/auth/v1/health', 'one level up is not a Supabase route');
});

test('S2 every production-bound probe is selected by the gate regex, before any proxy_pass', () => {
  const locate = locationModel(STAGING);
  for (const probe of PRODUCTION_PROBES) {
    assert.match(locate(probe), /^regex \^\/\(auth\|storage\|functions\|realtime\)\/v1\(\/\|\$\)$/, probe);
  }
});

test('S2 authorized probes reach their own location in the staging profile', () => {
  const locate = locationModel(STAGING);
  for (const [probe, want] of AUTHORIZED_PROBES) assert.equal(locate(probe), want, probe);
});

// ---- S3: the authorized blocks and the public server block are the production text, byte for byte
const RPC_START = "        # --- RPC calls: /rest/v1/rpc/<fn> -> PostgREST's /rpc/<fn> ---";
const DEFAULT_LOCATION = '        location / {';
const PUBLIC_START = '    # ---------------- PUBLIC: browsers via the ALB ----------------';
test('S3 internal rest and alive blocks are identical to the production profile', () => {
  const want = slice(LEGACY, RPC_START, DEFAULT_LOCATION);
  assert.ok(want.split('\n').length > 10);
  assert.equal(slice(STAGING, RPC_START, DEFAULT_LOCATION), want);
});
test('S3 public server block is identical to the production profile', () => {
  const want = slice(LEGACY, PUBLIC_START, null);
  assert.ok(want.includes('server_name ${PUBLIC_HOST};'));
  assert.equal(slice(STAGING, PUBLIC_START, null), want);
});

// ---- S6: candidate task definition
test('S6 candidate task definition: proxy on 8080 and postgrest on 3000, no port 443, no SUPABASE_AUTH_HOST', () => {
  assert.deepEqual(TASK.containerDefinitions.map((c) => c.name), TASK_FX.containerNames);
  const [proxy, pg] = TASK.containerDefinitions;
  assert.deepEqual(proxy.portMappings.map((p) => p.containerPort), [TASK_FX.proxy.containerPort]);
  assert.deepEqual(proxy.environment, TASK_FX.proxy.environment);
  assert.deepEqual(proxy.healthCheck.command, TASK_FX.proxy.healthCommand);
  assert.deepEqual(pg.portMappings.map((p) => p.containerPort), [TASK_FX.postgrest.containerPort]);
  assert.equal(pg.image, TASK_FX.postgrest.image);
  assert.deepEqual(Object.fromEntries(pg.environment.map((e) => [e.name, e.value])), TASK_FX.postgrest.environment);
  assert.deepEqual(pg.secrets.map((s) => s.name), TASK_FX.postgrest.secretNames);
  assert.equal(TASK_TEXT.includes('SUPABASE_AUTH_HOST'), false);
});

// ---- S7: deploy workflow contract
test('S7 deploy workflow: staging build argument and render check before the push, sidecar check before register', () => {
  const lines = DEPLOY.split('\n');
  const build = lines.findIndex((l) => l.includes('docker build --build-arg PROXY_TEMPLATE=nginx.staging.conf.template'));
  const push = lines.findIndex((l) => l.trim() === 'docker push "$IMAGE"');
  const render = lines.findIndex((l) => l.includes("envsubst '\\$\\${SUPABASE_AUTH_HOST} \\$\\${PUBLIC_HOST}'"));
  const probe = lines.findIndex((l) => l.includes('-e SUPABASE_AUTH_HOST=probe.invalid --entrypoint /bin/sh'));
  assert.equal(lines.filter((l) => l.includes('docker build')).length, 1, 'one docker build');
  assert.ok(build > 0 && push > build, 'build argument precedes the push');
  assert.ok(probe > build && render > probe && render < push, 'render check runs between the build and the push');
  assert.ok(lines.some((l) => l.includes('grep -c -E') && l.includes("'^[[:space:]]*upstream[[:space:]]'")), 'upstream count check');
  assert.ok(lines.some((l) => l.includes("grep -q 'proxy_pass https://'")), 'https proxy_pass check');
  assert.ok(lines.some((l) => l.includes("grep -q 'probe.invalid'")), 'probe value check');
  const roll = lines.findIndex((l) => l.includes('Register task-definition revision + roll the service'));
  const jqDrop = lines.findIndex((l) => l.includes('select(.name != "SUPABASE_AUTH_HOST")'));
  const sidecar = lines.findIndex((l) => l.includes('([.containerDefinitions[].name] | sort) == ["postgrest","proxy"]'));
  const register = lines.findIndex((l) => l.includes('aws ecs register-task-definition'));
  assert.ok(roll > 0 && jqDrop > roll && sidecar > roll, 'SUPABASE_AUTH_HOST drop and sidecar check are in the roll step');
  assert.ok(sidecar < register && sidecar > 0, 'sidecar check precedes the register call');
  assert.equal(DEPLOY.includes('database-url'), false, 'no database-url reference');
});

test('S7 deploy workflow: Secrets Manager names are the names in the fixture', () => {
  const found = [...new Set(DEPLOY.match(/vitana\/(?:aurora|gateway|supabase)\/[A-Za-z0-9_\/-]+/g))].sort();
  assert.deepEqual(found, [...TASK_FX.secretsManagerNames].sort());
});

// ---- S8: setup script contract
test('S8 setup script: the task definition builder never names SUPABASE_AUTH_HOST or the Supabase project ref', () => {
  assert.doesNotMatch(SETUP, /SUPABASE_AUTH_HOST|auth_host|inmkhvwdcuyhnxkgfvsb/);
  assert.equal(SETUP.split('environment:[],').length - 1, 1, 'the proxy container environment is empty');
});

// ---- S9: Dockerfile contract
test('S9 Dockerfile: PROXY_TEMPLATE defaults to the production profile and selects the COPY source; ENV, EXPOSE and CMD are pinned', () => {
  const lines = DOCKERFILE.split('\n');
  assert.equal(lines.filter((l) => /^ARG\s/.test(l)).length, 1, 'one ARG');
  assert.ok(lines.includes('ARG PROXY_TEMPLATE=nginx.conf.template'), 'default is the production profile');
  assert.equal(lines.filter((l) => /^COPY\s/.test(l)).length, 1, 'one COPY');
  assert.ok(lines.includes('COPY ${PROXY_TEMPLATE} /etc/nginx/nginx.conf.template'), 'COPY uses the ARG');
  assert.ok(lines.indexOf('ARG PROXY_TEMPLATE=nginx.conf.template') < lines.indexOf('COPY ${PROXY_TEMPLATE} /etc/nginx/nginx.conf.template'));
  assert.deepEqual(lines.filter((l) => /^(ENV|EXPOSE|CMD)\s/.test(l)), IMAGE_FX.dockerfileLines);
  const cmdNames = [...lines.find((l) => /^CMD\s/.test(l)).matchAll(/\$\$\{([A-Z_]+)\}/g)].map((m) => m[1]);
  assert.deepEqual(cmdNames, IMAGE_FX.allowlist);
  assert.deepEqual([...ALLOWLIST], IMAGE_FX.allowlist);
});

// ---- S10: F1 guard. Only this file names the production Supabase project (PROD_HOST is the tripwire). The Docker
// harness uses the reserved .invalid mock name, and its fail-closed guards are wired into the functions that start
// containers and send requests. The harness runs only under Docker (behavior.test.mjs).
const PROD_REF = PROD_HOST.split('.')[0];

// Body of a shell function in the harness: the lines from "name() {" through the first later line that is exactly "}".
function shellFn(src, name) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => l.startsWith(`${name}() {`));
  assert.notEqual(i, -1, `function ${name} is defined`);
  const j = lines.indexOf('}', i);
  assert.notEqual(j, -1, `function ${name} closes`);
  return lines.slice(i, j + 1).join('\n');
}

test('S10 route-isolation harness: production project ref only in this file; mock alias is .invalid; guards are wired', () => {
  const files = [
    ...fs.readdirSync(HERE).filter((f) => fs.statSync(path.join(HERE, f)).isFile()),
    ...fs.readdirSync(FX).map((f) => path.join('fixtures', f)),
  ];
  const named = files.filter((f) => path.basename(f) !== 'config-contract.test.mjs' && read(path.join(HERE, f)).includes(PROD_REF));
  assert.deepEqual(named, []);
  const harness = read(path.join(HERE, 'route-isolation.sh'));
  assert.match(harness, /^MOCK_AUTH_HOST=mock-supabase\.invalid$/m);
  assert.match(harness, /^AUTH_HOST=\$MOCK_AUTH_HOST$/m);
  assert.doesNotMatch(harness, /\.supabase\.(co|com)\b/);
  assert.match(shellFn(harness, 'require_mock'), /docker inspect/);
  assert.match(shellFn(harness, 'check_auth_host'), /"\$MOCK_AUTH_HOST" \| 127\.0\.0\.1\)/);
  assert.match(shellFn(harness, 'start_proxy'), /\brequire_mock\b/);
  assert.match(shellFn(harness, 'start_proxy'), /check_auth_host "\$\{arg#SUPABASE_AUTH_HOST=\}"/);
  assert.match(shellFn(harness, 'req'), /\brequire_mock\b/);
  assert.match(shellFn(harness, 'b6'), /\brequire_mock\b/);
});
