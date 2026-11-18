#!/usr/bin/env node
// Settings as code for the self-hosted GitLab (plan eng-gitlab-m2 §3.3, lane settings, part A). The file
// infra/gitlab-engineering/settings/gitlab-settings.json is the single source of truth for who may do what in GitLab; this script
// reads GitLab, compares, and (apply) corrects what differs. Free tier only: every endpoint is listed in the README and in the test.
//
//   node scripts/eng/gitlab-settings.mjs [apply|check] [--config FILE] [--ci-dir DIR] [--url URL] [--admin-token-file FILE] [--dry-run]
//   apply (default)  corrects GitLab to match the file; a second run makes no write            check (or --check)  writes nothing
//   exit codes       0 done / no drift   1 error (nothing more is written)   2 usage mistake   3 drift found (check only)
//   environment      REGION and DOMAIN from /etc/vitana/env (the systemd unit loads it)
//
// How a run goes: licence guard (GET /license; a licence stops everything, nothing is written) → read everything (GitLab,
// Secrets Manager, /etc/vitana) → compare → write, in this order, each change on its own: the sync's own admin token, the legacy
// runner retag, service accounts, vitana/ci-config and its files, projects (settings, protected branch, webhook), memberships, the
// fleet runner, and LAST the account tokens, so a protection and the retag exist before any credential does. A failed change holds
// back only the changes that depend on it; a network error or three server errors in a row end the run. All reads happen before the
// first write, so a GitLab that cannot be read changes nothing. Every write is sent with retries: 0 (an action is never repeated by
// the client); the next run, ten minutes later, tries again from a fresh read.
//
// Secrets: tokens go to Secrets Manager through a private 0600 file (see makeSecrets.put), never as an argument; the bot token files are written
// atomically with mode 0600; no log line, error or output contains a token (a redactor knows every secret the run has seen, and GitLab
// token shapes). The admin token of the sync (/etc/vitana/settings-admin-token, created once by ops-install.sh) is rotated by the
// sync itself with POST /personal_access_tokens/:id/rotate when fewer than 10 days are left; the file is checked writable first.
// Dependency-free Node 20 (UNIT.yml runs scripts/**/*.test.mjs with no install). GitLab, AWS and the files are reached through
// injected dependencies, so the tests use fakes.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, GitLabApiError, projectId, redact } from './gitlab-api.mjs';

// ── constants of the plan ────────────────────────────────────────────────────────────────────────────────────────────────────
export const SCHEMA_VERSION = 1;
export const TOKEN_NAME = 'vitana-settings';
export const WEBHOOK_NAME = 'vitana-gateway';
export const MAIN_BRANCH = 'main';
export const CI_PROJECT = 'ci-config';
export const ADMIN_ROTATE_BELOW_DAYS = 10;
export const SERVICE_ACCOUNT_CAP = 100;
export const SERVICE_ACCOUNT_WARN_AT = 80;
export const ROLES = Object.freeze({ reporter: 20, developer: 30, maintainer: 40 });
export const ROLE_NAMES = Object.freeze({ 20: 'Reporter', 30: 'Developer', 40: 'Maintainer', 50: 'Owner' });
export const CI_READER_LEVEL = 20; // a pipeline reads its central configuration with the rights of the user who triggers it
export const SECRETS = Object.freeze({
  agent: (username) => `vitana/engineering/gitlab/agents/${username}`,
  fleet: 'vitana/engineering/gitlab/fleet-runner-token',
  webhook: 'vitana/engineering/gitlab/webhook-signing-token',
});
export const SCOPES = Object.freeze(['api', 'read_api', 'read_repository', 'write_repository']);
export const DEFAULT_SCOPES = Object.freeze({ reporter: ['read_api'], developer: ['api', 'write_repository'], maintainer: ['api', 'write_repository'] });
export const WEBHOOK_EVENTS = Object.freeze({ merge_request: 'merge_requests_events', pipeline: 'pipeline_events' });
export const PROFILES = Object.freeze({
  // M1's behaviour: the mirror user pushes, force push is allowed; merge settings of a mirror project are not managed
  mirror: Object.freeze({ protect: Object.freeze({ push: 40, merge: 40, forcePush: true }), merge: null }),
  native: Object.freeze({
    protect: Object.freeze({ push: 0, merge: 40, forcePush: false }),
    merge: Object.freeze({
      merge_method: 'ff', squash_option: 'always', only_allow_merge_if_pipeline_succeeds: true, only_allow_merge_if_all_discussions_are_resolved: true,
      remove_source_branch_after_merge: true, automatic_rebase_enabled: false, squash_commit_template: '%{title}', merge_commit_template: '%{title}',
    }),
  }),
});
const HOOK_FLAGS = Object.freeze(['push_events', 'tag_push_events', 'issues_events', 'confidential_issues_events', 'note_events', 'confidential_note_events', 'job_events',
  'pipeline_events', 'wiki_page_events', 'deployment_events', 'releases_events', 'milestone_events', 'feature_flag_events', 'resource_access_token_events', 'merge_requests_events']);
export const SCHEMA_KEYS = Object.freeze({
  top: ['schema_version', 'gitlab_url', 'group', 'owners', 'tokens', 'runners', 'accounts', 'projects'],
  tokens: ['lifetime_days', 'rotate_below_days'],
  runners: ['legacy', 'fleet'],
  runner: ['description', 'tags', 'paused'],
  account: ['username', 'name', 'role', 'projects', 'scopes', 'token_file'],
  project: ['profile', 'landing', 'rehearsal', 'required_jobs', 'ci_file', 'webhook'],
  webhook: ['url', 'events'],
});
// ── the delivery cutover (plan agentic-delivery §3.6 step 8, §8.2 step 3, lane cutover) ───────────────────────────────────────
// A project with a `cutover` block has four states. inactive: its generated pipeline file (cutover.ci_file) is not in the CI folder yet,
// so the project is exactly what milestone 2 made it. shadow: the file is there, the marker is not: the project stays `mirror`, runs the
// delivery pipeline with DELIVERY_MODE=shadow and sends merge-request and pipeline events to the gateway. rehearsal: the marker says
// "rehearsal": shadow, but DELIVERY_MODE=live (plan §8.1 step 5). live: the marker says "live": the `native` profile, landing, the required
// jobs, push and tag-push events, the push mirror of protected branches to GitHub (divergent refs kept), a protected assist/*, "skipped
// pipelines count as successful" and DELIVERY_MODE=live. Removing the marker converges back to shadow. The marker is a host file written by
// scripts/eng/delivery-cutover.sh; the merge bot reads the same view through loadEffectiveProjects().
export const CUTOVER = Object.freeze({
  markerFile: '/etc/vitana/delivery-cutover',
  markerSchema: 'vitana.delivery-cutover-marker/v1',
  modes: Object.freeze(['rehearsal', 'live']),
  variable: 'DELIVERY_MODE',
  states: Object.freeze(['inactive', 'shadow', 'rehearsal', 'live']),
});
export const CUTOVER_KEYS = Object.freeze({
  top: ['cutover'],
  projectExtra: ['cutover'],
  topBlock: ['accounts'],
  project: ['github', 'ci_file', 'webhook_url', 'mirror_user', 'shadow', 'live'],
  shadow: ['webhook_events', 'mirror_user_role'],
  live: ['landing', 'required_jobs', 'webhook_events', 'mirror_user_role', 'push_mirror', 'protected_branches', 'allow_merge_on_skipped_pipeline'],
  pushMirror: ['token_file', 'only_protected_branches', 'keep_divergent_refs'],
  branch: ['name', 'push', 'merge'],
  account: ['username', 'name', 'scopes', 'token_file', 'shadow_role', 'live_role', 'projects'],
});
export const CUTOVER_WEBHOOK_EVENTS = Object.freeze({ ...WEBHOOK_EVENTS, push: 'push_events', tag_push: 'tag_push_events' });
export const DEFAULTS = Object.freeze({ url: 'http://127.0.0.1', adminTokenFile: '/etc/vitana/settings-admin-token' });
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const defaultConfigPath = () => path.resolve(HERE, '..', '..', 'infra', 'gitlab-engineering', 'settings', 'gitlab-settings.json');
export const defaultCiDir = () => path.resolve(HERE, '..', '..', 'infra', 'gitlab-engineering', 'ci');

const DAY_MS = 86_400_000;
const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}$/;
const GLRT = /^glrt-[A-Za-z0-9_.-]{8,}$/;
const SIGNING_OK = /^whsec_[A-Za-z0-9+/]{43}=$/;
const REGION_OK = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const NAME_OK = /^[a-z0-9][a-z0-9_.-]{1,63}$/;
const GROUP_OK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const TAG_OK = /^[A-Za-z0-9._-]{1,64}$/;
const CI_FILE_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}\.yml$/;
const TOKEN_FILE_OK = /^\/etc\/vitana\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const SECRET_ID_OK = /^vitana\/engineering\/gitlab\/[A-Za-z0-9/_-]+$/;

// ── configuration: schema version 1 ──────────────────────────────────────────────────────────────────────────────────────────
export class ConfigError extends Error {
  constructor(message) { super(message); this.name = 'ConfigError'; }
}
export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}
const bad = (where, problem) => { throw new ConfigError(`${where}: ${problem}`); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const key = (parent, k) => (parent ? `${parent}.${k}` : k);
function onlyKeys(o, allowed, where) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(key(where, k), `unknown key (allowed here: ${allowed.join(', ')})`);
}
function str(v, where, re, what) {
  if (typeof v !== 'string' || !re.test(v)) bad(where, `must be ${what} (got ${JSON.stringify(v)?.slice(0, 60)})`);
  return v;
}
function list(v, where, { min = 0, itemRe, itemWhat, unique = true } = {}) {
  if (!Array.isArray(v)) bad(where, 'must be a list');
  if (v.length < min) bad(where, `must have at least ${min} entr${min === 1 ? 'y' : 'ies'}`);
  v.forEach((x, i) => str(x, `${where}[${i}]`, itemRe, itemWhat));
  if (unique && new Set(v).size !== v.length) bad(where, 'must not repeat an entry');
  return [...v];
}
function httpsUrl(v, where) {
  let u;
  try { u = new URL(v); } catch { bad(where, 'must be an https URL'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) bad(where, 'must be an https URL without credentials or fragment');
  return v;
}

/** Validates schema version 1 and returns the normalised configuration. Every error names the key (for example accounts[2].role). */
export function validateConfig(raw) {
  if (!isObj(raw)) bad('settings', 'must be a JSON object');
  onlyKeys(raw, [...SCHEMA_KEYS.top, ...CUTOVER_KEYS.top], '');
  if (raw.schema_version !== SCHEMA_VERSION) bad('schema_version', `must be ${SCHEMA_VERSION} (got ${JSON.stringify(raw.schema_version)})`);
  const gitlabUrl = httpsUrl(raw.gitlab_url, 'gitlab_url');
  const group = str(raw.group, 'group', GROUP_OK, 'a GitLab group path (letters, digits, _ . -)');
  const owners = list(raw.owners, 'owners', { min: 1, itemRe: NAME_OK, itemWhat: 'a lower-case GitLab username' });

  if (!isObj(raw.tokens)) bad('tokens', 'must be an object');
  onlyKeys(raw.tokens, SCHEMA_KEYS.tokens, 'tokens');
  const { lifetime_days: life, rotate_below_days: below } = raw.tokens;
  if (!Number.isInteger(life) || life < 2 || life > 90) bad('tokens.lifetime_days', 'must be a whole number of days from 2 to 90 (plan §3.3: tokens expire in at most 90 days)');
  if (!Number.isInteger(below) || below < 1 || below >= life) bad('tokens.rotate_below_days', `must be a whole number of days from 1 to ${life - 1} (below the lifetime)`);

  if (!isObj(raw.runners)) bad('runners', 'must be an object');
  onlyKeys(raw.runners, SCHEMA_KEYS.runners, 'runners');
  const runner = (r, where, allowPaused) => {
    if (!isObj(r)) bad(where, 'must be an object');
    onlyKeys(r, allowPaused ? SCHEMA_KEYS.runner : SCHEMA_KEYS.runner.filter((k) => k !== 'paused'), where);
    const out = {
      description: str(r.description, key(where, 'description'), /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,100}$/, 'a runner description'),
      tags: list(r.tags, key(where, 'tags'), { min: 1, itemRe: TAG_OK, itemWhat: 'a runner tag' }),
    };
    if (allowPaused) {
      if (r.paused !== undefined && typeof r.paused !== 'boolean') bad(key(where, 'paused'), 'must be true or false');
      out.paused = r.paused === true;
    }
    return out;
  };
  const legacy = runner(raw.runners.legacy, 'runners.legacy', true);
  const fleet = runner(raw.runners.fleet, 'runners.fleet', false);
  if (legacy.tags.some((t) => fleet.tags.includes(t))) bad('runners.legacy.tags', 'must not contain a tag of the fleet runner: the legacy runner must not be selected by any pipeline');
  if (legacy.description === fleet.description) bad('runners.fleet.description', 'must differ from the legacy runner description');

  if (!isObj(raw.projects) || Object.keys(raw.projects).length === 0) bad('projects', 'must be an object with at least one project');
  const projects = {};
  for (const [name, p] of Object.entries(raw.projects)) {
    const where = `projects.${name}`;
    str(name, where, NAME_OK, 'a lower-case project path');
    if (name === CI_PROJECT) bad(where, `${CI_PROJECT} is managed by the sync itself and must not be listed`);
    if (!isObj(p)) bad(where, 'must be an object');
    onlyKeys(p, [...SCHEMA_KEYS.project, ...CUTOVER_KEYS.projectExtra], where);
    if (!Object.hasOwn(PROFILES, p.profile)) bad(key(where, 'profile'), `must be one of ${Object.keys(PROFILES).join(', ')} (got ${JSON.stringify(p.profile)})`);
    for (const flag of ['landing', 'rehearsal']) if (p[flag] !== undefined && typeof p[flag] !== 'boolean') bad(key(where, flag), 'must be true or false');
    const out = {
      profile: p.profile, landing: p.landing === true, rehearsal: p.rehearsal === true,
      required_jobs: p.required_jobs === undefined ? [] : list(p.required_jobs, key(where, 'required_jobs'), { itemRe: /^.{1,255}$/, itemWhat: 'a job name' }),
      ci_file: p.ci_file === undefined || p.ci_file === null ? null : str(p.ci_file, key(where, 'ci_file'), CI_FILE_OK, 'a file name ending in .yml, without a path'),
      webhook: null,
      cutover: p.cutover === undefined || p.cutover === null ? null : validateProjectCutover(p.cutover, key(where, 'cutover')),
    };
    if (out.landing && out.profile !== 'native') bad(key(where, 'landing'), 'needs profile native: a mirror project is pushed to by the mirror user, not landed by the bot');
    if (out.rehearsal && out.profile !== 'native') bad(key(where, 'rehearsal'), 'needs profile native (plan §3.8: a rehearsal project is native, with no webhook and no mirror)');
    if (p.webhook !== undefined && p.webhook !== null) {
      const wh = p.webhook;
      const wwhere = key(where, 'webhook');
      if (!isObj(wh)) bad(wwhere, 'must be an object with url and events');
      onlyKeys(wh, SCHEMA_KEYS.webhook, wwhere);
      if (out.rehearsal) bad(wwhere, 'a rehearsal project must not have a webhook');
      out.webhook = { url: httpsUrl(wh.url, key(wwhere, 'url')), events: list(wh.events, key(wwhere, 'events'), { min: 1, itemRe: new RegExp(`^(${Object.keys(WEBHOOK_EVENTS).join('|')})$`), itemWhat: `one of ${Object.keys(WEBHOOK_EVENTS).join(', ')}` }) };
    }
    if (out.cutover && out.profile !== 'mirror') bad(key(where, 'cutover'), 'needs profile mirror: the cutover turns a mirror project into a native one');
    projects[name] = out;
  }

  if (!Array.isArray(raw.accounts)) bad('accounts', 'must be a list');
  const seen = new Set();
  const files = new Set();
  const accounts = raw.accounts.map((a, i) => {
    const where = `accounts[${i}]`;
    if (!isObj(a)) bad(where, 'must be an object');
    onlyKeys(a, SCHEMA_KEYS.account, where);
    const username = str(a.username, key(where, 'username'), NAME_OK, 'a lower-case GitLab username');
    if (seen.has(username)) bad(key(where, 'username'), `${username} appears twice`);
    if (owners.includes(username)) bad(key(where, 'username'), `${username} is an owner (a person), not a service account`);
    seen.add(username);
    if (!Object.hasOwn(ROLES, a.role)) bad(key(where, 'role'), `must be one of ${Object.keys(ROLES).join(', ')} (got ${JSON.stringify(a.role)})`);
    const projs = list(a.projects ?? [], key(where, 'projects'), { itemRe: NAME_OK, itemWhat: 'a project of this file' });
    projs.forEach((p, j) => { if (!Object.hasOwn(projects, p)) bad(`${where}.projects[${j}]`, `${p} is not a project in "projects"`); });
    const scopes = a.scopes === undefined ? [...DEFAULT_SCOPES[a.role]] : list(a.scopes, key(where, 'scopes'), { min: 1, itemRe: new RegExp(`^(${SCOPES.join('|')})$`), itemWhat: `one of ${SCOPES.join(', ')}` });
    let tokenFile = null;
    if (a.token_file !== undefined && a.token_file !== null) {
      tokenFile = str(a.token_file, key(where, 'token_file'), TOKEN_FILE_OK, 'a file directly under /etc/vitana');
      if (files.has(tokenFile)) bad(key(where, 'token_file'), `${tokenFile} is already used by another account`);
      files.add(tokenFile);
    }
    const name = a.name === undefined ? username : str(a.name, key(where, 'name'), /^.{1,100}$/, 'a display name');
    return { username, name, role: a.role, projects: projs, scopes, token_file: tokenFile };
  });
  const cutover = raw.cutover === undefined || raw.cutover === null ? null : validateTopCutover(raw.cutover, projects, seen, owners, files);
  return { schema_version: SCHEMA_VERSION, gitlab_url: gitlabUrl, group, owners, tokens: { lifetime_days: life, rotate_below_days: below }, runners: { legacy, fleet }, projects, accounts, cutover };
}

const GH_REPO_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RULE_OK = /^[A-Za-z0-9][A-Za-z0-9._/*-]{0,100}$/;
const CUTOVER_EVENTS = Object.keys(CUTOVER_WEBHOOK_EVENTS);
function bool(v, where) { if (typeof v !== 'boolean') bad(where, 'must be true or false'); return v; }
function roleOf(v, where) { if (!Object.hasOwn(ROLES, v)) bad(where, `must be one of ${Object.keys(ROLES).join(', ')} (got ${JSON.stringify(v)})`); return v; }
function eventList(v, where) {
  return list(v, where, { min: 1, itemRe: new RegExp(`^(${CUTOVER_EVENTS.join('|')})$`), itemWhat: `one of ${CUTOVER_EVENTS.join(', ')}` });
}
/** The `cutover` block of a project (plan agentic-delivery §8.2 step 3). Every error names the key. */
function validateProjectCutover(c, where) {
  if (!isObj(c)) bad(where, 'must be an object');
  onlyKeys(c, CUTOVER_KEYS.project, where);
  const sh = c.shadow;
  const lv = c.live;
  if (!isObj(sh)) bad(key(where, 'shadow'), 'must be an object');
  if (!isObj(lv)) bad(key(where, 'live'), 'must be an object');
  onlyKeys(sh, CUTOVER_KEYS.shadow, key(where, 'shadow'));
  onlyKeys(lv, CUTOVER_KEYS.live, key(where, 'live'));
  const out = {
    github: str(c.github, key(where, 'github'), GH_REPO_OK, 'a GitHub repository (owner/name)'),
    ci_file: str(c.ci_file, key(where, 'ci_file'), CI_FILE_OK, 'a file name ending in .yml, without a path'),
    webhook_url: httpsUrl(c.webhook_url, key(where, 'webhook_url')),
    mirror_user: c.mirror_user === undefined ? null : str(c.mirror_user, key(where, 'mirror_user'), NAME_OK, 'a lower-case GitLab username'),
    shadow: { webhook_events: eventList(sh.webhook_events, key(where, 'shadow.webhook_events')), mirror_user_role: sh.mirror_user_role === undefined ? null : roleOf(sh.mirror_user_role, key(where, 'shadow.mirror_user_role')) },
    live: {
      landing: bool(lv.landing, key(where, 'live.landing')),
      required_jobs: list(lv.required_jobs, key(where, 'live.required_jobs'), { min: 1, itemRe: /^.{1,255}$/, itemWhat: 'a job name' }),
      webhook_events: eventList(lv.webhook_events, key(where, 'live.webhook_events')),
      mirror_user_role: lv.mirror_user_role === undefined ? null : roleOf(lv.mirror_user_role, key(where, 'live.mirror_user_role')),
      push_mirror: null,
      protected_branches: [],
      allow_merge_on_skipped_pipeline: bool(lv.allow_merge_on_skipped_pipeline, key(where, 'live.allow_merge_on_skipped_pipeline')),
    },
  };
  if (out.mirror_user && (out.shadow.mirror_user_role === null || out.live.mirror_user_role === null)) bad(key(where, 'mirror_user'), 'needs shadow.mirror_user_role and live.mirror_user_role');
  const pm = lv.push_mirror;
  if (!isObj(pm)) bad(key(where, 'live.push_mirror'), 'must be an object');
  onlyKeys(pm, CUTOVER_KEYS.pushMirror, key(where, 'live.push_mirror'));
  out.live.push_mirror = {
    token_file: str(pm.token_file, key(where, 'live.push_mirror.token_file'), TOKEN_FILE_OK, 'a file directly under /etc/vitana'),
    only_protected_branches: bool(pm.only_protected_branches, key(where, 'live.push_mirror.only_protected_branches')),
    keep_divergent_refs: bool(pm.keep_divergent_refs, key(where, 'live.push_mirror.keep_divergent_refs')),
  };
  if (out.live.push_mirror.only_protected_branches !== true) bad(key(where, 'live.push_mirror.only_protected_branches'), 'must be true: only protected branches (main) are mirrored to GitHub (plan §3.13)');
  if (out.live.push_mirror.keep_divergent_refs !== true) bad(key(where, 'live.push_mirror.keep_divergent_refs'), 'must be true: a divergent GitHub ref is kept, never overwritten (plan §3.13)');
  if (!Array.isArray(lv.protected_branches)) bad(key(where, 'live.protected_branches'), 'must be a list');
  const seen = new Set();
  lv.protected_branches.forEach((b, i) => {
    const w = `${key(where, 'live.protected_branches')}[${i}]`;
    if (!isObj(b)) bad(w, 'must be an object');
    onlyKeys(b, CUTOVER_KEYS.branch, w);
    const name = str(b.name, key(w, 'name'), BRANCH_RULE_OK, 'a branch name or wildcard such as assist/*');
    if (name === MAIN_BRANCH || seen.has(name)) bad(key(w, 'name'), `${name} is ${name === MAIN_BRANCH ? 'protected by the profile already' : 'listed twice'}`);
    seen.add(name);
    for (const k of ['push', 'merge']) if (![0, 30, 40].includes(b[k])) bad(key(w, k), 'must be 0 (No one), 30 (Developers) or 40 (Maintainers)');
    out.live.protected_branches.push({ name, push: b.push, merge: b.merge });
  });
  return out;
}
/** The top-level `cutover` block: the accounts that exist while a project is in shadow or live (the bridge). */
function validateTopCutover(c, projects, usernames, owners, tokenFiles) {
  if (!isObj(c)) bad('cutover', 'must be an object');
  onlyKeys(c, CUTOVER_KEYS.topBlock, 'cutover');
  if (!Array.isArray(c.accounts)) bad('cutover.accounts', 'must be a list');
  const names = new Set();
  const accounts = c.accounts.map((a, i) => {
    const where = `cutover.accounts[${i}]`;
    if (!isObj(a)) bad(where, 'must be an object');
    onlyKeys(a, CUTOVER_KEYS.account, where);
    const username = str(a.username, key(where, 'username'), NAME_OK, 'a lower-case GitLab username');
    if (usernames.has(username) || names.has(username)) bad(key(where, 'username'), `${username} is already an account of this file`);
    if (owners.includes(username)) bad(key(where, 'username'), `${username} is an owner (a person), not a service account`);
    names.add(username);
    const projs = list(a.projects, key(where, 'projects'), { min: 1, itemRe: NAME_OK, itemWhat: 'a project of this file' });
    projs.forEach((p, j) => { if (!projects[p]?.cutover) bad(`${where}.projects[${j}]`, `${p} has no cutover block`); });
    const tokenFile = a.token_file === undefined || a.token_file === null ? null : str(a.token_file, key(where, 'token_file'), TOKEN_FILE_OK, 'a file directly under /etc/vitana');
    if (tokenFile) { if (tokenFiles.has(tokenFile)) bad(key(where, 'token_file'), `${tokenFile} is already used by another account`); tokenFiles.add(tokenFile); }
    const scopes = a.scopes === undefined ? [...DEFAULT_SCOPES.developer] : list(a.scopes, key(where, 'scopes'), { min: 1, itemRe: new RegExp(`^(${SCOPES.join('|')})$`), itemWhat: `one of ${SCOPES.join(', ')}` });
    return {
      username, name: a.name === undefined ? username : str(a.name, key(where, 'name'), /^.{1,100}$/, 'a display name'),
      shadow_role: roleOf(a.shadow_role, key(where, 'shadow_role')), live_role: roleOf(a.live_role, key(where, 'live_role')), projects: projs, scopes, token_file: tokenFile,
    };
  });
  return { accounts };
}

// ── the view of the delivery cutover: marker, state of a project, the configuration the rest of the run works on ─────────────────
/** The marker file: { present, mode, at, problem }. A file that is not a marker counts as absent and is reported. */
export async function readMarker(fsDep, file = CUTOVER.markerFile) {
  const f = await fsDep.readFile(file).catch(() => null);
  if (!f) return { present: false, mode: null, at: null, problem: null };
  let j;
  try { j = JSON.parse(f.text); } catch { return { present: false, mode: null, at: null, problem: `${file} is not valid JSON; treated as absent` }; }
  if (!isObj(j) || j.schema !== CUTOVER.markerSchema) return { present: false, mode: null, at: null, problem: `${file} does not carry the schema ${CUTOVER.markerSchema}; treated as absent` };
  if (!CUTOVER.modes.includes(j.mode)) return { present: false, mode: null, at: null, problem: `${file}: mode must be ${CUTOVER.modes.join(' or ')}; treated as absent` };
  return { present: true, mode: j.mode, at: typeof j.at === 'string' ? j.at : null, problem: null };
}
/** inactive | shadow | rehearsal | live (see the comment at CUTOVER). */
export function projectState(p, marker, deliveryFiles) {
  if (!p.cutover || !deliveryFiles.has(p.cutover.ci_file)) return 'inactive';
  if (marker?.present && marker.mode === 'live') return 'live';
  if (marker?.present && marker.mode === 'rehearsal') return 'rehearsal';
  return 'shadow';
}
/**
 * The configuration a run works on: the validated file with each cutover project turned into its state (pure). An inactive project and a
 * file without cutover blocks come out unchanged, so milestone 2 behaves exactly as before until a generated pipeline file exists.
 */
export function effectiveConfig(config, { marker = null, deliveryFiles = new Set() } = {}) {
  const projects = {};
  const states = {};
  for (const [name, p] of Object.entries(config.projects)) {
    const state = projectState(p, marker, deliveryFiles);
    states[name] = state;
    if (state === 'inactive') { projects[name] = { ...p, cutoverState: 'inactive', cutoverPlan: null }; continue; }
    const c = p.cutover;
    const live = state === 'live';
    const block = live ? c.live : c.shadow;
    projects[name] = {
      ...p, cutoverState: state,
      profile: live ? 'native' : p.profile, landing: live ? c.live.landing : p.landing, required_jobs: live ? c.live.required_jobs : p.required_jobs,
      ci_file: c.ci_file, webhook: { url: c.webhook_url, events: block.webhook_events },
      cutoverPlan: {
        github: c.github, mode: state === 'shadow' ? 'shadow' : 'live', live, pushMirror: live ? c.live.push_mirror : null,
        managedBranches: c.live.protected_branches, wantBranches: live ? c.live.protected_branches : [], allowSkipped: live && c.live.allow_merge_on_skipped_pipeline,
        mirrorUser: c.mirror_user ? { username: c.mirror_user, role: block.mirror_user_role } : null,
      },
    };
  }
  const active = Object.entries(projects).filter(([, p]) => p.cutoverState !== 'inactive').map(([n]) => n);
  const liveNames = new Set(active.filter((n) => projects[n].cutoverState === 'live'));
  const accounts = config.accounts.map((a) => (a.role === 'maintainer' && liveNames.size ? { ...a, projects: [...new Set([...a.projects, ...liveNames])] } : a));
  for (const a of config.cutover?.accounts ?? []) {
    const mine = a.projects.filter((n) => active.includes(n));
    if (!mine.length) continue;
    accounts.push({ username: a.username, name: a.name, role: mine.some((n) => liveNames.has(n)) ? a.live_role : a.shadow_role, projects: mine, scopes: a.scopes, token_file: a.token_file });
  }
  return { ...config, projects, accounts, cutoverStates: states };
}
/** The projects as the merge bot reads them ({ name, path, landing, required_jobs }), in the view of the marker: landing is on for a live project. */
export async function loadEffectiveProjects(settingsFile, { fs: fsDep = realFs(), markerFile = CUTOVER.markerFile, ciDir = defaultCiDir() } = {}) {
  const f = await fsDep.readFile(settingsFile);
  if (!f) throw new Error(`${settingsFile} cannot be read`);
  const config = validateConfig(JSON.parse(f.text));
  const files = new Set(await fsDep.listYml(ciDir).catch(() => []));
  const eff = effectiveConfig(config, { marker: await readMarker(fsDep, markerFile), deliveryFiles: files });
  return Object.entries(eff.projects).map(([name, p]) => ({ name, path: `${eff.group}/${name}`, landing: p.landing === true, required_jobs: [...p.required_jobs] }));
}

// ── small helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const dayStart = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
export const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
export const plusDays = (nowMs, n) => isoDate(dayStart(nowMs) + n * DAY_MS);
/** Whole days from today (UTC) to the expiry date; Infinity for a token without one. A token expires at the start of its date. */
export function daysLeft(expiresAt, nowMs) {
  if (expiresAt === null || expiresAt === undefined) return Infinity;
  return Math.round((Date.parse(`${expiresAt}T00:00:00Z`) - dayStart(nowMs)) / DAY_MS);
}
const sameSet = (a, b) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const oneLine = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const sha12 = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);

/** Removes every secret the run has seen (add), GitLab token shapes and bearer tokens from text that may reach a log or an error. */
export function makeRedactor() {
  const secrets = new Set();
  const r = (text) => {
    let s = redact(text, null).replace(/whsec_[A-Za-z0-9+/=_-]{8,}/g, '[redacted]');
    for (const v of secrets) s = s.split(v).join('[redacted]');
    return s;
  };
  r.add = (v) => { if (typeof v === 'string' && v.trim().length >= 8) secrets.add(v.trim()); };
  return r;
}

// ── the machine: files, AWS CLI ──────────────────────────────────────────────────────────────────────────────────────────────
export function realFs() {
  return {
    async readFile(p) {
      try {
        const [text, st] = await Promise.all([fs.promises.readFile(p, 'utf8'), fs.promises.stat(p)]);
        return { text, mode: st.mode & 0o777 };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },
    /** Temp file in the same directory with the final mode from the start, fsync, rename: a reader sees the old or the new file, never half. */
    async writeAtomic(p, text, { mode = 0o600 } = {}) {
      const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
      let fh;
      try {
        fh = await fs.promises.open(tmp, 'wx', mode);
        await fh.chmod(mode); // the umask can only remove bits: make the mode exact before any content is written
        await fh.writeFile(text, 'utf8');
        await fh.sync();
        await fh.close();
        fh = null;
        await fs.promises.rename(tmp, p);
      } catch (e) {
        if (fh) await fh.close().catch(() => {});
        await fs.promises.unlink(tmp).catch(() => {});
        throw e;
      }
    },
    /** Can a file next to `p` be created and removed? Used before a rotation whose result has nowhere else to go. */
    async preflight(p) {
      const probe = path.join(path.dirname(p), `.${path.basename(p)}.probe-${process.pid}`);
      const fh = await fs.promises.open(probe, 'wx', 0o600);
      await fh.close();
      await fs.promises.unlink(probe);
    },
    async listYml(dir) {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isFile() && e.name.endsWith('.yml')).map((e) => e.name).sort();
    },
  };
}

function defaultAws(env) {
  return (args, { input } = {}) => new Promise((resolve, reject) => {
    const child = spawn('aws', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (d) => { if (out.length < 1_000_000) out += d; });
    child.stderr.on('data', (d) => { if (err.length < 100_000) err += d; });
    child.stdin.on('error', () => {}); // aws may exit before it has read its input
    child.on('error', (e) => { clearTimeout(timer); reject(Object.assign(new Error(`aws could not be started (${e.code ?? e.message})`), { stderr: '' })); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out });
      else reject(Object.assign(new Error(`aws ${args[0]} ${args[1]} failed (exit ${code}): ${oneLine(err.split('\n').find((l) => l.trim()) ?? '', 200)}`), { stderr: err, code }));
    });
    child.stdin.end(input ?? '');
  });
}

export function defaultDeps(env = process.env) {
  return {
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env,
    stdout: (line) => process.stdout.write(`${line}\n`),
    aws: defaultAws(env),
    fs: realFs(),
  };
}

const errText = (e) => `${e?.message ?? ''} ${e?.stderr ?? ''}`;
function makeSecrets({ aws, region, redactor }) {
  const check = (id) => { if (!SECRET_ID_OK.test(id)) throw new Error(`refusing a secret name outside vitana/engineering/gitlab/: ${oneLine(id, 80)}`); };
  return {
    /** The secret value, or null when the secret or its value does not exist yet. Any other AWS error is an error. */
    async get(id) {
      check(id);
      try {
        const { stdout } = await aws(['secretsmanager', 'get-secret-value', '--secret-id', id, '--query', 'SecretString', '--output', 'text', '--region', region]);
        const v = String(stdout).replace(/\r?\n$/, '');
        if (v === '' || v === 'None') return null;
        redactor.add(v);
        return v;
      } catch (e) {
        if (/ResourceNotFoundException/.test(errText(e))) return null;
        throw new Error(`reading the secret ${id} failed: ${oneLine(redactor(errText(e)), 220)}`);
      }
    },
    /** Puts a value (a private file, never an argument); creates the secret when it does not exist. */
    async put(id, value) {
      check(id);
      redactor.add(value);
      // The AWS CLI cannot read file:///dev/stdin when a systemd unit runs it (ParamValidation, errno 6), so the value goes
      // through a private file that exists only for this call: a 0700 directory holding a 0600 file, removed in finally.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vitana-secret-'));
      try {
        const file = path.join(dir, 'value');
        fs.writeFileSync(file, value, { mode: 0o600 });
        const secretString = `file://${file}`;
        try {
          await aws(['secretsmanager', 'put-secret-value', '--secret-id', id, '--secret-string', secretString, '--region', region]);
        } catch (e) {
          if (!/ResourceNotFoundException/.test(errText(e))) throw new Error(`storing the secret ${id} failed: ${oneLine(redactor(errText(e)), 220)}`);
          try {
            await aws(['secretsmanager', 'create-secret', '--name', id, '--description', 'Managed by scripts/eng/gitlab-settings.mjs (plan eng-gitlab-m2)', '--secret-string', secretString, '--region', region]);
          } catch (e2) {
            throw new Error(`creating the secret ${id} failed: ${oneLine(redactor(errText(e2)), 220)}`);
          }
        }
      } finally {
        // A removal error must not replace the put error; the directory holds only the 0600 file of this call.
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the put result is what the caller needs */ }
      }
    },
  };
}

// ── the plan: changes (what apply will do) and findings (what a person has to look at) ─────────────────────────────────────────
class Plan {
  constructor() { this.changes = []; this.findings = []; }
  add(change) { this.changes.push({ requires: [], gate: false, ...change }); return change.id; }
  has(id) { return this.changes.some((c) => c.id === id); }
  finding(level, area, message) { this.findings.push({ level, area, message }); }
}

/** Every write: retries 0, so the client never repeats an action that may already have been processed. */
const send = (ctx, method, p, body) => ctx.client.request(method, p, { body, retries: 0 });
const readAll = (ctx, p, query) => ctx.client.paginate(p, query ? { query } : {});
const levelName = (n) => (n === 0 ? 'No one' : ROLE_NAMES[n] ?? String(n));
const levelsText = (list) => (Array.isArray(list) ? list.map((x) => (x.user_id || x.group_id || x.deploy_key_id ? 'a user, group or key' : levelName(x.access_level))).join(' + ') : 'unknown');
const onlyLevel = (list, level) => Array.isArray(list) && list.length === 1 && list[0].access_level === level && !list[0].user_id && !list[0].group_id && !list[0].deploy_key_id;

// ── observation: every read, before any write ────────────────────────────────────────────────────────────────────────────────
async function whoAmI(ctx, value) {
  if (!TOKEN_OK.test(value)) return null;
  const c = createClient({ baseUrl: ctx.baseUrl, token: value, fetch: ctx.deps.fetch, sleep: ctx.deps.sleep, now: ctx.deps.now });
  const r = await c.raw('GET', '/personal_access_tokens/self', { okStatuses: [401, 403] });
  return r.status === 200 && r.data?.active === true ? r.data : null;
}

async function remoteFile(ctx, projectIdNumber, name) {
  const r = await ctx.client.raw('GET', `/projects/${projectIdNumber}/repository/files/${encodeURIComponent(name)}`, { query: { ref: MAIN_BRANCH }, okStatuses: [404] });
  if (r.status === 404) return null;
  return Buffer.from(String(r.data?.content ?? ''), r.data?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
}

async function observe(ctx) {
  const { config: cfg } = ctx;
  const get = (p, o) => ctx.client.get(p, o);
  const S = {};
  S.admin = await get('/personal_access_tokens/self');
  if (!S.admin || S.admin.active !== true) throw new Error('GitLab says the admin token is not active');
  if (!Array.isArray(S.admin.scopes) || !S.admin.scopes.includes('api')) throw new Error('the admin token needs the api scope');

  const sas = await readAll(ctx, '/service_accounts');
  S.serviceAccounts = new Map(sas.map((u) => [u.username, u]));
  S.otherUsers = new Set();
  for (const a of cfg.accounts) {
    const sa = S.serviceAccounts.get(a.username);
    if (sa) { ctx.ids.users.set(a.username, sa.id); continue; }
    const found = await get('/users', { query: { username: a.username } });
    if (Array.isArray(found) && found.some((u) => u.username === a.username)) S.otherUsers.add(a.username);
  }

  const g = await ctx.client.raw('GET', `/groups/${encodeURIComponent(cfg.group)}`, { okStatuses: [404] });
  if (g.status === 404) throw new Error(`the group ${cfg.group} does not exist; milestone 1's gitlab-configure.sh creates it`);
  S.groupId = g.data.id;

  S.projects = new Map();
  for (const name of [CI_PROJECT, ...Object.keys(cfg.projects)]) {
    const r = await ctx.client.raw('GET', `/projects/${projectId(`${cfg.group}/${name}`)}`, { okStatuses: [404] });
    if (r.status === 404) { S.projects.set(name, { exists: false }); continue; }
    const obj = r.data;
    ctx.ids.projects.set(name, obj.id);
    const P = { exists: true, obj, members: await readAll(ctx, `/projects/${obj.id}/members`) };
    if (name !== CI_PROJECT) {
      P.branches = await readAll(ctx, `/projects/${obj.id}/protected_branches`);
      P.membersAll = await readAll(ctx, `/projects/${obj.id}/members/all`);
      P.hooks = await readAll(ctx, `/projects/${obj.id}/hooks`);
      if (cfg.projects[name].cutoverPlan) { // only a project in shadow, rehearsal or live is asked for its variables and its remote mirrors
        P.variables = await readAll(ctx, `/projects/${obj.id}/variables`);
        P.mirrors = await readAll(ctx, `/projects/${obj.id}/remote_mirrors`);
      }
    }
    S.projects.set(name, P);
  }

  S.ownerUsers = new Map();
  for (const o of cfg.owners) {
    const needed = Object.keys(cfg.projects).some((n) => { const P = S.projects.get(n); return P.exists && (P.membersAll.find((m) => m.username === o)?.access_level ?? 0) < ROLES.maintainer; });
    if (!needed) continue;
    const found = await get('/users', { query: { username: o } });
    S.ownerUsers.set(o, Array.isArray(found) ? found.find((u) => u.username === o) ?? null : null);
  }

  const all = await readAll(ctx, '/runners/all', { type: 'instance_type' });
  S.runners = new Map();
  for (const r of [...all].sort((a, b) => a.id - b.id)) if (!S.runners.has(r.description)) S.runners.set(r.description, r);
  S.runnerDetail = new Map();
  for (const desc of [cfg.runners.legacy.description, cfg.runners.fleet.description]) {
    const r = S.runners.get(desc);
    if (r) S.runnerDetail.set(desc, await get(`/runners/${r.id}`));
  }

  S.ci = { local: new Map(), remote: new Map(), missingDir: false, ignored: [] };
  let names = [];
  try { names = await ctx.deps.fs.listYml(ctx.ciDir); } catch (e) { if (e?.code === 'ENOENT') S.ci.missingDir = true; else throw e; }
  for (const n of names) {
    if (!CI_FILE_OK.test(n)) { S.ci.ignored.push(n); continue; }
    const f = await ctx.deps.fs.readFile(path.join(ctx.ciDir, n));
    if (f) S.ci.local.set(n, f.text);
  }
  const cip = S.projects.get(CI_PROJECT);
  if (cip.exists) {
    const wanted = new Set([...S.ci.local.keys(), ...Object.values(cfg.projects).map((p) => p.ci_file).filter(Boolean)]);
    for (const n of [...wanted].sort()) S.ci.remote.set(n, await remoteFile(ctx, cip.obj.id, n));
  }

  S.tokens = new Map();
  for (const a of cfg.accounts) {
    const sa = S.serviceAccounts.get(a.username);
    const T = { sa, secret: null, self: null, active: [], file: a.token_file ? await ctx.deps.fs.readFile(a.token_file) : null };
    if (sa) {
      T.secret = await ctx.secrets.get(SECRETS.agent(a.username));
      T.active = await readAll(ctx, '/personal_access_tokens', { user_id: sa.id, state: 'active' });
      if (T.secret) { const me = await whoAmI(ctx, T.secret); T.self = me && me.user_id === sa.id ? me : null; }
    }
    S.tokens.set(a.username, T);
  }
  S.fleetSecret = await ctx.secrets.get(SECRETS.fleet);
  S.webhookSecret = Object.values(cfg.projects).some((p) => p.webhook) ? await ctx.secrets.get(SECRETS.webhook) : null;
  S.pushMirrorTokens = new Map(); // project -> the GitHub token of its push mirror (a file under /etc/vitana), or null
  for (const [name, p] of Object.entries(cfg.projects)) {
    const pm = p.cutoverPlan?.pushMirror;
    if (!pm) continue;
    const f = await ctx.deps.fs.readFile(pm.token_file).catch(() => null);
    const token = f ? f.text.trim() : '';
    if (TOKEN_OK.test(token)) { ctx.redactor.add(token); S.pushMirrorTokens.set(name, { token, mode: f.mode }); } else S.pushMirrorTokens.set(name, null);
  }
  return S;
}

// ── planning ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** What to do with the tokens of one account (pure). `secret` is the answer of GET /personal_access_tokens/self for the stored token. */
export function planToken({ active, secret, want, nowMs, lifetimeDays, rotateBelowDays }) {
  const tooLong = (t) => t.expires_at === null || t.expires_at === undefined || daysLeft(t.expires_at, nowMs) > lifetimeDays;
  const managed = active.filter((t) => t.name === TOKEN_NAME);
  const revoke = active.filter((t) => t.name !== TOKEN_NAME && tooLong(t)).map((t) => ({ id: t.id, reason: 'its expiry is missing or more than the maximum lifetime away' }));
  if (managed.length === 0) return { action: 'create', reason: 'the account has no token', revoke };
  let primary = secret?.id === undefined ? undefined : managed.find((t) => t.id === secret.id);
  if (!primary) primary = [...managed].sort((a, b) => b.id - a.id)[0];
  for (const t of managed) if (t !== primary) revoke.push({ id: t.id, reason: 'a second token of the sync' });
  if (!sameSet(primary.scopes ?? [], want)) return { action: 'replace', primary, reason: `its scopes (${(primary.scopes ?? []).join(', ')}) differ from the file`, revoke };
  if (tooLong(primary)) return { action: 'rotate', primary, reason: 'its expiry is missing or more than the maximum lifetime away', revoke };
  const left = daysLeft(primary.expires_at, nowMs);
  if (left < rotateBelowDays) return { action: 'rotate', primary, reason: `${left} day(s) left (rotated below ${rotateBelowDays})`, revoke };
  if (secret?.id !== primary.id) return { action: 'rotate', primary, reason: 'the stored token is missing or not accepted by GitLab', revoke };
  return { action: 'none', primary, revoke };
}

function planAdminToken(ctx, S, plan) {
  const left = daysLeft(S.admin.expires_at, ctx.nowMs);
  if (left < ADMIN_ROTATE_BELOW_DAYS) {
    plan.add({ id: 'admin-token:rotate', area: 'admin token', summary: `the sync's own token has ${left} day(s) left (rotated below ${ADMIN_ROTATE_BELOW_DAYS})`, apply: () => rotateAdminToken(ctx, S.admin) });
  } else if (ctx.adminFile && ctx.adminFile.mode !== undefined && ctx.adminFile.mode !== 0o600) {
    plan.add({ id: `file:${ctx.adminTokenFile}`, area: 'admin token', summary: `${ctx.adminTokenFile} has mode ${ctx.adminFile.mode.toString(8)}, expected 600`, apply: () => ctx.deps.fs.writeAtomic(ctx.adminTokenFile, ctx.adminFile.text, { mode: 0o600 }) });
  }
}

function planLegacyRunner(ctx, S, plan) {
  const L = ctx.config.runners.legacy;
  const r = S.runners.get(L.description);
  if (!r) { plan.finding('warn', 'legacy runner', `no instance runner named "${L.description}": nothing to retag (milestone 1's runner is gone or was renamed)`); return; }
  const d = S.runnerDetail.get(L.description);
  const body = {};
  if (!sameSet(d.tag_list ?? [], L.tags)) body.tag_list = L.tags.join(',');
  if (d.run_untagged !== false) body.run_untagged = false;
  if (Boolean(d.paused) !== L.paused) body.paused = L.paused;
  if (Object.keys(body).length === 0) return;
  plan.add({
    id: 'runner:legacy:update', area: 'legacy runner', gate: true,
    summary: `${L.description}: ${Object.entries(body).map(([k, v]) => `${k} = ${v}`).join(', ')}`,
    apply: () => send(ctx, 'PUT', `/runners/${r.id}`, body),
  });
}

function planAccounts(ctx, S, plan) {
  const used = S.serviceAccounts.size;
  if (used >= SERVICE_ACCOUNT_WARN_AT) plan.finding('warn', 'service accounts', `${used} of ${SERVICE_ACCOUNT_CAP} service accounts are used (the Free tier allows ${SERVICE_ACCOUNT_CAP} per instance; the sync warns from ${SERVICE_ACCOUNT_WARN_AT})`);
  for (const a of ctx.config.accounts) {
    if (S.serviceAccounts.has(a.username)) continue;
    if (S.otherUsers.has(a.username)) {
      plan.add({ id: `account:${a.username}`, area: 'accounts', summary: `${a.username} is taken by a user that is not a service account`, apply: async () => { throw new Error(`the username ${a.username} is already taken by a user that is not a service account; rename one of them`); } });
      continue;
    }
    plan.add({
      id: `account:${a.username}`, area: 'accounts', gate: true, summary: `create the service account ${a.username} (${a.role})`,
      apply: async () => { const res = await send(ctx, 'POST', '/service_accounts', { name: a.name, username: a.username }); ctx.ids.users.set(a.username, res.id); },
    });
  }
}

async function createProject(ctx, name, extra) {
  const res = await send(ctx, 'POST', '/projects', { name, path: name, namespace_id: ctx.groupId, visibility: 'private', ...extra });
  ctx.ids.projects.set(name, res.id);
}

function ciConfigPath(ctx, S, name, p, plan) {
  if (!p.ci_file) return null;
  const known = S.ci.local.has(p.ci_file) || (S.ci.remote.get(p.ci_file) ?? null) !== null;
  if (!known) {
    plan.finding('warn', `project ${name}`, `wants ${p.ci_file}, but it is neither in ${ctx.ciDir} nor in ${ctx.config.group}/${CI_PROJECT}; its CI configuration path is left as it is`);
    return null;
  }
  return `${p.ci_file}@${ctx.config.group}/${CI_PROJECT}:${MAIN_BRANCH}`;
}

function planCentralCi(ctx, S, plan) {
  const cip = S.projects.get(CI_PROJECT);
  if (S.ci.missingDir) plan.finding('warn', 'central CI', `the CI folder ${ctx.ciDir} does not exist; no file is synced`);
  for (const n of S.ci.ignored) plan.finding('warn', 'central CI', `${n} has a name the sync does not accept; ignored`);
  if (!cip.exists) {
    plan.add({ id: `project:${CI_PROJECT}:create`, area: 'central CI', summary: `create ${ctx.config.group}/${CI_PROJECT} (private, with a README, as milestone 1 does)`, apply: () => createProject(ctx, CI_PROJECT, { initialize_with_readme: true }) });
  }
  const actions = [];
  for (const [name, text] of [...S.ci.local].sort(([a], [b]) => a.localeCompare(b))) {
    const remote = cip.exists ? S.ci.remote.get(name) : null;
    if (remote === null || remote === undefined) actions.push({ action: 'create', file_path: name, content: text });
    else if (remote !== text) actions.push({ action: 'update', file_path: name, content: text });
  }
  if (actions.length === 0) return;
  plan.add({
    id: 'ci-files:write', area: 'central CI', requires: cip.exists ? [] : [`project:${CI_PROJECT}:create`],
    summary: `${actions.map((x) => `${x.action} ${x.file_path}`).join(', ')} in ${ctx.config.group}/${CI_PROJECT}`,
    apply: () => send(ctx, 'POST', `/projects/${ctx.projectIdOf(CI_PROJECT)}/repository/commits`, {
      branch: MAIN_BRANCH, commit_message: `vitana-eng: sync ${actions.map((x) => x.file_path).join(', ')} from infra/gitlab-engineering/ci (gitlab-settings)`, actions,
    }),
  });
}

async function applyProtection(ctx, name, want, observed) {
  const id = ctx.projectIdOf(name);
  const base = `/projects/${id}/protected_branches`;
  const list = observed ?? await readAll(ctx, base); // a project created in this run is read back: GitLab protects its default branch by instance defaults
  const cur = list.find((b) => b.name === MAIN_BRANCH);
  const body = { name: MAIN_BRANCH, push_access_level: want.push, merge_access_level: want.merge, allow_force_push: want.forcePush };
  if (!cur) { await send(ctx, 'POST', base, body); return; }
  if (onlyLevel(cur.push_access_levels, want.push) && onlyLevel(cur.merge_access_levels, want.merge)) {
    if (cur.allow_force_push !== want.forcePush) await send(ctx, 'PATCH', `${base}/${MAIN_BRANCH}`, { allow_force_push: want.forcePush });
    return;
  }
  // On the Free tier a protected branch's access levels can only be set when it is created, so: remove, then protect again at once.
  await send(ctx, 'DELETE', `${base}/${MAIN_BRANCH}`);
  try {
    await send(ctx, 'POST', base, body);
  } catch (first) {
    ctx.log({ event: 'protection_retry', project: name, error: ctx.redactor(oneLine(first.message)) });
    try {
      await send(ctx, 'POST', base, body);
    } catch (second) {
      ctx.log({ event: 'unprotected', project: name });
      throw new Error(`${MAIN_BRANCH} of ${name} is UNPROTECTED until the next run protects it again: ${oneLine(second.message, 160)}`);
    }
  }
}

function hookDrift(h, body) {
  const why = [];
  if (h.url !== body.url) why.push('url');
  if (HOOK_FLAGS.some((f) => Boolean(h[f]) !== body[f])) why.push('events');
  if (h.enable_ssl_verification !== true) why.push('ssl verification');
  if (h.signing_token_present !== true) why.push('signing token missing');
  if (h.description !== body.description) why.push('description / signing token fingerprint');
  return why;
}

function planProjects(ctx, S, plan) {
  const { config: cfg } = ctx;
  for (const [name, p] of Object.entries(cfg.projects)) {
    const P = S.projects.get(name);
    const prof = PROFILES[p.profile];
    const area = `project ${name}`;
    const ciPath = ciConfigPath(ctx, S, name, p, plan);
    const createId = `project:${name}:create`;
    if (!P.exists) {
      plan.add({
        id: createId, area, summary: `create ${cfg.group}/${name} (${p.profile}, private)`,
        apply: () => createProject(ctx, name, { initialize_with_readme: p.profile === 'native', ...(ciPath ? { ci_config_path: ciPath } : {}) }),
      });
    } else if (P.obj.default_branch && P.obj.default_branch !== MAIN_BRANCH) {
      plan.finding('warn', area, `the default branch is ${P.obj.default_branch}, not ${MAIN_BRANCH}; the merge bot and the protection work on ${MAIN_BRANCH}`);
    }
    const requires = P.exists ? [] : [createId];

    const want = { ...(P.exists && ciPath ? { ci_config_path: ciPath } : {}), ...(prof.merge ?? {}), ...(p.cutoverPlan ? { allow_merge_on_skipped_pipeline: p.cutoverPlan.allowSkipped } : {}) };
    const body = {};
    for (const [k, v] of Object.entries(want)) if (!P.exists || (k in P.obj && P.obj[k] !== v)) body[k] = v;
    if (Object.keys(body).length) {
      plan.add({ id: `project:${name}:settings`, area, requires, summary: `set ${Object.entries(body).map(([k, v]) => `${k} = ${v}`).join(', ')}`, apply: () => send(ctx, 'PUT', `/projects/${ctx.projectIdOf(name)}`, body) });
    }

    const pr = prof.protect;
    const cur = P.exists ? P.branches.find((b) => b.name === MAIN_BRANCH) : null;
    const why = [];
    if (!P.exists) why.push('protect main as part of the new project');
    else if (!cur) why.push(`${MAIN_BRANCH} is not protected`);
    else {
      if (!onlyLevel(cur.push_access_levels, pr.push)) why.push(`push is ${levelsText(cur.push_access_levels)}, should be ${levelName(pr.push)}`);
      if (!onlyLevel(cur.merge_access_levels, pr.merge)) why.push(`merge is ${levelsText(cur.merge_access_levels)}, should be ${levelName(pr.merge)}`);
      if (cur.allow_force_push !== pr.forcePush) why.push(`force push is ${cur.allow_force_push ? 'allowed' : 'off'}, should be ${pr.forcePush ? 'allowed' : 'off'}`);
    }
    if (why.length) {
      plan.add({ id: `project:${name}:protection`, area, gate: true, requires, summary: `protected branch ${MAIN_BRANCH}: ${why.join('; ')}`, apply: () => applyProtection(ctx, name, pr, P.exists ? P.branches : null) });
    }

    const mine = (P.exists ? P.hooks : []).find((h) => h.name === WEBHOOK_NAME);
    const hookId = `project:${name}:hook`;
    if (p.webhook) {
      const signing = S.webhookSecret;
      if (!signing || !SIGNING_OK.test(signing)) {
        plan.finding('warn', area, `webhook not written: the signing token in ${SECRETS.webhook} is ${signing ? 'not a whsec_ value of 32 bytes' : 'empty'}`);
      } else {
        const flags = Object.fromEntries(HOOK_FLAGS.map((f) => [f, false]));
        for (const e of p.webhook.events) flags[CUTOVER_WEBHOOK_EVENTS[e]] = true;
        const hook = { url: p.webhook.url, name: WEBHOOK_NAME, description: `Managed by gitlab-settings; signing token fingerprint ${sha12(signing)}`, enable_ssl_verification: true, signing_token: signing, ...flags };
        if (!mine) {
          plan.add({ id: hookId, area, requires, summary: `add the webhook ${p.webhook.url} (${p.webhook.events.join(', ')})`, apply: () => send(ctx, 'POST', `/projects/${ctx.projectIdOf(name)}/hooks`, hook) });
        } else {
          const drift = hookDrift(mine, hook);
          if (drift.length) plan.add({ id: hookId, area, summary: `webhook ${mine.url}: ${drift.join(', ')}`, apply: () => send(ctx, 'PUT', `/projects/${ctx.projectIdOf(name)}/hooks/${mine.id}`, hook) });
        }
      }
    } else if (mine) {
      plan.add({ id: hookId, area, summary: `remove the webhook ${mine.url}: the file has none`, apply: () => ctx.client.raw('DELETE', `/projects/${ctx.projectIdOf(name)}/hooks/${mine.id}`, { okStatuses: [404], retries: 0 }) });
    }
  }
}

function planMembers(ctx, S, plan) {
  const { config: cfg } = ctx;
  const managed = new Set(cfg.accounts.map((a) => a.username));
  for (const name of [CI_PROJECT, ...Object.keys(cfg.projects)]) {
    const P = S.projects.get(name);
    const area = name === CI_PROJECT ? `project ${CI_PROJECT} (read access for pipelines)` : `project ${name}`;
    const desired = new Map();
    for (const a of cfg.accounts) {
      if (name === CI_PROJECT) { if (a.role !== 'reporter') desired.set(a.username, CI_READER_LEVEL); } else if (a.projects.includes(name)) desired.set(a.username, ROLES[a.role]);
    }
    const direct = new Map((P.exists ? P.members : []).map((m) => [m.username, m]));
    for (const [u, level] of desired) {
      const cur = direct.get(u);
      const requires = [...(P.exists ? [] : [`project:${name}:create`]), ...(plan.has(`account:${u}`) ? [`account:${u}`] : [])];
      if (!cur) {
        plan.add({ id: `member:${name}:${u}`, area, gate: true, requires, summary: `add ${u} as ${levelName(level)}`, apply: () => send(ctx, 'POST', `/projects/${ctx.projectIdOf(name)}/members`, { user_id: ctx.userId(u), access_level: level }) });
      } else if (cur.access_level !== level) {
        plan.add({ id: `member:${name}:${u}`, area, gate: true, requires, summary: `${u} is ${levelName(cur.access_level)}, should be ${levelName(level)}`, apply: () => send(ctx, 'PUT', `/projects/${ctx.projectIdOf(name)}/members/${cur.id}`, { access_level: level }) });
      }
    }
    for (const [u, m] of direct) {
      if (!managed.has(u) || desired.has(u)) continue;
      plan.add({ id: `member:${name}:${u}`, area, gate: true, summary: `remove ${u} (${levelName(m.access_level)}): the file does not list it here`, apply: () => ctx.client.raw('DELETE', `/projects/${ctx.projectIdOf(name)}/members/${m.id}`, { okStatuses: [404], retries: 0 }) });
    }
  }
  const allowedMaintainers = new Set([...cfg.owners, ...cfg.accounts.filter((a) => a.role === 'maintainer').map((a) => a.username)]);
  const warnedOwners = new Set();
  for (const [name, p] of Object.entries(cfg.projects)) {
    const P = S.projects.get(name);
    if (!P.exists) continue;
    const effective = new Map(P.membersAll.map((m) => [m.username, m.access_level]));
    const direct = new Map(P.members.map((m) => [m.username, m]));
    for (const o of cfg.owners) {
      if ((effective.get(o) ?? 0) >= ROLES.maintainer) continue;
      const user = S.ownerUsers.get(o);
      if (!user) {
        if (!warnedOwners.has(o)) plan.finding('warn', 'owners', `the owner ${o} has no GitLab account yet, so it cannot be made Maintainer; create the account or correct "owners"`);
        warnedOwners.add(o);
        continue;
      }
      const cur = direct.get(o);
      plan.add({
        id: `member:${name}:${o}`, area: `project ${name}`, gate: true,
        summary: cur ? `${o} (owner) is ${levelName(cur.access_level)}, should be Maintainer` : `add ${o} (owner) as Maintainer`,
        apply: () => (cur ? send(ctx, 'PUT', `/projects/${ctx.projectIdOf(name)}/members/${cur.id}`, { access_level: ROLES.maintainer }) : send(ctx, 'POST', `/projects/${ctx.projectIdOf(name)}/members`, { user_id: user.id, access_level: ROLES.maintainer })),
      });
    }
    if (p.profile !== 'native') continue;
    for (const m of P.membersAll) {
      if (plan.has(`member:${name}:${m.username}`) && p.cutoverPlan?.mirrorUser?.username === m.username) continue; // this run lowers the milestone-1 mirror user itself
      if (m.access_level >= ROLES.maintainer && !allowedMaintainers.has(m.username)) {
        plan.finding('drift', `project ${name}`, `@${m.username} is ${levelName(m.access_level)}, but only ${[...allowedMaintainers].join(', ')} may hold that role here; the sync does not change people: add them to "owners" or lower the role in GitLab`);
      }
    }
  }
}

// ── the delivery cutover: the CI variable, the push mirror, the extra protected branches, the milestone-1 mirror user ───────────
/** The path of a GitHub mirror target as GitLab returns it (credentials are masked), or null when the target is not on github.com. */
const mirrorPath = (m) => { try { const u = new URL(m.url); return u.hostname === 'github.com' ? u.pathname : null; } catch { return null; } };

/** Free tier: the access levels of a protected branch can only be set when it is created, so a changed rule is removed and protected again. */
async function applyExtraProtection(ctx, project, want, cur) {
  const base = `/projects/${ctx.projectIdOf(project)}/protected_branches`;
  const body = { name: want.name, push_access_level: want.push, merge_access_level: want.merge, allow_force_push: false };
  if (cur) await send(ctx, 'DELETE', `${base}/${encodeURIComponent(want.name)}`);
  try {
    await send(ctx, 'POST', base, body);
  } catch (first) {
    ctx.log({ event: 'protection_retry', project, branch: want.name, error: ctx.redactor(oneLine(first.message)) });
    await send(ctx, 'POST', base, body);
  }
}

function planCutover(ctx, S, plan) {
  for (const [name, p] of Object.entries(ctx.config.projects)) {
    const c = p.cutoverPlan;
    if (!c) continue;
    const P = S.projects.get(name);
    if (!P.exists) continue; // the project is created above (milestone 2); the next run applies the cutover to it
    const area = `project ${name} (delivery ${p.cutoverState})`;
    const pid = () => ctx.projectIdOf(name);

    const cur = P.variables.find((v) => v.key === CUTOVER.variable && (v.environment_scope ?? '*') === '*');
    if (!cur) {
      plan.add({ id: `project:${name}:variable`, area, summary: `set the CI variable ${CUTOVER.variable} = ${c.mode}`, apply: () => send(ctx, 'POST', `/projects/${pid()}/variables`, { key: CUTOVER.variable, value: c.mode, protected: false, masked: false }) });
    } else if (cur.value !== c.mode || cur.protected === true || cur.masked === true) {
      plan.add({ id: `project:${name}:variable`, area, summary: `the CI variable ${CUTOVER.variable} is ${oneLine(cur.value, 20)}${cur.protected ? ' (protected)' : ''}${cur.masked ? ' (masked)' : ''}, should be ${c.mode}`, apply: () => send(ctx, 'PUT', `/projects/${pid()}/variables/${CUTOVER.variable}`, { value: c.mode, protected: false, masked: false }) });
    }

    const target = `/${c.github}.git`;
    const mine = P.mirrors.filter((m) => mirrorPath(m) === target);
    const removeMirror = (m) => plan.add({ id: `project:${name}:mirror:${m.id}:remove`, area, summary: `remove the push mirror to github.com${target}${c.pushMirror ? ': a second one' : ': the project is not live'}`, apply: () => ctx.client.raw('DELETE', `/projects/${pid()}/remote_mirrors/${m.id}`, { okStatuses: [404], retries: 0 }) });
    if (!c.pushMirror) {
      for (const m of mine) removeMirror(m);
    } else {
      const flags = { enabled: true, only_protected_branches: c.pushMirror.only_protected_branches, keep_divergent_refs: c.pushMirror.keep_divergent_refs };
      const tok = S.pushMirrorTokens.get(name);
      if (tok && tok.mode !== undefined && tok.mode !== 0o600) plan.finding('warn', area, `${c.pushMirror.token_file} has mode ${tok.mode.toString(8)}, expected 600`);
      if (mine.length === 0) {
        if (!tok) plan.finding('drift', area, `the push mirror to github.com${target} cannot be created: ${c.pushMirror.token_file} is missing or does not hold a token`);
        else plan.add({ id: `project:${name}:mirror`, area, summary: `create the push mirror to github.com${target} (protected branches only, divergent refs kept; token from ${c.pushMirror.token_file})`, apply: () => send(ctx, 'POST', `/projects/${pid()}/remote_mirrors`, { url: `https://x-access-token:${tok.token}@github.com${target}`, auth_method: 'password', ...flags }) });
      } else {
        const [first, ...extra] = mine;
        for (const m of extra) removeMirror(m);
        const why = [];
        if (first.enabled !== true) why.push('it is disabled');
        if (first.only_protected_branches !== flags.only_protected_branches) why.push('it does not mirror protected branches only');
        if (first.keep_divergent_refs !== flags.keep_divergent_refs) why.push('it does not keep divergent refs');
        if (why.length) plan.add({ id: `project:${name}:mirror`, area, summary: `the push mirror to github.com${target}: ${why.join('; ')}`, apply: () => send(ctx, 'PUT', `/projects/${pid()}/remote_mirrors/${first.id}`, flags) });
        if (first.last_error) plan.finding('warn', area, `the push mirror to github.com${target} reports an error: ${oneLine(first.last_error, 160)}`);
      }
    }

    for (const b of c.managedBranches) {
      const have = P.branches.find((x) => x.name === b.name);
      const id = `project:${name}:branch:${b.name}`;
      if (!c.wantBranches.some((w) => w.name === b.name)) {
        if (have) plan.add({ id, area, summary: `remove the protected branch rule ${b.name}: the project is not live`, apply: () => ctx.client.raw('DELETE', `/projects/${pid()}/protected_branches/${encodeURIComponent(b.name)}`, { okStatuses: [404], retries: 0 }) });
        continue;
      }
      const why = [];
      if (!have) why.push(`${b.name} is not protected`);
      else {
        if (!onlyLevel(have.push_access_levels, b.push)) why.push(`push is ${levelsText(have.push_access_levels)}, should be ${levelName(b.push)}`);
        if (!onlyLevel(have.merge_access_levels, b.merge)) why.push(`merge is ${levelsText(have.merge_access_levels)}, should be ${levelName(b.merge)}`);
        if (have.allow_force_push !== false) why.push('force push is allowed, should be off');
      }
      if (why.length) plan.add({ id, area, gate: true, summary: `protected branch ${b.name}: ${why.join('; ')}`, apply: () => applyExtraProtection(ctx, name, b, have) });
    }

    if (c.mirrorUser) {
      const m = P.members.find((x) => x.username === c.mirrorUser.username);
      const level = ROLES[c.mirrorUser.role];
      if (m && m.access_level !== level) {
        plan.add({ id: `member:${name}:${m.username}`, area, gate: true, summary: `${m.username} (the milestone-1 mirror user) is ${levelName(m.access_level)}, should be ${levelName(level)}`, apply: () => send(ctx, 'PUT', `/projects/${pid()}/members/${m.id}`, { access_level: level }) });
      }
    }
  }
}

function planCutoverNotes(ctx, plan) {
  const m = ctx.marker;
  if (m?.problem) plan.finding('warn', 'delivery cutover', m.problem);
  if (!m?.present) return;
  for (const [name, p] of Object.entries(ctx.config.projects)) {
    if (p.cutover && p.cutoverState === 'inactive') plan.finding('drift', `project ${name}`, `the cutover marker (${m.mode}) is set, but ${p.cutover.ci_file} is not in the CI folder, so the project stays as it is; the generated pipeline file must reach this checkout first`);
  }
}

function planFleetRunner(ctx, S, plan) {
  const F = ctx.config.runners.fleet;
  const r = S.runners.get(F.description);
  const want = { tag_list: F.tags.join(','), run_untagged: false, locked: false, access_level: 'not_protected', paused: false };
  if (!r) {
    plan.add({
      id: 'runner:fleet:create', area: 'fleet runner', gate: true, summary: `create the instance runner ${F.description} (tags ${F.tags.join(', ')}) and store its token in ${SECRETS.fleet}`,
      apply: async () => {
        const res = await send(ctx, 'POST', '/user/runners', { runner_type: 'instance_type', description: F.description, ...want });
        ctx.redactor.add(res?.token);
        await ctx.secrets.put(SECRETS.fleet, res.token);
      },
    });
    return;
  }
  const d = S.runnerDetail.get(F.description);
  const body = {};
  if (!sameSet(d.tag_list ?? [], F.tags)) body.tag_list = want.tag_list;
  for (const k of ['run_untagged', 'locked', 'access_level']) if (d[k] !== want[k]) body[k] = want[k];
  if (Boolean(d.paused) !== want.paused) body.paused = want.paused;
  if (Object.keys(body).length) plan.add({ id: 'runner:fleet:update', area: 'fleet runner', gate: true, summary: `${F.description}: ${Object.entries(body).map(([k, v]) => `${k} = ${v}`).join(', ')}`, apply: () => send(ctx, 'PUT', `/runners/${r.id}`, body) });
  if (!S.fleetSecret || !GLRT.test(S.fleetSecret)) {
    plan.add({
      id: 'runner:fleet:token', area: 'fleet runner', summary: `${SECRETS.fleet} holds no runner token: reset the token of ${F.description} and store the new one`,
      apply: async () => {
        const res = await send(ctx, 'POST', `/runners/${r.id}/reset_authentication_token`);
        ctx.redactor.add(res?.token);
        await ctx.secrets.put(SECRETS.fleet, res.token);
      },
    });
  }
}

function planTokens(ctx, S, plan) {
  const { config: cfg } = ctx;
  const protections = plan.changes.filter((c) => /^project:[^:]+:protection$/.test(c.id)).map((c) => c.id);
  for (const a of cfg.accounts) {
    const T = S.tokens.get(a.username);
    const requires = [
      ...(plan.has(`account:${a.username}`) ? [`account:${a.username}`] : []),
      ...(plan.has('runner:legacy:update') ? ['runner:legacy:update'] : []),
      ...protections,
      ...plan.changes.filter((c) => c.id.startsWith('member:') && c.id.endsWith(`:${a.username}`)).map((c) => c.id),
    ];
    const t = T.sa
      ? planToken({ active: T.active, secret: T.self, want: a.scopes, nowMs: ctx.nowMs, lifetimeDays: cfg.tokens.lifetime_days, rotateBelowDays: cfg.tokens.rotate_below_days })
      : { action: 'create', reason: 'the account is new', revoke: [] };
    if (t.action === 'none' && t.revoke.length === 0) {
      if (a.token_file && (!T.file || T.file.text.trim() !== T.secret || T.file.mode !== 0o600)) {
        plan.add({ id: `file:${a.token_file}`, area: `token of ${a.username}`, summary: `${a.token_file} is ${T.file ? 'out of date or not mode 600' : 'missing'}`, apply: () => ctx.deps.fs.writeAtomic(a.token_file, `${T.secret}\n`, { mode: 0o600 }) });
      }
      continue;
    }
    plan.add({
      id: `token:${a.username}`, area: `token of ${a.username}`, gate: false, requires,
      summary: t.action === 'none' ? `revoke ${t.revoke.length} stray token(s)` : `${t.action}: ${t.reason}${t.revoke.length ? `; revoke ${t.revoke.length} other token(s)` : ''}`,
      apply: () => issueToken(ctx, a, t),
    });
  }
}

function planNotes(ctx, plan) {
  let host = '';
  try { host = new URL(ctx.config.gitlab_url).hostname; } catch { /* validated */ }
  const domain = String(ctx.deps.env?.DOMAIN ?? '').trim();
  if (domain && host && domain !== host) plan.finding('warn', 'settings file', `gitlab_url names ${host}, but this host's DOMAIN is ${domain}`);
}

// ── appliers that need more than one call ────────────────────────────────────────────────────────────────────────────────────
async function rotateAdminToken(ctx, meta) {
  const file = ctx.adminTokenFile;
  try { await ctx.deps.fs.preflight(file); } catch (e) {
    throw new Error(`${file} cannot be written (${e?.code ?? oneLine(e?.message, 80)}), so the admin token is not rotated: the new token would have nowhere to go`);
  }
  const cur = await ctx.client.get(`/personal_access_tokens/${meta.id}`); // rotating a token that is already revoked would revoke its whole family
  if (!cur || cur.active !== true) throw new Error('the admin token is no longer active; not rotating it');
  const res = await send(ctx, 'POST', `/personal_access_tokens/${meta.id}/rotate`, { expires_at: plusDays(ctx.nowMs, ctx.config.tokens.lifetime_days) });
  const token = res?.token;
  if (typeof token !== 'string' || !TOKEN_OK.test(token)) throw new Error('GitLab rotated the admin token but returned no usable token; mint a new one with m2.sh install');
  ctx.redactor.add(token);
  try { await ctx.deps.fs.writeAtomic(file, `${token}\n`, { mode: 0o600 }); } catch (e) {
    throw new Error(`the admin token was rotated, but the new one could not be written to ${file} (${e?.code ?? oneLine(e?.message, 80)}); mint a new admin token with m2.sh install`);
  }
  ctx.useToken(token);
  const me = await ctx.client.get('/personal_access_tokens/self');
  ctx.log({ event: 'admin_token_rotated', id: me?.id, expires_at: me?.expires_at });
}

async function issueToken(ctx, acc, t) {
  const expires = plusDays(ctx.nowMs, ctx.config.tokens.lifetime_days);
  if (t.action !== 'none') {
    let res;
    if (t.action === 'rotate') {
      const cur = await ctx.client.get(`/personal_access_tokens/${t.primary.id}`);
      if (!cur || cur.active !== true) throw new Error(`the token ${t.primary.id} of ${acc.username} is no longer active; the next run decides again`);
      res = await send(ctx, 'POST', `/personal_access_tokens/${t.primary.id}/rotate`, { expires_at: expires });
    } else {
      res = await send(ctx, 'POST', `/users/${ctx.userId(acc.username)}/personal_access_tokens`, { name: TOKEN_NAME, scopes: acc.scopes, expires_at: expires });
    }
    const value = res?.token;
    if (typeof value !== 'string' || !TOKEN_OK.test(value)) throw new Error(`GitLab returned no usable token for ${acc.username}`);
    ctx.redactor.add(value);
    await ctx.secrets.put(SECRETS.agent(acc.username), value);
    if (acc.token_file) await ctx.deps.fs.writeAtomic(acc.token_file, `${value}\n`, { mode: 0o600 });
    if (t.action === 'replace') await ctx.client.raw('DELETE', `/personal_access_tokens/${t.primary.id}`, { okStatuses: [404], retries: 0 });
  }
  for (const r of t.revoke) await ctx.client.raw('DELETE', `/personal_access_tokens/${r.id}`, { okStatuses: [404], retries: 0 });
}

// ── executing the plan ───────────────────────────────────────────────────────────────────────────────────────────────────────
const isInfraError = (e) => e instanceof GitLabApiError && (e.code === 'network' || e.code === 'timeout' || e.status >= 500);

/**
 * One change at a time, in plan order. A failed change holds back only the changes that require it (a failed legacy retag, a failed
 * protection or a failed membership keeps the tokens back). A network error, or three server errors in a row, ends the run: the
 * next ones would fail the same way and the next run starts from a fresh read anyway.
 */
async function execute(ctx, plan) {
  const applied = [];
  const failed = [];
  const skipped = [];
  const held = new Set();
  let infraInARow = 0;
  let aborted = false;
  for (const ch of plan.changes) {
    const blockers = ch.requires.filter((id) => held.has(id));
    if (blockers.length) {
      held.add(ch.id);
      skipped.push({ id: ch.id, because: blockers.join(', ') });
      ctx.log({ event: 'change_skipped', id: ch.id, because: blockers.join(', ') });
      continue;
    }
    try {
      await ch.apply();
      applied.push(ch.id);
      infraInARow = 0;
      ctx.log({ event: 'applied', id: ch.id, summary: ch.summary });
    } catch (e) {
      held.add(ch.id);
      const error = ctx.redactor(oneLine(e?.message ?? e));
      failed.push({ id: ch.id, error });
      ctx.log({ event: 'change_failed', id: ch.id, error });
      if (isInfraError(e)) {
        infraInARow += 1;
        if (e.code === 'network' || e.code === 'timeout' || infraInARow >= 3) {
          aborted = true;
          ctx.log({ event: 'run_aborted', reason: e.code === 'network' || e.code === 'timeout' ? 'GitLab could not be reached' : 'three server errors in a row' });
          break;
        }
      } else {
        infraInARow = 0;
      }
    }
  }
  return { applied, failed, skipped, aborted };
}

const hasLicence = (d) => (Array.isArray(d) ? d.length > 0 : isObj(d) && ['id', 'plan', 'starts_at', 'expires_at'].some((k) => d[k] !== undefined && d[k] !== null));

const USAGE = `usage: gitlab-settings.mjs [apply|check] [--config FILE] [--ci-dir DIR] [--url URL] [--admin-token-file FILE] [--marker-file FILE] [--dry-run]
  apply (default) corrects GitLab to match the settings file; check (or --check) writes nothing and exits 3 on drift.
  --marker-file is the delivery cutover marker (default ${CUTOVER.markerFile}): without it a project with a cutover block runs the shadow pipelines.
  exit: 0 done / no drift, 1 error, 2 usage mistake, 3 drift. REGION (and DOMAIN) come from /etc/vitana/env.`;

/** The whole run. Returns { exitCode, licence, drift, findings, applied, failed, skipped, aborted }; prints JSON log lines and drift lines. */
export async function run(opts, depsIn = {}) {
  const deps = { ...defaultDeps(depsIn.env ?? process.env), ...depsIn };
  const redactor = makeRedactor();
  const out = (line) => deps.stdout(redactor(String(line)));
  const log = (event) => out(JSON.stringify({ ts: new Date(deps.now()).toISOString(), ...event }));
  const command = opts.command ?? 'apply';
  const result = { exitCode: 1, command, licence: false, drift: [], findings: [], applied: [], failed: [], skipped: [], aborted: false };
  const stop = (code, message, event) => { out(`gitlab-settings: ${message}`); if (event) log(event); result.exitCode = code; return result; };

  if (command !== 'apply' && command !== 'check') return stop(2, `unknown command ${JSON.stringify(command)}`);
  const region = String(deps.env?.REGION ?? '');
  if (!REGION_OK.test(region)) return stop(2, 'REGION is not set to an AWS region (for example eu-central-1); the systemd unit loads /etc/vitana/env');

  const configFile = opts.configFile ?? defaultConfigPath();
  const cf = await deps.fs.readFile(configFile).catch(() => null);
  if (!cf) return stop(1, `the settings file ${configFile} cannot be read`);
  let config;
  try {
    config = validateConfig(JSON.parse(cf.text));
  } catch (e) {
    if (e instanceof ConfigError) return stop(1, `${configFile}: ${e.message}`);
    if (e instanceof SyntaxError) return stop(1, `${configFile} is not valid JSON: ${oneLine(e.message, 120)}`);
    throw e;
  }

  const marker = await readMarker(deps.fs, opts.markerFile ?? CUTOVER.markerFile);
  const deliveryFiles = new Set(await deps.fs.listYml(opts.ciDir ?? defaultCiDir()).catch(() => []));
  config = effectiveConfig(config, { marker, deliveryFiles });

  const adminTokenFile = opts.adminTokenFile ?? DEFAULTS.adminTokenFile;
  const af = await deps.fs.readFile(adminTokenFile).catch(() => null);
  if (!af) return stop(1, `the admin token file ${adminTokenFile} cannot be read; ops-install.sh creates it (m2.sh install)`);
  const adminToken = af.text.trim();
  if (!TOKEN_OK.test(adminToken)) return stop(1, `${adminTokenFile} does not hold a token`);
  redactor.add(adminToken);

  const ctx = {
    config, deps, redactor, log, nowMs: deps.now(), region, baseUrl: opts.url ?? DEFAULTS.url, adminTokenFile, ciDir: opts.ciDir ?? defaultCiDir(),
    adminFile: af, ids: { users: new Map(), projects: new Map() }, groupId: null, client: null, marker,
  };
  ctx.secrets = makeSecrets({ aws: deps.aws, region, redactor });
  ctx.userId = (u) => { const id = ctx.ids.users.get(u); if (!id) throw new Error(`there is no GitLab user id for ${u}`); return id; };
  ctx.projectIdOf = (n) => { const id = ctx.ids.projects.get(n); if (!id) throw new Error(`there is no GitLab project id for ${n}`); return id; };
  ctx.useToken = (token) => {
    redactor.add(token);
    ctx.client = createClient({ baseUrl: ctx.baseUrl, token, fetch: deps.fetch, sleep: deps.sleep, now: deps.now, log: (e) => log({ ...e, event: 'gitlab_retry' }) });
  };
  try {
    ctx.useToken(adminToken);
  } catch (e) {
    if (e instanceof GitLabApiError && e.code === 'bad_config') return stop(2, `--url: ${e.message}`);
    throw e;
  }

  log({ event: 'start', command, dryRun: command === 'check' || opts.dryRun === true, gitlab: ctx.baseUrl });
  result.cutover = Object.fromEntries(Object.entries(config.projects).filter(([, p]) => p.cutoverState !== 'inactive').map(([n, p]) => [n, p.cutoverState]));
  if (Object.keys(result.cutover).length) log({ event: 'cutover_state', projects: result.cutover, marker: marker.present ? marker.mode : null });
  let S;
  try {
    const lic = await ctx.client.raw('GET', '/license', { okStatuses: [404] });
    result.licence = lic.status !== 404 && hasLicence(lic.data);
    if (result.licence) {
      const plan = Array.isArray(lic.data) ? lic.data[0]?.plan : lic.data?.plan;
      out(`LICENCE FOUND: this GitLab holds a licence${plan ? ` (plan ${oneLine(plan, 30)})` : ''}. Milestone 2 runs on the Free tier with no licence (plan eng-gitlab-m2 section 2). Nothing was written; remove the licence, then run again.`);
      log({ event: 'licence_found', plan: plan ? oneLine(plan, 30) : null });
      result.exitCode = 1;
      return result;
    }
    log({ event: 'licence_guard', licence: 'none' });
    S = await observe(ctx);
    ctx.groupId = S.groupId;
  } catch (e) {
    const error = oneLine(e?.message ?? e);
    log({ event: 'observe_failed', error, status: e?.status ?? null });
    const hint = e instanceof GitLabApiError && e.status === 401 ? ' (GitLab does not accept the admin token; if it was lost or has expired, m2.sh install mints a new one)' : '';
    return stop(1, `GitLab, Secrets Manager or the files could not be read, so nothing was written: ${error}${hint}`);
  }

  const plan = new Plan();
  planAdminToken(ctx, S, plan);
  planLegacyRunner(ctx, S, plan);
  planAccounts(ctx, S, plan);
  planCentralCi(ctx, S, plan);
  planProjects(ctx, S, plan);
  planCutover(ctx, S, plan);
  planMembers(ctx, S, plan);
  planFleetRunner(ctx, S, plan);
  planTokens(ctx, S, plan);
  planNotes(ctx, plan);
  planCutoverNotes(ctx, plan);

  for (const ch of plan.changes) {
    result.drift.push({ id: ch.id, area: ch.area, summary: ch.summary });
    out(`drift: ${ch.area}: ${ch.summary}`);
    log({ event: 'drift', id: ch.id, area: ch.area, summary: ch.summary });
  }
  for (const f of plan.findings) {
    result.findings.push(f);
    out(`${f.level === 'drift' ? 'drift' : 'warning'}: ${f.area}: ${f.message}`);
    log({ event: 'finding', level: f.level, area: f.area, message: f.message });
  }
  const driftCount = plan.changes.length + plan.findings.filter((f) => f.level === 'drift').length;
  const warnCount = plan.findings.filter((f) => f.level === 'warn').length;
  log({ event: 'observed', changes: plan.changes.length, findings: plan.findings.length });

  if (command === 'check') {
    out(`settings check: ${driftCount} drift(s), ${warnCount} warning(s)`);
    result.exitCode = driftCount > 0 ? 3 : 0;
    return result;
  }
  if (opts.dryRun === true) {
    for (const ch of plan.changes) out(`would apply ${ch.id}: ${ch.summary}`);
    out(`settings apply --dry-run: ${plan.changes.length} change(s) would be made, nothing was written`);
    result.exitCode = 0;
    return result;
  }
  const done = await execute(ctx, plan);
  Object.assign(result, done);
  result.exitCode = done.failed.length > 0 || done.aborted ? 1 : 0;
  out(`settings apply: ${done.applied.length} applied, ${done.failed.length} failed, ${done.skipped.length} skipped${done.aborted ? ' (run aborted)' : ''}`);
  log({ event: 'done', exit: result.exitCode, applied: done.applied.length, failed: done.failed.length, skipped: done.skipped.length });
  return result;
}

// ── command line ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function parseArgs(argv) {
  const o = { command: null, dryRun: false, help: false };
  const valueFlags = { '--config': 'configFile', '--ci-dir': 'ciDir', '--url': 'url', '--admin-token-file': 'adminTokenFile', '--marker-file': 'markerFile' };
  const setCommand = (c) => { if (o.command && o.command !== c) throw new UsageError('give one command: apply or check'); o.command = c; };
  const args = [...argv];
  while (args.length > 0) {
    let a = args.shift();
    let inline;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--dry-run' || a === '--check') {
      if (inline !== undefined) throw new UsageError(`${a} takes no value`);
      if (a === '--check') setCommand('check'); else o.dryRun = true;
      continue;
    }
    if (Object.hasOwn(valueFlags, a)) {
      const v = inline ?? args.shift();
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      o[valueFlags[a]] = v;
      continue;
    }
    if (a === 'apply' || a === 'check') { setCommand(a); continue; }
    throw new UsageError(a.startsWith('-') ? `unknown option ${oneLine(a, 40)}` : `unknown command ${oneLine(a, 40)}`);
  }
  o.command ??= 'apply';
  return o;
}

/** Exit codes: 0 done / no drift, 1 error, 2 usage mistake, 3 drift (check). */
export async function main(argv, depsIn = {}) {
  const deps = { ...defaultDeps(depsIn.env ?? process.env), ...depsIn };
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    deps.stdout(`gitlab-settings: ${e.message}`);
    deps.stdout(USAGE);
    return 2;
  }
  if (o.help) { deps.stdout(USAGE); return 0; }
  return (await run(o, deps)).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const finish = (code) => process.stdout.write('', () => process.exit(code)); // drop any timer a hung request left behind
  main(process.argv.slice(2)).then(finish, (err) => {
    process.stderr.write(`gitlab-settings: unexpected error: ${oneLine(redact(err?.message, null))}\n`, () => process.exit(1));
  });
}
