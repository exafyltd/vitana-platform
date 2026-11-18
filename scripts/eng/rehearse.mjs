// The rehearsal of the self-hosted GitLab (plan eng-gitlab-m2 §3.8, lane rehearsal): twelve agents work in parallel on a scratch project, the
// fleet scales, the merge bot lands their merge requests, and a report says whether the whole path (agents, fleet, bot, main) works before
// any real repository depends on it. The owner starts it with `bash m2.sh rehearse`, which runs, on the GitLab machine:
//
//   node scripts/eng/rehearse.mjs --project rehearsal --agents 12
//   options: --settings FILE   --url URL (default http://127.0.0.1)   --dry-run   --run-id ID   --max-minutes N (30-240, default 110)
//            --poll-seconds N (1-300, default 15)   --gitlab-private-ip IP (default: the machine's own private address)   --help
//   environment: REGION (from /etc/vitana/env, as for the settings sync); FLEET_ASG_NAME (default vitana-eng-fleet); GITLAB_PRIVATE_IP
//   exit codes:  0  every acceptance this run checked held         1  one failed, was not proven, or the run could not finish
//                2  usage mistake, or a refusal to start (a safety check failed or could not be made): NOTHING was written
//
// What it does, in order. Every write is announced on stderr before it is made. The report goes to stdout, progress to stderr.
//   1 Refuses to start unless the project is marked `rehearsal: true`, is `native`, has `landing: true` and no webhook in gitlab-settings.json,
//     AND the live project agrees (no webhook, no mirror, `main` protected as the native profile: push No one, merge Maintainers, no force
//     push), every account of the project has a token whose owner is who the secret says, no merge request of another origin is open,
//     `CLAUDE.md` is a protected gate file under the rules of this machine, the role of this machine may read the fleet group (one read of
//     describe-auto-scaling-groups and of describe-scaling-activities; a denial is a refusal naming autoscaling:DescribeAutoScalingGroups and
//     autoscaling:DescribeScalingActivities, so A1 is never left unproven for that reason), and the built seed passes its own tests in a
//     temporary directory (so the job `unit` of the seed merge request cannot fail). --dry-run stops here and prints the plan.
//   2 Closes merge requests left open by an earlier run (source branch rehearsal/…).
//   3 Seed: if main does not hold infra/gitlab-engineering/rehearsal/seed/ (see manifest.json) it is put there by a merge request of lane
//     rehearsal/seed, reviewed and landed by the bot like any other (main takes no push). A seed that is current is not touched.
//   4 Wave 1: five control merge requests, then --agents lane merge requests (round robin over the four seat accounts), each one commit
//     on its own branch, opened by the seat account. Wave 2, once the first job of the first wave has started (or after 8 minutes; the other
//     first-wave machines are then still in the group when the second wave asks for its own): the reviewer account
//     `agent-reviewer` pushes the review commit in the form the bot trusts, the controls get their faults. The bot then lands the lanes.
//   5 Waits for the bot (sampling the ASG every poll), lets the jobs settle, closes the control merge requests, waits for the fleet to
//     return to 0, and reads everything it needs: jobs, traces, commits on main, bot comments, protection, members, token expiry, the
//     settings check (`gitlab-settings.mjs check`).
// Who does what: the four seats `agent-kiro-*` open and change their own merge requests; `agent-reviewer` pushes review commits; every read
// uses `bot-land` through a client that has no write method. Tokens come from Secrets Manager vitana/engineering/gitlab/agents/<username>
// through the injected aws runner and are never printed. AWS is only read (get-secret-value of those secrets, describe-auto-scaling-groups,
// describe-scaling-activities of the fleet group). GitLab is written only inside the rehearsal project: POST repository/commits, POST
// merge_requests, PUT merge_requests/:iid (close), DELETE repository/branches/:name. Nothing else, nowhere else.
//
// The report (stdout). One line per fact; each acceptance of plan §9 has a verdict PASS, FAIL or NOT PROVEN:
//   REHEARSAL REPORT / run / project / times / RESULT line
//   A1 FLEET      peak fleet size (machines in the ASG, any state, the largest of the samples; needs 20 when 12 agents; the report also
//                 gives the most that were booting or serving), jobs run, machines launched (from the ASG activity history; needs
//                 >= jobs run), minutes from the last job to 0 machines (needs <= 15)
//   A2 ISOLATION  the three negative controls (imds, gitlab-host, aws-env) as the jobs printed them: counts of PASS and FAIL per control,
//                 the first detail line of a control that failed, and the baseline (information only: was GitLab reachable from the job).
//                 imds is a PASS when no metadata token was issued to the job and a plain read returned no data (a timeout, 401 and 403
//                 are the protection working); it is a FAIL only when the token request or the plain read answered 2xx.
//   A3 ACCESS     main: push No one, merge Maintainers, no force push; the Maintainers; token expiry of every account (<= 90 days);
//                 the settings check exit code
//   A4 LANDING    merge requests landed, commits on main (subjects), one commit each with the VTID, in landing order; the five controls
//                 and the refusal code the bot gave each (comments marked vitana-land:<code>)
//   A8 LEGACY     jobs that ran on the legacy runner (must be 0: it is retagged); the pause is an owner step after A1 and is only noted
//   PROBLEMS      jobs that never finished, the ASG activity (launches that failed, with AWS's message), landing merge requests that did not
//                 land with every reason the bot gave
//   COMMITS ON MAIN, BOT REFUSALS, NEGATIVE CONTROLS (per control: PASS/FAIL counts), progress notes
// With --agents below 12 the plan's 20-machine peak is not checked (the report says so) and the other checks stand.
//
// Dependency-free Node 20. GitLab, AWS, time and the files are injected, so the tests use a fake GitLab, a fake aws runner and a virtual
// clock; no test reaches a network.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, GitLabApiError, projectId } from './gitlab-api.mjs';
import {
  ConfigError, SECRETS, daysLeft, defaultConfigPath, defaultDeps as settingsDefaultDeps, main as settingsMain, makeRedactor, validateConfig,
} from './gitlab-settings.mjs';
import { DEFAULTS as LAND } from './gitlab-land.mjs';
import { PROTECTED_GATE_PATHS } from '../collab/queue.mjs';
import { protectedTouched } from '../collab/land-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ── constants of the plan ────────────────────────────────────────────────────────────────────────────────────────────────────
export const SLUG = 'rehearsal';
export const RUN_VTID = 'VTID-05540';
export const LANE_COUNT = 12;
export const MAIN = 'main';
export const FLEET_ASG = 'vitana-eng-fleet';
export const CONTROL_FILE = 'CLAUDE.md';
export const SEAT_PREFIX = 'agent-kiro-';
export const REVIEWER = LAND.reviewerUser;
export const BOT = LAND.botUser;
export const REVIEWER_TRAILER = 'agent:vitana-lane-reviewer (rehearsal)';
export const NEGCTL = Object.freeze(['imds', 'gitlab-host', 'aws-env']);
export const LIMITS = Object.freeze({ minPeak: 20, zeroSeconds: 900, tokenDays: 90 });
export const DEFAULT_URL = 'http://127.0.0.1';
/** Minutes kept at the end of --max-minutes for letting the jobs settle, closing the controls, waiting for the fleet to reach 0 and reading. */
export const END_RESERVE_MIN = 20;
/** A bot that landed a lane within this many minutes of the end of the landing budget was still working (the report says so). */
export const STILL_LANDING_MIN = 10;
/** The two IAM actions the rehearsal reads the fleet group with. infra/gitlab-engineering/terraform/settings.tf grants both to the role of the GitLab machine. */
export const IAM_ACTIONS = Object.freeze(['autoscaling:DescribeAutoScalingGroups', 'autoscaling:DescribeScalingActivities']);
export const IAM_HINT = 'the role of the GitLab machine needs autoscaling:DescribeAutoScalingGroups and autoscaling:DescribeScalingActivities (infra/gitlab-engineering/terraform/settings.tf grants them; see infra/gitlab-engineering/rehearsal/README.md)';
/** How many scaling activities the history at the end asks for: far more than a run makes (about 60), far below the 1,000,000 characters the aws runner keeps. */
export const ACTIVITIES_MAX_ITEMS = 500;
export const defaultSeedDir = () => path.resolve(HERE, '..', '..', 'infra', 'gitlab-engineering', 'rehearsal', 'seed');
export const defaultPlatformRoot = () => path.resolve(HERE, '..', '..');

/** The five controls: one refusal each (plan §9 A4). `expect` is the reason code the bot writes in its comment (gitlab-land.mjs COMMENT_TEXT). */
export const CONTROLS = Object.freeze([
  Object.freeze({ id: 'ctl-no-review', control: 'no_review', expect: 'no_review', what: 'no review at all' }),
  Object.freeze({ id: 'ctl-stale-review', control: 'stale_review', expect: 'review_stale', what: 'a review of an older head; code changed after it' }),
  Object.freeze({ id: 'ctl-builder-accept', control: 'builder_accept', expect: 'review_forged', what: 'an accept pushed by the builder, not by agent-reviewer' }),
  Object.freeze({ id: 'ctl-red-job', control: 'red_job', expect: 'checks_failed', what: 'a reviewed merge request whose required job is red' }),
  Object.freeze({ id: 'ctl-protected-file', control: 'protected_file', expect: 'protected_gate_file', what: 'a reviewed merge request that changes a protected gate file' }),
]);

const SECRET_ID_OK = /^vitana\/engineering\/gitlab\/agents\/[a-z0-9][a-z0-9_.-]{1,62}$/;
const REGION_OK = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;
const NAME_OK = /^[a-z0-9][a-z0-9_.-]{1,63}$/;
const RUN_ID_OK = /^r[0-9a-z]{4,24}$/;
const TOKEN_OK = /^[A-Za-z0-9_.~=-]{8,}$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const SHA = /^[0-9a-f]{40}$/;
const VTID_SUBJECT = /^VTID-\d{5}\b/;
const NON_FINAL = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'waiting_for_callback', 'scheduled', 'canceling']);
const enc = encodeURIComponent;
const oneLine = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const pad2 = (n) => String(n).padStart(2, '0');

export class UsageError extends Error {
  constructor(message) { super(message); this.name = 'UsageError'; }
}
/** A refusal to start. Nothing has been written. */
export class Refusal extends Error {
  constructor(problems) { super(problems.join('; ')); this.name = 'Refusal'; this.problems = problems; }
}
/** The run cannot go on (the seed did not land, the reviewer's push is not seen); the report is still printed. */
export class RunStop extends Error {
  constructor(message) { super(message); this.name = 'RunStop'; }
}

// ── command line ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const USAGE = [
  'usage: node scripts/eng/rehearse.mjs --project <name> [--agents 12] [--settings FILE] [--url URL] [--dry-run] [--run-id ID]',
  '                                     [--max-minutes 110] [--poll-seconds 15] [--gitlab-private-ip IP] [--help]',
  'exit 0: every acceptance checked held; 1: one failed, was not proven, or the run could not finish; 2: usage mistake or refusal to start (nothing written)',
].join('\n');
const VALUE_FLAGS = Object.freeze({
  '--project': 'project', '--agents': 'agents', '--settings': 'settings', '--url': 'url', '--run-id': 'runId',
  '--max-minutes': 'maxMinutes', '--poll-seconds': 'pollSeconds', '--gitlab-private-ip': 'gitlabPrivateIp',
});

const whole = (name, v, min, max) => {
  if (typeof v === 'number') { if (!Number.isInteger(v)) throw new UsageError(`${name} must be a whole number`); return v; }
  if (!/^\d{1,6}$/.test(String(v))) throw new UsageError(`${name} must be a whole number from ${min} to ${max}`);
  return Number(v);
};

export function parseArgs(argv) {
  const o = { project: null, agents: LANE_COUNT, settings: null, url: DEFAULT_URL, runId: null, maxMinutes: 110, pollSeconds: 15, gitlabPrivateIp: null, dryRun: false, help: false };
  const args = [...argv];
  while (args.length > 0) {
    let a = args.shift();
    let inline;
    if (a.startsWith('--') && a.includes('=')) { inline = a.slice(a.indexOf('=') + 1); a = a.slice(0, a.indexOf('=')); }
    if (a === '--help' || a === '-h') { o.help = true; continue; }
    if (a === '--dry-run') {
      if (inline !== undefined) throw new UsageError('--dry-run takes no value');
      o.dryRun = true;
      continue;
    }
    if (!Object.hasOwn(VALUE_FLAGS, a)) throw new UsageError(a.startsWith('-') ? `unknown option ${oneLine(a, 40)}` : `unexpected argument ${oneLine(a, 40)}`);
    const v = inline ?? args.shift();
    if (v === undefined || String(v).startsWith('--')) throw new UsageError(`${a} needs a value`);
    o[VALUE_FLAGS[a]] = v;
  }
  if (o.help) return o;
  if (!o.project) throw new UsageError('--project is required (the scratch project, for example rehearsal)');
  if (!NAME_OK.test(o.project)) throw new UsageError('--project must be a lower-case project path inside the group');
  o.agents = whole('--agents', o.agents, 1, LANE_COUNT);
  if (o.agents < 1 || o.agents > LANE_COUNT) throw new UsageError(`--agents must be a whole number from 1 to ${LANE_COUNT} (the seed spec has ${LANE_COUNT} lanes)`);
  o.maxMinutes = whole('--max-minutes', o.maxMinutes, 30, 240);
  if (o.maxMinutes < 30 || o.maxMinutes > 240) throw new UsageError('--max-minutes must be from 30 to 240');
  o.pollSeconds = whole('--poll-seconds', o.pollSeconds, 1, 300);
  if (o.pollSeconds < 1 || o.pollSeconds > 300) throw new UsageError('--poll-seconds must be from 1 to 300');
  if (o.runId !== null && !RUN_ID_OK.test(o.runId)) throw new UsageError('--run-id must be r followed by 4 to 24 lower-case letters or digits');
  if (o.gitlabPrivateIp !== null && !IPV4.test(o.gitlabPrivateIp)) throw new UsageError('--gitlab-private-ip must be an IPv4 address');
  return o;
}

// ── the plan of merge requests ──────────────────────────────────────────────────────────────────────────────────────────────
export const laneKeyFor = (id) => `${SLUG}/${id}`;
export const laneFilePath = (id) => `.kiro/specs/${SLUG}/lanes/${id}.md`;
export const branchFor = (runId, id) => `${SLUG}/${runId}/${id}`;
const seatLetters = (username) => (String(username).replace(SEAT_PREFIX, '').replace(/[^a-z]/g, '').slice(0, 12) || 'seat');

/**
 * The merge requests of a run, in the order they are opened: the five controls first (so they are the oldest and the bot reads them first),
 * then `agents` lanes. `seats` are the usernames of the four seat accounts, in the order of gitlab-settings.json: lane i is opened by
 * seats[(i-1) mod n], control k by seats[(agents+k) mod n].
 */
export function planMergeRequests({ agents, seats, runId, vtid = RUN_VTID }) {
  if (!Number.isInteger(agents) || agents < 1 || agents > LANE_COUNT) throw new UsageError(`agents must be a whole number from 1 to ${LANE_COUNT}`);
  if (!Array.isArray(seats) || seats.length === 0) throw new UsageError('there is no seat account to open merge requests');
  const mk = (base) => ({
    ...base, branch: branchFor(runId, base.id), laneKey: laneKeyFor(base.id), laneFile: laneFilePath(base.id),
  });
  const lanes = Array.from({ length: agents }, (_, i) => {
    const id = `lane-${pad2(i + 1)}`;
    return mk({ id, kind: 'land', index: i + 1, seat: seats[i % seats.length], title: `${vtid} (${laneKeyFor(id)}): rehearsal lane ${i + 1} of ${agents}` });
  });
  const controls = CONTROLS.map((c, k) => mk({
    id: c.id, kind: 'control', control: c.control, expect: c.expect, what: c.what, seat: seats[(agents + k) % seats.length],
    title: `${vtid} (${laneKeyFor(c.id)}): control, ${c.what}`,
  }));
  return { controls, lanes, order: [...controls, ...lanes] };
}

export function seedItem({ runId, seat, vtid = RUN_VTID }) {
  const id = 'seed';
  return {
    id, kind: 'seed', seat, branch: branchFor(runId, id), laneKey: laneKeyFor(id), laneFile: laneFilePath(id),
    title: `${vtid} (${laneKeyFor(id)}): seed the rehearsal repository`,
  };
}

export function mrDescription(item, runId) {
  const what = item.kind === 'control' ? `Control: ${item.what}. The bot must refuse it (reason ${item.expect}).` : item.kind === 'seed' ? 'Puts the seed of the rehearsal repository on main.' : 'A lane of the rehearsal spec; the bot should land it.';
  return `${what}\n\nRehearsal run ${runId}, opened by ${item.seat} through scripts/eng/rehearse.mjs (plan eng-gitlab-m2, section 3.8). A scratch project: nothing here is real work.`;
}

// ── commits: the exact form the merge bot trusts ───────────────────────────────────────────────────────────────────────────
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12);
export const sessionIdFor = (kind, name, ms, hex) => (kind === 'reviewer' ? `agent-vitana-lane-reviewer-${stamp(ms)}-${hex}` : `kiro-${seatLetters(name)}-${stamp(ms)}-${hex}`);

export const builderMessage = (item, session) => `${item.title}\n\nCollab-Session: ${session}\nCollab-Lane: ${item.laneKey}`;
/**
 * A review commit as gitlab-land.mjs reads it (trailers via queue.mjs commitsInRange): Collab-Review (the lane), Collab-Verdict accept,
 * Collab-Reviewer `agent:vitana-lane-reviewer (…)`, Collab-Reviewed-Head (40 hex, the head the review covers). The bot also needs the commit
 * to be PUSHED by agent-reviewer; a builder who writes this same message is refused as review_forged.
 */
export const acceptMessage = (item, { session, reviewedHead }) => [
  `review(${item.laneKey}): accept`, '',
  `Collab-Session: ${session}`, `Collab-Review: ${item.laneKey}`, 'Collab-Verdict: accept', `Collab-Reviewer: ${REVIEWER_TRAILER}`, `Collab-Reviewed-Head: ${reviewedHead}`,
].join('\n');

const lane = (id, extra = '') => `---\nlane: ${id}\nstate: in-review\nnext_actor: kiro\nexecutor: kiro\nseat: exafy\nreviewer: ${REVIEWER_TRAILER}\npaths:\n  - src/lanes/**\n  - test/lanes/**\n---\n# Lane: ${id} (rehearsal)\nA control merge request of the rehearsal.${extra}\n\n## Log\n### 2026-11-05T00:00Z · rehearse · in-review\nLane file created by the control merge request.\n`;

/** The files of the builder's commit: new files only, named by run and lane, so no two merge requests touch the same path. */
export function builderFiles(item, runId) {
  const mod = `src/lanes/${runId}-${item.id}.mjs`;
  const tst = `test/lanes/${runId}-${item.id}.test.mjs`;
  const files = {};
  files[mod] = `// Rehearsal ${item.id} of run ${runId}, opened by ${item.seat}.\nexport const lane = '${item.id}';\nexport const run = '${runId}';\nexport const seat = '${item.seat}';\n`;
  const body = item.control === 'red_job'
    ? "  assert.equal('red', 'green', 'the red-job control of the rehearsal fails on purpose');\n"
    : `  assert.equal(lane, '${item.id}');\n  assert.equal(run, '${runId}');\n  assert.equal(seat, '${item.seat}');\n`;
  files[tst] = `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { lane, run, seat } from '../../src/lanes/${runId}-${item.id}.mjs';\n\ntest('rehearsal ${item.id} of run ${runId} is built by ${item.seat}', () => {\n${body}});\n`;
  if (item.control === 'protected_file') files[CONTROL_FILE] = `# Rehearsal control\nThis file is a protected gate file. The merge bot must refuse the merge request that changes it (run ${runId}).\n`;
  if (item.kind === 'control') files[item.laneFile] = lane(item.id);
  return files;
}

export function appendLaneEntry(text, { ts, session, verdict, reviewedHead }) {
  const base = String(text).endsWith('\n') ? String(text) : `${text}\n`;
  return `${base}\n### ${ts} · ${session} · review\nverdict: ${verdict}\nreviewed head: ${reviewedHead}\n`;
}

const tsOf = (ms) => `${new Date(ms).toISOString().slice(0, 16)}Z`;
export const builderCommitBody = (item, { runId, session }) => ({
  branch: item.branch, start_branch: MAIN, commit_message: builderMessage(item, session),
  actions: Object.entries(builderFiles(item, runId)).map(([file_path, content]) => ({ action: 'create', file_path, content })),
});
/** The reviewer's commit: an entry on the lane file and nothing else (so `reviewCurrent` still counts it for the head). */
export const reviewCommitBody = (item, { session, reviewedHead, laneText, ms }) => ({
  branch: item.branch, commit_message: acceptMessage(item, { session, reviewedHead }),
  actions: [{ action: 'update', file_path: item.laneFile, content: appendLaneEntry(laneText, { ts: tsOf(ms), session, verdict: 'accept', reviewedHead }) }],
});
/** The same words from the builder's account: the bot refuses it (review_forged). */
export const forgedAcceptBody = reviewCommitBody;
/** Code that changes after the review (the stale-review control). */
export const staleChangeBody = (item, { runId, session }) => ({
  branch: item.branch, commit_message: `${item.title}: change after the review\n\nCollab-Session: ${session}\nCollab-Lane: ${item.laneKey}`,
  actions: [{ action: 'create', file_path: `src/lanes/${runId}-${item.id}-after-review.mjs`, content: `// Written after the review of ${item.id}: the review no longer counts.\nexport const changedAfterReview = true;\n` }],
});

// ── the seed ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** git's blob id of a text: what GET repository/tree reports as `id`. */
export const blobId = (text) => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(String(text))}\0`).update(String(text)).digest('hex');

export function readManifest(seedDir = defaultSeedDir()) {
  const m = JSON.parse(fs.readFileSync(path.join(seedDir, 'manifest.json'), 'utf8'));
  if (m.schema !== 'vitana.rehearsal-seed/v1' || !m.collab || !Array.isArray(m.collab.files)) throw new Error('rehearsal seed manifest.json is not schema vitana.rehearsal-seed/v1');
  return m;
}

/**
 * The files the seed puts on main: Map<path, text>. Folder files keep their path (the folder `spec/` maps to .kiro/specs/rehearsal/); the
 * collab tooling is copied from `<platformRoot>/scripts/collab` to tools/collab (never scripts/collab: protected gate files); the config
 * names the private address of the GitLab machine for the gitlab-host control.
 */
export function buildSeedFiles({ seedDir = defaultSeedDir(), platformRoot = defaultPlatformRoot(), gitlabPrivateIp }) {
  const manifest = readManifest(seedDir);
  const files = new Map();
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      if (!e.isFile() || r === 'manifest.json') continue;
      const target = Object.entries(manifest.map).reduce((p, [from, to]) => (p.startsWith(from) ? `${to}${p.slice(from.length)}` : p), r);
      files.set(target, fs.readFileSync(path.join(dir, e.name), 'utf8'));
    }
  };
  walk(seedDir, '');
  for (const f of manifest.collab.files) {
    const from = path.join(platformRoot, manifest.collab.from, f);
    if (!fs.existsSync(from)) throw new Error(`the collab tooling file ${manifest.collab.from}/${f} is missing in ${platformRoot}`);
    files.set(`${manifest.collab.to}/${f}`, fs.readFileSync(from, 'utf8'));
  }
  if (!IPV4.test(gitlabPrivateIp ?? '')) throw new Error('the private address of the GitLab machine is not known (pass --gitlab-private-ip)');
  files.set('rehearsal.config.json', `${JSON.stringify({ schema: 'vitana.rehearsal-config/v1', gitlabPrivateIp }, null, 2)}\n`);
  return files;
}

/**
 * What a merge request must do to make main hold the seed. `existing` is Map<path, blobId> of main. A path under a createOnly prefix
 * (the spec: lane files grow log entries) is created when absent and never updated.
 */
export function diffSeed(files, existing, createOnly = []) {
  const create = [];
  const update = [];
  const same = [];
  for (const [p, text] of files) {
    if (!existing.has(p)) { create.push(p); continue; }
    if (createOnly.some((prefix) => p.startsWith(prefix))) { same.push(p); continue; }
    (existing.get(p) === blobId(text) ? same : update).push(p);
  }
  return { create, update, same };
}
export const seedActions = (diff, files) => [
  ...diff.create.map((p) => ({ action: 'create', file_path: p, content: files.get(p) })),
  ...diff.update.map((p) => ({ action: 'update', file_path: p, content: files.get(p) })),
];
export const seedCommitBody = (item, diff, files, session) => ({
  branch: item.branch, start_branch: MAIN, commit_message: builderMessage(item, session), actions: seedActions(diff, files),
});

/** The paths of the seed that the merge bot would refuse (protected gate files) or that need an executor lane (governance); must be none. */
export function seedRefusals(files, protectedGlobs = PROTECTED_GATE_PATHS) {
  return protectedTouched([...files.keys()], protectedGlobs);
}

/** The first private IPv4 address of a physical-looking interface (not loopback, docker, bridge, veth). */
export function pickPrivateIp(interfaces) {
  const skip = /^(lo|docker|br-|veth|cni|flannel|virbr|tun|tap)/;
  const priv = (a) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  for (const name of Object.keys(interfaces ?? {}).sort()) {
    if (skip.test(name)) continue;
    for (const a of interfaces[name] ?? []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal && priv(a.address)) return a.address;
    }
  }
  return null;
}

// ── safety checks (pure) ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** The file side of the refusal (plan §3.8). → { ok, problems, config, project } */
export function checkSettingsFile(raw, name) {
  let config;
  try { config = validateConfig(raw); } catch (e) {
    if (e instanceof ConfigError) return { ok: false, problems: [`the settings file is not valid: ${e.message}`], config: null, project: null };
    throw e;
  }
  const p = config.projects[name];
  const problems = [];
  if (!p) problems.push(`project "${name}" is not in gitlab-settings.json`);
  else {
    if (p.rehearsal !== true) problems.push(`project "${name}" is not marked rehearsal: true in gitlab-settings.json`);
    if (p.profile !== 'native') problems.push(`project "${name}" has profile "${p.profile}", not native (a mirrored project is never rehearsed on)`);
    if (p.webhook) problems.push(`project "${name}" has a webhook in gitlab-settings.json`);
    if (p.landing !== true) problems.push(`project "${name}" has landing: false, so the merge bot would never land anything there`);
  }
  return { ok: problems.length === 0, problems, config, project: p ?? null };
}

const exactly = (list, level) => Array.isArray(list) && list.length === 1 && list[0].access_level === level && !list[0].user_id && !list[0].group_id && !list[0].deploy_key_id;
/** Problems with `main` of a native project: push No one, merge Maintainers, no force push. [] when it is as the native profile says. */
export function protectionProblems(pb) {
  if (!pb || typeof pb !== 'object') return ['main is not protected'];
  const problems = [];
  if (!exactly(pb.push_access_levels, 0)) problems.push('push to main is not "No one"');
  if (!exactly(pb.merge_access_levels, 40)) problems.push('merge to main is not "Maintainers"');
  if (pb.allow_force_push !== false) problems.push('force push to main is allowed');
  return problems;
}

// ── parsing what GitLab and AWS tell us ──────────────────────────────────────────────────────────────────────────────────────
/** The lines of a job trace, with ANSI codes and carriage returns removed. */
const traceLines = (text) => String(text ?? '').split(/\r\n|\n|\r/).map((raw) => raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));

/** The `NEGCTL <name> PASS|FAIL` lines of a job trace (the line must be exactly that; a `NEGCTL-INFO` line is never one). */
export function parseNegctl(text) {
  const out = [];
  for (const line of traceLines(text)) {
    const m = /^NEGCTL (imds|gitlab-host|aws-env) (PASS|FAIL)$/.exec(line);
    if (m) out.push({ name: m[1], result: m[2] });
  }
  return out;
}

/** For each control that printed FAIL: the detail line the job printed just before it (`negctl: <name>: <detail>`), '' when there was none. */
export function parseNegctlFailures(text) {
  const out = [];
  const detail = {};
  for (const line of traceLines(text)) {
    const d = /^negctl: (imds|gitlab-host|aws-env): (.*)$/.exec(line);
    if (d) { detail[d[1]] = d[2]; continue; }
    const m = /^NEGCTL (imds|gitlab-host|aws-env) FAIL$/.exec(line);
    if (m) out.push({ name: m[1], detail: detail[m[1]] ?? '' });
  }
  return out;
}

/** The `NEGCTL-INFO baseline gitlab: reachable|not reachable|not checked (...)` lines of a job trace: whether the job could reach GitLab at all. */
export function parseBaseline(text) {
  const out = [];
  for (const line of traceLines(text)) {
    const m = /^NEGCTL-INFO baseline (gitlab): (reachable|not reachable|not checked)(?: \(.*\))?$/.exec(line);
    if (m) out.push({ name: m[1], state: m[2] });
  }
  return out;
}

/** A comment of the merge bot: `<!-- vitana-land:<code>:<head> -->` written by bot-land. Anyone else's copy of the marker is ignored. */
export function parseBotNote(note, botUser = BOT) {
  if (!note || typeof note.body !== 'string' || note.author?.username !== botUser) return null;
  const m = /<!-- vitana-land:([a-z_]+):([0-9a-f]{40}) -->/.exec(note.body);
  if (!m) return null;
  return { code: m[1], head: m[2], text: oneLine(note.body.replace(m[0], ''), 200) };
}

/** One DescribeAutoScalingGroups answer → { t, ok, total, active, desired }; active = machines Pending or InService (not Terminating). */
export function parseFleetSample(json, t) {
  const g = json?.AutoScalingGroups?.[0];
  if (!g) return { t, ok: false, error: 'the Auto Scaling group was not found' };
  const states = (Array.isArray(g.Instances) ? g.Instances : []).map((i) => String(i.LifecycleState ?? ''));
  return { t, ok: true, total: states.length, active: states.filter((s) => s === 'InService' || s.startsWith('Pending')).length, desired: Number.isInteger(g.DesiredCapacity) ? g.DesiredCapacity : null };
}

/** Launch activities since `sinceMs`: { launched, failed, failures } (a Failed or Cancelled launch is not a machine). */
export function countLaunches(activities, sinceMs) {
  let launched = 0;
  const failures = [];
  for (const a of Array.isArray(activities) ? activities : []) {
    if (!(Date.parse(a?.StartTime ?? '') >= sinceMs)) continue;
    if (!/^Launching a new EC2 instance/i.test(a.Description ?? '')) continue;
    if (a.StatusCode === 'Failed' || a.StatusCode === 'Cancelled') failures.push(oneLine(a.StatusMessage || a.Cause || a.Description, 180));
    else launched += 1;
  }
  return { launched, failed: failures.length, failures: failures.slice(0, 3) };
}

// ── the verdicts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** checks: [{ name, ok: true | false | null (could not be decided) | 'skip', detail }] → PASS | FAIL | NOT_PROVEN. */
export function settle(checks) {
  if (checks.some((c) => c.ok === false)) return 'FAIL';
  if (checks.some((c) => c.ok === null)) return 'NOT_PROVEN';
  return 'PASS';
}
const fmtSec = (s) => (s === null || s === undefined ? 'unknown' : s >= 120 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);

/**
 * A1: the fleet reaches 20 machines (12 agents), every job got a machine of its own (machines launched >= jobs run, from the ASG activity
 * history) and the group is back at 0 within 15 minutes of the last job.
 */
export function evalA1({ agents = LANE_COUNT, samples = [], activities = null, activitiesError = null, jobs = [], runStartMs, fleetRunner, limits = LIMITS }) {
  const valid = samples.filter((s) => s.ok);
  const firstError = samples.find((s) => !s.ok)?.error ?? activitiesError ?? null;
  const ran = jobs.filter((j) => j.started_at && Date.parse(j.started_at) >= runStartMs);
  const onFleet = ran.filter((j) => j.runner?.description === fleetRunner);
  const elsewhere = ran.length - onFleet.length;
  const peak = valid.reduce((m, s) => Math.max(m, s.total), 0);
  const peakActive = valid.reduce((m, s) => Math.max(m, s.active), 0);
  const launches = activities === null ? null : countLaunches(activities, runStartMs);
  const finishes = onFleet.map((j) => Date.parse(j.finished_at ?? '')).filter(Number.isFinite);
  const lastFinish = finishes.length ? Math.max(...finishes) : null;
  let secondsToZero = null;
  let zeroDecided = null;
  if (lastFinish !== null && valid.length) {
    const zero = valid.filter((s) => s.t >= lastFinish && s.total === 0 && s.desired === 0).sort((a, b) => a.t - b.t)[0];
    if (zero) { secondsToZero = Math.max(0, Math.round((zero.t - lastFinish) / 1000)); zeroDecided = secondsToZero <= limits.zeroSeconds; }
    else {
      const lastSeen = Math.max(...valid.map((s) => s.t));
      zeroDecided = (lastSeen - lastFinish) / 1000 > limits.zeroSeconds ? false : null;
    }
  }
  const checks = [];
  if (valid.length === 0) {
    checks.push({ name: 'sampling', ok: null, detail: `the ASG could not be read${firstError ? ` (${oneLine(firstError, 160)})` : ''}; ${IAM_HINT}` });
  } else if (agents === LANE_COUNT) {
    checks.push({ name: 'peak', ok: peak >= limits.minPeak, detail: `peak fleet size ${peak} machine(s) in the group, ${peakActive} of them booting or serving at the most (needs at least ${limits.minPeak})` });
  } else {
    checks.push({ name: 'peak', ok: 'skip', detail: `peak fleet size ${peak} machine(s) (the plan's ${limits.minPeak} is checked with ${LANE_COUNT} agents; this run had ${agents})` });
  }
  if (onFleet.length === 0) checks.push({ name: 'jobs', ok: null, detail: 'no job of the run was seen on the fleet runner' });
  else if (launches === null) checks.push({ name: 'own', ok: null, detail: `machines launched are unknown (the ASG activity history could not be read${activitiesError ? `: ${oneLine(activitiesError, 120)}` : ''}); ${IAM_HINT}` });
  else checks.push({ name: 'own', ok: launches.launched >= onFleet.length, detail: `${onFleet.length} job(s) ran, ${launches.launched} machine(s) launched (needs launched >= jobs run)` });
  if (elsewhere > 0) checks.push({ name: 'runner', ok: false, detail: `${elsewhere} job(s) did not run on the fleet runner ${fleetRunner}` });
  if (valid.length) {
    if (lastFinish === null) checks.push({ name: 'zero', ok: null, detail: 'no job finished, so the time to 0 machines is unknown' });
    else checks.push({ name: 'zero', ok: zeroDecided, detail: secondsToZero === null ? `the group was not back at 0 ${zeroDecided === false ? `within ${limits.zeroSeconds / 60} minutes of the last job` : 'when the run stopped waiting'}` : `back at 0 machines ${fmtSec(secondsToZero)} after the last job (needs at most ${limits.zeroSeconds / 60} min)` });
  }
  return {
    verdict: settle(checks), checks, peak, peakActive, jobsRun: onFleet.length, jobsElsewhere: elsewhere, launched: launches?.launched ?? null,
    failedLaunches: launches?.failed ?? 0, launchFailures: launches?.failures ?? [], secondsToZero, lastJobFinish: lastFinish, samplesRead: valid.length,
  };
}

/** A2: the three negative controls as the jobs printed them. `traces`: [{ jobId, name, status, text, error }] */
export function evalA2({ traces = [] }) {
  const per = Object.fromEntries(NEGCTL.map((n) => [n, { pass: 0, fail: 0 }]));
  const problems = [];
  const firstFail = {};
  const baseline = { reachable: 0, notReachable: 0, notChecked: 0 };
  let complete = 0;
  let unreadable = 0;
  for (const t of traces) {
    if (t.error) { unreadable += 1; continue; }
    const lines = parseNegctl(t.text);
    for (const l of lines) per[l.name][l.result === 'PASS' ? 'pass' : 'fail'] += 1;
    for (const f of parseNegctlFailures(t.text)) firstFail[f.name] ??= { jobId: t.jobId, detail: oneLine(f.detail, 240) };
    for (const b of parseBaseline(t.text)) baseline[b.state === 'reachable' ? 'reachable' : b.state === 'not reachable' ? 'notReachable' : 'notChecked'] += 1;
    const seen = new Set(lines.map((l) => l.name));
    if (NEGCTL.every((n) => seen.has(n))) complete += 1;
    else if (t.status === 'success') problems.push(`job #${t.jobId} succeeded but printed only ${[...seen].join(', ') || 'no'} negative control line(s)`);
  }
  const checks = NEGCTL.map((n) => {
    const c = per[n];
    if (c.fail > 0) return { name: n, ok: false, detail: `${n}: ${c.fail} FAIL, ${c.pass} PASS${firstFail[n]?.detail ? ` (job #${firstFail[n].jobId}: ${firstFail[n].detail})` : ''}` };
    if (c.pass === 0) return { name: n, ok: null, detail: `${n}: not seen in any job trace` };
    return { name: n, ok: true, detail: `${n}: ${c.pass} PASS, 0 FAIL` };
  });
  for (const p of problems) checks.push({ name: 'complete', ok: false, detail: p });
  // The baseline is information only (a skipped check: it never changes the verdict). It tells whether the jobs could reach GitLab at all, because a
  // container with no network passes the two network controls without any isolation having been shown.
  const seenBaseline = baseline.reachable + baseline.notReachable + baseline.notChecked;
  if (seenBaseline > 0) {
    const notes = [];
    if (baseline.notReachable > 0) notes.push(`NOT reached in ${baseline.notReachable}: the two network controls prove nothing there`);
    if (baseline.notChecked > 0) notes.push(`not checked in ${baseline.notChecked}`);
    checks.push({ name: 'baseline', ok: 'skip', detail: `baseline (information only): GitLab was reached from the job in ${baseline.reachable} of ${seenBaseline} trace(s)${notes.length ? `, ${notes.join(', ')}` : ''}` });
  }
  return { verdict: settle(checks), checks, per, baseline, jobsRead: traces.length, jobsComplete: complete, unreadable };
}

/**
 * A3: nobody can push to main, the only Maintainers are bot-land and the owner(s), every token expires in at most 90 days, and
 * `gitlab-settings.mjs check` exits 0. Each input may be null when it could not be read.
 */
export function evalA3({ protection, members, owners = [], tokens, settingsCheck, nowMs, maxDays = LIMITS.tokenDays }) {
  const checks = [];
  if (protection === null || protection === undefined) checks.push({ name: 'protection', ok: null, detail: 'the protection of main could not be read' });
  else {
    const problems = protectionProblems(protection);
    checks.push({ name: 'protection', ok: problems.length === 0, detail: problems.length === 0 ? 'main: push No one, merge Maintainers, no force push' : problems.join('; ') });
  }
  if (!Array.isArray(members)) checks.push({ name: 'maintainers', ok: null, detail: 'the members could not be read' });
  else {
    const maint = members.filter((m) => m.access_level >= 40).map((m) => m.username).sort();
    const allowed = new Set([BOT, ...owners]);
    const extra = maint.filter((u) => !allowed.has(u));
    const botOk = maint.includes(BOT);
    checks.push({ name: 'maintainers', ok: extra.length === 0 && botOk, detail: `Maintainers: ${maint.join(', ') || 'none'}${extra.length ? `; not allowed: ${extra.join(', ')}` : ''}${botOk ? '' : `; ${BOT} is not a Maintainer`}` });
  }
  if (!Array.isArray(tokens)) checks.push({ name: 'tokens', ok: null, detail: 'the tokens could not be read' });
  else {
    const rows = tokens.map((t) => {
      if (t.error) return { user: t.user, ok: null, text: `${t.user}: could not be read (${oneLine(t.error, 80)})` };
      const left = daysLeft(t.expires_at ?? null, nowMs);
      const ok = t.active === true && t.revoked !== true && Number.isFinite(left) && left > 0 && left <= maxDays;
      return { user: t.user, ok, left, text: `${t.user}: ${t.expires_at ? `${left} day(s) left` : 'no expiry'}${t.active === true ? '' : ', not active'}` };
    });
    const bad = rows.filter((r) => r.ok === false);
    const unknown = rows.filter((r) => r.ok === null);
    const latest = Math.max(0, ...rows.filter((r) => Number.isFinite(r.left)).map((r) => r.left));
    checks.push({ name: 'tokens', ok: bad.length ? false : unknown.length ? null : true, detail: bad.length || unknown.length ? [...bad, ...unknown].map((r) => r.text).join('; ') : `${rows.length} token(s) checked, the latest expires in ${latest} day(s) (needs at most ${maxDays})` });
  }
  if (!settingsCheck) checks.push({ name: 'settings check', ok: null, detail: 'the settings check did not run' });
  else checks.push({ name: 'settings check', ok: settingsCheck.exitCode === 0, detail: `gitlab-settings.mjs check exit ${settingsCheck.exitCode}${settingsCheck.exitCode === 3 ? ' (drift)' : ''}` });
  return { verdict: settle(checks), checks };
}

/**
 * A4: the bot lands the lanes one at a time, each exactly one commit on main with the VTID in its subject, in the order it landed them;
 * each control is refused with its reason. `lanes`: [{ id, title, state, mergedAt }]; `commits`: oldest first, { title, parent_ids };
 * `controls`: [{ id, expect, state, codes: [reason codes of the bot's comments] }].
 */
export function evalA4({ lanes = [], commits = null, controls = [] }) {
  const checks = [];
  const merged = lanes.filter((l) => l.state === 'merged').sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));
  checks.push({ name: 'landed', ok: merged.length === lanes.length && lanes.length > 0, detail: `${merged.length} of ${lanes.length} lane merge request(s) landed` });
  const times = merged.map((l) => Date.parse(l.mergedAt));
  checks.push({ name: 'one at a time', ok: times.every(Number.isFinite) && times.every((t, i) => i === 0 || t > times[i - 1]), detail: 'landing times strictly increase' });
  if (commits === null) checks.push({ name: 'commits', ok: null, detail: 'the commits on main could not be read' });
  else {
    const titles = commits.map((c) => c.title);
    checks.push({ name: 'one commit each', ok: [...titles].sort().join('\n') === lanes.map((l) => l.title).sort().join('\n'), detail: `${commits.length} commit(s) on main since the run began, ${lanes.length} expected, subjects are the merge request titles` });
    checks.push({ name: 'VTID', ok: commits.length > 0 && titles.every((t) => VTID_SUBJECT.test(t)), detail: 'every subject starts with a VTID' });
    checks.push({ name: 'squash', ok: commits.length > 0 && commits.every((c) => (c.parent_ids ?? []).length === 1), detail: 'every commit has exactly one parent (no merge commit)' });
    checks.push({ name: 'order', ok: titles.join('\n') === merged.map((l) => l.title).join('\n'), detail: 'the commits are in the order the merge requests landed' });
  }
  for (const c of controls) {
    if (c.state === 'merged') checks.push({ name: c.id, ok: false, detail: `${c.id} LANDED (it must be refused: ${c.expect})` });
    else if (c.codes.includes(c.expect)) checks.push({ name: c.id, ok: true, detail: `${c.id}: refused, reason ${c.expect}` });
    else checks.push({ name: c.id, ok: false, detail: `${c.id}: no refusal with reason ${c.expect} (the bot said: ${c.codes.join(', ') || 'nothing'})` });
  }
  return { verdict: settle(checks), checks, landed: merged.length };
}

/** A8: no job of the run ran on the legacy runner (it is retagged), and the settings check (which compares its tags and pause) is clean. */
export function evalA8({ jobs = [], runStartMs, legacyRunner, fleetRunner, settingsCheck, legacyPausedInFile }) {
  const ran = jobs.filter((j) => j.started_at && Date.parse(j.started_at) >= runStartMs);
  const onLegacy = ran.filter((j) => j.runner?.description === legacyRunner);
  const onFleet = ran.filter((j) => j.runner?.description === fleetRunner);
  const checks = [
    { name: 'legacy jobs', ok: onLegacy.length === 0, detail: `${onLegacy.length} job(s) ran on the legacy runner ${legacyRunner}` },
    { name: 'fleet jobs', ok: onFleet.length > 0 ? true : null, detail: `${onFleet.length} job(s) ran on the fleet runner ${fleetRunner}` },
    settingsCheck ? { name: 'settings check', ok: settingsCheck.exitCode === 0, detail: `the settings check (tags and pause of both runners) exit ${settingsCheck.exitCode}` } : { name: 'settings check', ok: null, detail: 'the settings check did not run' },
  ];
  return { verdict: settle(checks), checks, pauseNote: legacyPausedInFile === true ? 'the legacy runner is paused in gitlab-settings.json' : 'pausing the legacy runner (runners.legacy.paused: true) is the owner step after A1' };
}

// ── the machine: AWS CLI, settings check, clock ──────────────────────────────────────────────────────────────────────────────
async function realSettingsCheck({ configFile, url, env }) {
  const lines = [];
  const exitCode = await settingsMain(['check', '--config', configFile, '--url', url], { env, stdout: (l) => lines.push(String(l)) });
  return { exitCode, lines };
}

export function defaultDeps(env = process.env) {
  return {
    fetch: globalThis.fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    env,
    aws: settingsDefaultDeps(env).aws,
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    networkInterfaces: () => os.networkInterfaces(),
    seedDir: defaultSeedDir(),
    platformRoot: defaultPlatformRoot(),
    protectedGlobs: PROTECTED_GATE_PATHS,
    settingsCheck: realSettingsCheck,
    random: () => crypto.randomBytes(2).toString('hex'),
    seedSelfTest: realSeedSelfTest,
  };
}

/** The only AWS calls the rehearsal makes: read a token secret of an agent account, describe the fleet group and its activities. */
export function guardAws(aws) {
  return (args, o) => {
    const [service, operation] = args;
    const secret = args[args.indexOf('--secret-id') + 1] ?? '';
    const ok = (service === 'secretsmanager' && operation === 'get-secret-value' && SECRET_ID_OK.test(secret))
      || (service === 'autoscaling' && (operation === 'describe-auto-scaling-groups' || operation === 'describe-scaling-activities'));
    if (!ok) throw new Error(`refusing an AWS call the rehearsal does not make: ${oneLine(`${service} ${operation}`, 60)}`);
    return aws(args, o);
  };
}

const WRITES = Object.freeze([
  { method: 'POST', re: /^\/repository\/commits$/ },
  { method: 'POST', re: /^\/merge_requests$/ },
  { method: 'PUT', re: /^\/merge_requests\/\d+$/ },
  { method: 'DELETE', re: /^\/repository\/branches\/[A-Za-z0-9._%-]+$/ },
]);

/** Is this branch name `main` (also written refs/heads/main)? */
const isMain = (name) => String(name ?? '').replace(/^refs\/heads\//, '') === MAIN;
const branchOfPath = (rel) => { try { return decodeURIComponent(rel.slice('/repository/branches/'.length)); } catch { return null; } };

/**
 * The four writes the rehearsal makes, as method and path below the project (the same list `writer` enforces). Nothing else is allowed.
 * None may be aimed at the branch `main`: a commit must name another branch in its body, and `main` is not a branch to delete.
 */
export function isAllowedWrite(method, rel, body) {
  if (!WRITES.some((w) => w.method === method && w.re.test(rel))) return false;
  if (method === 'POST' && rel === '/repository/commits') return typeof body?.branch === 'string' && body.branch.trim() !== '' && !isMain(body.branch);
  if (method === 'DELETE') { const branch = branchOfPath(rel); return branch !== null && !isMain(branch); }
  return true;
}

/** Reads go through this: a GitLab client with no write method. */
const observer = (client) => ({
  get: (p, o) => client.get(p, o),
  paginate: (p, o) => client.paginate(p, o),
  raw: (p, o) => client.raw('GET', p, o),
  text: (p, o) => client.request('GET', p, { ...o, expect: 'text' }),
});

/** The writes of one account: four calls, all inside the rehearsal project (the path is built here from the project id), none aimed at main, each sent once. */
export function writer(ctx, username) {
  const client = ctx.clients.get(username);
  const send = (method, rel, body) => {
    if (!isAllowedWrite(method, rel, body)) throw new Error(`refusing a write the rehearsal does not make: ${method} ${rel}`);
    return client.request(method, `${ctx.P}${rel}`, { body, retries: 0 });
  };
  return {
    commit: (body) => send('POST', '/repository/commits', body),
    openMr: (body) => send('POST', '/merge_requests', body),
    closeMr: (iid) => send('PUT', `/merge_requests/${iid}`, { state_event: 'close' }),
    deleteBranch: (branch) => send('DELETE', `/repository/branches/${enc(branch)}`),
  };
}

async function readToken(aws, region, username, redactor) {
  const id = SECRETS.agent(username);
  try {
    const { stdout } = await aws(['secretsmanager', 'get-secret-value', '--secret-id', id, '--query', 'SecretString', '--output', 'text', '--region', region]);
    const v = String(stdout).replace(/\r?\n$/, '').trim();
    if (v === '' || v === 'None') return { error: `the secret ${id} is empty: the settings sync has not stored a token for ${username} yet` };
    if (!TOKEN_OK.test(v)) return { error: `the secret ${id} does not hold a token` };
    redactor.add(v);
    return { token: v };
  } catch (e) {
    return { error: `the secret ${id} could not be read: ${oneLine(redactor(`${e?.message ?? e}`), 200)}` };
  }
}

const errText = (redactor, e) => oneLine(redactor(`${e?.message ?? e}`), 220);

// ── safety checks that read GitLab ──────────────────────────────────────────────────────────────────────────────────────────
/** The live side of the refusal: [] when the live project is the native scratch project the file says it is. */
export async function liveProblems(obs, P) {
  const problems = [];
  const read = async (what, fn) => { try { return { value: await fn() }; } catch (e) { problems.push(`${what} could not be read (${e instanceof GitLabApiError ? `HTTP ${e.status || e.code}` : oneLine(e?.message, 80)}), so it was not proven safe`); return null; } };
  const info = await read('the project', () => obs.get(P));
  if (info) {
    if (info.value?.archived === true) problems.push('the project is archived');
    if (info.value?.default_branch !== MAIN) problems.push(`the default branch is "${info.value?.default_branch}", not ${MAIN}`);
    if (info.value?.mirror === true) problems.push('the live project is a mirror');
  }
  const hooks = await read('the webhooks', () => obs.get(`${P}/hooks`));
  if (hooks && (!Array.isArray(hooks.value) || hooks.value.length > 0)) problems.push(`the live project has ${Array.isArray(hooks.value) ? hooks.value.length : 'unknown'} webhook(s)`);
  const mirrors = await read('the remote mirrors', () => obs.get(`${P}/remote_mirrors`));
  if (mirrors && (!Array.isArray(mirrors.value) || mirrors.value.length > 0)) problems.push(`the live project has ${Array.isArray(mirrors.value) ? mirrors.value.length : 'unknown'} remote mirror(s)`);
  const pb = await read('the protection of main', () => obs.get(`${P}/protected_branches/${MAIN}`));
  if (pb) problems.push(...protectionProblems(pb.value).map((p) => `the live project: ${p}`));
  return problems;
}

// ── the run ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleepFor = (ctx, ms) => ctx.deps.sleep(Math.max(1, Math.round(ms)));
const minutes = (ms) => Math.round(ms / 60000);

async function sampleFleet(ctx) {
  const t = ctx.now();
  let s;
  try {
    const { stdout } = await ctx.aws(['autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names', ctx.asgName, '--region', ctx.region, '--output', 'json']);
    s = parseFleetSample(JSON.parse(stdout), t);
  } catch (e) {
    s = { t, ok: false, error: oneLine(ctx.redactor(`${e?.message ?? e} ${e?.stderr ?? ''}`), 220) };
  }
  ctx.model.samples.push(s);
  // A failed read is tried again at the next poll, however many fail in a row: a throttled call at the start must not end the sampling for the run
  // (a denial is caught before the run, in prepare()). Said once for each run of failures.
  ctx.failStreak = s.ok ? 0 : ctx.failStreak + 1;
  if (ctx.failStreak === 3) ctx.model.notes.push(`the fleet group could not be read 3 times in a row (${s.error}); it is read again on every poll`);
  return s;
}

async function listJobsSince(ctx, sinceMs) {
  const jobs = [];
  for (let page = 1; page <= 100; page++) {
    const res = await ctx.obs.raw(`${ctx.P}/jobs`, { query: { per_page: 100, page } });
    const list = Array.isArray(res.data) ? res.data : [];
    jobs.push(...list.filter((j) => Date.parse(j.created_at) >= sinceMs));
    const oldest = list.length ? Date.parse(list[list.length - 1].created_at) : 0;
    if (!res.headers.get('x-next-page') || list.length === 0 || oldest < sinceMs) break;
  }
  return jobs;
}

async function listBlobs(ctx) {
  try {
    const tree = await ctx.obs.paginate(`${ctx.P}/repository/tree`, { query: { ref: MAIN, recursive: true } });
    return new Map(tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.id]));
  } catch (e) {
    if (e instanceof GitLabApiError && e.status === 404) return new Map();
    throw e;
  }
}

/** The commits on main after `baseSha`, oldest first (the history is read newest first, page by page, until the base is found). */
async function commitsSince(ctx, baseSha) {
  const found = [];
  for (let page = 1; page <= 20; page++) {
    const res = await ctx.obs.raw(`${ctx.P}/repository/commits`, { query: { ref_name: MAIN, per_page: 100, page } });
    const list = Array.isArray(res.data) ? res.data : [];
    const at = list.findIndex((c) => c.id === baseSha);
    if (at >= 0) { found.push(...list.slice(0, at)); return found.reverse(); }
    found.push(...list);
    if (!res.headers.get('x-next-page') || list.length === 0) break;
  }
  throw new Error('the commit main had before the lanes was not found in its history');
}

const mrIidOfJob = (job) => Number(/^refs\/merge-requests\/(\d+)\/head$/.exec(job?.pipeline?.ref ?? '')?.[1]) || null;

function progress(ctx, force = false) {
  const t = ctx.now();
  if (!force && t - ctx.lastProgress < 60_000) return;
  ctx.lastProgress = t;
  const lanes = ctx.items.filter((i) => i.kind === 'land');
  const controls = ctx.items.filter((i) => i.kind === 'control');
  const last = [...ctx.model.samples].reverse().find((s) => s.ok);
  ctx.say(`t+${minutes(t - ctx.startMs)}m landed ${lanes.filter((i) => i.state === 'merged').length}/${lanes.length}, controls refused ${controls.filter((i) => i.codes.includes(i.expect)).length}/${controls.length}, fleet ${last ? `${last.total} (peak ${ctx.model.samples.reduce((m, s) => (s.ok ? Math.max(m, s.total) : m), 0)})` : 'unread'}`);
}

/** Open one merge request: the builder's commit creates the branch from main, then the seat account opens the request. */
async function openItem(ctx, item, commitBody) {
  const w = writer(ctx, item.seat);
  ctx.say(`opening ${item.id} as ${item.seat}: branch ${item.branch}`);
  await w.commit(commitBody);
  const mr = await w.openMr({ source_branch: item.branch, target_branch: MAIN, title: item.title, description: mrDescription(item, ctx.runId), remove_source_branch: true, squash: true });
  Object.assign(item, { iid: mr.iid, head: mr.sha, state: mr.state ?? 'opened', createdAt: mr.created_at ?? null, url: mr.web_url ?? null, codes: [], notes: [] });
  ctx.byIid.set(item.iid, item);
  return mr;
}

const hex4 = (ctx) => ctx.deps.random();
const seatSession = (ctx, item) => { if (!ctx.seatSessions.has(item.seat)) ctx.seatSessions.set(item.seat, sessionIdFor('seat', item.seat, ctx.startMs, hex4(ctx))); return ctx.seatSessions.get(item.seat); };

async function currentHead(ctx, item) {
  const mr = await ctx.obs.get(`${ctx.P}/merge_requests/${item.iid}`);
  if (!SHA.test(mr?.sha ?? '')) throw new Error(`merge request !${item.iid} has no head`);
  return mr.sha;
}
const laneText = (ctx, item) => ctx.obs.text(`${ctx.P}/repository/files/${enc(item.laneFile)}/raw`, { query: { ref: item.branch } });

/** The reviewer account commits the accept on top of the branch (the form of acceptMessage); the commit is made by agent-reviewer. */
async function reviewItem(ctx, item) {
  const reviewedHead = await currentHead(ctx, item);
  const text = await laneText(ctx, item);
  ctx.say(`reviewing ${item.id} as ${REVIEWER}: accept of head ${reviewedHead.slice(0, 8)}`);
  const commit = await writer(ctx, REVIEWER).commit(reviewCommitBody(item, { session: ctx.reviewerSession, reviewedHead, laneText: text, ms: ctx.now() }));
  Object.assign(item, { reviewedHead, reviewCommit: commit?.id ?? null });
  return commit;
}

/** The first review of a run: the bot trusts only a commit found in a push event of agent-reviewer, so prove the event exists. */
async function expectPushEvent(ctx, commitId) {
  const until = ctx.now() + 120_000;
  for (;;) {
    const events = await ctx.obs.get(`${ctx.P}/events`, { query: { action: 'pushed', per_page: 100 } });
    if (Array.isArray(events) && events.some((e) => e?.author_username === REVIEWER && e.push_data?.commit_to === commitId)) return;
    if (ctx.now() >= until) {
      throw new RunStop(`${REVIEWER} committed ${String(commitId).slice(0, 8)}, but GitLab shows no push event of ${REVIEWER} for it after 2 minutes. The merge bot trusts only a review commit found in a push event of the reviewer, so it would refuse every accept. A commit made through the API may not create one on this GitLab: the review commit has to be pushed with git`);
    }
    await sleepFor(ctx, 5000);
  }
}

async function refreshMrs(ctx) {
  const iids = ctx.items.map((i) => i.iid).filter(Boolean);
  if (iids.length === 0) return;
  const list = await ctx.obs.paginate(`${ctx.P}/merge_requests`, { query: { state: 'all', iids } });
  for (const mr of list) {
    const item = ctx.byIid.get(mr.iid);
    if (!item) continue;
    Object.assign(item, { state: mr.state, mergedAt: mr.merged_at ?? item.mergedAt ?? null, head: mr.sha ?? item.head });
  }
}

async function readNotes(ctx, item) {
  const notes = await ctx.obs.paginate(`${ctx.P}/merge_requests/${item.iid}/notes`, { query: { sort: 'asc', order_by: 'created_at' } });
  item.notes = notes.map((n) => parseBotNote(n)).filter(Boolean);
  item.codes = [...new Set(item.notes.map((n) => n.code))];
}

async function waitForMerged(ctx, item, until) {
  for (;;) {
    await refreshMrs(ctx);
    if (item.state === 'merged') return true;
    if (item.state === 'closed') throw new RunStop(`merge request !${item.iid} (${item.id}) was closed`);
    await sampleFleet(ctx);
    progress(ctx);
    if (ctx.now() >= until) return false;
    await sleepFor(ctx, Math.min(ctx.pollMs, until - ctx.now()));
  }
}

async function hygiene(ctx) {
  const open = ctx.openAtStart.filter((mr) => String(mr.source_branch).startsWith(`${SLUG}/`));
  for (const mr of open) {
    ctx.say(`closing !${mr.iid} left open by an earlier run (${mr.source_branch})`);
    await writer(ctx, ctx.seats[0]).closeMr(mr.iid);
  }
  ctx.model.closedAtStart = open.map((mr) => mr.iid);
}

async function seedPhase(ctx) {
  const manifest = readManifest(ctx.deps.seedDir);
  const existing = await listBlobs(ctx);
  const diff = diffSeed(ctx.seedFiles, existing, manifest.createOnly);
  if (diff.create.length + diff.update.length === 0) { ctx.model.seed = { status: 'present', files: ctx.seedFiles.size }; return; }
  const item = { ...seedItem({ runId: ctx.runId, seat: ctx.seats[0] }), seed: true };
  ctx.items.push(item);
  const t0 = ctx.now();
  await openItem(ctx, item, seedCommitBody(item, diff, ctx.seedFiles, seatSession(ctx, item)));
  const review = await reviewItem(ctx, item);
  await expectPushEvent(ctx, review.id);
  const landed = await waitForMerged(ctx, item, Math.min(ctx.deadline, t0 + 25 * 60_000));
  ctx.model.seed = { status: landed ? 'landed' : 'not landed', iid: item.iid, minutes: minutes(ctx.now() - t0), created: diff.create.length, updated: diff.update.length };
  if (!landed) {
    await readNotes(ctx, item).catch(() => {});
    throw new RunStop(`the seed merge request !${item.iid} did not land within 25 minutes (bot said: ${item.codes.join(', ') || 'nothing'}); no other merge request was opened`);
  }
  ctx.items.splice(ctx.items.indexOf(item), 1);
  ctx.byIid.delete(item.iid);
}

async function wave1(ctx) {
  ctx.wave1Ms = ctx.now();
  for (const item of ctx.plan.order) {
    ctx.items.push(item);
    await openItem(ctx, item, builderCommitBody(item, { runId: ctx.runId, session: seatSession(ctx, item) }));
  }
}

/**
 * Has a job of one of this run's merge requests started? The jobs of the first wave last seconds and each one's machine is deleted when it ends, so
 * waiting for every one of them would let the machines of the first wave be gone before the second wave asks for its own. The first start is enough:
 * the others are then still waiting for a machine or booting, which is a machine in the group all the same. A job on a pipeline of main does not count.
 */
async function firstJobsStarted(ctx) {
  const jobs = await listJobsSince(ctx, ctx.wave1Ms);
  const ours = new Set(ctx.plan.order.map((item) => item.iid).filter(Boolean));
  return jobs.some((j) => j.started_at && ours.has(mrIidOfJob(j)));
}

async function wave2(ctx) {
  const until = Math.min(ctx.deadline, ctx.now() + 8 * 60_000);
  for (;;) {
    if (await firstJobsStarted(ctx)) break;
    await sampleFleet(ctx);
    progress(ctx);
    if (ctx.now() >= until) { ctx.model.notes.push('no first-wave job had started after 8 minutes; the review commits were pushed anyway'); break; }
    await sleepFor(ctx, Math.min(ctx.pollMs, until - ctx.now()));
  }
  for (const item of ctx.plan.order) {
    if (item.control === 'no_review') continue;
    if (item.control === 'builder_accept') {
      const reviewedHead = await currentHead(ctx, item);
      const text = await laneText(ctx, item);
      ctx.say(`${item.id}: ${item.seat} writes an accept itself (it must be refused)`);
      await writer(ctx, item.seat).commit(forgedAcceptBody(item, { session: seatSession(ctx, item), reviewedHead, laneText: text, ms: ctx.now() }));
      continue;
    }
    const commit = await reviewItem(ctx, item);
    if (!ctx.pushEventSeen) { await expectPushEvent(ctx, commit.id); ctx.pushEventSeen = true; }
    if (item.control === 'stale_review') {
      ctx.say(`${item.id}: ${item.seat} changes code after the review (it must be refused)`);
      await writer(ctx, item.seat).commit(staleChangeBody(item, { runId: ctx.runId, session: seatSession(ctx, item) }));
    }
  }
}

async function landPhase(ctx) {
  const lanes = ctx.items.filter((i) => i.kind === 'land');
  const controls = ctx.items.filter((i) => i.kind === 'control');
  const until = ctx.landDeadline;
  let lanesDoneAt = null;
  for (;;) {
    await refreshMrs(ctx);
    for (const c of controls) if (!c.codes.includes(c.expect)) await readNotes(ctx, c);
    await sampleFleet(ctx);
    progress(ctx);
    if (lanes.every((l) => l.state === 'merged')) lanesDoneAt ??= ctx.now();
    const refused = controls.every((c) => c.codes.includes(c.expect));
    if (lanesDoneAt !== null && (refused || ctx.now() - lanesDoneAt >= 5 * 60_000)) return;
    if (ctx.now() >= until) {
      // Say whether the bot was broken or only slow: a bot that landed a lane in the last minutes was still working, and a longer budget would have helped.
      const landed = lanes.filter((l) => l.state === 'merged');
      const last = Math.max(...landed.map((l) => Date.parse(l.mergedAt)).filter(Number.isFinite));
      const slow = Number.isFinite(last) && ctx.now() - last < STILL_LANDING_MIN * 60_000;
      ctx.model.notes.push(`stopped waiting for the bot after ${minutes(until - ctx.startMs)} minutes; ${landed.length} of ${lanes.length} lanes had landed${slow ? `, the last one less than ${STILL_LANDING_MIN} minutes before: the bot was still landing, so the budget was too short, not the bot broken (a longer --max-minutes also needs a longer Systems Manager timeout in m2.sh, which allows 7200 seconds)` : ''}`);
      return;
    }
    await sleepFor(ctx, Math.min(ctx.pollMs, until - ctx.now()));
  }
}

async function settleJobs(ctx, until) {
  for (;;) {
    ctx.model.jobs = await listJobsSince(ctx, ctx.startMs);
    if (!ctx.model.jobs.some((j) => NON_FINAL.has(j.status))) return;
    await sampleFleet(ctx);
    progress(ctx);
    if (ctx.now() >= until) { ctx.model.notes.push('some jobs had not finished when the run stopped waiting'); return; }
    await sleepFor(ctx, Math.min(ctx.pollMs, until - ctx.now()));
  }
}

async function cleanup(ctx) {
  for (const item of ctx.items.filter((i) => i.kind === 'control' && i.iid)) {
    const w = writer(ctx, item.seat);
    if (item.state === 'opened') { ctx.say(`closing control !${item.iid} (${item.id})`); await w.closeMr(item.iid); }
    ctx.say(`deleting branch ${item.branch}`);
    await w.deleteBranch(item.branch).catch((e) => { if (!(e instanceof GitLabApiError && e.status === 404)) throw e; });
  }
}

async function waitForZero(ctx) {
  const finishes = ctx.model.jobs.filter((j) => j.runner?.description === ctx.config.runners.fleet.description).map((j) => Date.parse(j.finished_at ?? '')).filter(Number.isFinite);
  if (finishes.length === 0) return;
  const last = Math.max(...finishes);
  const limit = Math.min(ctx.deadline, last + (LIMITS.zeroSeconds + 60) * 1000);
  let failed = 0; // waiting for a group that cannot be read is pointless: three failed reads in a row end the wait
  for (;;) {
    const s = await sampleFleet(ctx);
    if (s.ok && s.t >= last && s.total === 0 && s.desired === 0) return;
    failed = s.ok ? 0 : failed + 1;
    if (failed >= 3 || ctx.now() >= limit) return;
    progress(ctx);
    await sleepFor(ctx, Math.min(ctx.pollMs, limit - ctx.now()));
  }
}

/** Runs one reading step; a failure is noted and gives `null`, so one unreadable fact never hides the others in the report. */
async function attempt(ctx, label, fn) {
  try { return await fn(); } catch (e) { ctx.model.notes.push(`${label}: ${errText(ctx.redactor, e)}`); return null; }
}

async function collect(ctx) {
  const { model } = ctx;
  const required = new Set(ctx.project.required_jobs);
  model.jobs = (await attempt(ctx, 'jobs', () => listJobsSince(ctx, ctx.startMs))) ?? model.jobs;
  if (model.jobs.length) {
    model.traces = [];
    for (const j of model.jobs.filter((x) => required.has(x.name) && x.started_at && ['success', 'failed'].includes(x.status))) {
      try { model.traces.push({ jobId: j.id, name: j.name, status: j.status, text: await ctx.obs.text(`${ctx.P}/jobs/${j.id}/trace`) }); } catch (e) { model.traces.push({ jobId: j.id, name: j.name, status: j.status, error: errText(ctx.redactor, e) }); }
    }
  }
  if (ctx.baseSha) model.commits = await attempt(ctx, 'commits on main', () => commitsSince(ctx, ctx.baseSha));
  for (const item of ctx.items) if (item.iid) await attempt(ctx, `notes of !${item.iid}`, () => readNotes(ctx, item));
  model.protection = await attempt(ctx, 'protection of main', () => ctx.obs.get(`${ctx.P}/protected_branches/${MAIN}`));
  model.members = await attempt(ctx, 'members', () => ctx.obs.paginate(`${ctx.P}/members/all`));
  model.tokens = [];
  for (const a of ctx.accounts) {
    try {
      const t = await ctx.clients.get(a.username).get('/personal_access_tokens/self');
      model.tokens.push({ user: a.username, expires_at: t?.expires_at ?? null, active: t?.active === true, revoked: t?.revoked === true });
    } catch (e) { model.tokens.push({ user: a.username, error: errText(ctx.redactor, e) }); }
  }
  model.settingsCheck = await attempt(ctx, 'settings check', () => ctx.deps.settingsCheck({ configFile: ctx.configFile, url: ctx.opts.url, env: ctx.deps.env }));
  try {
    const { stdout } = await ctx.aws(['autoscaling', 'describe-scaling-activities', '--auto-scaling-group-name', ctx.asgName, '--max-items', String(ACTIVITIES_MAX_ITEMS), '--region', ctx.region, '--output', 'json']);
    model.activities = JSON.parse(stdout).Activities ?? [];
  } catch (e) { model.activitiesError = oneLine(ctx.redactor(`${e?.message ?? e} ${e?.stderr ?? ''}`), 220); }
}

function verdicts(ctx) {
  const { model } = ctx;
  const lanes = ctx.items.filter((i) => i.kind === 'land');
  const controls = ctx.items.filter((i) => i.kind === 'control');
  const fleetRunner = ctx.config.runners.fleet.description;
  model.a1 = evalA1({ agents: ctx.opts.agents, samples: model.samples, activities: model.activities, activitiesError: model.activitiesError, jobs: model.jobs, runStartMs: ctx.startMs, fleetRunner });
  model.a2 = evalA2({ traces: model.traces });
  model.a3 = evalA3({ protection: model.protection, members: model.members, owners: ctx.config.owners, tokens: model.tokens.length ? model.tokens : null, settingsCheck: model.settingsCheck, nowMs: ctx.now() });
  model.a4 = evalA4({ lanes: lanes.map((l) => ({ id: l.id, title: l.title, state: l.state, mergedAt: l.mergedAt })), commits: model.commits, controls: controls.map((c) => ({ id: c.id, expect: c.expect, state: c.state, codes: c.codes ?? [] })) });
  model.a8 = evalA8({ jobs: model.jobs, runStartMs: ctx.startMs, legacyRunner: ctx.config.runners.legacy.description, fleetRunner, settingsCheck: model.settingsCheck, legacyPausedInFile: ctx.config.runners.legacy.paused });
}

// ── the report ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const LABEL = { PASS: 'PASS', FAIL: 'FAIL', NOT_PROVEN: 'NOT PROVEN' };
const mark = (c) => (c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : c.ok === 'skip' ? 'skip' : '??  ');

export function exitCodeOf(model) {
  const all = [model.a1, model.a2, model.a3, model.a4, model.a8];
  return !model.stop && all.every((a) => a?.verdict === 'PASS') ? 0 : 1;
}

export function renderReport(ctx) {
  const { model } = ctx;
  const L = [];
  const section = (title, a, extra = []) => {
    L.push('', `${title.padEnd(14)} ${LABEL[a?.verdict] ?? 'NOT PROVEN'}`);
    for (const c of a?.checks ?? []) L.push(`  [${mark(c)}] ${c.detail}`);
    for (const e of extra) L.push(`  ${e}`);
  };
  const took = minutes((model.finishedMs ?? ctx.now()) - ctx.startMs);
  const code = exitCodeOf(model);
  const failing = [['A1', model.a1], ['A2', model.a2], ['A3', model.a3], ['A4', model.a4], ['A8', model.a8]];
  L.push('REHEARSAL REPORT (plan eng-gitlab-m2, section 3.8)');
  L.push(`run ${ctx.runId} | project ${ctx.projectPath} | ${ctx.opts.agents} agents + ${CONTROLS.length} controls | started ${new Date(ctx.startMs).toISOString()} | took ${took} min`);
  L.push(`RESULT: ${code === 0 ? 'PASS' : model.stop ? 'INCOMPLETE' : 'FAIL'}   ${failing.map(([n, a]) => `${n} ${LABEL[a?.verdict] ?? 'NOT PROVEN'}`).join(' | ')}`);
  if (model.stop) L.push(`STOPPED in ${model.stop.phase}: ${model.stop.message}`);
  const seed = model.seed;
  L.push('', `SEED          ${seed.status}${seed.iid ? ` through !${seed.iid} in ${seed.minutes} min (${seed.created} file(s) created, ${seed.updated} updated)` : seed.files ? ` (${seed.files} file(s) already on main)` : ''}`);
  const bySeat = {};
  for (const i of ctx.items.filter((x) => !x.seed && x.iid)) bySeat[i.seat] = (bySeat[i.seat] ?? 0) + 1;
  L.push(`OPENED        ${Object.entries(bySeat).map(([s, n]) => `${s} ${n}`).join(', ') || 'none'}`);
  section('A1 FLEET', model.a1);
  section('A2 ISOLATION', model.a2, model.a2 ? [`traces read ${model.a2.jobsRead}, with all three lines ${model.a2.jobsComplete}, unreadable ${model.a2.unreadable}`] : []);
  const settingsLines = (model.settingsCheck?.exitCode ?? 0) !== 0 ? (model.settingsCheck.lines ?? []).filter((l) => /^(drift|warning|LICENCE|gitlab-settings)/.test(l)).slice(0, 6).map((l) => `settings check said: ${oneLine(l, 200)}`) : [];
  section('A3 ACCESS', model.a3, settingsLines);
  section('A4 LANDING', model.a4);
  section('A8 LEGACY', model.a8, model.a8 ? [model.a8.pauseNote] : []);

  L.push('', 'COMMITS ON MAIN (oldest first)');
  if (!model.commits) L.push('  not read');
  else if (model.commits.length === 0) L.push('  none');
  else model.commits.forEach((c, i) => L.push(`  ${String(i + 1).padStart(2)}. ${oneLine(c.title, 140)}${(c.parent_ids ?? []).length === 1 ? '' : '  <-- not one parent'}`));

  L.push('', 'BOT REFUSALS (comments of bot-land on the controls)');
  for (const c of ctx.items.filter((i) => i.kind === 'control')) {
    L.push(`  ${c.id.padEnd(20)} expected ${c.expect.padEnd(20)} bot said: ${(c.codes ?? []).join(', ') || 'nothing'}${c.state === 'merged' ? '  <-- LANDED' : ''}`);
  }
  const laneNotes = {};
  for (const l of ctx.items.filter((i) => i.kind === 'land')) for (const n of l.notes ?? []) laneNotes[n.code] = (laneNotes[n.code] ?? 0) + 1;
  if (Object.keys(laneNotes).length) L.push(`  comments on the lane merge requests: ${Object.entries(laneNotes).map(([k, v]) => `${k} x${v}`).join(', ')} (no_review before the review commit is expected; so can be review_forged right after it, because GitLab records the push of a review a moment after the push and the next tick of the bot lands the lane; what counts is the lane that did not land)`);

  L.push('', 'NEGATIVE CONTROLS (from the job traces)');
  for (const n of NEGCTL) L.push(`  ${n.padEnd(12)} PASS ${model.a2?.per?.[n]?.pass ?? 0}  FAIL ${model.a2?.per?.[n]?.fail ?? 0}`);

  const problems = [];
  const stuck = model.jobs.filter((j) => NON_FINAL.has(j.status));
  for (const j of stuck) problems.push(`job #${j.id} ${j.name} is still ${j.status} (created ${j.created_at}${mrIidOfJob(j) ? `, merge request !${mrIidOfJob(j)}` : ''})`);
  if (model.a1 && model.a1.failedLaunches > 0) problems.push(`${model.a1.failedLaunches} machine launch(es) failed: ${model.a1.launchFailures.join(' | ')}`);
  for (const l of ctx.items.filter((i) => i.kind === 'land' && i.state !== 'merged')) problems.push(`${l.id} (!${l.iid ?? '?'}) did not land (${l.state ?? 'not opened'}); the bot said: ${(l.codes ?? []).join(', ') || 'nothing'}`);
  if (problems.length || model.notes.length) {
    L.push('', 'PROBLEMS AND NOTES');
    for (const p of problems) L.push(`  - ${p}`);
    for (const n of model.notes) L.push(`  - ${n}`);
  }
  return L.join('\n');
}

// ── the fleet group, read once before anything is written ────────────────────────────────────────────────────────────────────
const DENIED = /AccessDenied|UnauthorizedOperation|UnauthorizedAccess|not authorized/i;
const withoutRunnerPrefix = (message) => String(message ?? '').replace(/^aws \S+ \S+ failed \(exit \d+\): /, '');

/**
 * One read of each operation that A1 needs, before anything is written: describe-auto-scaling-groups of the fleet group and
 * describe-scaling-activities of it (a single item). → { denied: ['<action> is denied (<why>)'], failed: ['<operation>: <why>'] }.
 * A denial can never be repaired by waiting, so prepare() refuses on it; any other failure (a throttled call) is only noted.
 */
export async function fleetReadProblems(aws, { region, asgName, redactor = (s) => s }) {
  const reads = [
    { action: IAM_ACTIONS[0], op: 'describe-auto-scaling-groups', args: ['autoscaling', 'describe-auto-scaling-groups', '--auto-scaling-group-names', asgName, '--region', region, '--output', 'json'] },
    { action: IAM_ACTIONS[1], op: 'describe-scaling-activities', args: ['autoscaling', 'describe-scaling-activities', '--auto-scaling-group-name', asgName, '--max-items', '1', '--region', region, '--output', 'json'] },
  ];
  const denied = [];
  const failed = [];
  for (const read of reads) {
    try { await aws(read.args); } catch (e) {
      const why = oneLine(redactor(withoutRunnerPrefix(e?.message ?? e)), 200);
      if (DENIED.test(`${e?.message ?? e} ${e?.stderr ?? ''}`)) denied.push(`${read.action} is denied (${why})`);
      else failed.push(`${read.op}: ${why}`);
    }
  }
  return { denied, failed };
}

// ── the seed must pass its own tests, here, before it is put on main ─────────────────────────────────────────────────────────
/** The `*.test.mjs` files under test/ of a seed tree, sorted, as paths relative to its root. */
function seedTestFiles(root) {
  const found = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.test.mjs')) found.push(path.relative(root, p));
    }
  };
  if (fs.existsSync(path.join(root, 'test'))) walk(path.join(root, 'test'));
  return found;
}

/**
 * The tests of the built seed, run the way the job `unit` runs them (`node --test` on test/**, no install) in a temporary directory that is removed
 * afterwards: the part of `npm test` that decides its exit code. The negative controls are not run (they would probe this machine, not a job).
 * The child gets a PATH and a temporary directory and nothing else of this environment. → { ok, output }
 */
export async function realSeedSelfTest(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rehearse-seed-selftest-'));
  try {
    for (const [p, text] of files) {
      const f = path.join(dir, p);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
    }
    const tests = seedTestFiles(dir);
    if (tests.length === 0) return { ok: false, output: 'the seed has no test files under test/' };
    const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: { PATH: process.env.PATH ?? '', TMPDIR: os.tmpdir() } });
    const output = `${r.error ? `${r.error.message}\n` : ''}${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim();
    return { ok: r.status === 0 && !r.error, output };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** The lines of a failed test run that say what failed (or its first lines), as one line for a refusal. */
const failureExcerpt = (output) => {
  const lines = String(output ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hits = lines.filter((l) => /not ok|✖|rror|Cannot find|ERR_/.test(l));
  return oneLine((hits.length ? hits : lines).slice(0, 4).join(' | '), 320);
};

// ── preparing: every check that can refuse, before the first write ───────────────────────────────────────────────────────────
async function prepare(opts, deps, io) {
  const { redactor, say } = io;
  const configFile = opts.settings ?? defaultConfigPath();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(configFile, 'utf8')); } catch (e) { throw new Refusal([`the settings file ${configFile} cannot be read (${oneLine(e.message, 100)})`]); }
  const fileCheck = checkSettingsFile(raw, opts.project);
  if (!fileCheck.ok) throw new Refusal(fileCheck.problems);
  const region = String(deps.env?.REGION ?? '');
  if (!REGION_OK.test(region)) throw new Refusal(['REGION is not set to an AWS region (for example eu-central-1); /etc/vitana/env sets it']);
  const { config, project } = fileCheck;
  const accounts = config.accounts.filter((a) => a.projects.includes(opts.project));
  const seats = accounts.filter((a) => a.role === 'developer' && a.username.startsWith(SEAT_PREFIX)).map((a) => a.username);
  const problems = [];
  if (seats.length === 0) problems.push(`no seat account (${SEAT_PREFIX}*, developer) is a member of ${opts.project} in gitlab-settings.json`);
  if (!accounts.some((a) => a.username === REVIEWER && a.role === 'developer')) problems.push(`${REVIEWER} is not a developer of ${opts.project} in gitlab-settings.json`);
  if (!accounts.some((a) => a.username === BOT && a.role === 'maintainer')) problems.push(`${BOT} is not a maintainer of ${opts.project} in gitlab-settings.json`);
  if (problems.length) throw new Refusal(problems);

  const aws = guardAws(deps.aws);
  const tokens = new Map();
  for (const a of accounts) {
    const r = await readToken(aws, region, a.username, redactor);
    if (r.error) problems.push(r.error); else tokens.set(a.username, r.token);
  }
  if (problems.length) throw new Refusal(problems);

  const clients = new Map();
  try {
    for (const a of accounts) clients.set(a.username, createClient({ baseUrl: opts.url, token: tokens.get(a.username), fetch: deps.fetch, sleep: deps.sleep, now: deps.now }));
  } catch (e) { throw new Refusal([`--url ${opts.url}: ${errText(redactor, e)}`]); }
  const obs = observer(clients.get(BOT));
  const projectPath = `${config.group}/${opts.project}`;
  const pid = projectId(projectPath);
  const P = `/projects/${pid}`;

  for (const a of accounts) {
    try {
      const me = await clients.get(a.username).get('/user');
      if (me?.username !== a.username) problems.push(`the token in the secret of ${a.username} belongs to ${me?.username ?? 'nobody'}`);
    } catch (e) { problems.push(`the token of ${a.username} was not accepted by GitLab (${errText(redactor, e)})`); }
  }
  if (problems.length) throw new Refusal(problems);

  problems.push(...await liveProblems(obs, P));
  const open = await obs.paginate(`${P}/merge_requests`, { query: { state: 'opened' } }).catch((e) => { problems.push(`the open merge requests could not be read (${errText(redactor, e)})`); return []; });
  const foreign = open.filter((mr) => !String(mr.source_branch).startsWith(`${SLUG}/`));
  if (foreign.length) problems.push(`${foreign.length} open merge request(s) are not from a rehearsal run (for example !${foreign[0].iid}, branch ${foreign[0].source_branch}); the bot would land them: close them first`);

  const globs = deps.protectedGlobs ?? PROTECTED_GATE_PATHS;
  if (protectedTouched([CONTROL_FILE], globs).length === 0) problems.push(`${CONTROL_FILE} is not a protected gate file under the rules of this machine, so the protected-file control would prove nothing`);
  const ip = opts.gitlabPrivateIp ?? deps.env?.GITLAB_PRIVATE_IP ?? pickPrivateIp(deps.networkInterfaces?.());
  if (!IPV4.test(ip ?? '')) problems.push('the private address of the GitLab machine is not known (pass --gitlab-private-ip)');

  // The role of this machine must be able to read the fleet group, or A1 could not be proven after an hour: each operation is read once, here, before
  // anything is written. A denial is a refusal that names both actions; any other failure (a throttled call) is only noted and the run goes on.
  const asgName = deps.env?.FLEET_ASG_NAME || FLEET_ASG;
  const fleet = await fleetReadProblems(aws, { region, asgName, redactor });
  if (fleet.denied.length) problems.push(`the role of the GitLab machine may not read the fleet group ${asgName}: ${fleet.denied.join('; ')}; it needs both ${IAM_ACTIONS.join(' and ')} (infra/gitlab-engineering/terraform/settings.tf grants them: apply that Terraform change, then run again)`);
  const preflightNotes = fleet.failed.length ? [`the fleet group could not be read before the run (${fleet.failed.join('; ')}); the run goes on, and A1 is NOT PROVEN if the reads keep failing`] : [];

  let seedFiles = null;
  if (problems.length === 0) {
    try {
      seedFiles = buildSeedFiles({ seedDir: deps.seedDir, platformRoot: deps.platformRoot, gitlabPrivateIp: ip });
      const refused = seedRefusals(seedFiles, globs);
      if (refused.length) problems.push(`the seed contains protected gate file(s) the bot would refuse: ${refused.join(', ')}`);
    } catch (e) { problems.push(`the seed cannot be built: ${oneLine(e.message, 200)}`); }
    if (seedFiles && problems.length === 0) {
      // The seed's `unit` job runs its tests; the tools/collab copied from this machine are part of them. A copy that drifted from the seed (a new local
      // import) would fail that job, the seed merge request would never land, and the run would stop after 25 minutes: so it is run here, once, first.
      try {
        const self = await deps.seedSelfTest(seedFiles);
        if (!self.ok) problems.push(`the seed does not pass its own tests on this machine (the job unit would fail, so the seed merge request would never land): ${failureExcerpt(self.output)}`);
      } catch (e) { problems.push(`the tests of the seed could not be run on this machine: ${errText(redactor, e)}`); }
    }
  }
  if (problems.length) throw new Refusal(problems);
  say(`checks passed for ${projectPath}: native, no webhook, no mirror, main protected; ${accounts.length} account(s) verified; the seed passes its own tests${fleet.failed.length ? '' : `; the fleet group ${asgName} can be read`}`);
  return { region, configFile, config, project, accounts, seats, clients, obs, projectPath, pid, P, openAtStart: open, seedFiles, privateIp: ip, aws, asgName, preflightNotes };
}

// ── run, main ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The last resort for an error that nothing caught (a plain Node error): one line on stderr with every secret removed, cut to one line. → the exit code, 1 */
export function lastResort(err, { stderr = (line) => process.stderr.write(`${line}\n`), redactor = makeRedactor() } = {}) {
  stderr(`rehearse: unexpected error: ${oneLine(redactor(String(err?.message ?? err)), 300)}`);
  return 1;
}

export async function run(optsIn, depsIn = {}) {
  const deps = { ...defaultDeps(depsIn.env ?? process.env), ...depsIn };
  const opts = { agents: LANE_COUNT, settings: null, url: DEFAULT_URL, runId: null, maxMinutes: 110, pollSeconds: 15, gitlabPrivateIp: null, dryRun: false, ...optsIn };
  const redactor = makeRedactor();
  try {
    return await runChecked(opts, deps, redactor);
  } catch (e) {
    // an error nothing caught: the redactor of this run knows every token it has read, so the line is safe to print
    return { exitCode: lastResort(e, { stderr: deps.stderr, redactor }), unexpected: true };
  }
}

async function runChecked(opts, deps, redactor) {
  const out = (l) => deps.stdout(redactor(String(l)));
  const say = (l) => deps.stderr(redactor(`rehearse: ${l}`));
  let prep;
  try {
    prep = await prepare(opts, deps, { redactor, say });
  } catch (e) {
    const problems = e instanceof Refusal ? e.problems : [`a safety check could not be made: ${errText(redactor, e)}`];
    out('rehearse: refusing to start; nothing was written:');
    for (const p of problems) out(`  - ${p}`);
    return { exitCode: 2, refused: problems };
  }

  const startMs = deps.now();
  const runId = opts.runId ?? `r${stamp(startMs)}${deps.random()}`;
  const plan = planMergeRequests({ agents: opts.agents, seats: prep.seats, runId });
  const ctx = {
    ...prep, opts, deps, redactor, out, say, runId, plan, startMs, now: () => deps.now(), pollMs: opts.pollSeconds * 1000,
    deadline: startMs + opts.maxMinutes * 60_000, landDeadline: startMs + (opts.maxMinutes - END_RESERVE_MIN) * 60_000,
    items: [], byIid: new Map(), seatSessions: new Map(), failStreak: 0, lastProgress: 0, pushEventSeen: false,
    reviewerSession: sessionIdFor('reviewer', REVIEWER, startMs, deps.random()),
    model: { samples: [], jobs: [], traces: [], activities: null, activitiesError: null, commits: null, protection: null, members: null, tokens: [], settingsCheck: null, notes: [], seed: { status: 'unknown' }, stop: null, finishedMs: null },
  };

  if (opts.dryRun) {
    const existing = await listBlobs(ctx).catch(() => null);
    const manifest = readManifest(deps.seedDir);
    const d = existing ? diffSeed(ctx.seedFiles, existing, manifest.createOnly) : null;
    out(`rehearse: dry run for ${ctx.projectPath}, run ${runId}; every check passed; nothing will be written`);
    out(`seed: ${d ? (d.create.length + d.update.length === 0 ? 'already current on main' : `a merge request of lane ${SLUG}/seed would create ${d.create.length} and update ${d.update.length} file(s)`) : 'main could not be read'}`);
    for (const i of plan.order) out(`  ${i.kind === 'control' ? 'control' : 'lane   '} ${i.id.padEnd(20)} ${i.seat.padEnd(20)} ${i.branch}${i.expect ? `  (the bot must answer ${i.expect})` : ''}`);
    out(`then ${REVIEWER} pushes the review commits, ${BOT} lands the lanes, and the report decides A1, A2, A3, A4 and A8`);
    return { exitCode: 0, dryRun: true, plan };
  }

  const { model } = ctx;
  model.notes.push(...ctx.preflightNotes);
  const phases = [['hygiene', hygiene], ['seed', seedPhase], ['wave 1', async (c) => { c.baseSha = (await c.obs.get(`${c.P}/repository/branches/${MAIN}`)).commit.id; await wave1(c); }], ['wave 2', wave2], ['landing', landPhase]];
  try {
    for (const [name, fn] of phases) { ctx.phase = name; await fn(ctx); }
    ctx.phase = 'settle';
    await settleJobs(ctx, Math.min(ctx.deadline, deps.now() + 15 * 60_000));
    ctx.phase = 'cleanup';
    await cleanup(ctx);
  } catch (e) {
    model.stop = { phase: ctx.phase ?? 'start', message: e instanceof RunStop ? e.message : errText(redactor, e) };
    say(`stopped in ${model.stop.phase}: ${model.stop.message}`);
  }
  if (!ctx.baseSha && !model.stop) ctx.baseSha = null;
  await attempt(ctx, 'settling', () => settleJobs(ctx, Math.min(ctx.deadline, deps.now() + 2 * 60_000)));
  await attempt(ctx, 'waiting for the fleet to return to 0', () => waitForZero(ctx));
  await collect(ctx);
  model.finishedMs = deps.now();
  let report;
  let exitCode = 1;
  try {
    verdicts(ctx);
    report = redactor(renderReport(ctx));
    exitCode = exitCodeOf(model);
  } catch (e) {
    // a report that cannot be made must not lose what an hour of work found: say what is known and exit 1
    report = [`REHEARSAL REPORT could not be made (${errText(redactor, e)})`, `run ${runId} | project ${ctx.projectPath}`, `stop: ${model.stop ? `${model.stop.phase}: ${model.stop.message}` : 'none'}`, ...model.notes.map((n) => `note: ${n}`)].join('\n');
  }
  out(report);
  return { exitCode, report, model, ctx };
}

export async function main(argv, depsIn = {}) {
  const deps = { ...defaultDeps(depsIn.env ?? process.env), ...depsIn };
  let o;
  try { o = parseArgs(argv); } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    deps.stdout(`rehearse: ${e.message}`);
    deps.stdout(USAGE);
    return 2;
  }
  if (o.help) { deps.stdout(USAGE); return 0; }
  return (await run(o, deps)).exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (err) => { process.exitCode = lastResort(err); });
}
