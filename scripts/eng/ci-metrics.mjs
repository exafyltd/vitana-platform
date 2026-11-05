#!/usr/bin/env node
// CI metrics job (plan eng-gitlab-m2 §3.6, lane monitoring). Runs once a minute on the GitLab host from
// infra/gitlab-engineering/host/units/vitana-ci-metrics.timer and publishes what the alarms of terraform/monitoring.tf read.
//
//   node ci-metrics.mjs run [--url http://127.0.0.1] [--token-file /etc/vitana/bot-metrics-token] [--state-dir /var/lib/vitana-ci-metrics]
//                           [--region eu-central-1] [--bucket <backup bucket>] [--dry-run]
//   REGION and BACKUP_BUCKET come from /etc/vitana/env (the unit loads it), so the unit passes neither.
//
// What it publishes, in the CloudWatch namespace Vitana/Engineering, in ONE `aws cloudwatch put-metric-data` call:
//   GitLabReadFailed          1 when GitLab could not be read this minute, else 0
//   PendingJobs               jobs waiting for a runner                      (only when GitLab was read)
//   OldestPendingJobAgeSeconds  how long the oldest of them has waited        (only when GitLab was read and a job could be aged)
//   RunningJobs               jobs running or being prepared
//   FleetRunningJobs          the same, for jobs that carry the fleet tag vitana-eng (plan §3.2)
//   TickAgeSeconds{Unit}      seconds since the unit last COMPLETED a tick successfully (vitana-land, vitana-settings)
//   BackupAgeSeconds          seconds since the newest object under backups/ in the backup bucket
// A failed GitLab read publishes GitLabReadFailed=1 and none of the queue metrics. Never a zero: a zero would say "the queue is
// empty". The alarms treat a missing queue number as "not breaching" and a missing heartbeat (ticks, backup) as "breaching".
//
// Read only on GitLab: the account is bot-metrics (Reporter) and the module makes GET requests through the client of
// gitlab-api.mjs, nothing else. The token is read from a file, goes to the client and nowhere else, and is removed from every
// log line by the logger itself. Dependency-free Node (UNIT.yml runs scripts/**/*.test.mjs with no install).
//
// How the numbers are made, and what they cannot know:
//  - Job ages. The Jobs API has no "queued at" for a pending job. A job whose pipeline has not started (pipeline status pending) is
//    aged from its own created_at, which is when it was queued. A job of a pipeline that is running was created with the whole
//    pipeline, long before its stage began, so created_at would raise the alarm for a healthy pipeline whose first stage is slow;
//    it is aged from the latest finish of any job in its pipeline (one extra request per pipeline), which can only be too small, never
//    too large. A busy fleet that keeps finishing jobs is therefore caught by the fleet-at-maximum alarm, a dead fleet by this one.
//  - Ticks. systemd keeps the time a oneshot unit last became inactive, but forgets it while the unit runs again and cannot say
//    whether the run before was good. The last good completion is therefore kept in a small state file, so that a unit that
//    fails or runs long is seen growing older instead of resetting or disappearing.
//  - The fleet. "At maximum" is read as: running jobs with the fleet tag. One job runs on one machine (plan §3.2).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, GitLabApiError, redact } from './gitlab-api.mjs';

export const NAMESPACE = 'Vitana/Engineering';
export const METRIC = Object.freeze({
  pendingJobs: 'PendingJobs',
  oldestPendingJobAge: 'OldestPendingJobAgeSeconds',
  runningJobs: 'RunningJobs',
  fleetRunningJobs: 'FleetRunningJobs',
  gitlabReadFailed: 'GitLabReadFailed',
  tickAge: 'TickAgeSeconds',
  backupAge: 'BackupAgeSeconds',
});
/** Plan §3.4 (the merge bot) and §3.3 (the settings sync). */
export const TICK_UNITS = Object.freeze(['vitana-land', 'vitana-settings']);
/** Plan §3.2: the tag of the fleet runner. */
export const FLEET_TAG = 'vitana-eng';
/** The nightly GitLab backup archive goes to backups/, the configuration archive to config/ (host/backup.sh). */
export const BACKUP_PREFIX = 'backups/';

const JOB_SCOPES = ['pending', 'preparing', 'running'];
const MAX_PIPELINE_LOOKUPS = 25;
const STATE_FILE = 'ticks.json';
const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}$/;
const REGION_OK = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const BUCKET_OK = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const DEFAULTS = Object.freeze({
  url: 'http://127.0.0.1',
  tokenFile: '/etc/vitana/bot-metrics-token',
  stateDir: '/var/lib/vitana-ci-metrics',
  gitlabDeadlineMs: 40_000,
  requestTimeoutMs: 15_000,
});
const USAGE = `usage: ci-metrics.mjs run [--url URL] [--token-file FILE] [--state-dir DIR] [--region REGION] [--bucket BUCKET]
                         [--gitlab-deadline-ms N] [--request-timeout-ms N] [--dry-run]
  REGION and BACKUP_BUCKET are read from the environment when the options are not given.
`;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A failed read of GitLab that is not an HTTP answer (no token, nothing to read, too slow). */
class ReadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReadError';
    this.code = code;
  }
}

const oneLine = (text, max = 300) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const seconds = (fromMs, toMs) => Math.max(0, Math.floor((toMs - fromMs) / 1000));

// ------------------------------------------------------------------------------------------------ the job queue
/**
 * The job queue of every project the account belongs to: { pendingJobs, oldestPendingJobAgeSeconds, runningJobs, fleetRunningJobs }.
 * Any failed request fails the whole read: partial numbers would under-count. The exceptions are a project that does not let the
 * account read its jobs (403, 404: CI switched off there), which is skipped and logged, and a pipeline that vanished between two
 * requests, whose jobs are counted but not aged.
 */
export async function collectQueue({ client, now, log = () => {}, maxPipelineLookups = MAX_PIPELINE_LOOKUPS }) {
  const projects = await client.paginate('/projects', { query: { membership: true, archived: false, simple: true } });
  if (projects.length === 0) throw new ReadError('the account belongs to no project, so there is no queue to read', 'no_projects');

  let readable = 0;
  let pendingJobs = 0;
  let runningJobs = 0;
  let fleetRunningJobs = 0;
  const waiting = [];
  for (const project of projects) {
    const id = project?.id;
    if (!Number.isInteger(id) || id < 0) {
      log({ event: 'project_skipped', project: oneLine(project?.path_with_namespace, 100), reason: 'no id' });
      continue;
    }
    let jobs;
    try {
      jobs = await client.paginate(`/projects/${id}/jobs`, { query: { scope: JOB_SCOPES } });
    } catch (err) {
      if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) {
        log({ event: 'project_skipped', project: oneLine(project.path_with_namespace, 100), status: err.status });
        continue;
      }
      throw err;
    }
    readable++;
    for (const job of jobs) {
      if (job?.status === 'pending') {
        pendingJobs++;
        waiting.push({ projectId: id, job, createdMs: Date.parse(job.created_at) });
      } else if (job?.status === 'running' || job?.status === 'preparing') {
        runningJobs++;
        if (Array.isArray(job.tag_list) && job.tag_list.includes(FLEET_TAG)) fleetRunningJobs++;
      }
    }
  }
  if (readable === 0) throw new ReadError('no project allowed the account to read its jobs', 'no_readable_project');

  const oldestPendingJobAgeSeconds = pendingJobs === 0 ? 0 : await oldestAge({ client, waiting, now, log, maxPipelineLookups });
  return { pendingJobs, oldestPendingJobAgeSeconds, runningJobs, fleetRunningJobs };
}

const SKIPPED = Symbol('pipeline lookup skipped');

/** Seconds the longest-waiting pending job has waited, or null when none of them could be aged. */
async function oldestAge({ client, waiting, now, log, maxPipelineLookups }) {
  const datable = [];
  for (const w of waiting) {
    if (Number.isFinite(w.createdMs)) datable.push(w);
    else log({ event: 'job_without_timestamp', job: w.job?.id });
  }
  datable.sort((a, b) => a.createdMs - b.createdMs); // the oldest first, so the lookup cap spares the likeliest to matter

  const lookups = new Map();
  let made = 0;
  let oldest = null;
  for (const { projectId, job, createdMs } of datable) {
    let sinceMs = createdMs;
    const pipeline = job.pipeline;
    if (pipeline && pipeline.id !== undefined && pipeline.id !== null && pipeline.status !== 'pending') {
      const key = `${projectId}/${pipeline.id}`;
      let finished = lookups.get(key);
      if (finished === undefined) {
        if (made >= maxPipelineLookups) {
          finished = SKIPPED;
          log({ event: 'pipeline_lookup_skipped', project: projectId, pipeline: pipeline.id, reason: 'cap' });
        } else {
          made++;
          finished = await latestFinish({ client, projectId, pipelineId: pipeline.id, log });
        }
        lookups.set(key, finished);
      }
      if (finished === SKIPPED) continue;
      if (finished !== null) sinceMs = Math.max(sinceMs, finished);
    }
    const age = seconds(sinceMs, now);
    oldest = oldest === null ? age : Math.max(oldest, age);
  }
  return oldest;
}

/** The newest finish time (ms) of any job of the pipeline, null when none has finished, SKIPPED when the pipeline is gone. */
async function latestFinish({ client, projectId, pipelineId, log }) {
  let jobs;
  try {
    jobs = await client.paginate(`/projects/${projectId}/pipelines/${pipelineId}/jobs`);
  } catch (err) {
    if (err instanceof GitLabApiError && (err.status === 403 || err.status === 404)) {
      log({ event: 'pipeline_lookup_skipped', project: projectId, pipeline: pipelineId, status: err.status });
      return SKIPPED;
    }
    throw err;
  }
  let latest = null;
  for (const j of jobs) {
    const t = Date.parse(j?.finished_at);
    if (Number.isFinite(t)) latest = latest === null ? t : Math.max(latest, t); // a finish in the future (clock skew) ages the job as 0, see seconds()
  }
  return latest;
}

// ---------------------------------------------------------------------------------------------------- ticks
function parseProperties(text) {
  const props = {};
  for (const line of String(text).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return props;
}

/**
 * For each unit, the seconds since its last successful completed tick: { ticks: [{ unit, ageSeconds }], state }.
 * `state` maps a unit to the time (ms) of its last good completion, as read on an earlier run. A unit that is inactive with Result=success
 * has just finished well: its InactiveEnterTimestampMonotonic (µs since boot, the same clock as /proc/uptime on a machine that
 * never suspends) is that time. A unit that failed, or is running right now, says nothing about a good tick, so the stored time
 * stands and the age keeps growing. A unit with no good tick on record gives no datapoint at all (never 0).
 */
export async function collectTicks({ exec, now, uptimeSeconds, state = {}, units = TICK_UNITS, log = () => {} }) {
  const next = {};
  const ticks = [];
  if (uptimeSeconds === null || uptimeSeconds === undefined) log({ event: 'uptime_unreadable' });
  for (const unit of units) {
    let observedMs = null;
    if (isNumber(uptimeSeconds)) {
      try {
        const { stdout } = await exec('systemctl', ['show', `${unit}.service`, '-p', 'ActiveState', '-p', 'Result', '-p', 'InactiveEnterTimestampMonotonic']);
        const p = parseProperties(stdout);
        const mono = Number(p.InactiveEnterTimestampMonotonic);
        if (p.ActiveState === 'inactive' && p.Result === 'success' && Number.isFinite(mono) && mono > 0) {
          const agoSeconds = uptimeSeconds - mono / 1e6;
          if (agoSeconds >= -5) observedMs = now - Math.max(0, agoSeconds) * 1000;
          else log({ event: 'tick_clock_mismatch', unit });
        }
      } catch (err) {
        log({ event: 'systemctl_failed', unit, message: oneLine(err?.message) });
      }
    }
    const stored = isNumber(state[unit]) && state[unit] > 0 ? state[unit] : null;
    const best = observedMs !== null && stored !== null ? Math.max(observedMs, stored) : observedMs ?? stored;
    if (best === null) {
      log({ event: 'tick_unknown', unit });
      continue;
    }
    next[unit] = best;
    ticks.push({ unit, ageSeconds: seconds(best, now) });
  }
  return { ticks, state: next };
}

async function loadState(stateDir, units, log) {
  let text;
  try {
    text = await readFile(path.join(stateDir, STATE_FILE), 'utf8');
  } catch {
    return {}; // no file yet is the normal first run
  }
  try {
    const parsed = JSON.parse(text);
    const map = parsed?.version === 1 ? parsed.lastSuccessMs : null;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new Error('not a state file');
    const out = {};
    for (const unit of units) if (unit in map) out[unit] = map[unit]; // collectTicks decides whether a value is a time
    return out;
  } catch {
    log({ event: 'state_unreadable' });
    return {};
  }
}

async function saveState(stateDir, lastSuccessMs, log) {
  try {
    await mkdir(stateDir, { recursive: true });
    const file = path.join(stateDir, STATE_FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ version: 1, lastSuccessMs }, null, 1)}\n`);
    await rename(tmp, file);
  } catch (err) {
    log({ event: 'state_not_saved', message: oneLine(err?.message) });
  }
}

// ---------------------------------------------------------------------------------------------------- backup
/** Seconds since the newest object under backups/, or null (no bucket, empty bucket, listing failed): then no datapoint is published. */
export async function collectBackupAge({ exec, region, bucket, now, log = () => {} }) {
  if (!bucket) {
    log({ event: 'backup_skipped', reason: 'no bucket configured' });
    return null;
  }
  if (!BUCKET_OK.test(bucket)) {
    log({ event: 'backup_skipped', reason: 'the bucket name is not a bucket name' });
    return null;
  }
  try {
    const { stdout } = await exec('aws', ['s3api', 'list-objects-v2', '--bucket', bucket, '--prefix', BACKUP_PREFIX, '--query', 'Contents[].LastModified', '--output', 'json', '--region', region]);
    const list = JSON.parse(String(stdout).trim() || 'null');
    const times = Array.isArray(list) ? list.map((x) => Date.parse(x)).filter(Number.isFinite) : [];
    if (times.length === 0) {
      log({ event: 'backup_none_found', prefix: BACKUP_PREFIX });
      return null;
    }
    return seconds(Math.max(...times), now);
  } catch (err) {
    log({ event: 'backup_listing_failed', message: oneLine(err?.message) });
    return null;
  }
}

// ------------------------------------------------------------------------------------------------ publishing
/** The CloudWatch datums. A number that is not finite, or is negative, is never published. */
export function buildMetricData({ queue, ticks = [], backupAgeSeconds = null, gitlabFailed }) {
  const data = [];
  const add = (name, value, unit, dimensionUnit) => {
    if (!isNumber(value) || value < 0) return;
    data.push({ MetricName: name, ...(dimensionUnit ? { Dimensions: [{ Name: 'Unit', Value: dimensionUnit }] } : {}), Value: value, Unit: unit });
  };
  add(METRIC.gitlabReadFailed, gitlabFailed ? 1 : 0, 'Count');
  if (!gitlabFailed && queue) {
    add(METRIC.pendingJobs, queue.pendingJobs, 'Count');
    add(METRIC.oldestPendingJobAge, queue.oldestPendingJobAgeSeconds, 'Seconds');
    add(METRIC.runningJobs, queue.runningJobs, 'Count');
    add(METRIC.fleetRunningJobs, queue.fleetRunningJobs, 'Count');
  }
  for (const t of ticks) add(METRIC.tickAge, t.ageSeconds, 'Seconds', t.unit);
  add(METRIC.backupAge, backupAgeSeconds, 'Seconds');
  return data;
}

export async function publishMetrics({ exec, region, data }) {
  if (data.length === 0) return;
  await exec('aws', ['cloudwatch', 'put-metric-data', '--namespace', NAMESPACE, '--region', region, '--metric-data', JSON.stringify(data)]);
}

// ----------------------------------------------------------------------------------------------------- a run
function makeLogger({ stdout, now }) {
  let secret = null;
  const log = (event) => stdout(`${redact(JSON.stringify({ ts: new Date(now()).toISOString(), ...event }), secret)}\n`);
  log.setSecret = (value) => { secret = value; };
  return log;
}

async function readToken(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new ReadError(`the token file cannot be read (${err?.code ?? 'error'})`, 'token_unreadable');
  }
  const token = text.trim();
  if (!TOKEN_OK.test(token)) throw new ReadError('the token file does not hold a token', 'token_unreadable');
  return token;
}

/** The answer of `promise`, or a 'deadline' ReadError after `ms`. A late answer of the abandoned promise is handled by the race itself. */
function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new ReadError(`GitLab did not answer within ${ms} ms`, 'deadline')), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * One minute of work. GitLab, the units and the backup bucket are read independently: a failure of one never holds back the others.
 * Returns { exitCode }: 0 when the metrics were published (also when that includes the failure metric), 1 when publishing failed.
 */
export async function run(options, deps) {
  const log = makeLogger(deps);
  const t0 = deps.now();

  // 1. GitLab
  let queue = null;
  let gitlabFailed = false;
  try {
    const token = await readToken(options.tokenFile);
    log.setSecret(token);
    const client = createClient({
      baseUrl: options.url, token, fetch: deps.fetch, sleep: deps.sleep, retries: 2, baseDelayMs: 500, maxDelayMs: 4000, timeoutMs: options.requestTimeoutMs,
      log: (e) => log({ ...e, event: 'gitlab_retry' }),
    });
    queue = await withDeadline(collectQueue({ client, now: t0, log }), options.gitlabDeadlineMs);
  } catch (err) {
    gitlabFailed = true;
    log({ event: 'gitlab_read_failed', code: err?.code ?? 'unexpected', ...(isNumber(err?.status) && err.status > 0 ? { status: err.status } : {}), message: oneLine(err?.message) });
  }

  // 2. the two units
  let uptimeSeconds = null;
  try {
    const u = await deps.readUptime();
    if (isNumber(u)) uptimeSeconds = u;
  } catch { /* logged by collectTicks */ }
  const stored = await loadState(options.stateDir, TICK_UNITS, log);
  const { ticks, state } = await collectTicks({ exec: deps.exec, now: t0, uptimeSeconds, state: stored, units: TICK_UNITS, log });

  // 3. the backups
  const backupAgeSeconds = await collectBackupAge({ exec: deps.exec, region: options.region, bucket: options.bucket, now: t0, log });

  const data = buildMetricData({ queue, ticks, backupAgeSeconds, gitlabFailed });
  if (options.dryRun) {
    log({ event: 'dry_run', metrics: data });
    return { exitCode: 0 };
  }
  await saveState(options.stateDir, state, log);
  try {
    await publishMetrics({ exec: deps.exec, region: options.region, data });
  } catch (err) {
    log({ event: 'publish_failed', message: oneLine(err?.message) });
    return { exitCode: 1 };
  }
  log({ event: 'published', metrics: data.length, gitlab: gitlabFailed ? 'failed' : 'ok' });
  return { exitCode: 0 };
}

// ------------------------------------------------------------------------------------------------------- CLI
export function parseArgs(argv, env = {}) {
  const args = [...argv];
  const command = args.shift();
  if (command !== 'run') throw new UsageError(command ? `unknown command "${oneLine(command, 40)}"` : 'a command is required (run)');
  const o = { command, ...DEFAULTS, region: undefined, bucket: undefined, dryRun: false };
  const valueFlags = {
    '--url': 'url', '--token-file': 'tokenFile', '--state-dir': 'stateDir', '--region': 'region', '--bucket': 'bucket',
    '--gitlab-deadline-ms': 'gitlabDeadlineMs', '--request-timeout-ms': 'requestTimeoutMs',
  };
  while (args.length > 0) {
    let flag = args.shift();
    let inline;
    const eq = flag.indexOf('=');
    if (flag.startsWith('--') && eq > 0) { inline = flag.slice(eq + 1); flag = flag.slice(0, eq); }
    if (flag === '--dry-run') {
      if (inline !== undefined) throw new UsageError('--dry-run takes no value');
      o.dryRun = true;
      continue;
    }
    const key = valueFlags[flag];
    if (!key) throw new UsageError(`unknown option "${oneLine(flag, 40)}"`);
    const value = inline ?? args.shift();
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    o[key] = value;
  }
  for (const key of ['gitlabDeadlineMs', 'requestTimeoutMs']) {
    const n = typeof o[key] === 'number' ? o[key] : Number(o[key]);
    if (!Number.isInteger(n) || n < 1 || n > 600_000) throw new UsageError(`${key === 'gitlabDeadlineMs' ? '--gitlab-deadline-ms' : '--request-timeout-ms'} must be a whole number of milliseconds between 1 and 600000`);
    o[key] = n;
  }
  o.region = o.region ?? (env.REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION);
  if (!REGION_OK.test(String(o.region ?? ''))) throw new UsageError('a region is required: --region, or REGION in the environment (for example eu-central-1)');
  o.bucket = o.bucket ?? (env.BACKUP_BUCKET || undefined);
  if (o.bucket !== undefined && !BUCKET_OK.test(o.bucket)) throw new UsageError('--bucket is not a bucket name');
  let url;
  try { url = new URL(o.url); } catch { throw new UsageError('--url is not a URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new UsageError('--url must be http or https');
  return o;
}

const execFileAsync = promisify(execFile);

function defaultDeps() {
  return {
    fetch: globalThis.fetch,
    exec: (file, args) => execFileAsync(file, args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    now: () => Date.now(),
    readUptime: async () => {
      const n = Number.parseFloat((await readFile('/proc/uptime', 'utf8')).split(' ')[0]);
      return Number.isFinite(n) ? n : null;
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  };
}

/** Exit code: 0 done, 1 publishing failed, 2 usage mistake. */
export async function main(argv, env = process.env, deps = defaultDeps()) {
  if (argv.includes('--help') || argv.includes('-h')) {
    deps.stdout(USAGE);
    return 0;
  }
  let options;
  try {
    options = parseArgs(argv, env);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    deps.stderr(`ci-metrics: ${err.message}\n${USAGE}`);
    return 2;
  }
  return (await run(options, deps)).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const finish = (code) => process.stdout.write('', () => process.exit(code)); // drop timers a hung request may have left behind
  main(process.argv.slice(2)).then(finish, (err) => {
    process.stderr.write(`ci-metrics: unexpected error: ${oneLine(redact(err?.message, null))}\n`, () => process.exit(1));
  });
}
