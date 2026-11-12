// Tests of the settings-as-code sync (plan eng-gitlab-m2 §3.3, lane settings, part A): scripts/eng/gitlab-settings.mjs and
// infra/gitlab-engineering/settings/gitlab-settings.json. GitLab is a stateful fake on the recording fake fetch of lane
// gitlab-client (it knows only the Free-tier endpoints of ENDPOINTS and throws on any other call); AWS Secrets Manager and the
// files under /etc/vitana are in-memory fakes injected through deps. Dependency-free Node (node:test), so UNIT.yml runs it with
// no install. SETTINGS_TRANSCRIPT_FILE=<file> makes the "full apply" test write the call transcript of the evidence folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as settings from './gitlab-settings.mjs';

// Value files the sync wrote through the AWS CLI during a test: each must be gone once the call ends.
const seenSecretFiles = [];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'infra', 'gitlab-engineering', 'settings', 'gitlab-settings.json');
const README_FILE = path.join(ROOT, 'infra', 'gitlab-engineering', 'settings', 'README.md');
const SCRIPT_FILE = path.join(HERE, 'gitlab-settings.mjs');

// Fixture tokens are assembled at run time: the repository's secret scan has no allowlist, and these are not secrets.
const PAT_PREFIX = ['glp', 'at-'].join('');
const RUNNER_PREFIX = ['gl', 'rt-'].join('');
const NOW = Date.parse('2026-11-05T10:30:00Z');
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const inDays = (n) => isoDay(Math.floor(NOW / DAY) * DAY + n * DAY);
const ADMIN_TOKEN = `${PAT_PREFIX}adminAAAAAAAAAAAAAAAA`;
const ADMIN_FILE = '/etc/vitana/settings-admin-token';
const SECRET_FLEET = 'vitana/engineering/gitlab/fleet-runner-token';
const SECRET_WEBHOOK = 'vitana/engineering/gitlab/webhook-signing-token';
const SECRET_AGENT = (u) => `vitana/engineering/gitlab/agents/${u}`;
const SIGNING_TOKEN = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const NEW_SIGNING_TOKEN = `whsec_${Buffer.alloc(32, 9).toString('base64')}`;
const HOOK_URL = 'https://gateway.example.test/api/v1/internal/gitlab/webhook';
const CI_FILES = {
  'platform.gitlab-ci.yml': '# central CI for vitana-platform\nworkflow:\n  rules:\n    - if: $CI_COMMIT_BRANCH == "main"\n',
  'v1.gitlab-ci.yml': '# central CI for vitana-v1\nunit-tests:\n  script: [npm test]\n',
  'rehearsal.gitlab-ci.yml': '# central CI for rehearsal\nunit:\n  script: [node --test]\n',
};
const clone = (v) => JSON.parse(JSON.stringify(v));
const shipped = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const randomToken = () => `${PAT_PREFIX}${crypto.randomBytes(10).toString('hex')}`;

// ── the Free-tier endpoints the sync may call (docs.gitlab.com, the tier banner of each page includes Free) ────────────
export const ENDPOINTS = [
  ['GET', '/license', 'api/license'],
  ['GET', '/personal_access_tokens/self', 'api/personal_access_tokens'],
  ['GET', '/personal_access_tokens', 'api/personal_access_tokens'],
  ['GET', '/personal_access_tokens/:id', 'api/personal_access_tokens'],
  ['POST', '/personal_access_tokens/:id/rotate', 'api/personal_access_tokens'],
  ['DELETE', '/personal_access_tokens/:id', 'api/personal_access_tokens'],
  ['POST', '/users/:id/personal_access_tokens', 'api/user_tokens'],
  ['GET', '/users?username=', 'api/users'],
  ['GET', '/service_accounts', 'api/service_accounts'],
  ['POST', '/service_accounts', 'api/service_accounts'],
  ['GET', '/groups/:path', 'api/groups'],
  ['GET', '/projects/:id', 'api/projects'],
  ['POST', '/projects', 'api/projects'],
  ['PUT', '/projects/:id', 'api/projects'],
  ['GET', '/projects/:id/protected_branches', 'api/protected_branches'],
  ['POST', '/projects/:id/protected_branches', 'api/protected_branches'],
  ['PATCH', '/projects/:id/protected_branches/:name', 'api/protected_branches'],
  ['DELETE', '/projects/:id/protected_branches/:name', 'api/protected_branches'],
  ['GET', '/projects/:id/members', 'api/project_members'],
  ['GET', '/projects/:id/members/all', 'api/project_members'],
  ['POST', '/projects/:id/members', 'api/project_members'],
  ['PUT', '/projects/:id/members/:user_id', 'api/project_members'],
  ['DELETE', '/projects/:id/members/:user_id', 'api/project_members'],
  ['GET', '/projects/:id/hooks', 'api/project_webhooks'],
  ['POST', '/projects/:id/hooks', 'api/project_webhooks'],
  ['PUT', '/projects/:id/hooks/:hook_id', 'api/project_webhooks'],
  ['DELETE', '/projects/:id/hooks/:hook_id', 'api/project_webhooks'],
  ['GET', '/runners/all', 'api/runners'],
  ['GET', '/runners/:id', 'api/runners'],
  ['PUT', '/runners/:id', 'api/runners'],
  ['POST', '/user/runners', 'api/users'],
  ['POST', '/runners/:id/reset_authentication_token', 'api/runners'],
  ['GET', '/projects/:id/repository/files/:path', 'api/repository_files'],
  ['POST', '/projects/:id/repository/commits', 'api/commits'],
];

// ── fake GitLab ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function newGitLab() {
  const s = {
    seq: 100, down: false, fail: [], licence: null, serviceAccountCap: 100, hookSeq: 0, commits: 0,
    users: [{ id: 1, username: 'root', name: 'Administrator', admin: true, service: false }],
    pats: [{ id: 1, user_id: 1, name: 'settings-admin', scopes: ['api'], expires_at: inDays(60), revoked: false, value: ADMIN_TOKEN }],
    groups: [{ id: 10, path: 'vitana' }],
    projects: [],
    runners: [],
  };
  const nextId = () => ++s.seq;
  const ok = (json, status = 200, headers) => ({ status, json, headers });
  const notFound = (what = '404 Not Found') => ({ status: 404, json: { message: what } });
  const bad = (message, status = 400) => ({ status, json: { message } });
  const active = (p) => !p.revoked && (p.expires_at === null || p.expires_at > isoDay(NOW));
  const meta = (p) => ({ id: p.id, name: p.name, revoked: p.revoked, created_at: '2026-11-01T00:00:00.000Z', scopes: p.scopes, user_id: p.user_id, last_used_at: null, active: active(p), expires_at: p.expires_at });
  const page = (call, list) => {
    const per = Number(call.query.per_page?.[0] ?? 20);
    const pg = Number(call.query.page?.[0] ?? 1);
    return ok(list.slice((pg - 1) * per, pg * per), 200, { 'x-next-page': pg * per < list.length ? String(pg + 1) : '' });
  };
  const proj = (key) => {
    const k = decodeURIComponent(key);
    return /^\d+$/.test(k) ? s.projects.find((p) => p.id === Number(k)) : s.projects.find((p) => `vitana/${p.path}` === k);
  };
  const userById = (id) => s.users.find((u) => u.id === Number(id));
  const projectView = (p) => ({
    id: p.id, name: p.name, path: p.path, path_with_namespace: `vitana/${p.path}`, default_branch: p.default_branch, visibility: 'private',
    ci_config_path: p.ci_config_path, merge_method: p.merge_method, squash_option: p.squash_option,
    only_allow_merge_if_pipeline_succeeds: p.only_allow_merge_if_pipeline_succeeds,
    only_allow_merge_if_all_discussions_are_resolved: p.only_allow_merge_if_all_discussions_are_resolved,
    remove_source_branch_after_merge: p.remove_source_branch_after_merge, automatic_rebase_enabled: p.automatic_rebase_enabled,
    squash_commit_template: p.squash_commit_template, merge_commit_template: p.merge_commit_template, empty_repo: p.files.size === 0,
  });
  const memberView = (uid, level) => { const u = userById(uid); return { id: u.id, username: u.username, name: u.name, state: 'active', access_level: level }; };
  const levelName = { 0: 'No one', 30: 'Developers + Maintainers', 40: 'Maintainers' };
  const accessLevel = (level) => ({ id: nextId(), access_level: level, access_level_description: levelName[level] ?? String(level) });
  const branchView = (b) => ({
    id: b.id, name: b.name, push_access_levels: b.push_access_levels, merge_access_levels: b.merge_access_levels,
    unprotect_access_levels: b.unprotect_access_levels, allow_force_push: b.allow_force_push, code_owner_approval_required: false,
  });
  const HOOK_FLAGS = ['push_events', 'tag_push_events', 'issues_events', 'confidential_issues_events', 'note_events', 'confidential_note_events', 'job_events',
    'pipeline_events', 'wiki_page_events', 'deployment_events', 'releases_events', 'milestone_events', 'feature_flag_events', 'resource_access_token_events', 'merge_requests_events'];
  const hookView = (h) => { const { _signing, ...rest } = h; return { ...rest, token_present: false, signing_token_present: Boolean(_signing) }; };
  const runnerList = (r) => ({ id: r.id, description: r.description, paused: r.paused, active: !r.paused, runner_type: r.runner_type, is_shared: true, status: 'online' });
  const runnerView = (r) => ({ ...runnerList(r), tag_list: r.tag_list, run_untagged: r.run_untagged, locked: r.locked, access_level: r.access_level, maximum_timeout: null });
  // names of Premium-only request attributes, assembled at run time so that no file of the repository carries them as text
  const PREMIUM_BODY = [['allowed_to', '_push'], ['allowed_to', '_merge'], ['allowed_to', '_unprotect'], ['code_owner', '_approval_required']].map((x) => x.join(''));

  function addProject({ name, ci_config_path = '', readme = false }) {
    const p = {
      id: nextId(), name, path: name, default_branch: readme ? 'main' : null, ci_config_path,
      merge_method: 'merge', squash_option: 'default_off', only_allow_merge_if_pipeline_succeeds: false,
      only_allow_merge_if_all_discussions_are_resolved: false, remove_source_branch_after_merge: false, automatic_rebase_enabled: false,
      squash_commit_template: null, merge_commit_template: null,
      members: new Map(), branches: [], hooks: [], files: new Map(),
    };
    if (readme) {
      p.files.set('README.md', '# readme\n');
      p.branches.push({ id: nextId(), name: 'main', push_access_levels: [accessLevel(40)], merge_access_levels: [accessLevel(40)], unprotect_access_levels: [accessLevel(40)], allow_force_push: true });
    }
    s.projects.push(p);
    return p;
  }

  // [method, regexp over the path below /api/v4, admin only, handler(match, call, who, body)]
  const routes = [
    ['GET', /^\/license$/, true, () => (s.licence ? ok(s.licence) : notFound())],
    ['GET', /^\/personal_access_tokens\/self$/, false, (m, c, who) => ok(meta(who.pat))],
    ['GET', /^\/personal_access_tokens$/, true, (m, call) => {
      const uid = call.query.user_id?.[0];
      const state = call.query.state?.[0];
      let list = s.pats.filter((p) => (uid === undefined || p.user_id === Number(uid)) && (state !== 'active' || active(p)));
      list = [...list].sort((a, b) => a.id - b.id);
      return page(call, list.map(meta));
    }],
    ['GET', /^\/personal_access_tokens\/(\d+)$/, true, (m) => { const p = s.pats.find((x) => x.id === Number(m[1])); return p ? ok(meta(p)) : notFound(); }],
    ['POST', /^\/personal_access_tokens\/(\d+)\/rotate$/, true, (m, call) => {
      const old = s.pats.find((x) => x.id === Number(m[1]));
      if (!old) return notFound();
      if (!active(old)) return bad('401 Unauthorized', 401);
      old.revoked = true;
      const fresh = { id: nextId(), user_id: old.user_id, name: old.name, scopes: [...old.scopes], expires_at: call.body?.expires_at ?? inDays(7), revoked: false, value: randomToken() };
      s.pats.push(fresh);
      return ok({ ...meta(fresh), token: fresh.value });
    }],
    ['DELETE', /^\/personal_access_tokens\/(\d+)$/, true, (m) => { const p = s.pats.find((x) => x.id === Number(m[1])); if (!p) return notFound(); p.revoked = true; return { status: 204 }; }],
    ['POST', /^\/users\/(\d+)\/personal_access_tokens$/, true, (m, call) => {
      const u = userById(m[1]);
      if (!u) return notFound('404 User Not Found');
      const b = call.body ?? {};
      if (!b.name || !Array.isArray(b.scopes) || b.scopes.length === 0) return bad('name and scopes are required');
      const fresh = { id: nextId(), user_id: u.id, name: b.name, scopes: [...b.scopes], expires_at: b.expires_at ?? null, revoked: false, value: randomToken() };
      s.pats.push(fresh);
      return ok({ ...meta(fresh), token: fresh.value }, 201);
    }],
    ['GET', /^\/users$/, true, (m, call) => ok(s.users.filter((u) => u.username === call.query.username?.[0]).map((u) => ({ id: u.id, username: u.username, name: u.name })))],
    ['GET', /^\/service_accounts$/, true, (m, call) => page(call, s.users.filter((u) => u.service).sort((a, b) => b.id - a.id).map((u) => ({ id: u.id, username: u.username, name: u.name, email: `${u.username}@noreply.test`, public_email: '' })))],
    ['POST', /^\/service_accounts$/, true, (m, call) => {
      const b = call.body ?? {};
      if (s.users.some((u) => u.username === b.username)) return bad('Username has already been taken');
      if (s.users.filter((u) => u.service).length >= s.serviceAccountCap) return bad('You have reached the limit of service accounts for this instance');
      const u = { id: nextId(), username: b.username, name: b.name ?? 'Service account user', admin: false, service: true };
      s.users.push(u);
      return ok({ id: u.id, username: u.username, name: u.name, email: `${u.username}@noreply.test`, public_email: '', external: true }, 201);
    }],
    ['GET', /^\/groups\/([^/]+)$/, true, (m) => { const g = s.groups.find((x) => x.path === decodeURIComponent(m[1])); return g ? ok({ id: g.id, path: g.path }) : notFound('404 Group Not Found'); }],
    ['GET', /^\/projects\/([^/]+)$/, true, (m) => { const p = proj(m[1]); return p ? ok(projectView(p)) : notFound('404 Project Not Found'); }],
    ['POST', /^\/projects$/, true, (m, call) => {
      const b = call.body ?? {};
      if (s.projects.some((p) => p.path === b.path)) return bad('Path has already been taken');
      if (!s.groups.some((g) => g.id === b.namespace_id)) return bad('namespace_id is invalid');
      const p = addProject({ name: b.name, ci_config_path: b.ci_config_path ?? '', readme: b.initialize_with_readme === true });
      return ok(projectView(p), 201);
    }],
    ['PUT', /^\/projects\/([^/]+)$/, true, (m, call) => {
      const p = proj(m[1]);
      if (!p) return notFound('404 Project Not Found');
      for (const [k, v] of Object.entries(call.body ?? {})) {
        if (!(k in projectView(p))) return bad(`unknown project attribute ${k}`);
        p[k] = v;
      }
      return ok(projectView(p));
    }],
    ['GET', /^\/projects\/([^/]+)\/protected_branches$/, true, (m) => { const p = proj(m[1]); return p ? ok(p.branches.map(branchView)) : notFound(); }],
    ['POST', /^\/projects\/([^/]+)\/protected_branches$/, true, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p) return notFound();
      if (PREMIUM_BODY.some((k) => k in b)) return bad('not available on the Free tier');
      if (p.branches.some((x) => x.name === b.name)) return bad('Protected branch already exists', 409);
      const br = { id: nextId(), name: b.name, push_access_levels: [accessLevel(b.push_access_level ?? 40)], merge_access_levels: [accessLevel(b.merge_access_level ?? 40)], unprotect_access_levels: [accessLevel(b.unprotect_access_level ?? 40)], allow_force_push: b.allow_force_push === true };
      p.branches.push(br);
      return ok(branchView(br), 201);
    }],
    ['PATCH', /^\/projects\/([^/]+)\/protected_branches\/([^/]+)$/, true, (m, call) => {
      const p = proj(m[1]);
      const br = p?.branches.find((x) => x.name === decodeURIComponent(m[2]));
      if (!br) return notFound();
      const keys = Object.keys(call.body ?? {});
      if (keys.some((k) => k !== 'allow_force_push')) return bad('only allow_force_push can be changed on Free');
      if (typeof call.body?.allow_force_push === 'boolean') br.allow_force_push = call.body.allow_force_push;
      return ok(branchView(br));
    }],
    ['DELETE', /^\/projects\/([^/]+)\/protected_branches\/([^/]+)$/, true, (m) => {
      const p = proj(m[1]);
      const i = p ? p.branches.findIndex((x) => x.name === decodeURIComponent(m[2])) : -1;
      if (i < 0) return notFound();
      p.branches.splice(i, 1);
      return { status: 204 };
    }],
    ['GET', /^\/projects\/([^/]+)\/members$/, true, (m, call) => { const p = proj(m[1]); return p ? page(call, [...p.members].map(([uid, lvl]) => memberView(uid, lvl))) : notFound(); }],
    ['GET', /^\/projects\/([^/]+)\/members\/all$/, true, (m, call) => {
      const p = proj(m[1]);
      if (!p) return notFound();
      const all = new Map(p.members);
      if (!all.has(1)) all.set(1, 50); // root owns the group, so it holds Owner on every project
      return page(call, [...all].map(([uid, lvl]) => memberView(uid, lvl)));
    }],
    ['POST', /^\/projects\/([^/]+)\/members$/, true, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p || !userById(b.user_id)) return notFound();
      if (![20, 30, 40].includes(b.access_level)) return bad('access_level is invalid');
      if (p.members.has(b.user_id)) return bad('Member already exists', 409);
      p.members.set(b.user_id, b.access_level);
      return ok(memberView(b.user_id, b.access_level), 201);
    }],
    ['PUT', /^\/projects\/([^/]+)\/members\/(\d+)$/, true, (m, call) => {
      const p = proj(m[1]);
      const uid = Number(m[2]);
      if (!p || !p.members.has(uid)) return notFound();
      p.members.set(uid, call.body.access_level);
      return ok(memberView(uid, call.body.access_level));
    }],
    ['DELETE', /^\/projects\/([^/]+)\/members\/(\d+)$/, true, (m) => {
      const p = proj(m[1]);
      if (!p || !p.members.delete(Number(m[2]))) return notFound();
      return { status: 204 };
    }],
    ['GET', /^\/projects\/([^/]+)\/hooks$/, true, (m) => { const p = proj(m[1]); return p ? ok(p.hooks.map(hookView)) : notFound(); }],
    ['POST', /^\/projects\/([^/]+)\/hooks$/, true, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p) return notFound();
      if (!b.url) return bad('url is required');
      if (b.signing_token !== undefined && !/^whsec_[A-Za-z0-9+/]{43}=$/.test(b.signing_token)) return bad('signing_token must be whsec_<base64 of 32 bytes>', 422);
      const h = { id: ++s.hookSeq, url: b.url, name: b.name ?? '', description: b.description ?? '', project_id: p.id, enable_ssl_verification: b.enable_ssl_verification ?? true, _signing: b.signing_token ?? null };
      for (const f of HOOK_FLAGS) h[f] = b[f] ?? (f === 'push_events'); // GitLab turns push events on unless told otherwise
      p.hooks.push(h);
      return ok(hookView(h), 201);
    }],
    ['PUT', /^\/projects\/([^/]+)\/hooks\/(\d+)$/, true, (m, call) => {
      const p = proj(m[1]);
      const h = p?.hooks.find((x) => x.id === Number(m[2]));
      if (!h) return notFound();
      const b = call.body ?? {};
      if (b.signing_token !== undefined && !/^whsec_[A-Za-z0-9+/]{43}=$/.test(b.signing_token)) return bad('signing_token must be whsec_<base64 of 32 bytes>', 422);
      for (const [k, v] of Object.entries(b)) { if (k === 'signing_token') h._signing = v; else h[k] = v; }
      return ok(hookView(h));
    }],
    ['DELETE', /^\/projects\/([^/]+)\/hooks\/(\d+)$/, true, (m) => {
      const p = proj(m[1]);
      const i = p ? p.hooks.findIndex((x) => x.id === Number(m[2])) : -1;
      if (i < 0) return notFound();
      p.hooks.splice(i, 1);
      return { status: 204 };
    }],
    ['GET', /^\/runners\/all$/, true, (m, call) => page(call, s.runners.filter((r) => !call.query.type || r.runner_type === call.query.type[0]).map(runnerList))],
    ['GET', /^\/runners\/(\d+)$/, true, (m) => { const r = s.runners.find((x) => x.id === Number(m[1])); return r ? ok(runnerView(r)) : notFound(); }],
    ['PUT', /^\/runners\/(\d+)$/, true, (m, call) => {
      const r = s.runners.find((x) => x.id === Number(m[1]));
      if (!r) return notFound();
      for (const [k, v] of Object.entries(call.body ?? {})) r[k] = k === 'tag_list' ? String(v).split(',').filter(Boolean) : v;
      return ok(runnerView(r));
    }],
    ['POST', /^\/user\/runners$/, true, (m, call) => {
      const b = call.body ?? {};
      if (b.runner_type !== 'instance_type') return bad('runner_type is invalid');
      const r = { id: nextId(), description: b.description ?? '', tag_list: String(b.tag_list ?? '').split(',').filter(Boolean), run_untagged: b.run_untagged ?? true, locked: b.locked ?? false, access_level: b.access_level ?? 'not_protected', paused: b.paused ?? false, runner_type: 'instance_type', token: `${RUNNER_PREFIX}${crypto.randomBytes(10).toString('hex')}` };
      s.runners.push(r);
      return ok({ id: r.id, token: r.token, token_expires_at: null }, 201);
    }],
    ['POST', /^\/runners\/(\d+)\/reset_authentication_token$/, true, (m) => {
      const r = s.runners.find((x) => x.id === Number(m[1]));
      if (!r) return notFound();
      r.token = `${RUNNER_PREFIX}${crypto.randomBytes(10).toString('hex')}`;
      return ok({ token: r.token, token_expires_at: null }, 201);
    }],
    ['GET', /^\/projects\/([^/]+)\/repository\/files\/([^/]+)$/, true, (m, call) => {
      const p = proj(m[1]);
      const name = decodeURIComponent(m[2]);
      if (!p || call.query.ref?.[0] !== 'main' || !p.files.has(name)) return notFound('404 File Not Found');
      const content = p.files.get(name);
      return ok({ file_name: name, file_path: name, encoding: 'base64', content: Buffer.from(content).toString('base64'), content_sha256: crypto.createHash('sha256').update(content).digest('hex'), ref: 'main', last_commit_id: 'c'.repeat(40) });
    }],
    ['POST', /^\/projects\/([^/]+)\/repository\/commits$/, true, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p || b.branch !== 'main' || p.default_branch !== 'main') return bad('branch main does not exist');
      for (const a of b.actions ?? []) {
        if (a.action === 'create' && p.files.has(a.file_path)) return bad(`A file with this name already exists: ${a.file_path}`);
        if (a.action === 'update' && !p.files.has(a.file_path)) return bad(`A file with this name doesn't exist: ${a.file_path}`);
        if (!['create', 'update'].includes(a.action)) return bad('the sync only creates and updates files');
      }
      for (const a of b.actions ?? []) p.files.set(a.file_path, a.encoding === 'base64' ? Buffer.from(a.content, 'base64').toString('utf8') : a.content);
      s.commits += 1;
      return ok({ id: crypto.createHash('sha1').update(String(s.commits)).digest('hex'), title: b.commit_message }, 201);
    }],
  ];

  const f = fakeFetch();
  f.route('*', () => true, (call) => {
    if (s.down) return { networkError: 'ECONNREFUSED' };
    const hit = s.fail.find((x) => x.times > 0 && x.method === call.method && x.re.test(call.path));
    if (hit) { hit.times -= 1; return { status: hit.status, json: typeof hit.json === 'function' ? hit.json(call) : hit.json }; }
    const rel = call.path.replace(/^\/api\/v4/, '');
    const secret = call.headers['private-token'];
    const pat = s.pats.find((p) => p.value === secret && active(p));
    const who = pat ? { pat, user: userById(pat.user_id) } : null;
    const route = routes.find(([method, re]) => method === call.method && re.test(rel));
    if (!route) throw new Error(`fake GitLab: no Free-tier route for ${call.method} ${rel}`);
    if (!who) return { status: 401, json: { message: '401 Unauthorized' } };
    if (route[2] && !who.user.admin) return { status: 403, json: { message: '403 Forbidden' } };
    return route[3](rel.match(route[1]), call, who);
  });

  const gl = {
    s, fetch: f, addProject, meta,
    project: (name) => s.projects.find((p) => p.path === name),
    userByName: (name) => s.users.find((u) => u.username === name),
    patsOf: (username) => s.pats.filter((p) => p.user_id === gl.userByName(username)?.id),
    activePats: (username) => gl.patsOf(username).filter(active),
    runner: (description) => s.runners.find((r) => r.description === description),
    branch: (name, branch = 'main') => gl.project(name).branches.find((b) => b.name === branch),
    failNext: (method, re, status = 503, json = { message: 'boom' }, times = 1) => s.fail.push({ method, re, status, json, times }),
    tokenValues: () => s.pats.map((p) => p.value),
  };
  return gl;
}

/** What the M1 bundle leaves behind: the group, ci-config, the two mirrored projects, the mirror user and the persistent runner. */
function seedM1(gl) {
  const s = gl.s;
  s.users.push({ id: 50, username: 'vitana-mirror', name: 'Vitana mirror', admin: false, service: false });
  const cfg = gl.addProject({ name: 'ci-config', readme: true });
  cfg.files.set('platform.gitlab-ci.yml', 'm1 platform ci\n');
  cfg.files.set('v1.gitlab-ci.yml', 'm1 v1 ci\n');
  cfg.members.set(50, 20);
  for (const [name, ci] of [['vitana-platform', 'platform.gitlab-ci.yml@vitana/ci-config:main'], ['vitana-v1', 'v1.gitlab-ci.yml@vitana/ci-config:main']]) {
    gl.addProject({ name, ci_config_path: ci, readme: true }).members.set(50, 40);
  }
  s.runners.push({ id: 5, description: 'vitana-eng-1', tag_list: ['vitana-eng'], run_untagged: false, locked: false, access_level: 'not_protected', paused: false, runner_type: 'instance_type', token: `${RUNNER_PREFIX}legacy0123456789ab` });
}

// ── fake AWS Secrets Manager and fake /etc/vitana ─────────────────────────────────────────────────────────────────────────────
function awsError(code, text) { return Object.assign(new Error(`An error occurred (${code}) when calling the operation: ${text}`), { stderr: `An error occurred (${code}): ${text}` }); }
function newAws() {
  const secrets = new Map(); // name -> string, or null for a secret that exists and has no value yet
  const calls = [];
  const denied = new Set();
  const aws = async (args, opts = {}) => {
    calls.push({ args: [...args], input: opts.input });
    const [service, op] = args;
    assert.equal(service, 'secretsmanager');
    const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
    assert.equal(opt('--region'), 'eu-central-1');
    const id = opt('--secret-id') ?? opt('--name');
    const valueFile = args.find((a) => a.startsWith('file://'));
    if (valueFile) seenSecretFiles.push(valueFile.slice('file://'.length));
    if (denied.has(`${op}:${id}`)) throw awsError('AccessDeniedException', 'not authorized');
    if (op === 'get-secret-value') {
      if (!secrets.has(id)) throw awsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.");
      if (secrets.get(id) === null) throw awsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret value for VersionStage: AWSCURRENT");
      return { stdout: `${secrets.get(id)}\n` };
    }
    if (op === 'put-secret-value' || op === 'create-secret') {
      const src = opt('--secret-string');
      assert.match(src, /^file:\/\/.+\/value$/, 'a secret value is never a command-line argument: the CLI reads it from a private file');
      const stored = fs.readFileSync(src.slice('file://'.length), 'utf8');
      assert.ok(stored.length > 8, 'the stored value is a real secret, not an empty placeholder');
      assert.ok(!args.some((a) => a.includes(stored)), 'the value is not in the argument list');
      assert.equal(fs.statSync(src.slice('file://'.length)).mode & 0o777, 0o600, 'the value file is private (0600)');
      assert.equal(fs.statSync(path.dirname(src.slice('file://'.length))).mode & 0o777, 0o700, 'its directory is private (0700)');
      if (op === 'put-secret-value' && !secrets.has(id)) throw awsError('ResourceNotFoundException', "Secrets Manager can't find the specified secret.");
      if (op === 'create-secret' && secrets.has(id)) throw awsError('ResourceExistsException', 'already exists');
      secrets.set(id, stored);
      return { stdout: '{"Name":"x"}' };
    }
    throw new Error(`unexpected aws call ${op}`);
  };
  aws.calls = calls;
  aws.secrets = secrets;
  aws.deny = (op, id) => denied.add(`${op}:${id}`);
  aws.allow = (op, id) => denied.delete(`${op}:${id}`);
  aws.writes = () => calls.filter((c) => c.args[1] !== 'get-secret-value');
  return aws;
}

function newFs() {
  const files = new Map(); // path -> { text, mode }
  const writes = [];
  const err = () => Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
  const x = {
    files, writes, readOnly: false,
    async readFile(p) { return files.has(p) ? { ...files.get(p) } : null; },
    async writeAtomic(p, text, { mode } = {}) { if (x.readOnly) throw err(); files.set(p, { text, mode }); writes.push({ path: p, mode, text }); },
    async preflight() { if (x.readOnly) throw err(); },
    async listYml(dir) { return [...files.keys()].filter((k) => path.posix.dirname(k) === dir && k.endsWith('.yml')).map((k) => path.posix.basename(k)).sort(); },
  };
  return x;
}

// ── the world of one scenario ───────────────────────────────────────────────────────────────────────────────────────────────
function newWorld({ m1 = true, config = shipped(), preCreateAgentSecrets = false } = {}) {
  const gl = newGitLab();
  if (m1) seedM1(gl);
  const aws = newAws();
  const fsx = newFs();
  const lines = [];
  fsx.files.set('/repo/settings.json', { text: JSON.stringify(config, null, 2), mode: 0o644 });
  for (const [name, text] of Object.entries(CI_FILES)) fsx.files.set(`/repo/ci/${name}`, { text, mode: 0o644 });
  fsx.files.set('/repo/ci/README.md', { text: 'not a pipeline file\n', mode: 0o644 });
  fsx.files.set(ADMIN_FILE, { text: `${ADMIN_TOKEN}\n`, mode: 0o600 });
  aws.secrets.set(SECRET_FLEET, null); // Terraform creates the empty secret (plan §3.2)
  aws.secrets.set(SECRET_WEBHOOK, SIGNING_TOKEN);
  if (preCreateAgentSecrets) for (const a of config.accounts) aws.secrets.set(SECRET_AGENT(a.username), null);
  const order = []; // GitLab calls, Secrets Manager calls and file writes in the order they happened
  const trackedAws = Object.assign(async (args, opts) => { order.push(`aws ${args[1]} ${args[args.indexOf('--secret-id') + 1] ?? args[args.indexOf('--name') + 1]}`); return aws(args, opts); }, aws);
  const trackedFs = Object.assign(Object.create(fsx), { writeAtomic: async (p, text, o) => { order.push(`file ${p}`); return fsx.writeAtomic(p, text, o); } });
  Object.defineProperty(trackedFs, 'files', { value: fsx.files });
  const trackedFetch = async (url, init) => { order.push(`${init.method} ${new URL(url).pathname.replace('/api/v4', '')}`); return gl.fetch(url, init); };
  const deps = { fetch: trackedFetch, sleep: async () => {}, now: () => NOW, env: { REGION: 'eu-central-1', DOMAIN: 'gitlab.vitanaland.com' }, aws: trackedAws, fs: trackedFs, stdout: (l) => lines.push(String(l)) };
  const baseArgs = ['--config', '/repo/settings.json', '--ci-dir', '/repo/ci', '--url', 'https://gitlab.test', '--admin-token-file', ADMIN_FILE];
  const w = {
    gl, f: gl.fetch, aws, fsx, lines, deps, baseArgs, order,
    cli: (...argv) => settings.main([...baseArgs, ...argv], deps),
    run: (command = 'apply', extra = {}) => settings.run({ command, configFile: '/repo/settings.json', ciDir: '/repo/ci', url: 'https://gitlab.test', adminTokenFile: ADMIN_FILE, dryRun: false, ...extra }, deps),
    mark: () => ({ f: w.f.mark(), aws: aws.calls.length, fs: fsx.writes.length, lines: lines.length }),
    writesSince: (m) => ({ gitlab: w.f.writes(m.f), aws: aws.writes().filter((c) => aws.calls.indexOf(c) >= m.aws), fs: fsx.writes.slice(m.fs) }),
    setConfig: (c) => fsx.files.set('/repo/settings.json', { text: JSON.stringify(c, null, 2), mode: 0o644 }),
    text: () => lines.join('\n'),
    events: () => lines.filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)),
    secretValue: (name) => aws.secrets.get(name),
  };
  return w;
}
const callsOf = (f, method, re, mark = 0) => f.since(mark).filter((c) => c.method === method && re.test(c.path));
const noWritesAt = (w, m, label = 'second run') => {
  const x = w.writesSince(m);
  assert.deepEqual([x.gitlab.map((c) => `${c.method} ${c.path}`), x.aws.map((c) => c.args[1]), x.fs.map((c) => c.path)], [[], [], []], `${label}: no write to GitLab, Secrets Manager or /etc/vitana`);
};
async function applied(w) {
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0, `apply failed: ${JSON.stringify(r.failed)}\n${w.text().slice(-1500)}`);
  return r;
}

// ═════════════════════════════════════════ schema, validation, profiles ═════════════════════════════════════════════════════
test('config: the shipped file is schema version 1 with the accounts, roles, projects and profiles of plan 3.3', () => {
  const c = settings.validateConfig(shipped());
  assert.equal(c.schema_version, 1);
  assert.equal(c.group, 'vitana');
  assert.deepEqual(c.owners, ['root']);
  assert.deepEqual(c.tokens, { lifetime_days: 90, rotate_below_days: 30 });
  assert.deepEqual(Object.fromEntries(c.accounts.map((a) => [a.username, a.role])), {
    'agent-kiro-exafy': 'developer', 'agent-kiro-exafyltd': 'developer', 'agent-kiro-jtadic': 'developer', 'agent-kiro-hotmail': 'developer',
    'agent-reviewer': 'developer', 'bot-land': 'maintainer', 'bot-metrics': 'reporter',
  });
  assert.deepEqual(Object.keys(c.projects), ['vitana-platform', 'vitana-v1', 'rehearsal']);
  for (const n of ['vitana-platform', 'vitana-v1']) assert.deepEqual([c.projects[n].profile, c.projects[n].landing, c.projects[n].rehearsal, c.projects[n].webhook], ['mirror', false, false, null], `${n} is a mirror project`);
  assert.deepEqual([c.projects.rehearsal.profile, c.projects.rehearsal.landing, c.projects.rehearsal.rehearsal, c.projects.rehearsal.webhook], ['native', true, true, null]);
  for (const n of ['vitana-platform', 'vitana-v1']) {
    assert.deepEqual(c.accounts.filter((a) => a.projects.includes(n)).map((a) => a.username), ['bot-metrics'], `${n} has no agent member`);
  }
  const byName = Object.fromEntries(c.accounts.map((a) => [a.username, a]));
  assert.equal(byName['bot-land'].token_file, '/etc/vitana/bot-land-token');
  assert.equal(byName['bot-metrics'].token_file, '/etc/vitana/bot-metrics-token');
  assert.deepEqual(c.accounts.filter((a) => a.token_file).map((a) => a.username), ['bot-land', 'bot-metrics']);
  assert.deepEqual(byName['bot-metrics'].scopes, ['read_api'], 'the Reporter bot only reads');
  assert.deepEqual(c.runners.legacy, { description: 'vitana-eng-1', tags: ['vitana-legacy'], paused: false });
  assert.deepEqual(c.runners.fleet, { description: 'vitana-eng-fleet', tags: ['vitana-eng'] });
  assert.deepEqual(c.accounts.find((a) => a.role === 'maintainer').projects, ['rehearsal'], 'bot-land is Maintainer where it lands');
  assert.deepEqual(c.projects.rehearsal.required_jobs, ['unit'], 'must name a job of ci/rehearsal.gitlab-ci.yml: the bot refuses a merge request whose required job is absent');
  assert.deepEqual([c.projects['vitana-platform'].ci_file, c.projects['vitana-v1'].ci_file, c.projects.rehearsal.ci_file], ['platform.gitlab-ci.yml', 'v1.gitlab-ci.yml', 'rehearsal.gitlab-ci.yml']);
});

test('config: the shipped file satisfies what the merge bot reads (group, projects.<name>.landing and required_jobs)', () => {
  const s = shipped();
  assert.equal(typeof s.group, 'string');
  for (const [name, p] of Object.entries(s.projects)) {
    assert.equal(typeof p.landing, 'boolean', `${name}.landing`);
    assert.ok(Array.isArray(p.required_jobs) && p.required_jobs.every((j) => typeof j === 'string'), `${name}.required_jobs`);
  }
  assert.deepEqual(Object.entries(s.projects).filter(([, p]) => p.landing).map(([n]) => n), ['rehearsal']);
});

const INVALID = [
  ['the root is not an object', (c) => [], /settings/],
  ['schema version 2', (c) => { c.schema_version = 2; }, /schema_version/],
  ['no group', (c) => { delete c.group; }, /group/],
  ['a group path with a space', (c) => { c.group = 'bad group'; }, /group/],
  ['plain http URL', (c) => { c.gitlab_url = 'http://gitlab.example.test'; }, /gitlab_url/],
  ['no owner', (c) => { c.owners = []; }, /owners/],
  ['a duplicate owner', (c) => { c.owners = ['root', 'root']; }, /owners/],
  ['an unknown top-level key', (c) => { c.surprise = 1; }, /surprise/],
  ['a token lifetime above 90 days', (c) => { c.tokens.lifetime_days = 365; }, /tokens\.lifetime_days/],
  ['rotation threshold not below the lifetime', (c) => { c.tokens.rotate_below_days = 90; }, /tokens\.rotate_below_days/],
  ['the legacy runner keeps the fleet tag', (c) => { c.runners.legacy.tags = ['vitana-eng']; }, /runners\.legacy\.tags/],
  ['no fleet tag', (c) => { c.runners.fleet.tags = []; }, /runners\.fleet\.tags/],
  ['an unknown role', (c) => { c.accounts[0].role = 'owner'; }, /accounts\[0\]\.role/],
  ['an account on an unknown project', (c) => { c.accounts[0].projects = ['nope']; }, /accounts\[0\]\.projects\[0\]/],
  ['a duplicate username', (c) => { c.accounts[1].username = c.accounts[0].username; }, /accounts\[1\]\.username/],
  ['an account named like an owner', (c) => { c.accounts[2].username = 'root'; }, /accounts\[2\]\.username/],
  ['an upper-case username', (c) => { c.accounts[2].username = 'Agent-X'; }, /accounts\[2\]\.username/],
  ['a scope that grants too much', (c) => { c.accounts[0].scopes = ['api', 'sudo']; }, /accounts\[0\]\.scopes\[1\]/],
  ['a token file outside /etc/vitana', (c) => { c.accounts[5].token_file = '/tmp/bot-land-token'; }, /accounts\[5\]\.token_file/],
  ['a token file with a dot segment', (c) => { c.accounts[5].token_file = '/etc/vitana/../shadow'; }, /accounts\[5\]\.token_file/],
  ['two accounts sharing a token file', (c) => { c.accounts[6].token_file = c.accounts[5].token_file; }, /accounts\[6\]\.token_file/],
  ['an unknown profile', (c) => { c.projects['vitana-v1'].profile = 'weird'; }, /projects\.vitana-v1\.profile/],
  ['landing on a mirror project', (c) => { c.projects['vitana-v1'].landing = true; }, /projects\.vitana-v1\.landing/],
  ['a rehearsal project that is mirrored', (c) => { c.projects.rehearsal.profile = 'mirror'; c.projects.rehearsal.landing = false; }, /projects\.rehearsal\.rehearsal/],
  ['a rehearsal project with a webhook', (c) => { c.projects.rehearsal.webhook = { url: HOOK_URL, events: ['pipeline'] }; }, /projects\.rehearsal\.webhook/],
  ['required_jobs that is not a list', (c) => { c.projects.rehearsal.required_jobs = 'unit'; }, /projects\.rehearsal\.required_jobs/],
  ['an unknown project key', (c) => { c.projects.rehearsal.nope = true; }, /projects\.rehearsal\.nope/],
  ['a CI file outside the CI folder', (c) => { c.projects.rehearsal.ci_file = '../x.yml'; }, /projects\.rehearsal\.ci_file/],
  ['a webhook over plain http', (c) => { c.projects['vitana-v1'].webhook = { url: 'http://gateway.example.test/hook', events: ['pipeline'] }; }, /projects\.vitana-v1\.webhook\.url/],
  ['a webhook event the gateway does not map', (c) => { c.projects['vitana-v1'].webhook = { url: HOOK_URL, events: ['push'] }; }, /projects\.vitana-v1\.webhook\.events\[0\]/],
  ['a webhook with no events', (c) => { c.projects['vitana-v1'].webhook = { url: HOOK_URL, events: [] }; }, /projects\.vitana-v1\.webhook\.events/],
];
test('config: every invalid input is refused with an error that names the key', () => {
  for (const [label, mutate, key] of INVALID) {
    const c = clone(shipped());
    const replaced = mutate(c);
    const input = replaced !== undefined ? replaced : c;
    assert.throws(() => settings.validateConfig(input), (err) => {
      assert.ok(err instanceof settings.ConfigError, `${label}: a ConfigError`);
      assert.match(err.message, key, `${label}: names the key`);
      return true;
    }, label);
  }
  assert.doesNotThrow(() => settings.validateConfig(shipped()), 'the unmutated file is valid');
});

test('config: a project with a webhook, and defaults for what the file leaves out, are accepted', () => {
  const c = clone(shipped());
  c.projects['vitana-v1'].webhook = { url: HOOK_URL, events: ['merge_request', 'pipeline'] };
  delete c.projects['vitana-platform'].required_jobs;
  delete c.projects['vitana-platform'].rehearsal;
  delete c.projects['vitana-platform'].landing;
  delete c.accounts[0].scopes;
  delete c.accounts[5].scopes;
  delete c.accounts[6].scopes;
  const v = settings.validateConfig(c);
  assert.deepEqual(v.projects['vitana-v1'].webhook, { url: HOOK_URL, events: ['merge_request', 'pipeline'] });
  assert.deepEqual([v.projects['vitana-platform'].required_jobs, v.projects['vitana-platform'].rehearsal, v.projects['vitana-platform'].landing], [[], false, false]);
  assert.deepEqual(v.accounts[0].scopes, ['api', 'write_repository'], 'a Developer defaults to api and write_repository');
  assert.deepEqual(v.accounts[5].scopes, ['api', 'write_repository'], 'a Maintainer too');
  assert.deepEqual(v.accounts[6].scopes, ['read_api'], 'a Reporter only reads');
});

test('config: the README documents every key the validator accepts, the profiles, the exit codes and the single-source-of-truth rule', () => {
  const readme = fs.readFileSync(README_FILE, 'utf8');
  for (const [group, keys] of Object.entries(settings.SCHEMA_KEYS)) {
    for (const k of keys) assert.ok(readme.includes(`\`${k}\``), `README documents ${group} key \`${k}\``);
  }
  for (const word of ['mirror', 'native', 'single source of truth', 'check', 'apply', '--dry-run', 'exit 3', 'settings-admin-token', 'bot-land-token', 'bot-metrics-token',
    'vitana/engineering/gitlab/agents/', 'fleet-runner-token', 'webhook-signing-token', 'GET /license', 'ci-config', 'vitana-legacy']) {
    assert.ok(readme.includes(word), `README mentions ${word}`);
  }
});

test('cli: defaults are relative to the script (the settings file and the CI folder of the repository)', () => {
  assert.equal(settings.defaultConfigPath(), CONFIG_FILE);
  assert.equal(settings.defaultCiDir(), path.join(ROOT, 'infra', 'gitlab-engineering', 'ci'));
  assert.ok(fs.existsSync(settings.defaultConfigPath()));
});

test('free tier: the script, the settings file and the README name none of the Premium-only APIs or settings (plan §2)', () => {
  const names = [['approval', '_rules'], ['push', '_rule'], ['merge', '_trains'], ['protected', '_environments'], ['code_owner', '_approval_required'], ['allowed_to', '_push'],
    ['allowed_to', '_merge'], ['approvals_before', '_merge'], ['merge_pipelines', '_enabled'], ['/groups/:id', '/hooks'], ['external_status', '_checks'], ['/ldap']].map((p) => p.join(''));
  for (const file of [SCRIPT_FILE, CONFIG_FILE, README_FILE]) {
    const text = fs.readFileSync(file, 'utf8');
    for (const n of names) assert.ok(!text.includes(n), `${path.basename(file)} must not mention ${n}`);
  }
  // the only GitLab paths the script builds are the Free-tier endpoints this test file lists (the fake throws on any other)
  assert.ok(ENDPOINTS.length >= 30);
});

// ═════════════════════════════════════════ a full apply, and the second one ═════════════════════════════════════════════════════
const SEATS = ['agent-kiro-exafy', 'agent-kiro-exafyltd', 'agent-kiro-jtadic', 'agent-kiro-hotmail', 'agent-reviewer'];
const ACCOUNTS = [...SEATS, 'bot-land', 'bot-metrics'];

function writeTranscript(w, firstMark, secondMark) {
  const file = process.env.SETTINGS_TRANSCRIPT_FILE;
  if (!file) return;
  const shape = (c) => {
    const b = c.body && typeof c.body === 'object' ? Object.entries(c.body).map(([k, v]) => `${k}=${/token|content/.test(k) ? '<hidden>' : JSON.stringify(v)}`).join(' ') : '';
    return `${String(c.n).padStart(3)}  ${c.method.padEnd(6)} ${c.path.replace('/api/v4', '')}${c.url.includes('?') ? `?${c.url.split('?')[1].replace(/[&]?(per_page|page)=\d+/g, '').replace(/^&/, '')}` : ''}${b ? `   { ${b} }` : ''}`.replace(/\?$/, '');
  };
  const out = [];
  out.push('# Full apply of gitlab-settings.json on the fake GitLab (state left by milestone 1: group, ci-config, two mirrored projects, mirror user, runner vitana-eng-1)');
  out.push('# Source: scripts/eng/gitlab-settings.test.mjs, test "apply: a first apply ... second apply makes zero writes". Secrets and file contents are shown as <hidden>.');
  out.push('', '## Endpoints the sync is allowed to call (Free tier: the tier banner of each documentation page includes Free). The fake throws on any other.');
  for (const [m, p, doc] of ENDPOINTS) out.push(`  ${m.padEnd(6)} ${p.padEnd(46)} https://docs.gitlab.com/${doc}/`);
  const firstCalls = w.f.since(firstMark.f).slice(0, secondMark.f - firstMark.f);
  out.push('', `## First run: ${firstCalls.length} GitLab calls (${firstCalls.filter((c) => c.method !== 'GET').length} of them writes), in order`);
  for (const c of firstCalls) out.push(shape(c));
  out.push('', '## Secrets Manager calls of the first run');
  for (const c of w.aws.calls.slice(firstMark.aws, secondMark.aws)) out.push(`  aws ${c.args.slice(0, 4).join(' ')}${c.input !== undefined ? '   (value on stdin: <hidden>)' : ''}`);
  out.push('', '## Files written under /etc/vitana in the first run');
  for (const x of w.fsx.writes.slice(firstMark.fs, secondMark.fs)) out.push(`  ${x.path}  mode ${x.mode.toString(8).padStart(4, '0')}  (token: <hidden>)`);
  const second = w.f.since(secondMark.f);
  out.push('', `## Second run: ${second.length} GitLab calls, ${second.filter((c) => c.method !== 'GET').length} writes; Secrets Manager writes: ${w.aws.writes().length - w.aws.writes().filter((c) => w.aws.calls.indexOf(c) < secondMark.aws).length}; /etc/vitana writes: ${w.fsx.writes.length - secondMark.fs}`);
  const methods = {};
  for (const c of second) methods[c.method] = (methods[c.method] ?? 0) + 1;
  out.push(`  calls by method: ${JSON.stringify(methods)}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${out.join('\n')}\n`);
}

test('apply: a first apply on the M1 GitLab creates everything of plan 3.3, and the second apply makes zero writes', async () => {
  const w = newWorld();
  const first = w.mark();
  const r1 = await applied(w);
  const secondMark = w.mark();
  const gl = w.gl;

  // service accounts, one per seat, tokens of 90 days with the configured scopes, kept in Secrets Manager
  for (const name of ACCOUNTS) {
    const u = gl.userByName(name);
    assert.ok(u?.service, `${name} is a service account`);
    const pats = gl.activePats(name);
    assert.equal(pats.length, 1, `${name} holds one active token`);
    assert.equal(pats[0].name, 'vitana-settings');
    assert.equal(pats[0].expires_at, inDays(90), `${name}: 90 days`);
    assert.equal(w.secretValue(SECRET_AGENT(name)), pats[0].value, `${name}: the token is in Secrets Manager`);
  }
  assert.deepEqual(gl.activePats('bot-metrics')[0].scopes, ['read_api']);
  assert.deepEqual(gl.activePats('bot-land')[0].scopes.sort(), ['api', 'write_repository']);
  // the two bot token files
  assert.deepEqual(w.fsx.writes.map((x) => [x.path, x.mode]).sort(), [['/etc/vitana/bot-land-token', 0o600], ['/etc/vitana/bot-metrics-token', 0o600]]);
  assert.equal(w.fsx.files.get('/etc/vitana/bot-land-token').text, `${gl.activePats('bot-land')[0].value}\n`);
  assert.equal(w.fsx.files.get('/etc/vitana/bot-metrics-token').text, `${gl.activePats('bot-metrics')[0].value}\n`);

  // the rehearsal project (created by the sync), native profile
  const re = gl.project('rehearsal');
  assert.ok(re, 'the rehearsal project exists');
  assert.equal(re.ci_config_path, 'rehearsal.gitlab-ci.yml@vitana/ci-config:main');
  assert.deepEqual(
    [re.merge_method, re.squash_option, re.only_allow_merge_if_pipeline_succeeds, re.only_allow_merge_if_all_discussions_are_resolved, re.remove_source_branch_after_merge, re.automatic_rebase_enabled, re.squash_commit_template],
    ['ff', 'always', true, true, true, false, '%{title}'],
  );
  const main = gl.branch('rehearsal');
  assert.deepEqual([main.push_access_levels.map((x) => x.access_level), main.merge_access_levels.map((x) => x.access_level), main.allow_force_push], [[0], [40], false]);
  assert.deepEqual(Object.fromEntries([...re.members].map(([uid, lvl]) => [w.gl.s.users.find((u) => u.id === uid).username, lvl])), {
    'agent-kiro-exafy': 30, 'agent-kiro-exafyltd': 30, 'agent-kiro-jtadic': 30, 'agent-kiro-hotmail': 30, 'agent-reviewer': 30, 'bot-land': 40, 'bot-metrics': 20,
  });
  // the mirrored projects keep M1's behaviour
  for (const n of ['vitana-platform', 'vitana-v1']) {
    const b = gl.branch(n);
    assert.deepEqual([b.push_access_levels.map((x) => x.access_level), b.merge_access_levels.map((x) => x.access_level), b.allow_force_push], [[40], [40], true], `${n}: mirror protection`);
    assert.equal(gl.project(n).merge_method, 'merge', `${n}: the merge settings of a mirror project are not managed`);
    assert.equal(gl.project(n).members.get(gl.userByName('bot-metrics').id), 20);
    assert.equal(gl.project(n).members.get(50), 40, 'the mirror user is untouched');
  }
  // central CI: one commit, the three files, nothing else, the mirror user untouched
  const cfg = gl.project('ci-config');
  assert.equal(gl.s.commits, 1, 'one commit for all three files');
  for (const [name, text] of Object.entries(CI_FILES)) assert.equal(cfg.files.get(name), text, name);
  assert.ok(!cfg.files.has('README.md') || cfg.files.get('README.md') === '# readme\n', 'the folder README.md is not uploaded');
  assert.deepEqual([...cfg.members].map(([uid, lvl]) => [gl.s.users.find((u) => u.id === uid).username, lvl]).sort(), [...[...SEATS, 'bot-land'].map((n) => [n, 20]), ['vitana-mirror', 20]].sort());
  // runners
  assert.deepEqual(gl.runner('vitana-eng-1').tag_list, ['vitana-legacy']);
  const fleet = gl.runner('vitana-eng-fleet');
  assert.deepEqual([fleet.tag_list, fleet.run_untagged, fleet.locked, fleet.access_level, fleet.paused], [['vitana-eng'], false, false, 'not_protected', false]);
  assert.equal(w.secretValue(SECRET_FLEET), fleet.token);
  assert.match(fleet.token, /^glrt-/);
  assert.equal(r1.applied.length > 20, true);

  // second run: nothing to do, nothing written
  const r2 = await w.run('apply');
  assert.equal(r2.exitCode, 0);
  assert.deepEqual(r2.applied, []);
  noWritesAt(w, secondMark);
  assert.equal((await w.run('check')).exitCode, 0, 'check agrees');
  writeTranscript(w, first, secondMark);
});

test('apply: reads come first, the legacy runner is retagged before any token exists, protections and memberships exist before the first token', async () => {
  const w = newWorld();
  await applied(w);
  const calls = w.f.calls;
  const idx = (pred) => calls.findIndex(pred);
  const isTokenCreate = (c) => c.method === 'POST' && (/^\/api\/v4\/users\/\d+\/personal_access_tokens$/.test(c.path) || /^\/api\/v4\/personal_access_tokens\/\d+\/rotate$/.test(c.path));
  const firstToken = idx(isTokenCreate);
  const retag = idx((c) => c.method === 'PUT' && c.path === '/api/v4/runners/5');
  assert.ok(firstToken > 0 && retag > 0, 'both calls happen');
  assert.ok(retag < firstToken, 'plan §3.1/§9 A8: vitana-eng-1 is retagged before the first agent token exists');
  assert.deepEqual(calls[retag].body, { tag_list: 'vitana-legacy' });
  const firstAccount = idx((c) => c.method === 'POST' && c.path === '/api/v4/service_accounts');
  assert.ok(retag < firstAccount, 'the retag is the first thing done to GitLab (after the optional admin token rotation), before even the first account exists');
  const lastBeforeTokens = (re, method) => Math.max(-1, ...calls.map((c, i) => (c.method === method && re.test(c.path) && i < firstToken ? i : -1)));
  assert.ok(lastBeforeTokens(/protected_branches$/, 'POST') > -1, 'the rehearsal protection is set before the first token');
  assert.ok(lastBeforeTokens(/\/members$/, 'POST') > -1, 'memberships are set before the first token');
  assert.equal(calls.filter(isTokenCreate).length, 7);
  assert.ok(calls.slice(firstToken).every((c) => c.method === 'POST' || c.method === 'GET'), 'after the first token only token calls follow');
  assert.equal(calls[0].path, '/api/v4/license', 'the licence guard is the first call');
  const firstWrite = idx((c) => c.method !== 'GET');
  assert.deepEqual(calls.slice(firstWrite).filter((c) => c.method === 'GET').map((c) => c.path.replace(/\/projects\/\d+/, '/projects/:id')), ['/api/v4/projects/:id/protected_branches'],
    'observe-then-act: after the first write the only read is the read-back of the protection of the project created in this run');
});

test('profiles: native sets push No one, merge Maintainers, force push off and the merge settings of plan 3.3; mirror keeps M1', async () => {
  const w = newWorld();
  await applied(w);
  const native = w.f.calls.filter((c) => c.method === 'POST' && /protected_branches$/.test(c.path));
  assert.equal(native.length, 1, 'only the new native project needs a protection written');
  assert.deepEqual(native[0].body, { name: 'main', push_access_level: 0, merge_access_level: 40, allow_force_push: false });
  const put = w.f.calls.find((c) => c.method === 'PUT' && c.path === `/api/v4/projects/${w.gl.project('rehearsal').id}`);
  assert.deepEqual(put.body, {
    merge_method: 'ff', squash_option: 'always', only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true,
    remove_source_branch_after_merge: true, automatic_rebase_enabled: false, squash_commit_template: '%{title}', merge_commit_template: '%{title}',
  }, 'a project created in this run has no observed state, so every managed merge setting is written once');
  const mirrorIds = ['vitana-platform', 'vitana-v1'].map((n) => w.gl.project(n).id);
  assert.deepEqual(w.f.calls.filter((c) => mirrorIds.some((id) => c.path.startsWith(`/api/v4/projects/${id}/`) || c.path === `/api/v4/projects/${id}`) && c.method !== 'GET').map((c) => `${c.method} ${c.path}`).sort(),
    mirrorIds.map((id) => `POST /api/v4/projects/${id}/members`).sort(), 'mirror projects: only the metrics bot membership is written');
});

// ═════════════════════════════════════════ hand changes: check reports, apply corrects ═════════════════════════════════════════
const mbr = (w, project, username) => w.gl.project(project).members.get(w.gl.userByName(username).id);
const HAND = [
  ['native main: push raised to Developers', (w) => { w.gl.branch('rehearsal').push_access_levels[0].access_level = 30; }, /project:rehearsal:protection/, ['DELETE /protected_branches/main', 'POST /protected_branches']],
  ['native main: merge lowered to Developers', (w) => { w.gl.branch('rehearsal').merge_access_levels[0].access_level = 30; }, /project:rehearsal:protection/, ['DELETE /protected_branches/main', 'POST /protected_branches']],
  ['native main: force push switched on', (w) => { w.gl.branch('rehearsal').allow_force_push = true; }, /project:rehearsal:protection/, ['PATCH /protected_branches/main']],
  ['native main: protection removed', (w) => { w.gl.project('rehearsal').branches.length = 0; }, /project:rehearsal:protection/, ['POST /protected_branches']],
  ['native: merge method set to merge', (w) => { w.gl.project('rehearsal').merge_method = 'merge'; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: squash option set to default_on', (w) => { w.gl.project('rehearsal').squash_option = 'default_on'; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: automatic rebase switched on', (w) => { w.gl.project('rehearsal').automatic_rebase_enabled = true; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: pipelines no longer required', (w) => { w.gl.project('rehearsal').only_allow_merge_if_pipeline_succeeds = false; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: discussions no longer required', (w) => { w.gl.project('rehearsal').only_allow_merge_if_all_discussions_are_resolved = false; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: source branch kept after merge', (w) => { w.gl.project('rehearsal').remove_source_branch_after_merge = false; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: squash template cleared', (w) => { w.gl.project('rehearsal').squash_commit_template = null; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['native: CI configuration path pointed elsewhere', (w) => { w.gl.project('rehearsal').ci_config_path = '.gitlab-ci.yml'; }, /project:rehearsal:settings/, ['PUT /projects/']],
  ['mirror: force push switched off', (w) => { w.gl.branch('vitana-platform').allow_force_push = false; }, /project:vitana-platform:protection/, ['PATCH /protected_branches/main']],
  ['mirror: push lowered to Developers', (w) => { w.gl.branch('vitana-v1').push_access_levels[0].access_level = 30; }, /project:vitana-v1:protection/, ['DELETE /protected_branches/main', 'POST /protected_branches']],
  ['fleet runner: an extra tag', (w) => { w.gl.runner('vitana-eng-fleet').tag_list = ['vitana-eng', 'extra']; }, /runner:fleet:update/, ['PUT /runners/']],
  ['fleet runner: untagged jobs switched on', (w) => { w.gl.runner('vitana-eng-fleet').run_untagged = true; }, /runner:fleet:update/, ['PUT /runners/']],
  ['fleet runner: protected-only', (w) => { w.gl.runner('vitana-eng-fleet').access_level = 'ref_protected'; }, /runner:fleet:update/, ['PUT /runners/']],
  ['legacy runner: the fleet tag put back', (w) => { w.gl.runner('vitana-eng-1').tag_list = ['vitana-eng']; }, /runner:legacy:update/, ['PUT /runners/5']],
  ['legacy runner: untagged jobs switched on', (w) => { w.gl.runner('vitana-eng-1').run_untagged = true; }, /runner:legacy:update/, ['PUT /runners/5']],
  ['central CI: a file edited by hand', (w) => { w.gl.project('ci-config').files.set('rehearsal.gitlab-ci.yml', 'edited\n'); }, /ci-files:write/, ['POST /repository/commits']],
  ['central CI: a file deleted', (w) => { w.gl.project('ci-config').files.delete('v1.gitlab-ci.yml'); }, /ci-files:write/, ['POST /repository/commits']],
  ['membership: bot-land removed', (w) => { w.gl.project('rehearsal').members.delete(w.gl.userByName('bot-land').id); }, /member:rehearsal:bot-land/, ['POST /members']],
  ['membership: a seat promoted to Maintainer', (w) => { w.gl.project('rehearsal').members.set(w.gl.userByName('agent-kiro-jtadic').id, 40); }, /member:rehearsal:agent-kiro-jtadic/, ['PUT /members/']],
  ['membership: a seat added to a mirror project', (w) => { w.gl.project('vitana-v1').members.set(w.gl.userByName('agent-kiro-exafy').id, 30); }, /member:vitana-v1:agent-kiro-exafy/, ['DELETE /members/']],
  ['membership: a pipeline user lost read access to ci-config', (w) => { w.gl.project('ci-config').members.delete(w.gl.userByName('agent-reviewer').id); }, /member:ci-config:agent-reviewer/, ['POST /members']],
  ['token files: mode opened up', (w) => { w.fsx.files.get('/etc/vitana/bot-land-token').mode = 0o644; }, /file:\/etc\/vitana\/bot-land-token/, null],
  ['token files: content replaced', (w) => { w.fsx.files.get('/etc/vitana/bot-metrics-token').text = 'stale\n'; }, /file:\/etc\/vitana\/bot-metrics-token/, null],
  ['token files: deleted', (w) => { w.fsx.files.delete('/etc/vitana/bot-land-token'); }, /file:\/etc\/vitana\/bot-land-token/, null],
  ['admin token file: mode opened up', (w) => { w.fsx.files.get(ADMIN_FILE).mode = 0o644; }, /file:\/etc\/vitana\/settings-admin-token/, null],
];
test('drift: a setting changed by hand is reported by check (exit 3, nothing written) and corrected by apply', async () => {
  for (const [label, mutate, driftRe, writes] of HAND) {
    const w = newWorld();
    await applied(w);
    assert.equal(await w.cli('check'), 0, `${label}: clean before the change`);
    mutate(w);
    const m = w.mark();
    const check = await w.run('check');
    assert.equal(check.exitCode, 3, `${label}: check exits 3`);
    assert.ok(check.drift.some((d) => driftRe.test(d.id)), `${label}: names ${driftRe} (got ${check.drift.map((d) => d.id)})`);
    noWritesAt(w, m, `${label}: check`);
    assert.ok(w.lines.slice(m.lines).some((l) => /^drift: /.test(l)), `${label}: check prints the drift`);
    const m2 = w.mark();
    const fix = await w.run('apply');
    assert.equal(fix.exitCode, 0, `${label}: apply succeeds`);
    if (writes) {
      const got = w.writesSince(m2).gitlab.map((c) => `${c.method} ${c.path.replace(/^\/api\/v4\/projects\/\d+(?=\/)/, '').replace(/^\/api\/v4/, '')}`);
      assert.equal(got.length, writes.length, `${label}: exactly the expected writes (got ${got})`);
      writes.forEach((expected, i) => assert.ok(got[i].startsWith(expected) || got[i].includes(expected), `${label}: write ${i} is ${expected} (got ${got[i]})`));
    }
    assert.equal(await w.cli('check'), 0, `${label}: clean after apply`);
    const m3 = w.mark();
    assert.equal((await w.run('apply')).exitCode, 0);
    noWritesAt(w, m3, `${label}: apply after the fix`);
  }
});

test('membership: unmanaged members are never touched; an unexpected Maintainer of a native project is reported and not removed', async () => {
  const w = newWorld();
  await applied(w);
  w.gl.s.users.push({ id: 77, username: 'alice', name: 'Alice', admin: false, service: false });
  w.gl.project('rehearsal').members.set(77, 40);
  w.gl.project('vitana-v1').members.set(77, 30);
  const m = w.mark();
  const check = await w.run('check');
  assert.equal(check.exitCode, 3);
  assert.ok(check.findings.some((x) => x.level === 'drift' && /alice/.test(x.message) && /rehearsal/.test(x.area)), 'alice is reported as an unexpected Maintainer');
  assert.ok(!check.findings.some((x) => /vitana-v1/.test(x.area) && /alice/.test(x.message)), 'mirror projects are not audited');
  noWritesAt(w, m, 'check');
  const m2 = w.mark();
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0, 'apply cannot fix what needs a person and does not fail for it');
  noWritesAt(w, m2, 'apply: nothing to write for a human member');
  assert.equal(w.gl.project('rehearsal').members.get(77), 40, 'the human member is untouched');
  assert.equal(w.gl.project('vitana-v1').members.get(77), 30);
  assert.equal(w.gl.project('ci-config').members.get(50), 20, 'the mirror user is untouched');
  assert.ok(w.events().some((e) => e.event === 'finding' && e.level === 'drift'), 'logged each run');
  w.gl.project('rehearsal').members.delete(77);
  w.gl.project('vitana-v1').members.delete(77);
  assert.equal((await w.run('check')).exitCode, 0);
  const cfg = clone(shipped());
  cfg.owners = ['root', 'alice'];
  w.setConfig(cfg);
  w.gl.project('rehearsal').members.set(77, 40);
  await applied(w); // an owner is made Maintainer where it is not one yet
  assert.equal(w.gl.project('rehearsal').members.get(77), 40, 'an owner named in the file may be Maintainer');
  assert.equal((await w.run('check')).exitCode, 0);
  assert.ok(!(await w.run('check')).findings.some((x) => /alice/.test(x.message)), 'no longer reported');
});

test('membership: an owner named in the file who is not yet a member becomes a Maintainer of existing projects', async () => {
  const w = newWorld();
  w.gl.s.users.push({ id: 77, username: 'alice', name: 'Alice', admin: false, service: false });
  const cfg = clone(shipped());
  cfg.owners = ['root', 'alice'];
  w.setConfig(cfg);
  await applied(w);
  for (const n of ['vitana-platform', 'vitana-v1']) assert.equal(w.gl.project(n).members.get(77), 40, `${n}: alice is Maintainer`);
  assert.ok(!w.gl.project('rehearsal').members.has(77), 'a project created in the same run is left to the next run (root already owns it through the group)');
  await applied(w);
  assert.equal(w.gl.project('rehearsal').members.get(77), 40);
  cfg.owners = ['root', 'ghost'];
  w.setConfig(cfg);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0);
  assert.ok(r.findings.some((x) => /ghost/.test(x.message)), 'an owner without an account is reported, not fatal');
});

// ═════════════════════════════════════════ account tokens ═══════════════════════════════════════════════════════════════════════
const createsOf = (w, mark = 0) => callsOf(w.f, 'POST', /^\/api\/v4\/users\/\d+\/personal_access_tokens$/, mark);
const rotatesOf = (w, mark = 0) => callsOf(w.f, 'POST', /^\/api\/v4\/personal_access_tokens\/\d+\/rotate$/, mark);

test('tokens: created once with 90 days and the configured scopes; secret values are written from a private file, never as an argument', async () => {
  const w = newWorld();
  await applied(w);
  assert.equal(createsOf(w).length, 7, 'one creation per account');
  for (const c of createsOf(w)) {
    assert.equal(c.body.name, 'vitana-settings');
    assert.equal(c.body.expires_at, inDays(90));
    assert.ok(c.body.scopes.length > 0);
  }
  const creates = w.aws.calls.filter((c) => c.args[1] === 'create-secret').map((c) => c.args[c.args.indexOf('--name') + 1]).sort();
  assert.deepEqual(creates, ACCOUNTS.map(SECRET_AGENT).sort(), 'agent secrets that do not exist yet are created');
  assert.ok(w.aws.calls.some((c) => c.args[1] === 'put-secret-value' && c.args.includes(SECRET_FLEET)), 'the pre-created fleet secret gets a value');
  for (const c of w.aws.writes()) {
    const src = c.args[c.args.indexOf('--secret-string') + 1];
    assert.match(src, /^file:\/\//, 'the value is read from a private file, never passed as an argument');
  }
  for (const f of seenSecretFiles) {
    assert.ok(!fs.existsSync(f), 'the value file is removed after the call');
    assert.ok(!fs.existsSync(path.dirname(f)), 'its private directory is removed after the call');
  }
  // a second world where Terraform pre-created the secrets: they are put, not created
  const w2 = newWorld({ preCreateAgentSecrets: true });
  await applied(w2);
  assert.equal(w2.aws.calls.filter((c) => c.args[1] === 'create-secret').length, 0);
  assert.equal(w2.aws.calls.filter((c) => c.args[1] === 'put-secret-value').length, 8, '7 agent secrets and the fleet secret');
});

test('tokens: rotated only when fewer than 30 days are left (30 stays, 29 is rotated), the old token is revoked and the bot file follows', async () => {
  const w = newWorld();
  await applied(w);
  const reviewer = w.gl.activePats('agent-reviewer')[0];
  reviewer.expires_at = inDays(30);
  let m = w.mark();
  await applied(w);
  noWritesAt(w, m, '30 days left');
  reviewer.expires_at = inDays(29);
  m = w.mark();
  await applied(w);
  assert.equal(rotatesOf(w, m.f).length, 1);
  assert.equal(createsOf(w, m.f).length, 0, 'rotation, not a second token');
  assert.deepEqual(rotatesOf(w, m.f)[0].body, { expires_at: inDays(90) });
  const now = w.gl.activePats('agent-reviewer');
  assert.equal(now.length, 1);
  assert.notEqual(now[0].value, reviewer.value);
  assert.equal(reviewer.revoked, true);
  assert.equal(now[0].expires_at, inDays(90));
  assert.equal(w.secretValue(SECRET_AGENT('agent-reviewer')), now[0].value);
  assert.equal(w.fsx.writes.length, 2, 'only the two first-run bot files: a seat has no file');
  // a bot token: the file is rewritten too, mode 0600
  const bot = w.gl.activePats('bot-land')[0];
  bot.expires_at = inDays(12);
  m = w.mark();
  await applied(w);
  const fresh = w.gl.activePats('bot-land')[0];
  assert.notEqual(fresh.value, bot.value);
  assert.deepEqual(w.fsx.writes.slice(m.fs).map((x) => [x.path, x.mode, x.text]), [['/etc/vitana/bot-land-token', 0o600, `${fresh.value}\n`]]);
  assert.equal(w.secretValue(SECRET_AGENT('bot-land')), fresh.value);
  m = w.mark();
  await applied(w);
  noWritesAt(w, m);
});

test('tokens: a lost or wrong secret is recovered by rotating the active token, never by creating a second one', async () => {
  for (const bad of [null, `${PAT_PREFIX}wrongwrongwrongwrong`, 'not even a token']) {
    const w = newWorld();
    await applied(w);
    const before = w.gl.activePats('agent-kiro-exafy')[0];
    w.aws.secrets.set(SECRET_AGENT('agent-kiro-exafy'), bad);
    const check = await w.run('check');
    assert.equal(check.exitCode, 3, `${bad}: reported`);
    const m = w.mark();
    await applied(w);
    assert.equal(rotatesOf(w, m.f).length, 1, `${bad}: rotated`);
    assert.equal(createsOf(w, m.f).length, 0, `${bad}: no second token`);
    assert.equal(w.gl.activePats('agent-kiro-exafy').length, 1);
    assert.equal(w.secretValue(SECRET_AGENT('agent-kiro-exafy')), w.gl.activePats('agent-kiro-exafy')[0].value);
    assert.equal(before.revoked, true);
  }
});

test('tokens: a secret that cannot be read (access denied) is an error, not "lost": the run writes nothing', async () => {
  const w = newWorld();
  await applied(w);
  w.aws.deny('get-secret-value', SECRET_AGENT('agent-reviewer'));
  const m = w.mark();
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1, 'an unreadable secret is an error, not "lost"');
  noWritesAt(w, m);
  assert.match(w.text(), /agent-reviewer/);
});

test('tokens: scopes changed in the file replace the token, the new one stored before the old one is revoked', async () => {
  const w = newWorld();
  await applied(w);
  const old = w.gl.activePats('bot-metrics')[0];
  const cfg = clone(shipped());
  cfg.accounts.find((a) => a.username === 'bot-metrics').scopes = ['read_api', 'read_repository'];
  w.setConfig(cfg);
  const check = await w.run('check');
  assert.equal(check.exitCode, 3);
  w.order.length = 0;
  await applied(w);
  const fresh = w.gl.activePats('bot-metrics');
  assert.equal(fresh.length, 1);
  assert.deepEqual(fresh[0].scopes.sort(), ['read_api', 'read_repository']);
  assert.equal(old.revoked, true);
  const iCreate = w.order.findIndex((s) => /^POST \/users\/\d+\/personal_access_tokens$/.test(s));
  const iStore = w.order.findIndex((s) => s === `aws put-secret-value ${SECRET_AGENT('bot-metrics')}`);
  const iFile = w.order.findIndex((s) => s === 'file /etc/vitana/bot-metrics-token');
  const iRevoke = w.order.findIndex((s) => s === `DELETE /personal_access_tokens/${old.id}`);
  assert.ok(iCreate >= 0 && iStore > iCreate && iFile > iStore && iRevoke > iFile, `create < store < file < revoke (${[iCreate, iStore, iFile, iRevoke]})`);
});

test('tokens: a duplicate managed token and a token with no or a too-long expiry on a managed account are revoked', async () => {
  const w = newWorld();
  await applied(w);
  const land = w.gl.userByName('bot-land');
  const stray = { id: 9001, user_id: land.id, name: 'hand-made', scopes: ['api'], expires_at: null, revoked: false, value: `${PAT_PREFIX}handmadeAAAAAAAAAAAA` };
  const long = { id: 9002, user_id: land.id, name: 'long-lived', scopes: ['api'], expires_at: inDays(300), revoked: false, value: `${PAT_PREFIX}longlivedAAAAAAAAAAA` };
  const fine = { id: 9003, user_id: land.id, name: 'short-lived', scopes: ['api'], expires_at: inDays(20), revoked: false, value: `${PAT_PREFIX}shortlivedAAAAAAAAAA` };
  const dup = { id: 9004, user_id: land.id, name: 'vitana-settings', scopes: ['api', 'write_repository'], expires_at: inDays(90), revoked: false, value: `${PAT_PREFIX}duplicateAAAAAAAAAAA` };
  w.gl.s.pats.push(stray, long, fine, dup);
  const check = await w.run('check');
  assert.equal(check.exitCode, 3);
  await applied(w);
  assert.deepEqual([stray.revoked, long.revoked, fine.revoked, dup.revoked], [true, true, false, true], 'the token the secret holds is kept, short-lived foreign tokens are left alone');
  assert.equal(w.gl.activePats('bot-land').filter((p) => p.name === 'vitana-settings').length, 1);
  assert.equal(await w.cli('check'), 0);
});

test('tokens: a token created but not stored (Secrets Manager refused) is recovered by the next run through rotation', async () => {
  const w = newWorld();
  w.aws.deny('create-secret', SECRET_AGENT('agent-kiro-exafy'));
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.ok(r.failed.some((x) => x.id === 'token:agent-kiro-exafy'));
  assert.equal(w.gl.activePats('agent-kiro-exafy').length, 1, 'the token exists and nobody holds its value');
  assert.ok(r.applied.includes('token:agent-reviewer'), 'the other accounts are not held back');
  w.aws.allow('create-secret', SECRET_AGENT('agent-kiro-exafy'));
  const m = w.mark();
  await applied(w);
  assert.equal(rotatesOf(w, m.f).length, 1, 'rotation regains the value');
  assert.equal(createsOf(w, m.f).length, 0, 'no second token');
  assert.equal(w.gl.activePats('agent-kiro-exafy').length, 1);
  assert.equal(w.secretValue(SECRET_AGENT('agent-kiro-exafy')), w.gl.activePats('agent-kiro-exafy')[0].value);
});

test('tokens: no secret appears in any output or argument list, also when GitLab echoes tokens back in an error body', async () => {
  const w = newWorld();
  await applied(w);
  const secrets = () => [...w.gl.tokenValues(), SIGNING_TOKEN, NEW_SIGNING_TOKEN, ...[...w.aws.secrets.values()].filter((v) => v && v.length > 8), w.gl.runner('vitana-eng-fleet').token];
  const cfg = clone(shipped());
  cfg.projects['vitana-v1'].webhook = { url: HOOK_URL, events: ['pipeline'] };
  w.setConfig(cfg);
  w.gl.project('rehearsal').merge_method = 'merge';
  const echoed = () => `rejected: admin=${ADMIN_TOKEN} land=${w.secretValue(SECRET_AGENT('bot-land'))} hook=${SIGNING_TOKEN} runner=${w.gl.runner('vitana-eng-fleet').token}`;
  w.gl.failNext('PUT', /^\/api\/v4\/projects\/\d+$/, 422, () => ({ message: echoed(), error: echoed() }), 1);
  w.gl.failNext('POST', /\/hooks$/, 422, () => ({ message: echoed() }), 1);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1, 'the rejected changes fail');
  assert.ok(r.failed.length >= 2);
  const everything = [w.text(), JSON.stringify(r), ...w.aws.calls.map((c) => c.args.join(' '))].join('\n');
  for (const s of secrets()) assert.ok(!everything.includes(s), `a secret leaked: ${s.slice(0, 12)}…`);
  assert.ok(everything.includes('[redacted]'), 'the echoed values were scrubbed, not just absent');
  const m = w.mark();
  const ok = await w.run('apply');
  assert.equal(ok.exitCode, 0);
  for (const s of secrets()) assert.ok(!w.lines.slice(m.lines).join('\n').includes(s));
  void m;
});

// ═════════════════════════════════════════ the sync's own admin token ═══════════════════════════════════════════════════════════
test('admin token: not rotated with 10 days left, rotated with 9; the file is rewritten atomically (0600) and the rest of the run uses the new token', async () => {
  const w = newWorld();
  const admin = w.gl.s.pats[0];
  admin.expires_at = inDays(10);
  let m = w.mark();
  await w.run('check');
  assert.equal(rotatesOf(w, m.f).length, 0);
  assert.equal((await w.run('check')).drift.some((d) => d.id === 'admin-token:rotate'), false, '10 days left is not drift');
  admin.expires_at = inDays(9);
  const check = await w.run('check');
  assert.ok(check.drift.some((d) => d.id === 'admin-token:rotate'), '9 days left is drift');
  assert.equal(w.fsx.files.get(ADMIN_FILE).text, `${ADMIN_TOKEN}\n`, 'check never rewrites it');
  m = w.mark();
  w.order.length = 0;
  await applied(w);
  assert.equal(rotatesOf(w, m.f).length, 1);
  assert.deepEqual(rotatesOf(w, m.f)[0].body, { expires_at: inDays(90) });
  const fresh = w.gl.s.pats.find((p) => p.user_id === 1 && !p.revoked);
  assert.notEqual(fresh.value, ADMIN_TOKEN);
  assert.equal(admin.revoked, true);
  assert.equal(fresh.expires_at, inDays(90));
  assert.deepEqual(w.fsx.writes.filter((x) => x.path === ADMIN_FILE).map((x) => [x.mode, x.text]), [[0o600, `${fresh.value}\n`]], 'written once, mode 0600');
  const i = w.f.calls.findIndex((c) => c.method === 'POST' && /rotate$/.test(c.path));
  assert.equal(w.f.calls[i].headers['private-token'], ADMIN_TOKEN, 'the rotation itself is made with the old token');
  assert.ok(w.f.calls.slice(i + 1).every((c) => c.headers['private-token'] === fresh.value || /\/personal_access_tokens\/self$/.test(c.path)), 'afterwards the new token is used');
  const iRotate = w.order.findIndex((s) => /^POST \/personal_access_tokens\/\d+\/rotate$/.test(s));
  const iAdminFile = w.order.indexOf(`file ${ADMIN_FILE}`);
  const iRetag = w.order.indexOf('PUT /runners/5');
  assert.ok(iRotate >= 0 && iAdminFile > iRotate && iRetag > iAdminFile, `rotate < write of the file < any other change (${[iRotate, iAdminFile, iRetag]})`);
  for (const t of [ADMIN_TOKEN, fresh.value]) assert.ok(!w.text().includes(t), 'never printed');
  m = w.mark();
  await applied(w);
  noWritesAt(w, m);
});

test('admin token: if the file cannot be written the token is not rotated, the rest of the run goes on and the run fails loudly', async () => {
  const w = newWorld();
  w.gl.s.pats[0].expires_at = inDays(5);
  w.fsx.readOnly = true;
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(rotatesOf(w).length, 0, 'no rotation: the new token would have had nowhere to go');
  assert.ok(r.failed.some((x) => x.id === 'admin-token:rotate'));
  assert.equal(w.gl.s.pats[0].revoked, false, 'the admin token still works');
  assert.ok(w.gl.project('rehearsal'), 'the other settings are still applied');
  assert.match(w.text(), /admin-token:rotate/);
});

test('admin token: the rotation is not retried, and a refused rotation leaves the token file as it was', async () => {
  const w = newWorld();
  w.gl.s.pats[0].expires_at = inDays(2);
  w.gl.failNext('POST', /\/rotate$/, 503, { message: 'unavailable' }, 5);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(rotatesOf(w).length, 1, 'a rotation that may have been processed is never repeated');
  assert.equal(w.fsx.files.get(ADMIN_FILE).text, `${ADMIN_TOKEN}\n`);
  assert.equal(w.fsx.writes.filter((x) => x.path === ADMIN_FILE).length, 0);
});

test('admin token: a token GitLab does not accept stops the run before any write', async () => {
  for (const mutate of [(p) => { p.revoked = true; }, (p) => { p.expires_at = inDays(-1); }]) {
    const w = newWorld();
    mutate(w.gl.s.pats[0]);
    const r = await w.run('apply');
    assert.equal(r.exitCode, 1);
    noWritesAt(w, { f: 0, aws: 0, fs: 0 }, 'rejected admin token');
    assert.match(w.text(), /m2\.sh install/, 'the message says how to get a new admin token');
  }
});


// ═════════════════════════════════════════ runners ══════════════════════════════════════════════════════════════════════════════
test('fleet runner: created once with the plan values, its token goes to the secret; a missing, empty or placeholder secret resets the token', async () => {
  const w = newWorld();
  await applied(w);
  const create = w.f.calls.filter((c) => c.method === 'POST' && c.path === '/api/v4/user/runners');
  assert.equal(create.length, 1);
  assert.deepEqual(create[0].body, { runner_type: 'instance_type', description: 'vitana-eng-fleet', tag_list: 'vitana-eng', run_untagged: false, locked: false, access_level: 'not_protected', paused: false });
  assert.equal(w.gl.s.runners.filter((r) => r.description === 'vitana-eng-fleet').length, 1);
  for (const bad of [null, 'REPLACE_ME', '']) {
    w.aws.secrets.set(SECRET_FLEET, bad);
    const check = await w.run('check');
    assert.ok(check.drift.some((d) => d.id === 'runner:fleet:token'), `${JSON.stringify(bad)}: reported`);
    const m = w.mark();
    await applied(w);
    assert.equal(callsOf(w.f, 'POST', /reset_authentication_token$/, m.f).length, 1, `${JSON.stringify(bad)}: reset once`);
    assert.equal(w.secretValue(SECRET_FLEET), w.gl.runner('vitana-eng-fleet').token);
    assert.match(w.secretValue(SECRET_FLEET), /^glrt-/);
    assert.equal(w.gl.s.runners.filter((r) => r.description === 'vitana-eng-fleet').length, 1, 'never a second runner');
  }
  // the runner deleted by hand is created again
  w.gl.s.runners.splice(w.gl.s.runners.indexOf(w.gl.runner('vitana-eng-fleet')), 1);
  await applied(w);
  assert.equal(w.gl.s.runners.filter((r) => r.description === 'vitana-eng-fleet').length, 1);
  assert.equal(w.secretValue(SECRET_FLEET), w.gl.runner('vitana-eng-fleet').token);
});

test('fleet runner: a token whose storing failed is regained by the next run (the runner exists, the secret is empty)', async () => {
  const w = newWorld();
  w.aws.deny('put-secret-value', SECRET_FLEET);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.ok(r.failed.some((x) => x.id === 'runner:fleet:create'));
  assert.ok(w.gl.runner('vitana-eng-fleet'), 'the runner exists');
  w.aws.allow('put-secret-value', SECRET_FLEET);
  await applied(w);
  assert.equal(w.gl.s.runners.filter((x) => x.description === 'vitana-eng-fleet').length, 1);
  assert.equal(w.secretValue(SECRET_FLEET), w.gl.runner('vitana-eng-fleet').token);
});

test('legacy runner: retagged and kept unpaused until the file says paused; a missing runner is reported and does not stop the run', async () => {
  const w = newWorld();
  await applied(w);
  const legacy = w.gl.runner('vitana-eng-1');
  assert.deepEqual([legacy.tag_list, legacy.paused, legacy.run_untagged], [['vitana-legacy'], false, false]);
  const cfg = clone(shipped());
  cfg.runners.legacy.paused = true;
  w.setConfig(cfg);
  const m = w.mark();
  await applied(w);
  assert.deepEqual(w.writesSince(m).gitlab.map((c) => [c.method, c.path, c.body]), [['PUT', '/api/v4/runners/5', { paused: true }]], 'only the pause is written (plan §3.1: paused after acceptance A1)');
  assert.equal(legacy.paused, true);
  w.gl.s.runners.splice(w.gl.s.runners.indexOf(legacy), 1);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0);
  assert.ok(r.findings.some((x) => x.level === 'warn' && /vitana-eng-1/.test(x.message)));
});

// ═════════════════════════════════════════ project webhooks ═════════════════════════════════════════════════════════════════════
const withHook = (events = ['merge_request', 'pipeline'], url = HOOK_URL) => { const c = clone(shipped()); c.projects['vitana-v1'].webhook = { url, events }; return c; };
const fingerprint = (t) => crypto.createHash('sha256').update(t).digest('hex').slice(0, 12);
const hookOf = (w) => w.gl.project('vitana-v1').hooks[0];

test('webhook: created with the signing token read from Secrets Manager, only the configured events, nothing re-sent when unchanged', async () => {
  const w = newWorld({ config: withHook() });
  await applied(w);
  const post = w.f.calls.find((c) => c.method === 'POST' && /\/hooks$/.test(c.path));
  const flags = Object.fromEntries(Object.entries(post.body).filter(([k]) => /_events$/.test(k)));
  assert.equal(flags.merge_requests_events, true);
  assert.equal(flags.pipeline_events, true);
  assert.equal(flags.push_events, false, 'GitLab turns push events on unless told otherwise');
  assert.equal(Object.values(flags).filter(Boolean).length, 2);
  assert.equal(post.body.url, HOOK_URL);
  assert.equal(post.body.name, 'vitana-gateway');
  assert.equal(post.body.enable_ssl_verification, true);
  assert.equal(post.body.signing_token, SIGNING_TOKEN);
  assert.ok(post.body.description.includes(fingerprint(SIGNING_TOKEN)) && !post.body.description.includes(SIGNING_TOKEN), 'a fingerprint of the token, never the token');
  assert.ok(!w.text().includes(SIGNING_TOKEN));
  assert.equal(hookOf(w).signing_token_present, undefined, 'the fake never returns it');
  assert.equal(w.gl.project('vitana-platform').hooks.length, 0);
  const m = w.mark();
  await applied(w);
  noWritesAt(w, m);
  assert.equal((await w.run('check')).exitCode, 0);
});

test('webhook: a rotated signing token, a changed URL or event, a missing signing token and a removed hook are all corrected', async () => {
  const w = newWorld({ config: withHook() });
  await applied(w);
  const id = hookOf(w).id;
  // 1. the secret is rotated
  w.aws.secrets.set(SECRET_WEBHOOK, NEW_SIGNING_TOKEN);
  let r = await w.run('check');
  assert.ok(r.drift.some((d) => d.id === 'project:vitana-v1:hook'), 'rotation is seen through the fingerprint');
  let m = w.mark();
  await applied(w);
  let put = w.writesSince(m).gitlab;
  assert.equal(put.length, 1);
  assert.deepEqual([put[0].method, put[0].path.endsWith(`/hooks/${id}`), put[0].body.signing_token], ['PUT', true, NEW_SIGNING_TOKEN]);
  // 2. hand changes
  for (const [label, mutate] of [
    ['push events switched on', (h) => { h.push_events = true; }],
    ['URL changed', (h) => { h.url = 'https://evil.example.test/hook'; }],
    ['ssl verification off', (h) => { h.enable_ssl_verification = false; }],
    ['signing token removed', (h) => { h._signing = null; }],
    ['description rewritten', (h) => { h.description = 'x'; }],
  ]) {
    mutate(hookOf(w));
    assert.equal((await w.run('check')).exitCode, 3, label);
    await applied(w);
    assert.equal((await w.run('check')).exitCode, 0, `${label}: corrected`);
    assert.equal(w.gl.project('vitana-v1').hooks.length, 1, `${label}: never a second hook`);
  }
  // 3. the events in the file change
  w.setConfig(withHook(['pipeline']));
  await applied(w);
  assert.equal(hookOf(w).merge_requests_events, false);
  assert.equal(hookOf(w).pipeline_events, true);
  // 4. a hook of someone else is left alone, our hook goes when the file drops the webhook
  w.gl.project('vitana-v1').hooks.push({ id: 900, url: 'https://other.example.test/h', name: 'someone-else', description: '', push_events: true });
  w.setConfig(shipped());
  assert.equal((await w.run('check')).exitCode, 3);
  m = w.mark();
  await applied(w);
  assert.deepEqual(w.writesSince(m).gitlab.map((c) => c.method), ['DELETE']);
  assert.deepEqual(w.gl.project('vitana-v1').hooks.map((h) => h.name), ['someone-else']);
});

test('webhook: an empty, malformed or unreadable signing token is reported and no hook is written', async () => {
  for (const [label, value] of [['empty', null], ['not whsec_', 'plain-secret-value'], ['wrong length', 'whsec_AAAA']]) {
    const w = newWorld({ config: withHook() });
    w.aws.secrets.set(SECRET_WEBHOOK, value);
    const r = await w.run('apply');
    assert.equal(r.exitCode, 0, label);
    assert.ok(r.findings.some((x) => x.level === 'warn' && /signing/i.test(x.message)), `${label}: reported`);
    assert.equal(callsOf(w.f, 'POST', /\/hooks$/).length, 0, `${label}: no hook written`);
    if (value) assert.ok(!w.text().includes(value), `${label}: the value is not printed`);
  }
});

// ═════════════════════════════════════════ central CI in vitana/ci-config ═══════════════════════════════════════════════════════
test('central CI: only files that differ are written, in one commit, create vs update per file; nothing is deleted; other names are ignored', async () => {
  const w = newWorld();
  await applied(w);
  const cfg = w.gl.project('ci-config');
  cfg.files.set('extra.yml', 'someone else put this here\n');
  fsxSet(w, 'v1.gitlab-ci.yml', 'changed locally\n');
  fsxSet(w, 'brand-new.gitlab-ci.yml', 'new file\n');
  const m = w.mark();
  await applied(w);
  const commits = callsOf(w.f, 'POST', /repository\/commits$/, m.f);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].body.branch, 'main');
  assert.match(commits[0].body.commit_message, /vitana-eng/);
  assert.deepEqual(commits[0].body.actions.map((a) => [a.action, a.file_path]).sort(), [['create', 'brand-new.gitlab-ci.yml'], ['update', 'v1.gitlab-ci.yml']]);
  assert.equal(cfg.files.get('v1.gitlab-ci.yml'), 'changed locally\n');
  assert.equal(cfg.files.get('extra.yml'), 'someone else put this here\n', 'never deleted');
  assert.ok(!cfg.files.has('README.md') || cfg.files.get('README.md') !== 'not a pipeline file\n');
  const m2 = w.mark();
  await applied(w);
  noWritesAt(w, m2);
});

function fsxSet(w, name, text) { w.fsx.files.set(`/repo/ci/${name}`, { text, mode: 0o644 }); }

test('central CI: a project whose CI file exists nowhere is not pointed at it, and the run reports it', async () => {
  const w = newWorld();
  w.fsx.files.delete('/repo/ci/rehearsal.gitlab-ci.yml');
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0);
  assert.equal(w.gl.project('rehearsal').ci_config_path, '', 'GitLab would fail every pipeline of a project pointed at a missing file');
  assert.ok(r.findings.some((x) => /rehearsal\.gitlab-ci\.yml/.test(x.message)));
  fsxSet(w, 'rehearsal.gitlab-ci.yml', CI_FILES['rehearsal.gitlab-ci.yml']);
  await applied(w);
  assert.equal(w.gl.project('rehearsal').ci_config_path, 'rehearsal.gitlab-ci.yml@vitana/ci-config:main');
});

// ═════════════════════════════════════════ licence guard, unreachable GitLab, failures ═════════════════════════════════════════
test('licence guard: a licence stops check and apply loudly before any write; none, an empty body or an empty list pass', async () => {
  for (const licence of [{ id: 2, plan: 'paid-plan', expires_at: '2027-01-01' }, { id: 1, plan: 'paid-plan-2' }, [{ id: 3, plan: 'paid-plan' }]]) {
    const w = newWorld();
    w.gl.s.licence = licence;
    for (const command of ['apply', 'check']) {
      const r = await w.run(command);
      assert.equal(r.exitCode, 1, `${command}: stops`);
      assert.equal(r.licence, true);
    }
    noWritesAt(w, { f: 0, aws: 0, fs: 0 }, 'licence present');
    assert.match(w.text(), /LICENCE/);
    assert.match(w.text(), /nothing was written/i);
    assert.ok(w.events().some((e) => e.event === 'licence_found'));
    assert.equal(w.f.calls.length, 2, 'one call per run (GET /license), then the run stops');
  }
  for (const empty of [null, {}, []]) {
    const w = newWorld();
    w.gl.failNext('GET', /\/license$/, 200, empty, 1);
    assert.equal((await w.run('check')).licence, false, JSON.stringify(empty));
  }
  const w = newWorld();
  assert.equal((await w.run('check')).licence, false, '404 is no licence');
  assert.ok(w.events().some((e) => e.event === 'licence_guard' && e.licence === 'none'), 'the sync log shows the guard result (acceptance A7)');
});

test('licence guard: a licence that appears later stops the next run even though there is drift to correct', async () => {
  const w = newWorld();
  await applied(w);
  w.gl.project('rehearsal').merge_method = 'merge';
  w.gl.s.licence = { id: 5, plan: 'paid-plan' };
  const m = w.mark();
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  noWritesAt(w, m, 'licence appeared');
  assert.equal(w.gl.project('rehearsal').merge_method, 'merge');
  w.gl.s.licence = null;
  assert.equal((await w.run('apply')).exitCode, 0);
  assert.equal(w.gl.project('rehearsal').merge_method, 'ff');
});

test('licence guard: a licence read that fails (403) cannot prove there is none: stop without writing', async () => {
  const w = newWorld();
  w.gl.failNext('GET', /\/license$/, 403, { message: '403 Forbidden' }, 10);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  noWritesAt(w, { f: 0, aws: 0, fs: 0 });
});

test('unreachable GitLab: the run writes nothing and exits 1, the next run converges', async () => {
  const w = newWorld();
  w.gl.s.down = true;
  for (const command of ['apply', 'check']) {
    const r = await w.run(command);
    assert.equal(r.exitCode, 1, `${command}: an error, not drift`);
  }
  noWritesAt(w, { f: 0, aws: 0, fs: 0 }, 'GitLab down');
  assert.ok(w.events().some((e) => e.event === 'observe_failed'));
  assert.equal(w.aws.calls.length, 0, 'no Secrets Manager call before GitLab answered');
  w.gl.s.down = false;
  await applied(w);
  assert.equal((await w.run('check')).exitCode, 0);
});

test('unreachable GitLab: a read that fails half-way through the observation still writes nothing', async () => {
  for (const [method, re] of [['GET', /\/protected_branches$/], ['GET', /\/members$/], ['GET', /\/runners\/all$/], ['GET', /\/service_accounts$/], ['GET', /\/repository\/files\//]]) {
    const w = newWorld();
    await applied(w);
    w.gl.project('rehearsal').merge_method = 'merge';
    w.gl.failNext(method, re, 500, { message: 'boom' }, 50);
    const m = w.mark();
    const r = await w.run('apply');
    assert.equal(r.exitCode, 1, String(re));
    noWritesAt(w, m, `failed ${re}`);
    assert.equal(w.gl.project('rehearsal').merge_method, 'merge');
  }
});

test('failures: GitLab going away in the middle of the writes stops the run at the first network error; the next run finishes the job', async () => {
  const w = newWorld();
  const real = w.deps.fetch;
  w.deps.fetch = async (url, init) => { const res = await real(url, init); if (init.method !== 'GET') w.gl.s.down = true; return res; };
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(r.aborted, true);
  assert.ok(w.f.writes().length <= 3, `stopped after ${w.f.writes().length} writes`);
  assert.equal(w.gl.activePats('bot-land').length, 0, 'no token was handed out');
  w.deps.fetch = real;
  w.gl.s.down = false;
  await applied(w);
  assert.equal((await w.run('check')).exitCode, 0);
});

const RETRY_CASES = [
  ['retag of the legacy runner (PUT /runners/5)', 'PUT', /\/runners\/5$/, null, 'runner:legacy:update'],
  ['project merge settings (PUT /projects/:id)', 'PUT', /\/projects\/\d+$/, (w) => { w.gl.project('rehearsal').merge_method = 'merge'; }, 'project:rehearsal:settings'],
  ['removal of a protected branch (DELETE)', 'DELETE', /\/protected_branches\/main$/, (w) => { w.gl.branch('rehearsal').push_access_levels[0].access_level = 30; }, 'project:rehearsal:protection'],
  ['change of a member (PUT /members/:id)', 'PUT', /\/members\/\d+$/, (w) => { w.gl.project('rehearsal').members.set(w.gl.userByName('agent-kiro-jtadic').id, 40); }, 'member:rehearsal:agent-kiro-jtadic'],
  ['removal of a member (DELETE /members/:id)', 'DELETE', /\/members\/\d+$/, (w) => { w.gl.project('vitana-v1').members.set(w.gl.userByName('agent-kiro-exafy').id, 30); }, 'member:vitana-v1:agent-kiro-exafy'],
  ['revoking a token (DELETE /personal_access_tokens/:id)', 'DELETE', /\/personal_access_tokens\/\d+$/, (w) => { w.gl.s.pats.push({ id: 9100, user_id: w.gl.userByName('bot-land').id, name: 'x', scopes: ['api'], expires_at: null, revoked: false, value: `${PAT_PREFIX}xxxxxxxxxxxxxxxxxxxx` }); }, 'token:bot-land'],
  ['update of the fleet runner (PUT /runners/:id)', 'PUT', /\/runners\/\d+$/, (w) => { w.gl.runner('vitana-eng-fleet').run_untagged = true; }, 'runner:fleet:update'],
  ['creation of a service account (POST)', 'POST', /\/service_accounts$/, null, 'account:agent-kiro-exafy'],
  ['creation of a token (POST)', 'POST', /\/users\/\d+\/personal_access_tokens$/, null, 'token:agent-kiro-exafy'],
  ['commit to ci-config (POST)', 'POST', /repository\/commits$/, null, 'ci-files:write'],
];
test('every write passes retries: 0 — a 503 on a write is attempted once and left to the next run', async () => {
  for (const [label, method, re, prepare, changeId] of RETRY_CASES) {
    const w = newWorld();
    if (prepare) { await applied(w); prepare(w); } // prepare === null: the write happens in a first run on the M1 GitLab
    w.gl.failNext(method, re, 503, { message: 'unavailable' }, 20);
    const m = w.mark();
    const r = await w.run('apply');
    const sent = callsOf(w.f, method, re, m.f).map((c) => `${c.method} ${c.path} ${JSON.stringify(c.body)}`);
    assert.ok(sent.length >= 1, `${label}: the write was attempted`);
    assert.equal(new Set(sent).size, sent.length, `${label}: no request is sent twice (a retry would repeat it)`);
    assert.equal(r.exitCode, 1, `${label}: the run reports the failure`);
    assert.ok(r.failed.some((x) => x.id === changeId), `${label}: ${changeId} failed (got ${r.failed.map((x) => x.id)})`);
    w.gl.s.fail.length = 0;
    await applied(w);
    assert.equal((await w.run('check')).exitCode, 0, `${label}: the next run converges`);
  }
});

test('failures: a failed legacy retag keeps every token from being created; a failed account keeps only its own dependants back', async () => {
  const w = newWorld();
  w.gl.failNext('PUT', /\/runners\/5$/, 503, { message: 'unavailable' }, 20);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(createsOf(w).length, 0, 'no token while the legacy runner may still be selected');
  assert.ok(r.skipped.some((x) => x.id === 'token:bot-land' && /runner:legacy:update/.test(x.because)));
  assert.ok(r.applied.includes('project:rehearsal:protection'), 'independent work still happens');
  const w2 = newWorld();
  w2.gl.failNext('POST', /\/service_accounts$/, 400, { message: 'cannot create' }, 1);
  const r2 = await w2.run('apply');
  assert.equal(r2.exitCode, 1);
  const first = ACCOUNTS[0];
  assert.deepEqual(r2.skipped.map((x) => x.id).filter((id) => id.includes(first)).sort(), [`member:rehearsal:${first}`, `member:ci-config:${first}`, `token:${first}`].sort());
  assert.ok(r2.applied.includes(`token:${ACCOUNTS[1]}`), 'other accounts are served');
});

test('failures: three server errors in a row end the run, a single one does not', async () => {
  const w = newWorld();
  w.gl.failNext('POST', /\/service_accounts$/, 503, { message: 'unavailable' }, 20);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(r.aborted, true);
  assert.deepEqual(r.failed.map((x) => x.id), ['account:agent-kiro-exafy', 'account:agent-kiro-exafyltd', 'account:agent-kiro-jtadic']);
  assert.ok(w.events().some((e) => e.event === 'run_aborted'));
  const w2 = newWorld();
  w2.gl.failNext('POST', /\/service_accounts$/, 503, { message: 'unavailable' }, 1);
  const r2 = await w2.run('apply');
  assert.equal(r2.aborted, false);
  assert.equal(r2.failed.length, 1);
  assert.ok(r2.applied.includes('account:agent-kiro-exafyltd'), 'the run goes on after a single server error');
});

test('protection: when the re-creation after a removal fails, it is tried once more at once and then reported as unprotected', async () => {
  const w = newWorld();
  await applied(w);
  w.gl.branch('rehearsal').push_access_levels[0].access_level = 30;
  w.gl.failNext('POST', /\/protected_branches$/, 503, { message: 'unavailable' }, 1);
  let m = w.mark();
  let r = await w.run('apply');
  assert.equal(r.exitCode, 0, 'the immediate second attempt succeeds');
  assert.equal(callsOf(w.f, 'POST', /\/protected_branches$/, m.f).length, 2);
  assert.equal(callsOf(w.f, 'DELETE', /\/protected_branches\/main$/, m.f).length, 1);
  assert.equal(w.gl.branch('rehearsal').push_access_levels[0].access_level, 0);
  w.gl.branch('rehearsal').push_access_levels[0].access_level = 30;
  w.gl.failNext('POST', /\/protected_branches$/, 503, { message: 'unavailable' }, 2);
  m = w.mark();
  r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(w.gl.project('rehearsal').branches.length, 0, 'main is unprotected until the next run');
  assert.match(w.text(), /UNPROTECTED/);
  r = await w.run('apply');
  assert.equal(r.exitCode, 0);
  assert.equal(w.gl.branch('rehearsal').push_access_levels[0].access_level, 0);
});

test('failures: a failed protection keeps every token back; a failed membership keeps back the token of that account only', async () => {
  const w = newWorld();
  w.gl.failNext('POST', /\/protected_branches$/, 400, { message: 'cannot protect' }, 5);
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.ok(r.failed.some((x) => x.id === 'project:rehearsal:protection'));
  assert.equal(createsOf(w).length, 0, 'no credential exists while main of the native project is not protected');
  assert.ok(ACCOUNTS.every((u) => r.skipped.some((x) => x.id === `token:${u}` && /project:rehearsal:protection/.test(x.because))));
  const w2 = newWorld();
  w2.gl.failNext('POST', /\/members$/, 400, { message: 'cannot add' }, 1);
  const r2 = await w2.run('apply');
  assert.equal(r2.exitCode, 1);
  assert.deepEqual(r2.failed.map((x) => x.id), ['member:ci-config:agent-kiro-exafy']);
  assert.deepEqual(r2.skipped.map((x) => x.id), ['token:agent-kiro-exafy'], 'only the token of the account whose membership failed');
  assert.equal(w2.gl.activePats('agent-kiro-exafyltd').length, 1);
});

test('rotation: a token that turned inactive between the read and the rotation is not rotated (reuse of a revoked token would revoke its whole family)', async () => {
  const w = newWorld();
  await applied(w);
  w.gl.activePats('agent-reviewer')[0].expires_at = inDays(5);
  w.gl.failNext('GET', /^\/api\/v4\/personal_access_tokens\/\d+$/, 200, { id: 1, active: false, revoked: true }, 1);
  const m = w.mark();
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.equal(rotatesOf(w, m.f).length, 0);
  assert.ok(r.failed.some((x) => x.id === 'token:agent-reviewer' && /no longer active/.test(x.error)));
  const w2 = newWorld();
  w2.gl.s.pats[0].expires_at = inDays(4);
  w2.gl.failNext('GET', /^\/api\/v4\/personal_access_tokens\/\d+$/, 200, { id: 1, active: false }, 1);
  const r2 = await w2.run('apply');
  assert.equal(rotatesOf(w2).length, 0);
  assert.ok(r2.failed.some((x) => x.id === 'admin-token:rotate' && /no longer active/.test(x.error)));
});

// ═════════════════════════════════════════ service accounts ═════════════════════════════════════════════════════════════════════
test('service accounts: near the 100-account cap the sync reports it; at the cap creation fails loudly and only that account is held back', async () => {
  const w = newWorld();
  const fill = (n) => { for (let i = 0; i < n; i++) w.gl.s.users.push({ id: 5000 + w.gl.s.users.length, username: `svc-${w.gl.s.users.length}`, name: 'x', admin: false, service: true }); };
  fill(72);
  let r = await w.run('check');
  assert.ok(!r.findings.some((x) => /cap|100/.test(x.message)), '72 of 100 is not near');
  fill(8);
  r = await w.run('check');
  const cap = r.findings.find((x) => /100/.test(x.message));
  assert.ok(cap && cap.level === 'warn' && /80/.test(cap.message), `80 of 100 is reported: ${JSON.stringify(r.findings)}`);
  assert.equal(r.exitCode, 3, 'the drift is still there; the warning alone does not change the exit code');
  const w2 = newWorld();
  for (let i = 0; i < 95; i++) w2.gl.s.users.push({ id: 6000 + i, username: `svc-${i}`, name: 'x', admin: false, service: true });
  const r2 = await w2.run('apply');
  assert.equal(r2.exitCode, 1);
  assert.deepEqual(r2.failed.filter((x) => x.id.startsWith('account:')).map((x) => x.id), ['account:bot-land', 'account:bot-metrics'], '95 + 5 reach 100; the last two accounts cannot be created');
  assert.ok(r2.applied.includes('account:agent-reviewer') && r2.applied.includes('token:agent-reviewer'), 'the accounts that fit are served');
  assert.ok(r2.skipped.some((x) => x.id === 'token:bot-land'), 'no token for an account that does not exist');
  assert.match(w2.text(), /limit of service accounts/);
  assert.ok(r2.findings.some((x) => /95|100/.test(x.message)));
});

test('service accounts: a username already taken by a person is an error for that account only; it gets no token and no membership', async () => {
  const w = newWorld();
  w.gl.s.users.push({ id: 400, username: 'agent-reviewer', name: 'A person', admin: false, service: false });
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1);
  assert.ok(r.failed.some((x) => x.id === 'account:agent-reviewer' && /taken|not a service account/i.test(x.error)));
  assert.equal(w.gl.activePats('agent-reviewer').length, 0);
  assert.ok(![...w.gl.project('rehearsal').members.keys()].includes(400));
  assert.ok(r.applied.includes('token:bot-land'), 'the other accounts are served');
});

// ═════════════════════════════════════════ the command line ═════════════════════════════════════════════════════════════════════
test('cli: apply is the default; check and --check never write and exit 3 on drift, 0 when clean; --dry-run writes nothing', async () => {
  const w = newWorld();
  let m = w.mark();
  assert.equal(await w.cli('check'), 3);
  assert.equal(await w.cli('--check'), 3);
  assert.equal(await w.cli('--dry-run'), 0, 'apply --dry-run lists the drift and exits 0');
  assert.equal(await w.cli('apply', '--dry-run'), 0);
  noWritesAt(w, m, 'check and dry-run');
  assert.ok(w.lines.some((l) => /^drift: /.test(l)));
  assert.ok(w.lines.some((l) => /would apply/i.test(l)));
  assert.equal(await w.cli(), 0, 'no command = apply');
  assert.ok(w.gl.project('rehearsal'));
  m = w.mark();
  assert.equal(await w.cli('check'), 0);
  assert.equal(await w.cli(), 0);
  noWritesAt(w, m);
  assert.match(w.text(), /settings check: 0 drift/);
});

test('cli: usage mistakes exit 2 and write nothing; help exits 0', async () => {
  const w = newWorld();
  for (const argv of [['frobnicate'], ['apply', 'check'], ['--bogus'], ['--config'], ['--url'], ['check', '--ci-dir'], ['--dry-run=yes']]) {
    assert.equal(await settings.main(argv, w.deps), 2, argv.join(' '));
  }
  assert.equal(await settings.main([...w.baseArgs, 'check'], { ...w.deps, env: { DOMAIN: 'x.example.test' } }), 2, 'no REGION');
  assert.equal(await settings.main([...w.baseArgs.slice(0, 4), '--url', 'http://gitlab.example.test', 'check'], w.deps), 2, 'plain http to a remote host');
  assert.equal(await settings.main(['--help'], w.deps), 0);
  assert.ok(w.lines.some((l) => /usage: gitlab-settings\.mjs/.test(l)));
  assert.equal(w.f.calls.length, 0);
});

test('cli: a missing admin token file, an unreadable or invalid settings file are errors (exit 1) that say what to do', async () => {
  const w = newWorld();
  w.fsx.files.delete(ADMIN_FILE);
  assert.equal(await w.cli('check'), 1);
  assert.match(w.text(), /ops-install\.sh/);
  const w2 = newWorld();
  w2.fsx.files.delete('/repo/settings.json');
  assert.equal(await w2.cli('check'), 1);
  const bad = clone(shipped());
  bad.accounts[0].role = 'owner';
  const w3 = newWorld({ config: bad });
  assert.equal(await w3.cli('apply'), 1);
  assert.match(w3.text(), /accounts\[0\]\.role/);
  assert.equal(w3.f.calls.length, 0, 'an invalid file is refused before GitLab is contacted');
  const w4 = newWorld();
  w4.fsx.files.set('/repo/settings.json', { text: '{ not json', mode: 0o644 });
  assert.equal(await w4.cli('check'), 1);
  assert.match(w4.text(), /not valid JSON/);
});

test('cli: a settings file naming another DOMAIN than the host is reported as a warning', async () => {
  const w = newWorld();
  w.deps.env = { REGION: 'eu-central-1', DOMAIN: 'gitlab.other.example' };
  const r = await w.run('check');
  assert.ok(r.findings.some((x) => x.level === 'warn' && /gitlab\.other\.example/.test(x.message) && /gitlab\.vitanaland\.com/.test(x.message)));
});

// ═════════════════════════════════════════ the parts that touch the machine ═════════════════════════════════════════════════════
test('real file writer: atomic, mode 0600 whatever the umask, replaces a looser file, leaves no temp file, lists only .yml files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-fs-'));
  try {
    const rfs = settings.realFs();
    const target = path.join(dir, 'bot-token');
    fs.writeFileSync(target, 'old\n', { mode: 0o644 });
    const old = process.umask(0o000);
    try { await rfs.writeAtomic(target, 'new-token\n', { mode: 0o600 }); } finally { process.umask(old); }
    assert.equal(fs.readFileSync(target, 'utf8'), 'new-token\n');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['bot-token'], 'no temp file left behind');
    assert.deepEqual(await rfs.readFile(target), { text: 'new-token\n', mode: 0o600 });
    assert.equal(await rfs.readFile(path.join(dir, 'missing')), null);
    await rfs.preflight(target);
    assert.deepEqual(fs.readdirSync(dir), ['bot-token'], 'the preflight leaves nothing behind');
    await assert.rejects(() => rfs.preflight(path.join(dir, 'no-such-dir', 'x')));
    await assert.rejects(() => rfs.writeAtomic(path.join(dir, 'no-such-dir', 'x'), 't', { mode: 0o600 }));
    for (const n of ['b.yml', 'a.yml', 'c.yaml', 'notes.md']) fs.writeFileSync(path.join(dir, n), 'x');
    fs.mkdirSync(path.join(dir, 'd.yml'));
    fs.symlinkSync(path.join(dir, 'a.yml'), path.join(dir, 'link.yml'));
    assert.deepEqual(await rfs.listYml(dir), ['a.yml', 'b.yml'], 'regular .yml files, sorted');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('real aws runner: the generic runner passes input on stdin, never in the argument list; a failing call carries the AWS error text', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-aws-'));
  try {
    const bin = path.join(dir, 'aws');
    fs.writeFileSync(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > "$AWS_FAKE_ARGS"\ncat > "$AWS_FAKE_STDIN"\nif [ -n "$AWS_FAKE_FAIL" ]; then echo "An error occurred (ResourceNotFoundException): nope" >&2; exit 254; fi\necho \'{"Name":"x"}\'\n', { mode: 0o755 });
    const env = { PATH: `${dir}:${process.env.PATH}`, AWS_FAKE_ARGS: path.join(dir, 'args'), AWS_FAKE_STDIN: path.join(dir, 'stdin') };
    const real = settings.defaultDeps(env);
    const secret = `${PAT_PREFIX}supersecretvalue0123456789`;
    const out = await real.aws(['secretsmanager', 'put-secret-value', '--secret-id', SECRET_AGENT('x'), '--secret-string', 'file:///dev/stdin', '--region', 'eu-central-1'], { input: secret });
    assert.match(out.stdout, /Name/);
    assert.equal(fs.readFileSync(env.AWS_FAKE_STDIN, 'utf8'), secret);
    assert.ok(!fs.readFileSync(env.AWS_FAKE_ARGS, 'utf8').includes(secret));
    assert.ok(fs.readFileSync(env.AWS_FAKE_ARGS, 'utf8').includes('file:///dev/stdin'));
    const failing = settings.defaultDeps({ ...env, AWS_FAKE_FAIL: '1' });
    await assert.rejects(() => failing.aws(['secretsmanager', 'get-secret-value', '--secret-id', SECRET_AGENT('x')]), (e) => /ResourceNotFoundException/.test(`${e.message} ${e.stderr}`) && !e.message.includes(secret));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redaction: every secret registered during a run, GitLab token shapes and bearer tokens are removed from text', () => {
  const r = settings.makeRedactor();
  r.add('plain-secret-value-1');
  r.add('short');
  assert.equal(r(`a plain-secret-value-1 b ${PAT_PREFIX}abcdefghijklmnopqrstu c Bearer abc.def-123 d ${['whsec', '_'].join('')}QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVowMTIzNDU= e short`), 'a [redacted] b [redacted] c [redacted] d [redacted] e short');
  assert.equal(r(undefined), '');
});

test('free tier: every call of a full apply, a drift repair and a webhook run is on the documented endpoint list, with the documented method', async () => {
  const toRe = (tpl) => new RegExp(`^${tpl.replace(/\?.*$/, '').replace(/:[a-z_]+/g, '[^/]+')}$`);
  const known = ENDPOINTS.map(([m, p]) => [m, toRe(p)]);
  const w = newWorld({ config: withHook() });
  await applied(w);
  w.gl.branch('rehearsal').push_access_levels[0].access_level = 30;
  w.gl.project('vitana-v1').hooks[0].url = 'https://x.example.test/h';
  w.gl.s.pats.find((p) => p.user_id === 1).expires_at = inDays(3);
  await applied(w);
  for (const c of w.f.calls) {
    const rel = c.path.replace(/^\/api\/v4/, '');
    assert.ok(known.some(([m, re]) => m === c.method && re.test(rel)), `${c.method} ${rel} is not on the Free-tier endpoint list`);
  }
});

test('tokens: a value file is removed even when Secrets Manager refuses the write', async () => {
  const w = newWorld({ preCreateAgentSecrets: true });
  w.aws.deny('put-secret-value', SECRET_AGENT('agent-reviewer'));
  const r = await w.run('apply');
  assert.equal(r.exitCode, 1, 'a refused write is an error');
  assert.match(w.text(), /agent-reviewer/);
  assert.ok(seenSecretFiles.length > 0, 'the refused write did create a value file');
  for (const f of seenSecretFiles) {
    assert.ok(!fs.existsSync(f), 'the value file is removed after a refusal');
    assert.ok(!fs.existsSync(path.dirname(f)), 'its private directory is removed after a refusal');
  }
});
