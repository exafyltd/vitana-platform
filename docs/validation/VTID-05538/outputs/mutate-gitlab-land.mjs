// Mutation check for scripts/eng/gitlab-land.test.mjs (VTID-05538, lane eng-gitlab-m2/merge-bot).
// One behaviour of gitlab-land.mjs or of its two units is broken at a time in a scratch copy, and the test file must go red.
// A change counts as caught only when it is found exactly once in the file (otherwise AMBIGUOUS or NOOP), the changed .mjs file
// still parses (`node --check`, otherwise INVALID), and the test fails or hangs (HUNG, cut by a timeout). Anything else, and
// SURVIVED, is reported as not caught: the exit code is 1.
//
// usage: node mutate-gitlab-land.mjs <worktree containing scripts/eng, scripts/collab and infra/gitlab-engineering/host/units>
//        env: ONLY=<regex on the mutation name>  JOBS=<parallel runs, default 6>  TMPDIR=<where the scratch copies go>
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.resolve(process.argv[2] ?? '.');
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const JOBS = Number(process.env.JOBS ?? 6);
const TIMEOUT_MS = 180_000;
const LAND = 'scripts/eng/gitlab-land.mjs';
const SERVICE = 'infra/gitlab-engineering/host/units/vitana-land.service';
const TIMER = 'infra/gitlab-engineering/host/units/vitana-land.timer';
const TEST = 'scripts/eng/gitlab-land.test.mjs';

/** [name, file, exact text found once, replacement] */
const M = [];
const m = (name, file, from, to) => M.push({ name, file, from, to });

// ---- jobToCheckRun (plan §3.4 table)
m('success becomes failure', LAND, "case 'success': return run('completed', 'success');", "case 'success': return run('completed', 'failure');");
m('failed is always a failure', LAND, "case 'failed': return optional ? run('completed', 'neutral') : run('completed', 'failure');", "case 'failed': return run('completed', 'failure');");
m('failed is always neutral', LAND, "case 'failed': return optional ? run('completed', 'neutral') : run('completed', 'failure');", "case 'failed': return run('completed', 'neutral');");
m('canceled passes', LAND, "case 'canceled': return run('completed', 'cancelled');", "case 'canceled': return run('completed', 'success');");
m('skipped fails', LAND, "case 'skipped': return run('completed', 'skipped');", "case 'skipped': return run('completed', 'failure');");
m('manual is always pending', LAND, "case 'manual': return optional ? run('completed', 'neutral') : run('queued', null);", "case 'manual': return run('queued', null);");
m('manual is always neutral', LAND, "case 'manual': return optional ? run('completed', 'neutral') : run('queued', null);", "case 'manual': return run('completed', 'neutral');");
m('waiting_for_callback is unknown', LAND, ", 'waiting_for_resource', 'waiting_for_callback']);", ", 'waiting_for_resource']);");
m('canceling is unknown', LAND, "new Set(['running', 'canceling'])", "new Set(['running'])");
m('running is unknown', LAND, "new Set(['running', 'canceling'])", "new Set(['canceling'])");
m('unknown status passes', LAND, "if (typeof onUnknown === 'function') onUnknown(job);\n      return run('queued', null);", "if (typeof onUnknown === 'function') onUnknown(job);\n      return run('completed', 'success');");
m('unknown status is not reported', LAND, "if (typeof onUnknown === 'function') onUnknown(job);", '');
m('start time dropped', LAND, 'started_at: job.started_at ?? null', 'started_at: null');
m('a job without allow_failure is optional', LAND, 'const optional = job.allow_failure === true;', 'const optional = job.allow_failure !== false;');
// ---- required jobs, combining, checksFor
m('absent required job is pending when the pipeline finished', LAND, '(pipelineFinal ? failed : pending).push', '(pipelineFinal ? pending : failed).push');
m('skipped and neutral required jobs pass', LAND, "if (r.conclusion !== 'success') failed.push", "if (r.conclusion === 'failure') failed.push");
m('running required job fails', LAND, "if (r.status !== 'completed') { pending.push", "if (r.status !== 'completed') { failed.push");
m('no required jobs fails', LAND, "return { state: 'pass', detail: 'no required jobs configured' };", "return { state: 'fail', detail: 'no required jobs configured' };");
m('oldest attempt of a required job wins', LAND, 'if (!prev || runKey(r) >= runKey(prev)) latest.set(r.name, r);', 'if (!prev || runKey(r) <= runKey(prev)) latest.set(r.name, r);');
m('a failed check is ignored when combining', LAND, "const fail = verdicts.filter((v) => v.state === 'fail');", 'const fail = [];');
m('a pending check is ignored when combining', LAND, "const pending = verdicts.filter((v) => v.state === 'pending');", 'const pending = [];');
m('no pipeline passes', LAND, "if (!pipeline) return { state: 'pending', detail: 'no pipeline for this head yet' };", "if (!pipeline) return { state: 'pass', detail: 'no pipeline for this head yet' };");
m('finished pipeline without jobs passes', LAND, "if (final && jobs.length === 0) return { state: 'fail', kind: 'checks',", "if (final && jobs.length === 0) return { state: 'pass', kind: 'checks',");
m('the failing rule is not named', LAND, "const kind = plain.state === 'fail' ? 'checks' : named.state === 'fail' ? 'required' : undefined;", 'const kind = undefined;');
m('every pipeline is final', LAND, 'const final = PIPELINE_FINAL.has(pipeline.status);', 'const final = true;');
// ---- the review commit
m('a changes verdict counts as an accept', LAND, "if (commit.verdict !== 'accept') return { ok: false, code: 'review_changes'", "if (false) return { ok: false, code: 'review_changes'");
m('any reviewer name is accepted', LAND, 'const REVIEWER_RE = /^agent:vitana-lane-reviewer \\(/;', 'const REVIEWER_RE = /./;');
m('the reviewed head is not checked', LAND, "if (!SHA.test(commit.reviewedHead || '')) return", 'if (false) return');
m('an unproven push counts', LAND, 'if (pushed !== true) return', 'if (pushed === false) return');
m('the oldest review wins', LAND, "const commit = commits.find((c) => c.review === laneKey && (c.verdict === 'accept' || c.verdict === 'changes'));", "const commit = [...commits].reverse().find((c) => c.review === laneKey && (c.verdict === 'accept' || c.verdict === 'changes'));");
m('another lane\'s review counts', LAND, "const commit = commits.find((c) => c.review === laneKey && (c.verdict === 'accept' || c.verdict === 'changes'));", "const commit = commits.find((c) => (c.verdict === 'accept' || c.verdict === 'changes'));");
// ---- decide, squash message
m('a pending pipeline lands', LAND, "if (full.code === 2) return { action: 'wait'", "if (full.code === 2) return { action: 'land'");
m('everything refused is an update', LAND, "if (ignoringBehind.ok) return { action: 'update',", "if (true) return { action: 'update',");
m('a behind branch is never updated', LAND, 'const ignoringBehind = mergeDecision({ review, checks, behindBy: 0, protectedFiles });', 'const ignoringBehind = mergeDecision({ review, checks, behindBy, protectedFiles });');
m('protected file has no reason code', LAND, "if (protectedFiles.length) reasonCode = 'protected_gate_file';", "if (false) reasonCode = 'protected_gate_file';");
m('the description is dropped', LAND, 'return description ? `${title}\\n\\n${description}` : title;', 'return title;');
m('title whitespace is kept', LAND, ".replace(/\\s+/g, ' ').trim();\n  const description", ".trim();\n  const description");
m('CRLF in the description is kept', LAND, ".replace(/\\r\\n/g, '\\n').trim();\n  return description", ".trim();\n  return description");
// ---- who pushed the accept
m('any author counts as the reviewer', LAND, 'if (ev?.author_username !== ctx.reviewerUser) continue;', 'if (false) continue;');
m('any push of the reviewer proves the accept', LAND, 'if (pushRange(ctx, repo, pd).includes(sha)) return true;', 'if (pushRange(ctx, repo, pd).length > 0) return true;');
m('the push events are never read', LAND, 'for (let page = 1; page <= ctx.eventPages; page++) {', 'for (let page = 1; page <= 0; page++) {');
// ---- evaluate
m('drafts are read as ready', LAND, "if (mr.draft === true || mr.work_in_progress === true) return verdict('skip', 'draft'", "if (false) return verdict('skip', 'draft'");
m('a title without a VTID is enough', LAND, "if (!laneKey || !VTID_TITLE.test(mr.title || ''))", 'if (!laneKey)');
m('a moved head is not noticed', LAND, "if (head !== mr.sha) return verdict('skip', 'head_moved'", "if (false) return verdict('skip', 'head_moved'");
m('protected gate files are ignored', LAND, 'const protectedFiles = protectedTouched(files, PROTECTED_GATE_PATHS);', 'const protectedFiles = [];');
m('the diff includes what main brought in', LAND, "`origin/main...${head}`]).split", "`origin/main..${head}`]).split");
m('behind is never counted', LAND, "const behindBy = Number(gitRun(ctx, repo, ['rev-list', '--count', `${head}..origin/main`]));", 'const behindBy = 0;');
m('a stale review counts', LAND, "review = { ...current, code: current.ok ? 'review_found' : 'review_stale' };", "review = { ok: true, reason: 'x', code: 'review_found' };");
m('the pipeline is not asked for the head', LAND, "{ query: { sha: head, order_by: 'id', sort: 'desc', per_page: 20 } }", "{ query: { order_by: 'id', sort: 'desc', per_page: 20 } }");
m('the first pipeline is used whatever its sha', LAND, '.find((p) => p.sha === head) || null;', '[0] || null;');
m('required jobs are not passed on', LAND, 'checks = checksFor(pipeline, jobs, project.required_jobs, ', 'checks = checksFor(pipeline, jobs, [], ');
m('no comment is ever written for a skip', LAND, "comment: Boolean(COMMENT_TEXT[d.reasonCode]) && d.action === 'skip'", 'comment: false');
m('unexpected merge request fields are accepted', LAND, 'if (!Number.isInteger(mr.iid) || !SHA.test(mr.sha || \'\') || !BRANCH_OK.test(mr.source_branch || \'\')) return', 'if (false) return');
m('a branch behind a lapsing main is updated', LAND, 'if (lapsing.length) {', 'if (false) {');
m('the incoming files are not the merge-base diff', LAND, "['diff', '--name-only', '--no-renames', base, 'origin/main']", "['diff', '--name-only', '--no-renames', head, 'origin/main']");
// ---- landing
m('the merge call is retried by the client', LAND, '{ body, retries: 0 }', '{ body }');
m('the merge is not pinned to the head', LAND, 'const body = { sha: v.head, squash: true,', 'const body = { squash: true,');
m('no squash', LAND, 'squash: true, squash_commit_message', 'squash: false, squash_commit_message');
m('the source branch is kept', LAND, 'should_remove_source_branch: true', 'should_remove_source_branch: false');
m('any 200 is a landing', LAND, "if (res?.state === 'merged') {", 'if (res) {');
m('no re-read after an error', LAND, 'const current = await ctx.client.get(`/projects/${pid}/merge_requests/${mr.iid}`).catch(() => null);', 'const current = null;');
m('a dry run lands', LAND, "if (ctx.dryRun) { ctx.log({ event: 'would_land'", "if (false) { ctx.log({ event: 'would_land'");
// ---- updating a behind branch
m('the update is authored by the builder', LAND, 'GIT_AUTHOR_NAME: ctx.botUser,', "GIT_AUTHOR_NAME: 'builder',");
m('the update has no Collab-Session', LAND, '\\n\\nCollab-Session: ${ctx.botUser}`', '`');
m('the update is a force push', LAND, "['push', '-q', 'origin', `${sha}:refs/heads/${mr.source_branch}`]", "['push', '-q', '--force', 'origin', `${sha}:refs/heads/${mr.source_branch}`]");
m('the scratch worktree is kept', LAND, "  } finally {\n    gitRun(ctx, repo, ['worktree', 'remove', '--force', tmp], { allowFail: true });\n    fs.rmSync(tmp, { recursive: true, force: true });\n    gitRun(ctx, repo, ['worktree', 'prune'], { allowFail: true });\n  }", "  } finally {\n  }");
m('a conflict is not reported', LAND, "await ensureNote(ctx, pid, mr, 'conflict', v.head);", '');
m('a conflict is pushed on', LAND, 'if (merged === null) {', 'if (false) {');
m('a dry run updates', LAND, "if (ctx.dryRun) { ctx.log({ event: 'would_update'", "if (false) { ctx.log({ event: 'would_update'");
// ---- one tick
m('the project goes on after acting', LAND, 'if (acted && !statusOnly) break;', '');
m('a waiting merge request does not hold the others', LAND, "      acted = true;\n      continue;\n    }\n    if (v.action === 'update')", "      continue;\n    }\n    if (v.action === 'update')");
m('a merge request never loses its turn', LAND, 'ctx.now() - since > ctx.pipelineWaitMs', 'ctx.now() - since > 1e15');
m('every waiting merge request loses its turn', LAND, 'ctx.now() - since > ctx.pipelineWaitMs', 'ctx.now() - since > -1');
m('merge requests are taken in the order the API lists them', LAND, ".sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.iid - b.iid)", '');
m('projects without landing are read', LAND, 'ctx.projects.filter((p) => p.landing === true)', 'ctx.projects');
m('any default branch is accepted', LAND, "if (info?.default_branch !== 'main') {", 'if (false) {');
m('a skipped merge request gets no comment', LAND, 'if (v.comment) await ensureNote(ctx, pid, mr, v.reasonCode, v.head);', '');
m('a failed project does not fail the tick', LAND, 'failed = true;\n      ctx.log({ event: \'project_failed\'', "ctx.log({ event: 'project_failed'");
// ---- comments
m('a comment is written again and again', LAND, "if (notes.some((n) => typeof n?.body === 'string' && n.body.includes(marker) && n.author?.username === ctx.botUser)) return false;", '');
m('anyone\'s note stands in for the bot\'s', LAND, ' && n.author?.username === ctx.botUser)) return false;', ')) return false;');
m('a dry run comments', LAND, "if (ctx.dryRun) { ctx.log({ event: 'would_comment'", "if (false) { ctx.log({ event: 'would_comment'");
// ---- logs, git credentials, command line
m('the log is not redacted', LAND, 'write(redact(JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }), token))', 'write(JSON.stringify({ ts: new Date(now()).toISOString(), ...entry }))');
m('git may prompt', LAND, ", GIT_TERMINAL_PROMPT: '0' };", ' };');
m('the askpass script answers a wrong user', LAND, 'Username*) echo oauth2 ;;', 'Username*) echo root ;;');
m('the askpass script is world readable', LAND, '{ mode: 0o700 }', '{ mode: 0o755 }');
m('the token is put in the git environment', LAND, 'LAND_TOKEN_FILE: tokenFile, GIT_TERMINAL_PROMPT', 'LAND_TOKEN_FILE: tokenFile, LAND_TOKEN: readTokenForEnv(tokenFile), GIT_TERMINAL_PROMPT');
m('a failed run exits 0', LAND, 'const { failed } = await tick(ctx);\n    return failed ? 1 : 0;', 'const { failed } = await tick(ctx);\n    return 0;');
m('landing is true for every listed project', LAND, 'landing: p?.landing === true,', 'landing: Boolean(p),');
// ---- the units
m('the service is not one-shot', SERVICE, 'Type=oneshot', 'Type=simple');
m('the service has no flock', SERVICE, '/usr/bin/flock -n -E 0 /run/vitana-land.lock ', '');
m('a busy lock fails the unit', SERVICE, 'flock -n -E 0 ', 'flock -n ');
m('the service has no CPU limit', SERVICE, 'CPUQuota=50%\n', '');
m('the service has no memory limit', SERVICE, 'MemoryMax=1G\n', '');
m('the service has no Nice', SERVICE, 'Nice=10\n', '');
m('the service reads another token file', SERVICE, '--token-file /etc/vitana/bot-land-token', '--token-file /etc/vitana/mirror-token');
m('the token is in the unit', SERVICE, '--workdir /var/lib/vitana-land', '--workdir /var/lib/vitana-land --token fixture-token-0123456789abcdef');
m('the timer runs hourly', TIMER, 'OnUnitActiveSec=1min', 'OnUnitActiveSec=1h');
m('the timer starts another unit', TIMER, 'Unit=vitana-land.service', 'Unit=vitana-mirror.service');

// ── harness ──────────────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mutland-'));
process.on('exit', () => fs.rmSync(SCRATCH, { recursive: true, force: true }));

function baseline() {
  const out = (() => { try { return execFileSync(process.execPath, ['--test', TEST], { cwd: SRC, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS }); } catch (e) { return String(e.stdout || ''); } })();
  const tests = /^# tests (\d+)/m.exec(out)?.[1];
  const fail = /^# fail (\d+)/m.exec(out)?.[1];
  if (fail !== '0') { console.log(`baseline: the test fails on the unmutated tree (tests ${tests}, fail ${fail})`); process.exit(2); }
  console.log(`baseline: ${tests} tests pass on the unmutated tree`);
}

function copyTree(dest) {
  for (const rel of ['scripts/eng', 'scripts/collab', 'infra/gitlab-engineering/host/units']) {
    fs.cpSync(path.join(SRC, rel), path.join(dest, rel), { recursive: true });
  }
}

function runOne(mut, index) {
  return new Promise((resolve) => {
    const dir = path.join(SCRATCH, String(index));
    copyTree(dir);
    const file = path.join(dir, mut.file);
    const text = fs.readFileSync(file, 'utf8');
    const count = text.split(mut.from).length - 1;
    if (count === 0) return resolve({ mut, verdict: 'NOOP', note: 'the text to change was not found: fix the mutation' });
    if (count > 1) return resolve({ mut, verdict: 'AMBIGUOUS', note: `the text to change was found ${count} times: make it unique` });
    const changed = text.replace(mut.from, () => mut.to);
    if (changed === text) return resolve({ mut, verdict: 'NOOP', note: 'the change left the file as it was' });
    fs.writeFileSync(file, changed);
    if (mut.file.endsWith('.mjs')) {
      try { execFileSync(process.execPath, ['--check', file], { stdio: 'ignore' }); } catch { return resolve({ mut, verdict: 'INVALID', note: 'the changed file does not parse: it proves nothing' }); }
    }
    const child = spawn(process.execPath, ['--test', TEST], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.rmSync(dir, { recursive: true, force: true });
      if (signal) return resolve({ mut, verdict: 'HUNG', note: 'cut by the timeout' });
      const failed = [...out.matchAll(/^not ok \d+ - (.*)$/gm)].map((x) => x[1].slice(0, 58));
      const tests = Number(/^# tests (\d+)/m.exec(out)?.[1] ?? 0);
      if (code === 0 && /^# fail 0/m.test(out)) return resolve({ mut, verdict: 'SURVIVED', note: 'every test passed' });
      if (tests <= 1 && failed.length <= 1) return resolve({ mut, verdict: 'CRASH', note: `the test file crashed before running its cases: ${failed[0] ?? ''}` });
      resolve({ mut, verdict: 'caught', note: failed.slice(0, 3).join(' | ') });
    });
  });
}

baseline();
const chosen = M.map((mut, i) => ({ mut, i })).filter(({ mut }) => !ONLY || ONLY.test(mut.name));
const results = new Array(chosen.length);
let next = 0;
await Promise.all(Array.from({ length: Math.min(JOBS, chosen.length) }, async () => {
  while (next < chosen.length) {
    const k = next++;
    results[k] = await runOne(chosen[k].mut, chosen[k].i);
  }
}));
let bad = 0;
for (const r of results) {
  const label = r.verdict === 'caught' ? 'caught   ' : `${r.verdict.padEnd(9)}`;
  if (r.verdict !== 'caught') bad += 1;
  console.log(`${label} ${r.mut.name}  <- ${r.note}`);
}
console.log(`\nmutations: ${results.length}   caught: ${results.length - bad}   not caught: ${bad}`);
process.exit(bad === 0 ? 0 : 1);
