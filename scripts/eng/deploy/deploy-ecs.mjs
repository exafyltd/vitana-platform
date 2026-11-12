#!/usr/bin/env node
// VTID-05546 — staging deploy and rollback of one service on ECS (plan agentic-delivery §3.6 step 2, §3.8, §3.10).
//
//   deploy-ecs.mjs deploy   --service <svc> --cluster <c> --ecs-service <s> --push-file push-image.json --sha <sha>
//                           [--mode live|shadow] [--env-overrides '<json>'] [--runs-file deploy-runs.json]
//                           [--state-file deploy-state.json] [--out-dir deploy-out] [--repo-root <dir>]
//   deploy-ecs.mjs rollback --state-file deploy-state.json [--runs-file deploy-runs.json]
//
// deploy: refuses a service outside the plan §3.10 allowlist; checks the job's AWS identity (a missing role fails and
// names it); captures the live task definition and the served commit BEFORE any write; ends `superseded` without any
// ECS write when staging already serves a newer descendant; renders the new definition from the live one, changing
// only the image digest, the commit variables and (live mode only) the service's env_overrides; in shadow mode it
// stops there (the rendered definition and its diff are the artifact, nothing is written to ECS); in live mode it
// registers, updates the service, waits until stable and checks the served build stamp. A stabilise or stamp failure
// re-points the service to the captured revision, waits for the old stamp and ends the job red (`rolled_back`).
// rollback: the `.rollback-staging` job (on failure). Re-points to the captured revision when the deploy job did not
// (a killed or timed-out job); does nothing when nothing was changed or the deploy job already rolled back.
// Both write the deploy-runs file lane verify-on-gitlab reads: [{service, sha, started_at, finished_at, outcome}].
// Exit codes: 0 deployed / superseded / shadow / nothing to roll back; 1 failed or rolled back; 2 refused; 4 identity.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CLUSTER, REGISTRY, STAMP_URLS, DeployError, target, isFullSha, defaultRunner, aws, assertIdentity, readJson,
  writeJson, writeDeployRun, parseArgs, nowIso,
} from './lib.mjs';

const READ_ONLY_FIELDS = ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities',
  'registeredAt', 'registeredBy', 'deregisteredAt'];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/;

export function imageRepository(ref) {
  const noDigest = String(ref || '').split('@')[0];
  const slash = noDigest.lastIndexOf('/');
  const colon = noDigest.lastIndexOf(':');
  return colon > slash ? noDigest.slice(0, colon) : noDigest;
}

export function commitMatches(served, sha) {
  if (!served || !sha) return false;
  return served === sha || (served.length >= 7 && sha.startsWith(served));
}

// The image a deploy may use: the service's own ECR repository, by digest (push-image.json of the push job).
export function imageFromPush(t, service, push) {
  if (!push || push.service !== service) throw new DeployError(`push-image output is for '${push && push.service}', not '${service}': refused`, 2);
  if (push.repository !== t.ecrRepository || push.registry !== REGISTRY) {
    throw new DeployError(`push-image output names ${push.registry}/${push.repository}, outside ${REGISTRY}/${t.ecrRepository}: refused`, 2);
  }
  if (!DIGEST_RE.test(String(push.digest))) throw new DeployError(`push-image output has no image digest: refused`, 2);
  return `${REGISTRY}/${t.ecrRepository}@${push.digest}`;
}

export function parseEnvOverrides(raw) {
  if (raw === undefined || raw === null || raw === '' || raw === true) return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch (e) {
      throw new DeployError(`env overrides are not JSON: ${e.message}`, 2);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new DeployError('env overrides must be a JSON object', 2);
  for (const [k, v] of Object.entries(obj)) {
    if (!ENV_NAME_RE.test(k)) throw new DeployError(`env override name '${k}' is not an environment variable name`, 2);
    if (typeof v !== 'string') throw new DeployError(`env override ${k} must be a string`, 2);
  }
  return obj;
}

// The new definition: the live one, with only the image digest, the commit variables and the env overrides changed.
export function renderTaskDefinition(live, t, { image, sha, envOverrides = null }) {
  const td = JSON.parse(JSON.stringify(live));
  for (const k of READ_ONLY_FIELDS) delete td[k];
  const repo = `${REGISTRY}/${t.ecrRepository}`;
  const containers = Array.isArray(td.containerDefinitions) ? td.containerDefinitions : [];
  const idx = containers.findIndex((c) => imageRepository(c.image) === repo);
  if (idx < 0) throw new DeployError(`no container of task definition ${live.family} runs an image of ${repo}: refused`, 2);
  const c = containers[idx];
  c.image = image;
  const env = Array.isArray(c.environment) ? c.environment.map((e) => ({ ...e })) : [];
  const secretNames = new Set((Array.isArray(c.secrets) ? c.secrets : []).map((s) => s.name));
  const put = (name, value) => {
    const i = env.findIndex((e) => e.name === name);
    if (i >= 0) env[i] = { ...env[i], value };
    else env.push({ name, value });
  };
  const commitValues = { GIT_COMMIT_SHA: sha, COMMIT_SHA: sha, BUILD_INFO_MARKER: sha.slice(0, 12) };
  for (const n of t.commitVars) put(n, commitValues[n]);
  for (const n of t.commitVarsIfPresent) if (env.some((e) => e.name === n)) put(n, commitValues[n]);
  if (envOverrides) {
    for (const [k, v] of Object.entries(envOverrides)) {
      if (secretNames.has(k)) throw new DeployError(`env override ${k} is a secret of the live definition: refused`, 2);
      if (Object.prototype.hasOwnProperty.call(commitValues, k)) throw new DeployError(`env override ${k} is a commit variable: refused`, 2);
      put(k, v);
    }
  }
  c.environment = env;
  return td;
}

// What changed between the live definition and the rendered one, as readable lines (the shadow artifact and the log).
export function diffTaskDefinitions(live, rendered) {
  const lines = [];
  const base = JSON.parse(JSON.stringify(live));
  for (const k of READ_ONLY_FIELDS) delete base[k];
  const keys = new Set([...Object.keys(base), ...Object.keys(rendered)]);
  for (const k of keys) {
    if (k === 'containerDefinitions') continue;
    if (JSON.stringify(base[k]) !== JSON.stringify(rendered[k])) lines.push(`${k} changed`);
  }
  const a = base.containerDefinitions || [];
  const b = rendered.containerDefinitions || [];
  if (a.length !== b.length) lines.push('containerDefinitions count changed');
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const ca = a[i] || {};
    const cb = b[i] || {};
    const name = cb.name || ca.name || String(i);
    for (const k of new Set([...Object.keys(ca), ...Object.keys(cb)])) {
      if (k === 'environment') continue;
      if (JSON.stringify(ca[k]) !== JSON.stringify(cb[k])) {
        lines.push(k === 'image' ? `container ${name} image: ${ca.image} -> ${cb.image}` : `container ${name} ${k} changed`);
      }
    }
    const ea = new Map((ca.environment || []).map((e) => [e.name, e.value]));
    const eb = new Map((cb.environment || []).map((e) => [e.name, e.value]));
    for (const n of [...new Set([...ea.keys(), ...eb.keys()])].sort()) {
      if (ea.get(n) !== eb.get(n)) lines.push(`container ${name} env ${n}: ${ea.has(n) ? ea.get(n) : '<unset>'} -> ${eb.has(n) ? eb.get(n) : '<unset>'}`);
    }
  }
  return lines;
}

function describeService(run, t) {
  const out = aws(run, ['ecs', 'describe-services', '--cluster', CLUSTER, '--services', t.ecsService]);
  const svc = out && Array.isArray(out.services) ? out.services[0] : null;
  if (!svc || svc.status !== 'ACTIVE') throw new DeployError(`ECS service ${t.ecsService} is not ACTIVE in ${CLUSTER}`);
  return svc;
}

function describeTaskDefinition(run, arn) {
  const out = aws(run, ['ecs', 'describe-task-definition', '--task-definition', arn]);
  if (!out || !out.taskDefinition) throw new DeployError(`task definition ${arn} not found`);
  return out.taskDefinition;
}

function commitOfDefinition(td, t) {
  const c = (td.containerDefinitions || []).find((x) => imageRepository(x.image) === `${REGISTRY}/${t.ecrRepository}`);
  const env = (c && c.environment) || [];
  const hit = env.find((e) => e.name === 'GIT_COMMIT_SHA') || env.find((e) => e.name === 'COMMIT_SHA');
  return hit && typeof hit.value === 'string' && /^[0-9a-f]{7,40}$/.test(hit.value) ? hit.value : null;
}

// The commit staging serves now: the build stamp where the service has one, else the live definition's variable.
export async function servedCommit(t, deps, liveTd) {
  try {
    if (t.stamp === 'gateway') {
      const r = await deps.fetchText(STAMP_URLS.gateway);
      const j = JSON.parse(r.body);
      return j && j.env === 'staging' && typeof j.git_commit === 'string' && j.git_commit ? j.git_commit : null;
    }
    if (t.stamp === 'frontend') {
      const r = await deps.fetchText(`${STAMP_URLS.frontend}?deploy-check=${deps.clock ? deps.clock() : Date.now()}`);
      const m = /<meta name="vitana-app-version" content="([0-9a-f]{7,40})"/.exec(String(r.body || ''));
      return m ? m[1] : null;
    }
  } catch {
    return null;
  }
  return liveTd ? commitOfDefinition(liveTd, t) : null;
}

async function waitForStamp(t, deps, want, opts, newArn) {
  for (let a = 1; a <= opts.stampAttempts; a += 1) {
    if (t.stamp) {
      const got = await servedCommit(t, deps, null);
      if (commitMatches(got, want)) return true;
      deps.log(`stamp check ${a}/${opts.stampAttempts}: staging serves ${got || 'nothing readable'}, want ${want.slice(0, 12)}`);
    } else {
      const svc = describeService(deps.run, t);
      const primary = (svc.deployments || []).find((d) => d.status === 'PRIMARY');
      if (primary && primary.taskDefinition === newArn && primary.rolloutState !== 'FAILED'
        && primary.runningCount === primary.desiredCount) return true;
      deps.log(`rollout check ${a}/${opts.stampAttempts}: primary ${primary ? primary.taskDefinition : 'none'}, want ${newArn}`);
    }
    if (a < opts.stampAttempts) await deps.sleep(opts.stampIntervalMs);
  }
  return false;
}

function waitStable(run, t) {
  aws(run, ['ecs', 'wait', 'services-stable', '--cluster', CLUSTER, '--services', t.ecsService], { json: false });
}

// Re-point the service to the captured revision and wait for the old stamp (pattern of AWS-PROD-DEPLOY-GATEWAY.yml
// :1718-1745). Throws when the rollback itself fails.
async function repoint(t, deps, state, opts, why) {
  deps.log(`ROLLBACK ${t.ecsService}: ${why}; re-pointing to the captured revision ${state.captured_task_definition}`);
  aws(deps.run, ['ecs', 'update-service', '--cluster', CLUSTER, '--service', t.ecsService, '--task-definition', state.captured_task_definition]);
  waitStable(deps.run, t);
  if (state.captured_commit) {
    const ok = await waitForStamp(t, deps, state.captured_commit, opts, state.captured_task_definition);
    if (!ok) throw new DeployError(`rollback of ${t.ecsService} is stable but does not serve the captured commit ${state.captured_commit}`);
  }
  state.phase = 'rolled_back';
  state.rolled_back_at = nowIso(deps.clock);
}

function withDefaults(deps = {}) {
  return {
    run: deps.run || defaultRunner,
    fetchText: deps.fetchText || (async (url) => {
      const r = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
      return { status: r.status, body: await r.text() };
    }),
    isAncestor: deps.isAncestor || (() => false),
    sleep: deps.sleep || ((ms) => new Promise((res) => setTimeout(res, ms))),
    clock: deps.clock || Date.now,
    log: deps.log || ((m) => console.log(m)),
  };
}

export async function deploy(o, rawDeps) {
  const deps = withDefaults(rawDeps);
  const t = target(o.service);
  if (o.cluster !== CLUSTER || o.ecsService !== t.ecsService) {
    throw new DeployError(`${o.cluster}/${o.ecsService} is not the staging target of ${o.service} (${CLUSTER}/${t.ecsService}, plan §3.10): refused`, 2);
  }
  if (!isFullSha(o.sha)) throw new DeployError(`--sha must be a full commit SHA, got '${o.sha}'`, 2);
  const image = imageFromPush(t, o.service, o.push || readJson(o.pushFile));
  const mode = o.mode === 'live' ? 'live' : 'shadow';
  const envOverrides = mode === 'live' ? parseEnvOverrides(o.envOverrides) : null;
  const opts = { stampAttempts: o.stampAttempts || 20, stampIntervalMs: o.stampIntervalMs === undefined ? 15000 : o.stampIntervalMs };
  const startedAt = nowIso(deps.clock);
  const finish = (outcome) => writeDeployRun(o.runsFile, { service: o.service, sha: o.sha, started_at: startedAt, finished_at: nowIso(deps.clock), outcome });

  assertIdentity(deps.run, t.role);
  const svc = describeService(deps.run, t);
  const live = describeTaskDefinition(deps.run, svc.taskDefinition);
  if (t.family && live.family !== t.family) {
    throw new DeployError(`${t.ecsService} runs family ${live.family}, not ${t.family}: refused`, 2);
  }
  const served = await servedCommit(t, deps, live);
  const state = {
    service: o.service, cluster: CLUSTER, ecs_service: t.ecsService, sha: o.sha, mode, started_at: startedAt,
    captured_task_definition: svc.taskDefinition, captured_commit: served, new_task_definition: null, phase: 'captured',
  };
  writeJson(o.stateFile, state);
  deps.log(`captured ${t.ecsService}: ${svc.taskDefinition} (serves ${served || 'unknown'})`);

  if (served && !commitMatches(served, o.sha) && deps.isAncestor(o.sha, served)) {
    state.phase = 'superseded';
    writeJson(o.stateFile, state);
    finish('superseded');
    deps.log(`SUPERSEDED: staging already serves ${served}, a descendant of ${o.sha.slice(0, 12)}; nothing deployed`);
    return { outcome: 'superseded', code: 0 };
  }

  const rendered = renderTaskDefinition(live, t, { image, sha: o.sha, envOverrides });
  const diff = diffTaskDefinitions(live, rendered);
  writeJson(join(o.outDir, 'task-definition.json'), rendered);
  writeJson(join(o.outDir, 'task-definition.diff.json'), { service: o.service, from: svc.taskDefinition, mode, changes: diff });
  for (const line of diff) deps.log(`  ${line}`);

  if (mode !== 'live') {
    state.phase = 'skipped';
    writeJson(o.stateFile, state);
    finish('skipped');
    deps.log(`SHADOW: rendered ${live.family} for ${o.sha.slice(0, 12)}; nothing written to ECS (DELIVERY_MODE=${o.mode || 'unset'})`);
    return { outcome: 'skipped', code: 0, diff };
  }

  const reg = aws(deps.run, ['ecs', 'register-task-definition', '--cli-input-json', `file://${join(o.outDir, 'task-definition.json')}`]);
  const newArn = reg && reg.taskDefinition && reg.taskDefinition.taskDefinitionArn;
  if (!newArn) throw new DeployError('register-task-definition returned no ARN');
  state.new_task_definition = newArn;
  state.phase = 'registered';
  writeJson(o.stateFile, state);
  aws(deps.run, ['ecs', 'update-service', '--cluster', CLUSTER, '--service', t.ecsService, '--task-definition', newArn]);
  state.phase = 'updated';
  writeJson(o.stateFile, state);
  deps.log(`updated ${t.ecsService} to ${newArn}; waiting until stable`);

  let why = null;
  try {
    waitStable(deps.run, t);
  } catch (e) {
    why = `not stable: ${e.message}`;
  }
  if (!why && !(await waitForStamp(t, deps, o.sha, opts, newArn))) why = `stable but does not serve ${o.sha.slice(0, 12)}`;
  if (!why) {
    state.phase = 'done';
    writeJson(o.stateFile, state);
    finish('success');
    deps.log(`DEPLOYED ${o.service} ${o.sha.slice(0, 12)} on ${newArn}`);
    return { outcome: 'success', code: 0 };
  }
  try {
    await repoint(t, deps, state, opts, why);
  } catch (e) {
    state.phase = 'rollback_failed';
    writeJson(o.stateFile, state);
    finish('failed');
    deps.log(`FAILED: ${why}; the rollback failed too (${e.message}); rollback-staging retries`);
    return { outcome: 'failed', code: 1 };
  }
  writeJson(o.stateFile, state);
  finish('rolled_back');
  deps.log(`ROLLED BACK ${o.service}: ${why}`);
  return { outcome: 'rolled_back', code: 1 };
}

export async function rollback(o, rawDeps) {
  const deps = withDefaults(rawDeps);
  const state = readJson(o.stateFile, null);
  const nothing = (why) => {
    deps.log(`nothing to roll back: ${why}`);
    return { outcome: 'nothing', code: 0 };
  };
  if (!state || !state.captured_task_definition) return nothing('the deploy job captured no revision');
  if (['captured', 'superseded', 'skipped', 'done'].includes(state.phase)) return nothing(`the deploy job ended at phase ${state.phase}`);
  const t = target(state.service);
  if (state.ecs_service !== t.ecsService || state.cluster !== CLUSTER) {
    throw new DeployError(`state names ${state.cluster}/${state.ecs_service}, not the staging target of ${state.service}: refused`, 2);
  }
  const opts = { stampAttempts: o.stampAttempts || 20, stampIntervalMs: o.stampIntervalMs === undefined ? 15000 : o.stampIntervalMs };
  assertIdentity(deps.run, t.role);
  const svc = describeService(deps.run, t);
  if (svc.taskDefinition === state.captured_task_definition && (state.phase === 'rolled_back' || state.phase === 'registered')) {
    return nothing(`${t.ecsService} already runs the captured revision ${state.captured_task_definition}`);
  }
  await repoint(t, deps, state, opts, `deploy job ended at phase ${state.phase}`);
  writeJson(o.stateFile, state);
  if (o.runsFile) {
    writeDeployRun(o.runsFile, { service: state.service, sha: state.sha, started_at: state.started_at, finished_at: nowIso(deps.clock), outcome: 'rolled_back' });
  }
  return { outcome: 'rolled_back', code: 0 };
}

async function main(argv) {
  const a = parseArgs(argv);
  const cmd = a._[0];
  const env = process.env;
  const runsFile = a['runs-file'] || env.DEPLOY_RUNS_FILE || 'deploy-runs.json';
  const stateFile = a['state-file'] || 'deploy-state.json';
  const repoRoot = a['repo-root'] || env.CI_PROJECT_DIR || process.cwd();
  // The served commit may have landed after this job's checkout: fetch once when it is not known yet.
  const known = (c) => spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${c}^{commit}`], { stdio: 'ignore' }).status === 0;
  const isAncestor = (x, y) => {
    if (!known(y)) spawnSync('git', ['-C', repoRoot, 'fetch', '--quiet', 'origin'], { stdio: 'ignore' });
    return spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', x, y], { stdio: 'ignore' }).status === 0;
  };
  if (cmd === 'deploy') {
    return deploy({
      service: a.service || env.DEPLOY_SERVICE,
      cluster: a.cluster || env.DEPLOY_ECS_CLUSTER,
      ecsService: a['ecs-service'] || env.DEPLOY_ECS_SERVICE,
      pushFile: a['push-file'] || 'push-image.json',
      sha: a.sha || env.CI_COMMIT_SHA,
      mode: a.mode || env.DELIVERY_MODE,
      envOverrides: a['env-overrides'] !== undefined ? a['env-overrides'] : env.DEPLOY_ENV_OVERRIDES,
      runsFile, stateFile, outDir: a['out-dir'] || 'deploy-out',
    }, { isAncestor });
  }
  if (cmd === 'rollback') return rollback({ stateFile, runsFile }, { isAncestor });
  throw new DeployError('usage: deploy-ecs.mjs deploy|rollback …', 2);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((r) => process.exit(r.code), (e) => {
    console.error(`::error::${e.message}`);
    process.exit(e instanceof DeployError ? e.exitCode : 1);
  });
}
