// VTID-05546 — shared pieces of the GitLab deploy path (plan agentic-delivery §3.6 step 2, §3.7, §3.8, §3.10, §7).
// Dependency-free Node 20 ESM. Every AWS CLI and registry CLI call goes through an injectable runner, so the tests
// need no network and no AWS: `run(cmd, args, { input }) → { code, stdout, stderr }`.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const ACCOUNT = '472838866351';
export const REGION = 'eu-central-1';
export const CLUSTER = 'Vitana-ECS-Cluster';
export const REGISTRY = `${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com`;
export const PREVIEW_BUCKET = 'vitana-pr-previews';

// Plan §3.10: the only staging targets a GitLab deploy-class job may touch. Anything else is refused before the
// first AWS call. `stamp` says how the served commit is read: `gateway` (build-info, env=staging), `frontend` (the
// vitana-app-version meta tag), or null (the live task definition's commit variable; these services publish no stamp).
// `commitVars` are always written with the commit; `commitVarsIfPresent` only when the live definition has them.
export const STAGING_TARGETS = Object.freeze({
  'community-app': Object.freeze({
    project: 'vitana/vitana-v1', role: 'gl-v1-staging', ecrRepository: 'vitana/community-app',
    ecsService: 'vitana-community-app-staging', family: 'vitana-community-app', stamp: 'frontend',
    commitVars: [], commitVarsIfPresent: ['GIT_COMMIT_SHA', 'COMMIT_SHA'],
  }),
  gateway: Object.freeze({
    project: 'vitana/vitana-platform', role: 'gl-platform-staging', ecrRepository: 'vitana/gateway',
    ecsService: 'vitana-gateway', family: null, stamp: 'gateway',
    commitVars: ['GIT_COMMIT_SHA', 'COMMIT_SHA', 'BUILD_INFO_MARKER'], commitVarsIfPresent: [],
  }),
  'erp-bridge': Object.freeze({
    project: 'vitana/vitana-platform', role: 'gl-platform-staging', ecrRepository: 'vitana/erp-bridge',
    ecsService: 'vitana-erp-bridge', family: null, stamp: null,
    commitVars: [], commitVarsIfPresent: ['GIT_COMMIT_SHA', 'COMMIT_SHA', 'BUILD_INFO_MARKER'],
  }),
  'kiro-runner': Object.freeze({
    project: 'vitana/vitana-platform', role: 'gl-platform-staging', ecrRepository: 'vitana/kiro-runner',
    ecsService: 'vitana-kiro-runner', family: null, stamp: null,
    commitVars: [], commitVarsIfPresent: ['GIT_COMMIT_SHA', 'COMMIT_SHA', 'BUILD_INFO_MARKER'],
  }),
  'postgrest-aurora-proxy': Object.freeze({
    project: 'vitana/vitana-platform', role: 'gl-platform-staging', ecrRepository: 'vitana/postgrest-aurora-proxy',
    ecsService: 'vitana-postgrest-aurora-proxy', family: null, stamp: null,
    commitVars: [], commitVarsIfPresent: ['GIT_COMMIT_SHA', 'COMMIT_SHA', 'BUILD_INFO_MARKER'],
  }),
});

export const STAMP_URLS = Object.freeze({
  gateway: 'https://preview-aws-gateway.vitanaland.com/api/v1/admin/build-info',
  frontend: 'https://preview-aws.vitanaland.com/',
});

export class DeployError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export function target(service) {
  const t = Object.prototype.hasOwnProperty.call(STAGING_TARGETS, service) ? STAGING_TARGETS[service] : null;
  if (!t) {
    throw new DeployError(`service '${service}' is outside the staging allowlist of plan §3.10 (${Object.keys(STAGING_TARGETS).join(', ')}): refused`, 2);
  }
  return t;
}

export function isFullSha(sha) {
  return typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha);
}

export function defaultRunner(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input: opts.input, maxBuffer: 64 * 1024 * 1024, env: opts.env || process.env });
  if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message || r.error) };
  return { code: r.status === null ? 1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// One AWS CLI call. JSON output is parsed; a failure throws with the CLI's first error line.
export function aws(run, args, { json = true, input } = {}) {
  const full = [...args, '--region', REGION];
  if (json) full.push('--output', 'json');
  const r = run('aws', full, { input });
  if (r.code !== 0) {
    const line = String(r.stderr || r.stdout || '').trim().split('\n').filter(Boolean).pop() || `exit ${r.code}`;
    const err = new DeployError(`aws ${args.slice(0, 2).join(' ')} failed: ${line}`);
    err.awsArgs = args;
    throw err;
  }
  if (!json) return r.stdout;
  const text = String(r.stdout || '').trim();
  return text ? JSON.parse(text) : {};
}

// The job's AWS identity, checked before any other call. A missing role or a trust mismatch fails here and names
// the role, so a red job says what the owner has to apply (scripts/aws/setup-gitlab-oidc.sh, owner step A1).
export function assertIdentity(run, roleName) {
  let id;
  try {
    id = aws(run, ['sts', 'get-caller-identity']);
  } catch (e) {
    throw new DeployError(`could not sign in as role ${roleName} (arn:aws:iam::${ACCOUNT}:role/${roleName}): ${e.message}. The role is missing or its trust does not match this job; the owner applies it with scripts/aws/setup-gitlab-oidc.sh --apply (A1).`, 4);
  }
  if (id.Account !== ACCOUNT) {
    throw new DeployError(`signed in to account ${id.Account || '<unknown>'}, expected ${ACCOUNT}: refused`, 4);
  }
  return id;
}

export function readJson(file, fallback = undefined) {
  if (!file || !existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new DeployError(`file not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

// The deploy-runs file lane verify-on-gitlab reads (`run.mjs --deploy-runs-file`, VTID-05552):
// [{ "service", "sha", "started_at", "finished_at", "outcome" }]. One entry per deploy of a service; a later write
// for the same service and sha replaces that entry. Outcomes: success | failed | rolled_back | superseded | skipped
// (skipped = shadow mode, nothing deployed; the reader ignores it, as it ignores a skipped GitHub run).
export const DEPLOY_OUTCOMES = Object.freeze(['success', 'failed', 'rolled_back', 'superseded', 'skipped']);

export function writeDeployRun(file, entry) {
  if (!DEPLOY_OUTCOMES.includes(entry.outcome)) throw new DeployError(`unknown deploy outcome ${entry.outcome}`);
  const row = {
    service: entry.service,
    sha: entry.sha,
    started_at: entry.started_at,
    finished_at: entry.finished_at === undefined ? null : entry.finished_at,
    outcome: entry.outcome,
  };
  let list = [];
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }
  list = list.filter((e) => !(e && e.service === row.service && e.sha === row.sha));
  list.push(row);
  writeJson(file, list);
  return row;
}

// Minimal `--name value` / `--flag` parser.
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

export function nowIso(clock) {
  return new Date(clock ? clock() : Date.now()).toISOString();
}
