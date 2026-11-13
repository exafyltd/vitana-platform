// Tests of the delivery cutover in the settings sync (plan agentic-delivery §3.6 step 8 and §8.2 step 3, lane cutover, VTID-05545):
// scripts/eng/gitlab-settings.mjs and the `cutover` blocks of infra/gitlab-engineering/settings/gitlab-settings.json.
// GitLab is a stateful fake on the recording fake fetch of lane gitlab-client (it knows only the Free-tier endpoints of ENDPOINTS and
// throws on any other call); AWS Secrets Manager and /etc/vitana are in-memory fakes injected through deps, as in
// scripts/eng/gitlab-settings.test.mjs. A project with a cutover block is inactive until its generated pipeline file is in the CI folder,
// then runs the shadow pipelines; the marker file turns it live (or "rehearsal"); removing the marker converges it back.
// Dependency-free Node (node:test), so UNIT.yml runs it with no install.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeFetch } from './testing/fake-fetch.mjs';
import * as settings from './gitlab-settings.mjs';
import { loadProjects } from './gitlab-land.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const CONFIG_FILE = path.join(ROOT, 'infra', 'gitlab-engineering', 'settings', 'gitlab-settings.json');
const RUNBOOK_FILE = path.join(ROOT, 'infra', 'gitlab-engineering', 'RUNBOOK-cutover.md');
const SCRIPT_FILE = path.join(HERE, 'gitlab-settings.mjs');

// Fixture tokens are assembled at run time: the repository's secret scan has no allowlist, and these are not secrets.
const PAT_PREFIX = ['glp', 'at-'].join('');
const RUNNER_PREFIX = ['gl', 'rt-'].join('');
const GH_TOKEN = ['github', 'pat', '11AAAAAAAAAAAAAAAAAAAA'].join('_');
const NOW = Date.parse('2026-11-05T10:30:00Z');
const DAY = 86_400_000;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const inDays = (n) => isoDay(Math.floor(NOW / DAY) * DAY + n * DAY);
const ADMIN_TOKEN = `${PAT_PREFIX}adminAAAAAAAAAAAAAAAA`;
const ADMIN_FILE = '/etc/vitana/settings-admin-token';
const MARKER_FILE = '/etc/vitana/delivery-cutover';
const MIRROR_TOKEN_FILE = '/etc/vitana/github-push-mirror-token';
const SIGNING_TOKEN = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
const HOOK_URL = 'https://preview-aws-gateway.vitanaland.com/api/v1/internal/gitlab/webhook';
const CI_FILES = {
  'platform.gitlab-ci.yml': '# central CI for vitana-platform (milestone 2)\n',
  'v1.gitlab-ci.yml': '# central CI for vitana-v1 (milestone 2)\n',
  'rehearsal.gitlab-ci.yml': '# central CI for rehearsal\n',
};
const DELIVERY_FILES = {
  'platform-delivery.gitlab-ci.yml': '# GENERATED delivery pipeline of vitana-platform\n',
  'v1-delivery.gitlab-ci.yml': '# GENERATED delivery pipeline of vitana-v1\n',
};
const MIRRORED = ['vitana-platform', 'vitana-v1'];
const clone = (v) => JSON.parse(JSON.stringify(v));
const shipped = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const randomToken = () => `${PAT_PREFIX}${crypto.randomBytes(10).toString('hex')}`;
const marker = (mode, extra = {}) => JSON.stringify({ schema: 'vitana.delivery-cutover-marker/v1', mode, plan: 'agentic-delivery', at: '2026-11-06T09:00:00Z', ...extra });

// ── the Free-tier endpoints the sync may call in these runs (docs.gitlab.com, the tier banner of each page includes Free) ──────────
export const ENDPOINTS = [
  ['GET', '/license', 'api/license'], ['GET', '/personal_access_tokens/self', 'api/personal_access_tokens'], ['GET', '/personal_access_tokens', 'api/personal_access_tokens'],
  ['GET', '/personal_access_tokens/:id', 'api/personal_access_tokens'], ['POST', '/personal_access_tokens/:id/rotate', 'api/personal_access_tokens'], ['DELETE', '/personal_access_tokens/:id', 'api/personal_access_tokens'],
  ['POST', '/users/:id/personal_access_tokens', 'api/user_tokens'], ['GET', '/users?username=', 'api/users'], ['GET', '/service_accounts', 'api/service_accounts'], ['POST', '/service_accounts', 'api/service_accounts'],
  ['GET', '/groups/:path', 'api/groups'], ['GET', '/projects/:id', 'api/projects'], ['POST', '/projects', 'api/projects'], ['PUT', '/projects/:id', 'api/projects'],
  ['GET', '/projects/:id/protected_branches', 'api/protected_branches'], ['POST', '/projects/:id/protected_branches', 'api/protected_branches'],
  ['PATCH', '/projects/:id/protected_branches/:name', 'api/protected_branches'], ['DELETE', '/projects/:id/protected_branches/:name', 'api/protected_branches'],
  ['GET', '/projects/:id/members', 'api/project_members'], ['GET', '/projects/:id/members/all', 'api/project_members'], ['POST', '/projects/:id/members', 'api/project_members'],
  ['PUT', '/projects/:id/members/:user_id', 'api/project_members'], ['DELETE', '/projects/:id/members/:user_id', 'api/project_members'],
  ['GET', '/projects/:id/hooks', 'api/project_webhooks'], ['POST', '/projects/:id/hooks', 'api/project_webhooks'], ['PUT', '/projects/:id/hooks/:hook_id', 'api/project_webhooks'], ['DELETE', '/projects/:id/hooks/:hook_id', 'api/project_webhooks'],
  ['GET', '/runners/all', 'api/runners'], ['GET', '/runners/:id', 'api/runners'], ['PUT', '/runners/:id', 'api/runners'], ['POST', '/user/runners', 'api/users'], ['POST', '/runners/:id/reset_authentication_token', 'api/runners'],
  ['GET', '/projects/:id/repository/files/:path', 'api/repository_files'], ['POST', '/projects/:id/repository/commits', 'api/commits'],
  // new in lane cutover (both pages carry the Free tier banner: project-level CI/CD variables and project remote mirrors)
  ['GET', '/projects/:id/variables', 'api/project_level_variables'], ['POST', '/projects/:id/variables', 'api/project_level_variables'], ['PUT', '/projects/:id/variables/:key', 'api/project_level_variables'],
  ['GET', '/projects/:id/remote_mirrors', 'api/remote_mirrors'], ['POST', '/projects/:id/remote_mirrors', 'api/remote_mirrors'], ['PUT', '/projects/:id/remote_mirrors/:id', 'api/remote_mirrors'], ['DELETE', '/projects/:id/remote_mirrors/:id', 'api/remote_mirrors'],
];
const normalise = (p) => p.replace(/^\/api\/v4/, '').replace(/\?.*$/, '').replace(/\/projects\/(?:\d+|vitana%2F[A-Za-z0-9._-]+)/, '/projects/:id').replace(/\/hooks\/\d+/, '/hooks/:hook_id').replace(/\/members\/\d+/, '/members/:user_id')
  .replace(/\/runners\/\d+/, '/runners/:id').replace(/\/remote_mirrors\/\d+/, '/remote_mirrors/:id').replace(/\/variables\/[A-Z_]+/, '/variables/:key').replace(/\/protected_branches\/[^/]+$/, '/protected_branches/:name')
  .replace(/\/personal_access_tokens\/\d+/, '/personal_access_tokens/:id').replace(/\/users\/\d+/, '/users/:id').replace(/\/files\/[^/]+$/, '/files/:path').replace(/\/groups\/[^/]+$/, '/groups/:path');

// ── fake GitLab ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
function newGitLab() {
  const s = {
    seq: 100, hookSeq: 0, mirrorSeq: 0, commits: 0, fail: [],
    users: [{ id: 1, username: 'root', name: 'Administrator', admin: true, service: false }, { id: 50, username: 'vitana-mirror', name: 'Vitana mirror', admin: false, service: false }],
    pats: [{ id: 1, user_id: 1, name: 'settings-admin', scopes: ['api'], expires_at: inDays(60), revoked: false, value: ADMIN_TOKEN }],
    groups: [{ id: 10, path: 'vitana' }], projects: [], runners: [],
  };
  const nextId = () => ++s.seq;
  const ok = (json, status = 200, headers) => ({ status, json, headers });
  const notFound = (m = '404 Not Found') => ({ status: 404, json: { message: m } });
  const bad = (message, status = 400) => ({ status, json: { message } });
  const active = (p) => !p.revoked && (p.expires_at === null || p.expires_at > isoDay(NOW));
  const meta = (p) => ({ id: p.id, name: p.name, revoked: p.revoked, scopes: p.scopes, user_id: p.user_id, active: active(p), expires_at: p.expires_at });
  const page = (call, list) => {
    const per = Number(call.query.per_page?.[0] ?? 20);
    const pg = Number(call.query.page?.[0] ?? 1);
    return ok(list.slice((pg - 1) * per, pg * per), 200, { 'x-next-page': pg * per < list.length ? String(pg + 1) : '' });
  };
  const proj = (k0) => { const k = decodeURIComponent(k0); return /^\d+$/.test(k) ? s.projects.find((p) => p.id === Number(k)) : s.projects.find((p) => `vitana/${p.path}` === k); };
  const userById = (id) => s.users.find((u) => u.id === Number(id));
  const FIELDS = ['ci_config_path', 'merge_method', 'squash_option', 'only_allow_merge_if_pipeline_succeeds', 'only_allow_merge_if_all_discussions_are_resolved', 'remove_source_branch_after_merge',
    'automatic_rebase_enabled', 'squash_commit_template', 'merge_commit_template', 'allow_merge_on_skipped_pipeline'];
  const projectView = (p) => ({ id: p.id, name: p.name, path: p.path, path_with_namespace: `vitana/${p.path}`, default_branch: p.default_branch, ...Object.fromEntries(FIELDS.map((f) => [f, p[f]])) });
  const memberView = (uid, level) => { const u = userById(uid); return { id: u.id, username: u.username, name: u.name, state: 'active', access_level: level }; };
  const accessLevel = (level) => ({ id: nextId(), access_level: level });
  const branchView = (b) => ({ id: b.id, name: b.name, push_access_levels: b.push_access_levels, merge_access_levels: b.merge_access_levels, allow_force_push: b.allow_force_push });
  const HOOK_FLAGS = ['push_events', 'tag_push_events', 'issues_events', 'confidential_issues_events', 'note_events', 'confidential_note_events', 'job_events', 'pipeline_events', 'wiki_page_events',
    'deployment_events', 'releases_events', 'milestone_events', 'feature_flag_events', 'resource_access_token_events', 'merge_requests_events'];
  const hookView = (h) => { const { _signing, ...rest } = h; return { ...rest, signing_token_present: Boolean(_signing) }; };
  const runnerList = (r) => ({ id: r.id, description: r.description, paused: r.paused, runner_type: r.runner_type });
  const runnerView = (r) => ({ ...runnerList(r), tag_list: r.tag_list, run_untagged: r.run_untagged, locked: r.locked, access_level: r.access_level });
  const mirrorView = (m) => ({ id: m.id, enabled: m.enabled, url: m.maskedUrl, only_protected_branches: m.only_protected_branches, keep_divergent_refs: m.keep_divergent_refs, last_error: m.last_error ?? null, update_status: 'finished' });

  function addProject({ name, ci_config_path = '', readme = false }) {
    const p = {
      id: nextId(), name, path: name, default_branch: readme ? 'main' : null, ci_config_path, merge_method: 'merge', squash_option: 'default_off', only_allow_merge_if_pipeline_succeeds: false,
      only_allow_merge_if_all_discussions_are_resolved: false, remove_source_branch_after_merge: false, automatic_rebase_enabled: false, squash_commit_template: null, merge_commit_template: null,
      allow_merge_on_skipped_pipeline: false, members: new Map(), branches: [], hooks: [], files: new Map(), variables: [], mirrors: [],
    };
    if (readme) {
      p.files.set('README.md', '# readme\n');
      p.branches.push({ id: nextId(), name: 'main', push_access_levels: [accessLevel(40)], merge_access_levels: [accessLevel(40)], allow_force_push: true });
    }
    s.projects.push(p);
    return p;
  }
  const PREMIUM = [['mirror_branch', '_regex'], ['allowed_to', '_push']].map((x) => x.join(''));
  const maskUrl = (u) => u.replace(/\/\/[^@/]*@/, '//*****:*****@');

  const routes = [
    ['GET', /^\/license$/, () => notFound()],
    ['GET', /^\/personal_access_tokens\/self$/, (m, c, who) => ok(meta(who.pat))],
    ['GET', /^\/personal_access_tokens$/, (m, call) => {
      const uid = call.query.user_id?.[0];
      const list = s.pats.filter((p) => (uid === undefined || p.user_id === Number(uid)) && (call.query.state?.[0] !== 'active' || active(p))).sort((a, b) => a.id - b.id);
      return page(call, list.map(meta));
    }],
    ['GET', /^\/personal_access_tokens\/(\d+)$/, (m) => { const p = s.pats.find((x) => x.id === Number(m[1])); return p ? ok(meta(p)) : notFound(); }],
    ['POST', /^\/personal_access_tokens\/(\d+)\/rotate$/, (m, call) => {
      const old = s.pats.find((x) => x.id === Number(m[1]));
      if (!old) return notFound();
      old.revoked = true;
      const fresh = { id: nextId(), user_id: old.user_id, name: old.name, scopes: [...old.scopes], expires_at: call.body?.expires_at ?? inDays(7), revoked: false, value: randomToken() };
      s.pats.push(fresh);
      return ok({ ...meta(fresh), token: fresh.value });
    }],
    ['DELETE', /^\/personal_access_tokens\/(\d+)$/, (m) => { const p = s.pats.find((x) => x.id === Number(m[1])); if (!p) return notFound(); p.revoked = true; return { status: 204 }; }],
    ['POST', /^\/users\/(\d+)\/personal_access_tokens$/, (m, call) => {
      const u = userById(m[1]);
      if (!u) return notFound();
      const b = call.body ?? {};
      const fresh = { id: nextId(), user_id: u.id, name: b.name, scopes: [...b.scopes], expires_at: b.expires_at ?? null, revoked: false, value: randomToken() };
      s.pats.push(fresh);
      return ok({ ...meta(fresh), token: fresh.value }, 201);
    }],
    ['GET', /^\/users$/, (m, call) => ok(s.users.filter((u) => u.username === call.query.username?.[0]).map((u) => ({ id: u.id, username: u.username, name: u.name })))],
    ['GET', /^\/service_accounts$/, (m, call) => page(call, s.users.filter((u) => u.service).sort((a, b) => b.id - a.id).map((u) => ({ id: u.id, username: u.username, name: u.name })))],
    ['POST', /^\/service_accounts$/, (m, call) => {
      const b = call.body ?? {};
      if (s.users.some((u) => u.username === b.username)) return bad('Username has already been taken');
      const u = { id: nextId(), username: b.username, name: b.name, admin: false, service: true };
      s.users.push(u);
      return ok({ id: u.id, username: u.username, name: u.name }, 201);
    }],
    ['GET', /^\/groups\/([^/]+)$/, (m) => { const g = s.groups.find((x) => x.path === decodeURIComponent(m[1])); return g ? ok({ id: g.id, path: g.path }) : notFound(); }],
    ['GET', /^\/projects\/([^/]+)$/, (m) => { const p = proj(m[1]); return p ? ok(projectView(p)) : notFound('404 Project Not Found'); }],
    ['POST', /^\/projects$/, (m, call) => { const b = call.body ?? {}; const p = addProject({ name: b.name, ci_config_path: b.ci_config_path ?? '', readme: b.initialize_with_readme === true }); return ok(projectView(p), 201); }],
    ['PUT', /^\/projects\/([^/]+)$/, (m, call) => {
      const p = proj(m[1]);
      if (!p) return notFound();
      for (const [k, v] of Object.entries(call.body ?? {})) { if (!FIELDS.includes(k)) return bad(`unknown project attribute ${k}`); p[k] = v; }
      return ok(projectView(p));
    }],
    ['GET', /^\/projects\/([^/]+)\/protected_branches$/, (m) => { const p = proj(m[1]); return p ? ok(p.branches.map(branchView)) : notFound(); }],
    ['POST', /^\/projects\/([^/]+)\/protected_branches$/, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p) return notFound();
      if (PREMIUM.some((k) => k in b)) return bad('not available on the Free tier');
      if (p.branches.some((x) => x.name === b.name)) return bad('Protected branch already exists', 409);
      const br = { id: nextId(), name: b.name, push_access_levels: [accessLevel(b.push_access_level ?? 40)], merge_access_levels: [accessLevel(b.merge_access_level ?? 40)], allow_force_push: b.allow_force_push === true };
      p.branches.push(br);
      return ok(branchView(br), 201);
    }],
    ['PATCH', /^\/projects\/([^/]+)\/protected_branches\/([^/]+)$/, (m, call) => {
      const br = proj(m[1])?.branches.find((x) => x.name === decodeURIComponent(m[2]));
      if (!br) return notFound();
      if (Object.keys(call.body ?? {}).some((k) => k !== 'allow_force_push')) return bad('only allow_force_push can be changed on Free');
      br.allow_force_push = call.body.allow_force_push;
      return ok(branchView(br));
    }],
    ['DELETE', /^\/projects\/([^/]+)\/protected_branches\/([^/]+)$/, (m) => {
      const p = proj(m[1]);
      const i = p ? p.branches.findIndex((x) => x.name === decodeURIComponent(m[2])) : -1;
      if (i < 0) return notFound();
      p.branches.splice(i, 1);
      return { status: 204 };
    }],
    ['GET', /^\/projects\/([^/]+)\/members$/, (m, call) => { const p = proj(m[1]); return p ? page(call, [...p.members].map(([uid, lvl]) => memberView(uid, lvl))) : notFound(); }],
    ['GET', /^\/projects\/([^/]+)\/members\/all$/, (m, call) => {
      const p = proj(m[1]);
      if (!p) return notFound();
      const all = new Map(p.members);
      if (!all.has(1)) all.set(1, 50);
      return page(call, [...all].map(([uid, lvl]) => memberView(uid, lvl)));
    }],
    ['POST', /^\/projects\/([^/]+)\/members$/, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p || !userById(b.user_id)) return notFound();
      if (p.members.has(b.user_id)) return bad('Member already exists', 409);
      p.members.set(b.user_id, b.access_level);
      return ok(memberView(b.user_id, b.access_level), 201);
    }],
    ['PUT', /^\/projects\/([^/]+)\/members\/(\d+)$/, (m, call) => { const p = proj(m[1]); if (!p || !p.members.has(Number(m[2]))) return notFound(); p.members.set(Number(m[2]), call.body.access_level); return ok(memberView(Number(m[2]), call.body.access_level)); }],
    ['DELETE', /^\/projects\/([^/]+)\/members\/(\d+)$/, (m) => { const p = proj(m[1]); if (!p || !p.members.delete(Number(m[2]))) return notFound(); return { status: 204 }; }],
    ['GET', /^\/projects\/([^/]+)\/hooks$/, (m) => { const p = proj(m[1]); return p ? ok(p.hooks.map(hookView)) : notFound(); }],
    ['POST', /^\/projects\/([^/]+)\/hooks$/, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p || !b.url) return bad('url is required');
      const h = { id: ++s.hookSeq, url: b.url, name: b.name ?? '', description: b.description ?? '', enable_ssl_verification: b.enable_ssl_verification ?? true, _signing: b.signing_token ?? null };
      for (const f of HOOK_FLAGS) h[f] = b[f] ?? (f === 'push_events');
      p.hooks.push(h);
      return ok(hookView(h), 201);
    }],
    ['PUT', /^\/projects\/([^/]+)\/hooks\/(\d+)$/, (m, call) => {
      const h = proj(m[1])?.hooks.find((x) => x.id === Number(m[2]));
      if (!h) return notFound();
      for (const [k, v] of Object.entries(call.body ?? {})) { if (k === 'signing_token') h._signing = v; else h[k] = v; }
      return ok(hookView(h));
    }],
    ['DELETE', /^\/projects\/([^/]+)\/hooks\/(\d+)$/, (m) => { const p = proj(m[1]); const i = p ? p.hooks.findIndex((x) => x.id === Number(m[2])) : -1; if (i < 0) return notFound(); p.hooks.splice(i, 1); return { status: 204 }; }],
    ['GET', /^\/projects\/([^/]+)\/variables$/, (m, call) => { const p = proj(m[1]); return p ? page(call, p.variables) : notFound(); }],
    ['POST', /^\/projects\/([^/]+)\/variables$/, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p) return notFound();
      if (p.variables.some((v) => v.key === b.key)) return bad('has already been taken', 400);
      const v = { key: b.key, value: b.value, variable_type: 'env_var', protected: b.protected === true, masked: b.masked === true, environment_scope: b.environment_scope ?? '*' };
      p.variables.push(v);
      return ok(v, 201);
    }],
    ['PUT', /^\/projects\/([^/]+)\/variables\/([A-Z_]+)$/, (m, call) => {
      const v = proj(m[1])?.variables.find((x) => x.key === m[2]);
      if (!v) return notFound('404 Variable Not Found');
      Object.assign(v, call.body ?? {});
      return ok(v);
    }],
    ['GET', /^\/projects\/([^/]+)\/remote_mirrors$/, (m) => { const p = proj(m[1]); return p ? ok(p.mirrors.map(mirrorView)) : notFound(); }],
    ['POST', /^\/projects\/([^/]+)\/remote_mirrors$/, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p) return notFound();
      if (PREMIUM.some((k) => k in b)) return bad('not available on the Free tier');
      if (!/^https:\/\/[^@/]+@github\.com\/[^/]+\/[^/]+\.git$/.test(b.url ?? '')) return bad('url is invalid');
      const mm = { id: ++s.mirrorSeq, enabled: b.enabled ?? true, only_protected_branches: b.only_protected_branches ?? false, keep_divergent_refs: b.keep_divergent_refs ?? false, maskedUrl: maskUrl(b.url), rawUrl: b.url };
      p.mirrors.push(mm);
      return ok(mirrorView(mm), 201);
    }],
    ['PUT', /^\/projects\/([^/]+)\/remote_mirrors\/(\d+)$/, (m, call) => {
      const mm = proj(m[1])?.mirrors.find((x) => x.id === Number(m[2]));
      if (!mm) return notFound();
      for (const [k, v] of Object.entries(call.body ?? {})) { if (k === 'url') return bad('the URL of a mirror cannot be changed'); mm[k] = v; }
      return ok(mirrorView(mm));
    }],
    ['DELETE', /^\/projects\/([^/]+)\/remote_mirrors\/(\d+)$/, (m) => { const p = proj(m[1]); const i = p ? p.mirrors.findIndex((x) => x.id === Number(m[2])) : -1; if (i < 0) return notFound(); p.mirrors.splice(i, 1); return { status: 204 }; }],
    ['GET', /^\/runners\/all$/, (m, call) => page(call, s.runners.filter((r) => !call.query.type || r.runner_type === call.query.type[0]).map(runnerList))],
    ['GET', /^\/runners\/(\d+)$/, (m) => { const r = s.runners.find((x) => x.id === Number(m[1])); return r ? ok(runnerView(r)) : notFound(); }],
    ['PUT', /^\/runners\/(\d+)$/, (m, call) => { const r = s.runners.find((x) => x.id === Number(m[1])); if (!r) return notFound(); for (const [k, v] of Object.entries(call.body ?? {})) r[k] = k === 'tag_list' ? String(v).split(',').filter(Boolean) : v; return ok(runnerView(r)); }],
    ['POST', /^\/user\/runners$/, (m, call) => {
      const b = call.body ?? {};
      const r = { id: nextId(), description: b.description ?? '', tag_list: String(b.tag_list ?? '').split(',').filter(Boolean), run_untagged: b.run_untagged ?? true, locked: b.locked ?? false, access_level: b.access_level ?? 'not_protected', paused: b.paused ?? false, runner_type: 'instance_type', token: `${RUNNER_PREFIX}${crypto.randomBytes(10).toString('hex')}` };
      s.runners.push(r);
      return ok({ id: r.id, token: r.token }, 201);
    }],
    ['POST', /^\/runners\/(\d+)\/reset_authentication_token$/, (m) => { const r = s.runners.find((x) => x.id === Number(m[1])); if (!r) return notFound(); r.token = `${RUNNER_PREFIX}${crypto.randomBytes(10).toString('hex')}`; return ok({ token: r.token }, 201); }],
    ['GET', /^\/projects\/([^/]+)\/repository\/files\/([^/]+)$/, (m, call) => {
      const p = proj(m[1]);
      const name = decodeURIComponent(m[2]);
      if (!p || call.query.ref?.[0] !== 'main' || !p.files.has(name)) return notFound('404 File Not Found');
      return ok({ file_name: name, encoding: 'base64', content: Buffer.from(p.files.get(name)).toString('base64') });
    }],
    ['POST', /^\/projects\/([^/]+)\/repository\/commits$/, (m, call) => {
      const p = proj(m[1]);
      const b = call.body ?? {};
      if (!p || b.branch !== 'main') return bad('branch main does not exist');
      for (const a of b.actions ?? []) p.files.set(a.file_path, a.content);
      s.commits += 1;
      return ok({ id: crypto.createHash('sha1').update(String(s.commits)).digest('hex') }, 201);
    }],
  ];
  const f = fakeFetch();
  f.route('*', () => true, (call) => {
    const hit = s.fail.find((x) => x.times > 0 && x.method === call.method && x.re.test(call.path));
    if (hit) { hit.times -= 1; return { status: hit.status, json: { message: 'boom' } }; }
    const rel = call.path.replace(/^\/api\/v4/, '');
    const pat = s.pats.find((p) => p.value === call.headers['private-token'] && active(p));
    const route = routes.find(([method, re]) => method === call.method && re.test(rel));
    if (!route) throw new Error(`fake GitLab: no Free-tier route for ${call.method} ${rel}`);
    if (!pat) return { status: 401, json: { message: '401 Unauthorized' } };
    return route[2](rel.match(route[1]), call, { pat, user: userById(pat.user_id) });
  });
  const gl = {
    s, fetch: f, addProject,
    project: (n) => s.projects.find((p) => p.path === n),
    userByName: (n) => s.users.find((u) => u.username === n),
    activePats: (n) => s.pats.filter((p) => p.user_id === gl.userByName(n)?.id && active(p)),
    branch: (n, b = 'main') => gl.project(n).branches.find((x) => x.name === b),
    member: (project, username) => gl.project(project).members.get(gl.userByName(username)?.id),
    failNext: (method, re, status = 503) => s.fail.push({ method, re, status, times: 1 }),
  };
  return gl;
}

function seedM1(gl) {
  const cfg = gl.addProject({ name: 'ci-config', readme: true });
  cfg.files.set('platform.gitlab-ci.yml', 'm1\n');
  cfg.members.set(50, 20);
  for (const [name, ci] of [['vitana-platform', 'platform.gitlab-ci.yml@vitana/ci-config:main'], ['vitana-v1', 'v1.gitlab-ci.yml@vitana/ci-config:main']]) gl.addProject({ name, ci_config_path: ci, readme: true }).members.set(50, 40);
  gl.s.runners.push({ id: 5, description: 'vitana-eng-1', tag_list: ['vitana-eng'], run_untagged: false, locked: false, access_level: 'not_protected', paused: false, runner_type: 'instance_type', token: `${RUNNER_PREFIX}legacy0123456789ab` });
}

function newAws() {
  const secrets = new Map();
  const calls = [];
  const aws = async (args, opts = {}) => {
    calls.push({ args: [...args], input: opts.input });
    const [, op] = args;
    const opt = (n) => { const i = args.indexOf(n); return i < 0 ? undefined : args[i + 1]; };
    const id = opt('--secret-id') ?? opt('--name');
    const err = (code) => Object.assign(new Error(`An error occurred (${code})`), { stderr: `An error occurred (${code})` });
    if (op === 'get-secret-value') { if (!secrets.has(id) || secrets.get(id) === null) throw err('ResourceNotFoundException'); return { stdout: `${secrets.get(id)}\n` }; }
    if (op === 'put-secret-value' || op === 'create-secret') {
      assert.equal(opt('--secret-string'), 'file:///dev/stdin', 'a secret value is never a command-line argument');
      if (op === 'put-secret-value' && !secrets.has(id)) throw err('ResourceNotFoundException');
      secrets.set(id, opts.input);
      return { stdout: '{}' };
    }
    throw new Error(`unexpected aws call ${op}`);
  };
  aws.calls = calls;
  aws.secrets = secrets;
  return aws;
}

function newFs() {
  const files = new Map();
  const writes = [];
  const x = {
    files, writes,
    async readFile(p) { return files.has(p) ? { ...files.get(p) } : null; },
    async writeAtomic(p, text, { mode } = {}) { files.set(p, { text, mode }); writes.push({ path: p, mode, text }); },
    async preflight() {},
    async listYml(dir) { return [...files.keys()].filter((k) => path.posix.dirname(k) === dir && k.endsWith('.yml')).map((k) => path.posix.basename(k)).sort(); },
  };
  return x;
}

function newWorld({ delivery = true, config = shipped(), token = true } = {}) {
  const gl = newGitLab();
  seedM1(gl);
  const aws = newAws();
  const fsx = newFs();
  const lines = [];
  fsx.files.set('/repo/settings.json', { text: JSON.stringify(config, null, 2), mode: 0o644 });
  for (const [n, t] of Object.entries({ ...CI_FILES, ...(delivery ? DELIVERY_FILES : {}) })) fsx.files.set(`/repo/ci/${n}`, { text: t, mode: 0o644 });
  fsx.files.set(ADMIN_FILE, { text: `${ADMIN_TOKEN}\n`, mode: 0o600 });
  if (token) fsx.files.set(MIRROR_TOKEN_FILE, { text: `${GH_TOKEN}\n`, mode: 0o600 });
  aws.secrets.set('vitana/engineering/gitlab/fleet-runner-token', null);
  aws.secrets.set('vitana/engineering/gitlab/webhook-signing-token', SIGNING_TOKEN);
  const deps = { fetch: gl.fetch, sleep: async () => {}, now: () => NOW, env: { REGION: 'eu-central-1', DOMAIN: 'gitlab.vitanaland.com' }, aws, fs: fsx, stdout: (l) => lines.push(String(l)) };
  const w = {
    gl, f: gl.fetch, aws, fsx, lines, deps,
    run: (command = 'apply', extra = {}) => settings.run({ command, configFile: '/repo/settings.json', ciDir: '/repo/ci', url: 'https://gitlab.test', adminTokenFile: ADMIN_FILE, dryRun: false, ...extra }, deps),
    mark: () => ({ f: w.f.mark(), aws: aws.calls.length, fs: fsx.writes.length }),
    setMarker: (mode) => fsx.files.set(MARKER_FILE, { text: marker(mode), mode: 0o644 }),
    clearMarker: () => fsx.files.delete(MARKER_FILE),
    text: () => lines.join('\n'),
  };
  return w;
}
async function applied(w) {
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0, `apply failed: ${JSON.stringify(r.failed)}\n${w.text().slice(-1500)}`);
  return r;
}
async function converged(w, label) {
  const m = w.mark();
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0, `${label}: second apply ${JSON.stringify(r.failed)}`);
  assert.deepEqual(r.applied, [], `${label}: second apply applied nothing`);
  assert.deepEqual(w.f.writes(m.f).map((c) => `${c.method} ${c.path}`), [], `${label}: no GitLab write`);
  assert.deepEqual(w.aws.calls.slice(m.aws).filter((c) => c.args[1] !== 'get-secret-value'), [], `${label}: no Secrets Manager write`);
  assert.deepEqual(w.fsx.writes.slice(m.fs), [], `${label}: no file write`);
  assert.equal((await w.run('check')).exitCode, 0, `${label}: check agrees`);
}
const callsOf = (w, method, re) => w.f.calls.filter((c) => c.method === method && re.test(c.path));
const view = (w, name) => {
  const p = w.gl.project(name);
  return { p, main: w.gl.branch(name), assist: w.gl.branch(name, 'assist/*'), hook: p.hooks.find((h) => h.name === 'vitana-gateway'), mode: p.variables.find((v) => v.key === 'DELIVERY_MODE')?.value };
};
const levels = (b) => [b.push_access_levels.map((x) => x.access_level), b.merge_access_levels.map((x) => x.access_level), b.allow_force_push];
const flagsOf = (h) => Object.entries(h).filter(([k, v]) => /_events$/.test(k) && v === true).map(([k]) => k).sort();

// ═════════════════════════════════════════ the file ═════════════════════════════════════════════════════════════════════════════
test('config: the shipped file has a cutover block on both mirror projects and the bridge account, with the values of plan §8.2 step 3', () => {
  const c = settings.validateConfig(shipped());
  for (const [name, repo] of [['vitana-platform', 'platform'], ['vitana-v1', 'v1']]) {
    const x = c.projects[name].cutover;
    assert.equal(x.github, `exafyltd/${name}`);
    assert.equal(x.ci_file, `${repo}-delivery.gitlab-ci.yml`, 'the pipeline file lane pipelines generates');
    assert.equal(x.webhook_url, HOOK_URL, 'the staging gateway receives the events first (plan §3.11)');
    assert.deepEqual(x.shadow.webhook_events, ['merge_request', 'pipeline']);
    assert.deepEqual(x.live.webhook_events, ['merge_request', 'pipeline', 'push', 'tag_push'], 'pushes and tag pushes reach the gateway at the cut');
    assert.deepEqual(x.live.required_jobs, ['lane-scope', 'change-suite', 'gate']);
    assert.equal(x.live.landing, true);
    assert.deepEqual(x.live.push_mirror, { token_file: MIRROR_TOKEN_FILE, only_protected_branches: true, keep_divergent_refs: true });
    assert.deepEqual(x.live.protected_branches, [{ name: 'assist/*', push: 40, merge: 40 }]);
    assert.equal(x.live.allow_merge_on_skipped_pipeline, true);
    assert.deepEqual([x.mirror_user, x.shadow.mirror_user_role, x.live.mirror_user_role], ['vitana-mirror', 'maintainer', 'reporter']);
    assert.equal(c.projects[name].profile, 'mirror', 'the base stays what milestone 2 made it');
    assert.equal(c.projects[name].landing, false);
  }
  assert.deepEqual(c.cutover.accounts.map((a) => [a.username, a.shadow_role, a.live_role, a.token_file, a.projects]), [['bot-bridge', 'reporter', 'developer', '/etc/vitana/gitlab-bridge-token', MIRRORED]]);
  assert.deepEqual(c.cutover.accounts[0].scopes, ['api', 'write_repository'], 'the scopes the bridge runbook names');
});

const INVALID = [
  ['an unknown cutover key', (c) => { c.projects['vitana-v1'].cutover.surprise = 1; }, /projects\.vitana-v1\.cutover\.surprise/],
  ['a cutover block on a native project', (c) => { c.projects.rehearsal.cutover = clone(c.projects['vitana-v1'].cutover); }, /projects\.rehearsal\.cutover/],
  ['a GitHub repository without an owner', (c) => { c.projects['vitana-v1'].cutover.github = 'vitana-v1'; }, /cutover\.github/],
  ['a pipeline file with a path', (c) => { c.projects['vitana-v1'].cutover.ci_file = 'ci/v1.yml'; }, /cutover\.ci_file/],
  ['a webhook over plain http', (c) => { c.projects['vitana-v1'].cutover.webhook_url = 'http://gateway.example.test/hook'; }, /cutover\.webhook_url/],
  ['a webhook event the gateway does not map', (c) => { c.projects['vitana-v1'].cutover.live.webhook_events = ['push', 'deployment']; }, /cutover\.live\.webhook_events\[1\]/],
  ['no required jobs', (c) => { c.projects['vitana-v1'].cutover.live.required_jobs = []; }, /cutover\.live\.required_jobs/],
  ['landing that is not a boolean', (c) => { c.projects['vitana-v1'].cutover.live.landing = 'yes'; }, /cutover\.live\.landing/],
  ['a push mirror of every branch', (c) => { c.projects['vitana-v1'].cutover.live.push_mirror.only_protected_branches = false; }, /push_mirror\.only_protected_branches/],
  ['a push mirror that overwrites divergent refs', (c) => { c.projects['vitana-v1'].cutover.live.push_mirror.keep_divergent_refs = false; }, /push_mirror\.keep_divergent_refs/],
  ['a push mirror token outside /etc/vitana', (c) => { c.projects['vitana-v1'].cutover.live.push_mirror.token_file = '/tmp/token'; }, /push_mirror\.token_file/],
  ['no push mirror', (c) => { delete c.projects['vitana-v1'].cutover.live.push_mirror; }, /cutover\.live\.push_mirror/],
  ['main listed as an extra protected branch', (c) => { c.projects['vitana-v1'].cutover.live.protected_branches[0].name = 'main'; }, /protected_branches\[0\]\.name/],
  ['a protected branch that lets Guests push', (c) => { c.projects['vitana-v1'].cutover.live.protected_branches[0].push = 10; }, /protected_branches\[0\]\.push/],
  ['a mirror user without roles for both states', (c) => { delete c.projects['vitana-v1'].cutover.live.mirror_user_role; }, /cutover\.mirror_user/],
  ['an unknown role', (c) => { c.projects['vitana-v1'].cutover.shadow.mirror_user_role = 'owner'; }, /shadow\.mirror_user_role/],
  ['skipped pipelines that are not a boolean', (c) => { c.projects['vitana-v1'].cutover.live.allow_merge_on_skipped_pipeline = 1; }, /allow_merge_on_skipped_pipeline/],
  ['a bridge account that is already an account', (c) => { c.cutover.accounts[0].username = 'bot-land'; }, /cutover\.accounts\[0\]\.username/],
  ['a bridge account on a project with no cutover block', (c) => { c.cutover.accounts[0].projects = ['rehearsal']; }, /cutover\.accounts\[0\]\.projects\[0\]/],
  ['a bridge account without a role for each state', (c) => { delete c.cutover.accounts[0].live_role; }, /cutover\.accounts\[0\]\.live_role/],
  ['a bridge token file already used by another account', (c) => { c.cutover.accounts[0].token_file = '/etc/vitana/bot-land-token'; }, /cutover\.accounts\[0\]\.token_file/],
  ['an unknown key in the top-level block', (c) => { c.cutover.nope = true; }, /cutover\.nope/],
];
test('config: every invalid cutover input is refused with an error that names the key; the plain webhook of milestone 2 still refuses push events', () => {
  for (const [label, mutate, key] of INVALID) {
    const c = clone(shipped());
    mutate(c);
    assert.throws(() => settings.validateConfig(c), (err) => { assert.ok(err instanceof settings.ConfigError, label); assert.match(err.message, key, label); return true; }, label);
  }
  const plain = clone(shipped());
  plain.projects['vitana-v1'].webhook = { url: HOOK_URL, events: ['push'] };
  assert.throws(() => settings.validateConfig(plain), /projects\.vitana-v1\.webhook\.events\[0\]/, 'only the cutover block may ask for push and tag_push');
  assert.doesNotThrow(() => settings.validateConfig(shipped()));
});

test('the milestone-2 view is untouched: the shipped base keys, the exported key tables and the script text keep what gitlab-settings.test.mjs pins', () => {
  const c = settings.validateConfig(shipped());
  assert.deepEqual(MIRRORED.map((n) => [c.projects[n].profile, c.projects[n].landing, c.projects[n].rehearsal, c.projects[n].webhook, c.projects[n].required_jobs]), [['mirror', false, false, null, []], ['mirror', false, false, null, []]]);
  assert.deepEqual(MIRRORED.map((n) => c.projects[n].ci_file), ['platform.gitlab-ci.yml', 'v1.gitlab-ci.yml']);
  assert.equal(settings.SCHEMA_KEYS.project.includes('cutover'), false, 'the milestone-2 key table (documented by its README) is not extended; CUTOVER_KEYS is');
  assert.deepEqual(Object.keys(settings.WEBHOOK_EVENTS), ['merge_request', 'pipeline']);
  assert.deepEqual(Object.keys(settings.CUTOVER_WEBHOOK_EVENTS), ['merge_request', 'pipeline', 'push', 'tag_push']);
});

test('config: the runbook documents every key of the cutover block, the four states, the marker file and the token files (the settings README belongs to milestone 2)', () => {
  const runbook = fs.readFileSync(RUNBOOK_FILE, 'utf8');
  for (const [group, keys] of Object.entries(settings.CUTOVER_KEYS)) for (const k of keys) assert.ok(runbook.includes(`\`${k}\``), `RUNBOOK-cutover.md documents ${group} key \`${k}\``);
  for (const word of ['inactive', 'shadow', 'rehearsal', 'live', '/etc/vitana/delivery-cutover', '/etc/vitana/github-push-mirror-token', '/etc/vitana/github-bridge-token', '/etc/vitana/gitlab-bridge-token', 'DELIVERY_MODE', '--marker-file', 'loadEffectiveProjects']) {
    assert.ok(runbook.includes(word), `RUNBOOK-cutover.md mentions ${word}`);
  }
});

test('free tier: the script and the settings file name none of the Premium-only APIs or settings the cutover could be mistaken to need', () => {
  const names = [['approval', '_rules'], ['push', '_rule'], ['merge', '_trains'], ['protected', '_environments'], ['code_owner', '_approval_required'], ['allowed_to', '_push'], ['allowed_to', '_merge'],
    ['approvals_before', '_merge'], ['merge_pipelines', '_enabled'], ['mirror_branch', '_regex'], ['external_status', '_checks'], ['/ldap']].map((x) => x.join(''));
  for (const file of [SCRIPT_FILE, CONFIG_FILE]) { const text = fs.readFileSync(file, 'utf8'); for (const n of names) assert.ok(!text.includes(n), `${path.basename(file)} must not mention ${n}`); }
});

// ═════════════════════════════════════════ the four states ══════════════════════════════════════════════════════════════════════
test('inactive: without the generated pipeline files in the CI folder the sync is exactly what milestone 2 made it (no variable, no mirror, no bridge account, no cutover log line)', async () => {
  const w = newWorld({ delivery: false });
  const r = await applied(w);
  assert.deepEqual(r.cutover, {});
  assert.equal(callsOf(w, 'GET', /\/variables$|\/remote_mirrors$/).length, 0, 'not even asked for');
  assert.equal(w.gl.userByName('bot-bridge'), undefined);
  for (const n of MIRRORED) {
    const v = view(w, n);
    assert.equal(v.p.ci_config_path, `${n === 'vitana-v1' ? 'v1' : 'platform'}.gitlab-ci.yml@vitana/ci-config:main`);
    assert.equal(v.hook, undefined);
    assert.equal(v.p.variables.length + v.p.mirrors.length, 0);
    assert.deepEqual(levels(v.main), [[40], [40], true]);
  }
  assert.ok(!w.text().includes('cutover_state'));
  await converged(w, 'inactive');
  // a marker with nothing to switch on is reported, not obeyed
  w.setMarker('live');
  const check = await w.run('check');
  assert.equal(check.exitCode, 3);
  assert.match(w.text(), /drift: project vitana-platform: the cutover marker \(live\) is set, but platform-delivery\.gitlab-ci\.yml is not in the CI folder/);
  const before = w.mark();
  assert.equal((await w.run('apply')).exitCode, 0);
  assert.deepEqual(w.f.writes(before.f).map((c) => `${c.method} ${c.path}`), [], 'the projects stay as they are');
});

test('shadow: the pipeline files and no marker keep the mirror profile, point at the generated files, send merge-request and pipeline events, set DELIVERY_MODE=shadow, and add the bridge account as Reporter', async () => {
  const w = newWorld();
  const r = await applied(w);
  assert.deepEqual(r.cutover, { 'vitana-platform': 'shadow', 'vitana-v1': 'shadow' });
  assert.match(w.text(), /"event":"cutover_state","projects":\{"vitana-platform":"shadow","vitana-v1":"shadow"\},"marker":null/);
  for (const [n, file] of [['vitana-platform', 'platform-delivery.gitlab-ci.yml'], ['vitana-v1', 'v1-delivery.gitlab-ci.yml']]) {
    const v = view(w, n);
    assert.equal(v.p.ci_config_path, `${file}@vitana/ci-config:main`);
    assert.equal(v.mode, 'shadow');
    assert.deepEqual(levels(v.main), [[40], [40], true], 'mirror protection: the mirror user pushes');
    assert.equal(v.p.merge_method, 'merge', 'the merge settings of a mirror project are not managed');
    assert.equal(v.p.allow_merge_on_skipped_pipeline, false);
    assert.equal(v.assist, undefined);
    assert.equal(v.p.mirrors.length, 0, 'no push mirror before the cut: GitHub is the only writer of main');
    assert.equal(v.hook.url, HOOK_URL);
    assert.deepEqual(flagsOf(v.hook), ['merge_requests_events', 'pipeline_events']);
    assert.equal(w.gl.member(n, 'bot-bridge'), 20, 'the bridge reads, the dry run needs that');
    assert.equal(w.gl.member(n, 'bot-land'), undefined, 'the merge bot does not land on a shadow project');
    assert.equal(w.gl.member(n, 'vitana-mirror'), 40, 'the milestone-1 mirror user keeps pushing');
  }
  assert.equal(w.gl.project('ci-config').files.get('v1-delivery.gitlab-ci.yml'), DELIVERY_FILES['v1-delivery.gitlab-ci.yml'], 'the generated files reach vitana/ci-config');
  assert.equal(w.gl.userByName('bot-bridge').service, true);
  assert.equal(w.gl.activePats('bot-bridge').length, 1);
  assert.deepEqual(w.gl.activePats('bot-bridge')[0].scopes.sort(), ['api', 'write_repository']);
  assert.equal(w.fsx.files.get('/etc/vitana/gitlab-bridge-token').text, `${w.gl.activePats('bot-bridge')[0].value}\n`);
  assert.equal(w.fsx.files.get('/etc/vitana/gitlab-bridge-token').mode, 0o600);
  await converged(w, 'shadow');
});

test('live: the marker turns both projects native in one run: landing and the three required jobs for the bot, push and tag-push events, the push mirror of protected branches with divergent refs kept, a protected assist/*, skipped pipelines count, DELIVERY_MODE=live; a second run writes nothing', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  const m = w.mark();
  const r = await applied(w);
  assert.deepEqual(r.cutover, { 'vitana-platform': 'live', 'vitana-v1': 'live' });
  for (const n of MIRRORED) {
    const v = view(w, n);
    assert.deepEqual(levels(v.main), [[0], [40], false], 'native: push No one, merge Maintainers, force push off');
    assert.deepEqual([v.p.merge_method, v.p.squash_option, v.p.only_allow_merge_if_pipeline_succeeds, v.p.only_allow_merge_if_all_discussions_are_resolved, v.p.remove_source_branch_after_merge, v.p.squash_commit_template], ['ff', 'always', true, true, true, '%{title}']);
    assert.equal(v.p.allow_merge_on_skipped_pipeline, true, 'skipped pipelines are considered successful (the merge bot updates a train with ci.skip)');
    assert.equal(v.mode, 'live');
    assert.deepEqual(levels(v.assist), [[40], [40], false], 'assist/* is protected: only bot-land and the owner push there');
    assert.deepEqual(flagsOf(v.hook), ['merge_requests_events', 'pipeline_events', 'push_events', 'tag_push_events']);
    assert.equal(v.p.mirrors.length, 1);
    const mm = v.p.mirrors[0];
    assert.equal(mm.maskedUrl, `https://*****:*****@github.com/exafyltd/${n}.git`);
    assert.deepEqual([mm.enabled, mm.only_protected_branches, mm.keep_divergent_refs], [true, true, true]);
    assert.equal(mm.rawUrl, `https://x-access-token:${GH_TOKEN}@github.com/exafyltd/${n}.git`, 'the token of the file is the mirror credential');
    assert.equal(w.gl.member(n, 'bot-land'), 40, 'bot-land lands where the marker is');
    assert.equal(w.gl.member(n, 'bot-bridge'), 30, 'the bridge pushes branches and opens merge requests, and never merges');
    assert.equal(w.gl.member(n, 'vitana-mirror'), 20, 'the milestone-1 mirror user only reads from here on');
  }
  assert.equal(w.gl.member('rehearsal', 'bot-land'), 40);
  assert.ok(!w.text().includes('drift: project vitana-v1: @vitana-mirror'), 'the demoted mirror user is not reported as a stray Maintainer');
  // the cut is one run: the number of writes is small and nothing is written twice
  const writes = w.f.writes(m.f).map((c) => `${c.method} ${c.path.replace(/\/projects\/\d+/, '/projects/:id')}`);
  assert.equal(new Set(writes).size >= 1, true);
  assert.equal(writes.filter((x) => x.startsWith('POST /api/v4/projects/:id/remote_mirrors')).length, 2, 'one mirror per project');
  await converged(w, 'live');
});

test('removing the marker converges back to shadow: mirror profile, the push mirror and assist/* removed, skipped pipelines off, DELIVERY_MODE=shadow, the bridge a Reporter, the mirror user a Maintainer; a second run writes nothing', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  await applied(w);
  w.clearMarker();
  await applied(w);
  for (const n of MIRRORED) {
    const v = view(w, n);
    assert.deepEqual(levels(v.main), [[40], [40], true], 'main is a mirror branch again: the mirror user pushes, force allowed');
    assert.equal(v.mode, 'shadow');
    assert.equal(v.assist, undefined);
    assert.equal(v.p.mirrors.length, 0, 'the GitLab-to-GitHub mirror stops with the marker (the rollback restarts the GitHub-to-GitLab copy)');
    assert.equal(v.p.allow_merge_on_skipped_pipeline, false);
    assert.deepEqual(flagsOf(v.hook), ['merge_requests_events', 'pipeline_events']);
    assert.equal(w.gl.member(n, 'bot-bridge'), 20);
    assert.equal(w.gl.member(n, 'vitana-mirror'), 40);
  }
  const r = await w.run('check');
  assert.equal(r.exitCode, 0, w.text().slice(-800));
  const bot = await settings.loadEffectiveProjects('/repo/settings.json', { fs: w.fsx, markerFile: MARKER_FILE, ciDir: '/repo/ci' });
  assert.deepEqual(bot.filter((p) => p.landing).map((p) => p.name), ['rehearsal'], 'the merge bot lands nowhere on the two projects again');
  await converged(w, 'back in shadow');
});

test('rehearsal: the marker "rehearsal" is shadow with DELIVERY_MODE=live and nothing else: still the mirror profile, no landing, no push mirror, no assist/*', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('rehearsal');
  const r = await applied(w);
  assert.deepEqual(r.cutover, { 'vitana-platform': 'rehearsal', 'vitana-v1': 'rehearsal' });
  for (const n of MIRRORED) {
    const v = view(w, n);
    assert.equal(v.mode, 'live');
    assert.deepEqual(levels(v.main), [[40], [40], true]);
    assert.equal(v.p.mirrors.length, 0);
    assert.equal(v.assist, undefined);
    assert.equal(v.p.allow_merge_on_skipped_pipeline, false);
    assert.equal(w.gl.member(n, 'bot-land'), undefined);
    assert.deepEqual(flagsOf(v.hook), ['merge_requests_events', 'pipeline_events']);
  }
  const bot = await settings.loadEffectiveProjects('/repo/settings.json', { fs: w.fsx, markerFile: MARKER_FILE, ciDir: '/repo/ci' });
  assert.deepEqual(bot.filter((p) => p.landing).map((p) => p.name), ['rehearsal']);
  await converged(w, 'rehearsal');
  w.clearMarker();
  await applied(w);
  assert.equal(view(w, 'vitana-v1').mode, 'shadow');
});

// ═════════════════════════════════════════ what the merge bot sees ══════════════════════════════════════════════════════════════
test('merge bot: before the marker the bot reads what it reads today; with the marker it lands on both projects with the three required jobs (contract with gitlab-land.mjs loadProjects)', async () => {
  const w = newWorld();
  const eff = () => settings.loadEffectiveProjects('/repo/settings.json', { fs: w.fsx, markerFile: MARKER_FILE, ciDir: '/repo/ci' });
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cutover-bot-'));
  try {
    const today = loadProjects(CONFIG_FILE);
    assert.deepEqual((await eff()).map((p) => [p.name, p.path, p.landing, p.required_jobs]), today.map((p) => [p.name, p.path, p.landing, p.required_jobs]), 'no marker: exactly the view loadProjects has of the shipped file');
    w.setMarker('live');
    const live = await eff();
    assert.deepEqual(live.filter((p) => p.landing).map((p) => [p.name, p.required_jobs]).sort(), [['rehearsal', ['unit']], ['vitana-platform', ['lane-scope', 'change-suite', 'gate']], ['vitana-v1', ['lane-scope', 'change-suite', 'gate']]]);
    // gitlab-land.mjs reads { group, projects.<name>.landing, projects.<name>.required_jobs }: the effective view satisfies the same reader
    const file = path.join(tmp, 'effective.json');
    fs.writeFileSync(file, JSON.stringify({ group: 'vitana', projects: Object.fromEntries(live.map((p) => [p.name, { landing: p.landing, required_jobs: p.required_jobs }])) }));
    assert.deepEqual(loadProjects(file).map((p) => [p.name, p.path, p.landing, p.required_jobs]), live.map((p) => [p.name, p.path, p.landing, p.required_jobs]));
    // without the generated pipeline file the marker changes nothing for the bot either
    const bare = newWorld({ delivery: false });
    bare.setMarker('live');
    assert.deepEqual((await settings.loadEffectiveProjects('/repo/settings.json', { fs: bare.fsx, markerFile: MARKER_FILE, ciDir: '/repo/ci' })).filter((p) => p.landing).map((p) => p.name), ['rehearsal']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ═════════════════════════════════════════ failures, secrets, the marker file ═══════════════════════════════════════════════════
test('live without the GitHub token file: the push mirror is not created and the run reports it as drift (check exits 3); everything else converges; the next run creates it', async () => {
  const w = newWorld({ token: false });
  await applied(w);
  w.setMarker('live');
  const r = await w.run('apply');
  assert.equal(r.exitCode, 0);
  assert.equal(view(w, 'vitana-v1').p.mirrors.length, 0, 'no mirror without a token');
  assert.deepEqual(levels(view(w, 'vitana-v1').main), [[0], [40], false], 'the rest of the cut still converged');
  assert.match(w.text(), /drift: project vitana-v1 \(delivery live\): the push mirror to github\.com\/exafyltd\/vitana-v1\.git cannot be created: \/etc\/vitana\/github-push-mirror-token is missing/);
  assert.equal((await w.run('check')).exitCode, 3);
  w.fsx.files.set(MIRROR_TOKEN_FILE, { text: `${GH_TOKEN}\n`, mode: 0o600 });
  await applied(w);
  assert.equal(view(w, 'vitana-v1').p.mirrors.length, 1);
  await converged(w, 'token supplied');
});

test('live: a token file that is not mode 600 is warned about, a malformed one counts as missing', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  w.fsx.files.set(MIRROR_TOKEN_FILE, { text: `${GH_TOKEN}\n`, mode: 0o644 });
  await applied(w);
  assert.match(w.text(), /warning: project vitana-platform \(delivery live\): \/etc\/vitana\/github-push-mirror-token has mode 644, expected 600/);
  for (const [mode, warned] of [[0o600, false], [0o640, true]]) {   // a file of mode 600 is not warned about, a group-readable one is
    const x = newWorld();
    await applied(x);
    x.setMarker('live');
    x.fsx.files.set(MIRROR_TOKEN_FILE, { text: `${GH_TOKEN}\n`, mode });
    await applied(x);
    assert.equal(/github-push-mirror-token has mode \d+, expected 600/.test(x.text()), warned, `mode ${mode.toString(8)}`);
  }
  const bad = newWorld();
  await applied(bad);
  bad.setMarker('live');
  bad.fsx.files.set(MIRROR_TOKEN_FILE, { text: 'not a token with spaces\n', mode: 0o600 });
  await bad.run('apply');
  assert.equal(view(bad, 'vitana-v1').p.mirrors.length, 0);
});

test('live: a mirror that was changed by hand is corrected (disabled, every branch, divergent refs overwritten), a second one is removed, a mirror to another host is left alone, and its error is reported', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  await applied(w);
  const p = w.gl.project('vitana-v1');
  p.mirrors[0].enabled = false;
  p.mirrors[0].only_protected_branches = false;
  p.mirrors[0].keep_divergent_refs = false;
  p.mirrors[0].last_error = 'push to github.com failed: 403';
  p.mirrors.push({ id: 90, enabled: true, only_protected_branches: true, keep_divergent_refs: true, maskedUrl: 'https://*****:*****@github.com/exafyltd/vitana-v1.git' });
  p.mirrors.push({ id: 91, enabled: true, only_protected_branches: true, keep_divergent_refs: true, maskedUrl: 'https://*****:*****@backup.example.test/vitana-v1.git' });
  const check = await w.run('check');
  assert.equal(check.exitCode, 3);
  assert.match(w.text(), /the push mirror to github\.com\/exafyltd\/vitana-v1\.git: it is disabled; it does not mirror protected branches only; it does not keep divergent refs/);
  assert.match(w.text(), /warning: project vitana-v1 \(delivery live\): the push mirror to github\.com\/exafyltd\/vitana-v1\.git reports an error: push to github\.com failed: 403/);
  await applied(w);
  assert.deepEqual(p.mirrors.map((x) => x.id).sort((a, b) => a - b), [p.mirrors.find((x) => x.maskedUrl.includes('github.com')).id, 91].sort((a, b) => a - b), 'one GitHub mirror and the foreign one');
  const gh = p.mirrors.find((x) => x.maskedUrl.includes('github.com'));
  assert.deepEqual([gh.enabled, gh.only_protected_branches, gh.keep_divergent_refs], [true, true, true]);
});

test('live: a protected branch rule for assist/* changed by hand is repaired (removed and protected again), and its removal at rollback touches no other rule', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  await applied(w);
  w.gl.branch('vitana-v1', 'assist/*').push_access_levels[0].access_level = 30;
  w.gl.project('vitana-v1').branches.push({ id: 900, name: 'release/*', push_access_levels: [{ id: 1, access_level: 40 }], merge_access_levels: [{ id: 2, access_level: 40 }], allow_force_push: false });
  const check = await w.run('check');
  assert.equal(check.exitCode, 3);
  assert.match(w.text(), /protected branch assist\/\*: push is Developer, should be Maintainer/);
  await applied(w);
  assert.deepEqual(levels(w.gl.branch('vitana-v1', 'assist/*')), [[40], [40], false]);
  w.gl.branch('vitana-v1', 'assist/*').allow_force_push = true;   // someone allowed force pushes on the rule
  assert.equal((await w.run('check')).exitCode, 3);
  assert.match(w.text(), /protected branch assist\/\*: force push is allowed, should be off/);
  await applied(w);
  assert.deepEqual(levels(w.gl.branch('vitana-v1', 'assist/*')), [[40], [40], false]);
  w.clearMarker();
  await applied(w);
  assert.equal(w.gl.branch('vitana-v1', 'assist/*'), undefined);
  assert.ok(w.gl.branch('vitana-v1', 'release/*'), 'a rule the file does not manage stays');
});

test('failures: a push mirror that GitLab refuses does not hold back the rest of the cut; the next run creates it; a failed mirror user change leaves the Maintainer finding out of the run', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  w.gl.failNext('POST', /\/remote_mirrors$/, 503);
  const first = await w.run('apply');
  assert.equal(first.exitCode, 1);
  assert.ok(first.failed.some((x) => x.id === 'project:vitana-platform:mirror' || x.id === 'project:vitana-v1:mirror'), JSON.stringify(first.failed));
  assert.equal(w.gl.member('vitana-v1', 'bot-land'), 40, 'landing was set up in the same run');
  assert.equal(view(w, 'vitana-v1').mode, 'live');
  await applied(w);
  for (const n of MIRRORED) assert.equal(view(w, n).p.mirrors.length, 1);
  await converged(w, 'after the failed mirror');
});

test('a marker that is not valid is ignored and reported (the projects stay in shadow); the CLI accepts --marker-file and prints it in the usage', async () => {
  const w = newWorld();
  await applied(w);
  for (const text of ['not json', JSON.stringify({ schema: 'other', mode: 'live' }), JSON.stringify({ schema: 'vitana.delivery-cutover-marker/v1', mode: 'maybe' })]) {
    w.fsx.files.set(MARKER_FILE, { text, mode: 0o644 });
    const r = await w.run('check');
    assert.equal(r.exitCode, 0, text);
    assert.match(w.text(), /warning: delivery cutover: .*treated as absent/);
    assert.deepEqual(r.cutover, { 'vitana-platform': 'shadow', 'vitana-v1': 'shadow' });
  }
  w.fsx.files.set('/other/marker', { text: marker('live'), mode: 0o644 });
  w.fsx.files.delete(MARKER_FILE);
  const viaOption = await w.run('check', { markerFile: '/other/marker' });
  assert.deepEqual(viaOption.cutover, { 'vitana-platform': 'live', 'vitana-v1': 'live' }, 'the option names the marker');
  const out = [];
  const code = await settings.main(['--help'], { ...w.deps, stdout: (l) => out.push(l) });
  assert.equal(code, 0);
  assert.match(out.join('\n'), /--marker-file FILE/);
  assert.equal(settings.parseArgs(['check', '--marker-file', '/x']).markerFile, '/x');
  assert.throws(() => settings.parseArgs(['--marker-file']), /needs a value/);
});

test('no secret appears in any output, finding or argument list: not the GitHub token of the push mirror, not the bridge token, not the admin token', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('live');
  w.gl.failNext('POST', /\/remote_mirrors$/, 503);
  await w.run('apply');
  await applied(w);
  w.clearMarker();
  await applied(w);
  const secrets = [GH_TOKEN, ADMIN_TOKEN, SIGNING_TOKEN, ...w.gl.s.pats.map((p) => p.value)];
  for (const s of secrets) {
    assert.equal(w.text().includes(s), false, 'no output line holds a secret');
    for (const c of w.aws.calls) assert.equal(JSON.stringify(c.args).includes(s), false, 'no AWS argument holds a secret');
  }
  assert.equal(w.f.calls.some((c) => c.url.includes(GH_TOKEN)), false, 'the token is in a request body only, never in a URL');
});

test('free tier: every call of the shadow, rehearsal, live and back runs is on the documented endpoint list with the documented method', async () => {
  const w = newWorld();
  await applied(w);
  w.setMarker('rehearsal');
  await applied(w);
  w.setMarker('live');
  await applied(w);
  w.fsx.files.get(MIRROR_TOKEN_FILE);
  w.clearMarker();
  await applied(w);
  const listed = new Set(ENDPOINTS.map(([m, p]) => `${m} ${p}`));
  const seen = new Set(w.f.calls.map((c) => `${c.method} ${normalise(c.url.replace(/^https?:\/\/[^/]+/, '')).replace(/^\/users$/, '/users?username=')}`));
  for (const x of seen) assert.ok(listed.has(x), `${x} is a documented Free-tier endpoint`);
  for (const x of ['GET /projects/:id/variables', 'POST /projects/:id/variables', 'PUT /projects/:id/variables/:key', 'POST /projects/:id/remote_mirrors', 'DELETE /projects/:id/remote_mirrors/:id']) assert.ok(seen.has(x), `the runs used ${x}`);
});
