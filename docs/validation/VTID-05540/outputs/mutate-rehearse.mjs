// One behaviour of rehearse.mjs, of the seed, or of the files they read is broken at a time in a scratch copy, and rehearse.test.mjs must go red.
// A change counts as caught only when it is found exactly once in the file (otherwise AMBIGUOUS or NOOP), the changed .mjs file still parses
// (`node --check`, otherwise INVALID), and the test fails or hangs (HUNG, cut by a timeout). Anything else, and SURVIVED, is reported as not
// caught: the exit code is 1.
//
// usage: node mutate-rehearse.mjs <worktree containing scripts/eng, scripts/collab and infra/gitlab-engineering/{rehearsal,settings,ci,m2.sh}>
//        env: ONLY=<regex on the mutation name>  JOBS=<parallel runs, default 6>  TMPDIR=<where the scratch copies go>  CHECK_ONLY=1 (only find the texts)
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SRC = path.resolve(process.argv[2] ?? '.');
const ONLY = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
const JOBS = Number(process.env.JOBS ?? 6);
const TIMEOUT_MS = 240_000;
const RH = 'scripts/eng/rehearse.mjs';
const NEG = 'infra/gitlab-engineering/rehearsal/seed/scripts/negctl.mjs';
const CIT = 'infra/gitlab-engineering/rehearsal/seed/scripts/ci-test.mjs';
const MAN = 'infra/gitlab-engineering/rehearsal/seed/manifest.json';
const PKG = 'infra/gitlab-engineering/rehearsal/seed/package.json';
const SPEC = 'infra/gitlab-engineering/rehearsal/seed/test/spec.test.mjs';
const TEST = 'scripts/eng/rehearse.test.mjs';

/** [name, file, exact text found once, replacement] */
const M = [];
const m = (name, file, from, to) => M.push({ name, file, from, to });

// ---- the plan of merge requests
m('lanes are all opened by the first seat', RH, 'seat: seats[i % seats.length], title:', 'seat: seats[0], title:');
m('controls are opened after the lanes', RH, 'order: [...controls, ...lanes] }', 'order: [...lanes, ...controls] }');
m('a control expects the wrong reason', RH, "expect: 'review_stale', what:", "expect: 'no_review', what:");
m('a lane title has no VTID', RH, 'title: `${vtid} (${laneKeyFor(id)}): rehearsal lane ${i + 1} of ${agents}`', 'title: `(${laneKeyFor(id)}): rehearsal lane ${i + 1} of ${agents}`');
m('13 agents are planned', RH, "agents > LANE_COUNT) throw new UsageError(`agents must be a whole number", "agents > 99) throw new UsageError(`agents must be a whole number");
m('a branch name has no run id', RH, 'export const branchFor = (runId, id) => `${SLUG}/${runId}/${id}`;', 'export const branchFor = (runId, id) => `${SLUG}/${id}`;');
m('the control seats start at the first seat', RH, 'seat: seats[(agents + k) % seats.length],', 'seat: seats[k % seats.length],');
// ---- the command line
m('0 agents are accepted', RH, 'if (o.agents < 1 || o.agents > LANE_COUNT) throw new UsageError(', 'if (o.agents > LANE_COUNT) throw new UsageError(');
m('--project is optional', RH, "if (!o.project) throw new UsageError('--project is required", "if (false) throw new UsageError('--project is required");
m('an unknown option is accepted', RH, 'if (!Object.hasOwn(VALUE_FLAGS, a)) throw new UsageError(', 'if (false) throw new UsageError(');
m('any private address is accepted', RH, 'if (o.gitlabPrivateIp !== null && !IPV4.test(o.gitlabPrivateIp)) throw', 'if (false) throw');
m('--max-minutes below 30 is accepted', RH, "if (o.maxMinutes < 30 || o.maxMinutes > 240) throw new UsageError(", "if (o.maxMinutes > 240) throw new UsageError(");
// ---- the refusals
m('an unmarked project is accepted', RH, 'if (p.rehearsal !== true) problems.push(', 'if (false) problems.push(');
m('a mirror profile is accepted', RH, "if (p.profile !== 'native') problems.push(", 'if (false) problems.push(');
m('a webhook in the file is accepted', RH, 'if (p.webhook) problems.push(', 'if (false) problems.push(');
m('landing false is accepted', RH, 'if (p.landing !== true) problems.push(', 'if (false) problems.push(');
m('live webhooks are not looked at', RH, 'if (hooks && (!Array.isArray(hooks.value) || hooks.value.length > 0)) problems.push(', 'if (false) problems.push(');
m('a live mirror flag is not looked at', RH, "if (info.value?.mirror === true) problems.push(", 'if (false) problems.push(');
m('remote mirrors are not looked at', RH, 'if (mirrors && (!Array.isArray(mirrors.value) || mirrors.value.length > 0)) problems.push(', 'if (false) problems.push(');
m('the default branch is not looked at', RH, 'if (info.value?.default_branch !== MAIN) problems.push(', 'if (false) problems.push(');
m('who may push to main is not looked at', RH, 'if (!exactly(pb.push_access_levels, 0)) problems.push(', 'if (false) problems.push(');
m('who may merge to main is not looked at', RH, 'if (!exactly(pb.merge_access_levels, 40)) problems.push(', 'if (false) problems.push(');
m('force push to main is not looked at', RH, 'if (pb.allow_force_push !== false) problems.push(', 'if (false) problems.push(');
m('a user entry on push counts as No one', RH, '&& !list[0].user_id && !list[0].group_id', '&& !list[0].group_id');
m('an unprotected main passes', RH, "if (!pb || typeof pb !== 'object') return ['main is not protected'];", 'if (!pb || typeof pb !== \'object\') return [];');
m('unreadable live facts are taken as safe', RH, 'problems.push(`${what} could not be read (', '(`${what} could not be read (');
m('foreign open merge requests are accepted', RH, 'if (foreign.length) problems.push(', 'if (false) problems.push(');
m('a token of another account is accepted', RH, 'if (me?.username !== a.username) problems.push(', 'if (false) problems.push(');
m('an unprotected CLAUDE.md control is accepted', RH, 'if (protectedTouched([CONTROL_FILE], globs).length === 0) problems.push(', 'if (false) problems.push(');
m('a missing REGION is accepted', RH, 'if (!REGION_OK.test(region)) throw new Refusal(', 'if (false) throw new Refusal(');
m('a seed with a protected file is accepted', RH, 'if (refused.length) problems.push(', 'if (false) problems.push(');
m('a token of 3 characters is accepted', RH, "if (!TOKEN_OK.test(v)) return { error:", "if (false) return { error:");
m('an empty secret is accepted', RH, "if (v === '' || v === 'None') return { error:", "if (false) return { error:");
// ---- what is allowed to be written or read
m('any secret may be read', RH, "&& operation === 'get-secret-value' && SECRET_ID_OK.test(secret))", "&& operation === 'get-secret-value')");
m('any autoscaling call is allowed', RH, "(operation === 'describe-auto-scaling-groups' || operation === 'describe-scaling-activities')", 'true');
m('any merge request write is allowed', RH, "{ method: 'PUT', re: /^\\/merge_requests\\/\\d+$/ },", "{ method: 'PUT', re: /^\\/merge_requests\\/.*$/ },");
m('any branch name is deletable', RH, "re: /^\\/repository\\/branches\\/[A-Za-z0-9._%-]+$/ },", "re: /^\\/repository\\/branches\\/.*$/ },");
m('commits may be posted anywhere below the repository', RH, "{ method: 'POST', re: /^\\/repository\\/commits$/ },", "{ method: 'POST', re: /^\\/repository\\/.*$/ },");
m('closing sends another event', RH, "{ state_event: 'close' }", "{ state_event: 'reopen' }");
m('writes are repeated by the client', RH, 'client.request(method, `${ctx.P}${rel}`, { body, retries: 0 })', 'client.request(method, `${ctx.P}${rel}`, { body })');
m('the observer reads as the first seat', RH, 'const obs = observer(clients.get(BOT));', 'const obs = observer(clients.get(seats[0]));');
// ---- the seed
m('the collab tooling goes to scripts/collab', MAN, '"to": "tools/collab"', '"to": "scripts/collab"');
m('the spec goes to another folder', MAN, '"spec/": ".kiro/specs/rehearsal/"', '"spec/": ".kiro/specs/rehearsal-x/"');
m('lane files are rewritten by a refresh', MAN, '"createOnly": [".kiro/specs/rehearsal/"]', '"createOnly": []');
m('the queue is not copied', MAN, '"files": ["queue.mjs", "land-guard.mjs", "protected-gate-files.json"]', '"files": ["land-guard.mjs", "protected-gate-files.json"]');
m('the blob id counts characters, not bytes', RH, 'export const blobId = (text) => crypto.createHash(\'sha1\').update(`blob ${Buffer.byteLength(String(text))}\\0`)', 'export const blobId = (text) => crypto.createHash(\'sha1\').update(`blob ${String(text).length}\\0`)');
m('equal files are updated again', RH, '(existing.get(p) === blobId(text) ? same : update).push(p);', 'update.push(p);');
m('a file that exists is created again', RH, 'if (!existing.has(p)) { create.push(p); continue; }', 'if (true) { create.push(p); continue; }');
m('the config takes any address', RH, "if (!IPV4.test(gitlabPrivateIp ?? '')) throw new Error(", 'if (false) throw new Error(');
m('docker bridges are private addresses of the machine', RH, 'const skip = /^(lo|docker|br-|veth|cni|flannel|virbr|tun|tap)/;', 'const skip = /^(lo)/;');
m('172.32 is private', RH, '/^172\\.(1[6-9]|2\\d|3[01])\\./', '/^172\\./');
m('the package test script is not the job body', PKG, '"test": "node scripts/ci-test.mjs"', '"test": "node --test"');
m('a lane file names another lane', 'infra/gitlab-engineering/rehearsal/seed/spec/lanes/lane-12.md', 'lane: lane-12', 'lane: lane-13');
// ---- the negative controls of the seed
m('an answering metadata service passes', NEG, "pass: false, detail: `the instance metadata service answered a job", "pass: true, detail: `the instance metadata service answered a job");
m('the plain metadata read is not tried', NEG, "    httpProbe({ ...address, method: 'GET', path: '/latest/meta-data/', headers: {}, timeoutMs, request }),\n", '');
m('the token request is not tried', NEG, "    httpProbe({ ...address, method: 'PUT', path: '/latest/api/token', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, timeoutMs, request }),\n", '');
m('an HTTP error status is not an answer', NEG, "done({ answered: true, detail: `${method} ${path} answered HTTP ${res.statusCode}` });", "done({ answered: res.statusCode < 400, detail: `${method} ${path} answered HTTP ${res.statusCode}` });");
m('no address configured passes', NEG, "return { name: 'gitlab-host', pass: false, detail: 'no address of the GitLab machine is configured", "return { name: 'gitlab-host', pass: true, detail: 'no address of the GitLab machine is configured");
m('an open port of the machine passes', NEG, "return { name: 'gitlab-host', pass: false, detail: `the GitLab machine ${ip} accepted", "return { name: 'gitlab-host', pass: true, detail: `the GitLab machine ${ip} accepted");
m('port 8080 is not tried', NEG, 'export const HOST_PORTS = Object.freeze([22, 80, 443, 8080]);', 'export const HOST_PORTS = Object.freeze([22, 80, 443]);');
m('port 22 is not tried', NEG, 'export const HOST_PORTS = Object.freeze([22, 80, 443, 8080]);', 'export const HOST_PORTS = Object.freeze([80, 443, 8080]);');
m('only AWS_SECRET variables count', NEG, "Object.keys(env).filter((k) => /^AWS_/.test(k))", "Object.keys(env).filter((k) => /^AWS_SECRET/.test(k))");
m('the values of AWS variables are printed', NEG, "the job environment has AWS variable(s): ${names.join(', ')}", "the job environment has AWS variable(s): ${names.map((n) => `${n}=${env[n]}`).join(', ')}");
m('the control line has another format', NEG, "`NEGCTL ${name} ${pass ? 'PASS' : 'FAIL'}`", "`NEGCTL ${name}: ${pass ? 'PASS' : 'FAIL'}`");
m('a failing control fails the job', CIT, 'console.log(formatLine(result));', 'console.log(formatLine(result)); if (!result.pass) status = 1;');
m('failing tests do not fail the job', CIT, 'status = r.status ?? 1;', 'status = 0;');
m('a repository without tests passes', CIT, 'let status = 1;', 'let status = 0;');
m('the controls are not printed when tests fail', CIT, "console.log('ci-test: negative controls (plan eng-gitlab-m2, acceptance A2)');", "if (status !== 0) return status;\n  console.log('ci-test: negative controls (plan eng-gitlab-m2, acceptance A2)');");
// ---- reading traces, notes, samples, launches
m('NEGCTL lines need not start the line', RH, "/^NEGCTL (imds|gitlab-host|aws-env) (PASS|FAIL)$/.exec(line)", "/NEGCTL (imds|gitlab-host|aws-env) (PASS|FAIL)$/.exec(line)");
m('ANSI codes are not removed from traces', RH, ".replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, '')", '');
m('a lone carriage return is not a line end', RH, "split(/\\r\\n|\\n|\\r/)", "split(/\\r?\\n/)");
m('another author\'s marker is a bot note', RH, "note.author?.username !== botUser", 'false');
m('a short head is a bot note', RH, '<!-- vitana-land:([a-z_]+):([0-9a-f]{40}) -->', '<!-- vitana-land:([a-z_]+):([0-9a-f]+) -->');
m('Pending machines are not active', RH, "s === 'InService' || s.startsWith('Pending')", "s === 'InService'");
m('Terminating machines are active', RH, "s === 'InService' || s.startsWith('Pending')", "s === 'InService' || s.startsWith('Pending') || s.startsWith('Terminating')");
m('a missing group is a sample', RH, "if (!g) return { t, ok: false, error: 'the Auto Scaling group was not found' };", 'if (!g) return { t, ok: true, total: 0, active: 0, desired: 0 };');
m('a cancelled launch is a machine', RH, "if (a.StatusCode === 'Failed' || a.StatusCode === 'Cancelled') failures.push", "if (a.StatusCode === 'Failed') failures.push");
m('a failed launch is a machine', RH, "if (a.StatusCode === 'Failed' || a.StatusCode === 'Cancelled') failures.push", "if (a.StatusCode === 'Cancelled') failures.push");
m('a launch at the start counts as before it', RH, 'if (!(Date.parse(a?.StartTime ?? \'\') >= sinceMs)) continue;', 'if (!(Date.parse(a?.StartTime ?? \'\') > sinceMs)) continue;');
m('older launches count', RH, 'if (!(Date.parse(a?.StartTime ?? \'\') >= sinceMs)) continue;', '');
m('terminations count as launches', RH, "if (!/^Launching a new EC2 instance/i.test(a.Description ?? '')) continue;", '');
// ---- A1
m('A1: 19 machines are enough', RH, 'ok: peak >= limits.minPeak,', 'ok: peak >= limits.minPeak - 1,');
m('A1: the peak must exceed 20', RH, 'ok: peak >= limits.minPeak,', 'ok: peak > limits.minPeak,');
m('A1: the peak counts only active machines', RH, 'valid.reduce((m, s) => Math.max(m, s.total), 0)', 'valid.reduce((m, s) => Math.max(m, s.active), 0)');
m('A1: fewer machines than jobs are enough', RH, 'ok: launches.launched >= onFleet.length,', 'ok: launches.launched >= onFleet.length - 1,');
m('A1: machines must outnumber jobs', RH, 'ok: launches.launched >= onFleet.length,', 'ok: launches.launched > onFleet.length,');
m('A1: 901 seconds to zero is enough', RH, 'zeroDecided = secondsToZero <= limits.zeroSeconds;', 'zeroDecided = secondsToZero <= limits.zeroSeconds + 1;');
m('A1: exactly 900 seconds is too slow', RH, 'zeroDecided = secondsToZero <= limits.zeroSeconds;', 'zeroDecided = secondsToZero < limits.zeroSeconds;');
m('A1: a zero before the last job counts', RH, 's.t >= lastFinish && s.total === 0 && s.desired === 0', 's.total === 0 && s.desired === 0');
m('A1: a desired capacity left is ignored', RH, 's.t >= lastFinish && s.total === 0 && s.desired === 0', 's.t >= lastFinish && s.total === 0');
m('A1: a group that stays up is only unproven', RH, 'zeroDecided = (lastSeen - lastFinish) / 1000 > limits.zeroSeconds ? false : null;', 'zeroDecided = null;');
m('A1: a group that stays up passes', RH, 'zeroDecided = (lastSeen - lastFinish) / 1000 > limits.zeroSeconds ? false : null;', 'zeroDecided = true;');
m('A1: jobs on another runner are ignored', RH, 'if (elsewhere > 0) checks.push(', 'if (false) checks.push(');
m('A1: jobs from before the run count', RH, "const ran = jobs.filter((j) => j.started_at && Date.parse(j.started_at) >= runStartMs);\n  const onFleet", "const ran = jobs.filter((j) => j.started_at);\n  const onFleet");
m('A1: the IAM actions are not named', RH, 'autoscaling:DescribeAutoScalingGroups and autoscaling:DescribeScalingActivities', 'autoscaling:DescribeAutoScalingGroups');
m('A1: an unreadable group is a pass', RH, "checks.push({ name: 'sampling', ok: null,", "checks.push({ name: 'sampling', ok: true,");
m('A1: unknown launches are a pass', RH, "checks.push({ name: 'own', ok: null, detail: `machines launched are unknown", "checks.push({ name: 'own', ok: true, detail: `machines launched are unknown");
m('A1: fewer than 12 agents are held to 20', RH, 'else if (agents === LANE_COUNT) {', 'else if (true) {');
// ---- A2
m('A2: a FAIL line passes', RH, 'if (c.fail > 0) return { name: n, ok: false,', 'if (c.fail > 0) return { name: n, ok: true,');
m('A2: a control never seen passes', RH, 'if (c.pass === 0) return { name: n, ok: null,', 'if (c.pass === 0) return { name: n, ok: true,');
m('A2: a job without the lines passes', RH, "else if (t.status === 'success') problems.push(", 'else if (false) problems.push(');
m('A2: lines of failed jobs are not counted', RH, "for (const l of lines) per[l.name][l.result === 'PASS' ? 'pass' : 'fail'] += 1;", "for (const l of lines) if (t.status === 'success') per[l.name][l.result === 'PASS' ? 'pass' : 'fail'] += 1;");
// ---- A3
m('A3: 91 days are enough', RH, 'left > 0 && left <= maxDays', 'left > 0 && left <= maxDays + 1');
m('A3: exactly 90 days is too long', RH, 'left > 0 && left <= maxDays', 'left > 0 && left < maxDays');
m('A3: a token that expires today is fine', RH, 'left > 0 && left <= maxDays', 'left >= 0 && left <= maxDays');
m('A3: inactive tokens are fine', RH, 't.active === true && t.revoked !== true &&', 't.revoked !== true &&');
m('A3: revoked tokens are fine', RH, 't.active === true && t.revoked !== true &&', 't.active === true &&');
m('A3: extra Maintainers are fine', RH, 'ok: extra.length === 0 && botOk,', 'ok: botOk,');
m('A3: bot-land need not be a Maintainer', RH, 'ok: extra.length === 0 && botOk,', 'ok: extra.length === 0,');
m('A3: the owner is not allowed', RH, 'const allowed = new Set([BOT, ...owners]);', 'const allowed = new Set([BOT]);');
m('A3: Developers count as Maintainers', RH, 'members.filter((m) => m.access_level >= 40)', 'members.filter((m) => m.access_level >= 30)');
m('A3: a drifting settings check is fine', RH, "ok: settingsCheck.exitCode === 0, detail: `gitlab-settings.mjs check exit", "ok: true, detail: `gitlab-settings.mjs check exit");
m('A3: an unread protection passes', RH, "checks.push({ name: 'protection', ok: null,", "checks.push({ name: 'protection', ok: true,");
// ---- A4
m('A4: lanes that did not land pass', RH, "ok: merged.length === lanes.length && lanes.length > 0,", 'ok: true,');
m('A4: no lanes at all pass', RH, "ok: merged.length === lanes.length && lanes.length > 0,", 'ok: merged.length === lanes.length,');
m('A4: equal landing times are one at a time', RH, 'times.every((t, i) => i === 0 || t > times[i - 1])', 'times.every((t, i) => i === 0 || t >= times[i - 1])');
m('A4: the subjects on main are not compared with the merge requests', RH, "ok: [...titles].sort().join('\\n') === lanes.map((l) => l.title).sort().join('\\n'),", 'ok: true,');
m('A4: only the first subjects are compared', RH, "ok: [...titles].sort().join('\\n') === lanes.map((l) => l.title).sort().join('\\n'),", "ok: [...titles].sort().join('\\n') === lanes.map((l) => l.title).slice(0, titles.length).sort().join('\\n'),");
m('A4: a subject without VTID is fine', RH, 'ok: commits.length > 0 && titles.every((t) => VTID_SUBJECT.test(t)),', 'ok: true,');
m('A4: a merge commit is fine', RH, 'ok: commits.length > 0 && commits.every((c) => (c.parent_ids ?? []).length === 1),', 'ok: true,');
m('A4: the landing order is not looked at', RH, "ok: titles.join('\\n') === merged.map((l) => l.title).join('\\n'),", 'ok: true,');
m('A4: a landed control passes', RH, "if (c.state === 'merged') checks.push({ name: c.id, ok: false,", "if (c.state === 'merged') checks.push({ name: c.id, ok: true,");
m('A4: any refusal reason is fine', RH, 'else if (c.codes.includes(c.expect)) checks.push(', 'else if (c.codes.length > 0) checks.push(');
// ---- A8, verdicts, exit code
m('A8: a job on the legacy runner is fine', RH, "{ name: 'legacy jobs', ok: onLegacy.length === 0,", "{ name: 'legacy jobs', ok: true,");
m('A8: no job on the fleet is fine', RH, 'ok: onFleet.length > 0 ? true : null,', 'ok: true,');
m('A8: a drifting settings check is fine', RH, "{ name: 'settings check', ok: settingsCheck.exitCode === 0, detail: `the settings check (tags and pause", "{ name: 'settings check', ok: true, detail: `the settings check (tags and pause");
m('settle: a failure is only unproven', RH, "if (checks.some((c) => c.ok === false)) return 'FAIL';", "if (checks.some((c) => c.ok === false)) return 'NOT_PROVEN';");
m('settle: unknown is a pass', RH, "if (checks.some((c) => c.ok === null)) return 'NOT_PROVEN';", '');
m('exit 0 with unproven acceptances', RH, "all.every((a) => a?.verdict === 'PASS')", "all.every((a) => a?.verdict !== 'FAIL')");
m('a report that cannot be made exits 0', RH, 'let exitCode = 1;', 'let exitCode = 0;');
m('a report that cannot be made hides the stop', RH, "`stop: ${model.stop ? `${model.stop.phase}: ${model.stop.message}` : 'none'}`", "'stop: none'");
m('exit 0 after a stop', RH, 'return !model.stop && all.every(', 'return all.every(');
// ---- the run
m('wave 2 does not wait for the first jobs', RH, 'if (await firstJobsStarted(ctx)) break;', 'if (true) break;');
m('wave 2 waits for fewer jobs', RH, 'return jobs.filter((j) => j.started_at).length >= ctx.plan.order.length;', 'return jobs.filter((j) => j.started_at).length >= 1;');
m('the no-review control is reviewed', RH, "if (item.control === 'no_review') continue;", '');
m('the builder\'s accept is pushed by the reviewer', RH, 'await writer(ctx, item.seat).commit(forgedAcceptBody(', 'await writer(ctx, REVIEWER).commit(forgedAcceptBody(');
m('the reviews are made by the seat', RH, 'const commit = await writer(ctx, REVIEWER).commit(reviewCommitBody(', 'const commit = await writer(ctx, item.seat).commit(reviewCommitBody(');
m('the stale control gets no later change', RH, "if (item.control === 'stale_review') {", "if (false) {");
m('the push event is not proven for the seed', RH, '  await expectPushEvent(ctx, review.id);\n', '');
m('the push event wait is endless', RH, 'const until = ctx.now() + 120_000;', 'const until = ctx.now() + 120_000_000;');
m('the seed is always rebuilt', RH, 'if (diff.create.length + diff.update.length === 0) {', 'if (false) {');
m('a seed that did not land is not a stop', RH, 'if (!landed) {\n    await readNotes', 'if (false) {\n    await readNotes');
m('the seed wait is short', RH, 't0 + 25 * 60_000', 't0 + 25 * 60');
m('the base commit is read too late', RH, "c.baseSha = (await c.obs.get(`${c.P}/repository/branches/${MAIN}`)).commit.id; await wave1(c);", "await wave1(c); c.baseSha = (await c.obs.get(`${c.P}/repository/branches/${MAIN}`)).commit.id;");
m('the landing wait ends at the first landing', RH, "if (lanes.every((l) => l.state === 'merged')) lanesDoneAt ??= ctx.now();", "if (lanes.some((l) => l.state === 'merged')) lanesDoneAt ??= ctx.now();");
m('the end reserve is zero', RH, 'export const END_RESERVE_MIN = 20;', 'export const END_RESERVE_MIN = 0;');
m('the controls\' branches are kept', RH, 'await w.deleteBranch(item.branch).catch(', 'await Promise.resolve().catch(');
m('the controls are left open', RH, "if (item.state === 'opened') { ctx.say(`closing control", "if (false) { ctx.say(`closing control");
m('the lane branches are deleted too', RH, "ctx.items.filter((i) => i.kind === 'control' && i.iid)", 'ctx.items.filter((i) => i.iid)');
m('merge requests of earlier runs are left open', RH, 'await writer(ctx, ctx.seats[0]).closeMr(mr.iid);', '');
m('sampling goes on after three failures', RH, 'ctx.model.samples.length >= 3 && ctx.sampling', 'ctx.model.samples.length >= 300 && ctx.sampling');
m('the fleet group has another name', RH, "asgName: deps.env?.FLEET_ASG_NAME || FLEET_ASG,", "asgName: 'vitana-eng-fleet-x',");
m('jobs are not settled before the report', RH, "ctx.phase = 'settle';\n    await settleJobs(ctx, Math.min(ctx.deadline, deps.now() + 15 * 60_000));", "ctx.phase = 'settle';");
// ---- secrets and output
m('tokens are not registered for redaction', RH, '    redactor.add(v);\n    return { token: v };', '    return { token: v };');
m('the report string that is returned is not redacted', RH, 'report = redactor(renderReport(ctx));', 'report = renderReport(ctx);');
m('stdout is not redacted', RH, 'const out = (l) => deps.stdout(redactor(String(l)));', 'const out = (l) => deps.stdout(String(l));');
m('stderr is not redacted', RH, 'const say = (l) => deps.stderr(redactor(`rehearse: ${l}`));', 'const say = (l) => deps.stderr(`rehearse: ${l}`);');
m('progress goes to stdout', RH, 'const say = (l) => deps.stderr(redactor(`rehearse: ${l}`));', 'const say = (l) => deps.stdout(redactor(`rehearse: ${l}`));');
m('a refusal exits with 1', RH, "return { exitCode: 2, refused: problems };", "return { exitCode: 1, refused: problems };");
m('a dry run writes (opens the seed)', RH, 'if (opts.dryRun) {', 'if (false) {');
m('the exit code of main is not returned', RH, 'return (await run(o, deps)).exitCode;', 'await run(o, deps); return 0;');
m('usage mistakes exit with 1', RH, "deps.stdout(USAGE);\n    return 2;", "deps.stdout(USAGE);\n    return 1;");
m('the progress line shows the active machines as the fleet', RH, 'fleet ${last ? `${last.total} (peak', 'fleet ${last ? `${last.active} (peak');

// ── harness ──────────────────────────────────────────────────────────────────
const SCRATCH = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'mutreh-'));
process.on('exit', () => fs.rmSync(SCRATCH, { recursive: true, force: true }));
const COPY = ['scripts/eng', 'scripts/collab', 'infra/gitlab-engineering/rehearsal', 'infra/gitlab-engineering/settings', 'infra/gitlab-engineering/ci', 'infra/gitlab-engineering/m2.sh'];

function copyTree(dest) {
  for (const rel of COPY) fs.cpSync(path.join(SRC, rel), path.join(dest, rel), { recursive: true });
}
const clean = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR };

function baseline() {
  const dir = path.join(SCRATCH, 'base');
  copyTree(dir);
  const out = (() => { try { return execFileSync(process.execPath, ['--test', TEST], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: TIMEOUT_MS, env: clean }); } catch (e) { return String(e.stdout || ''); } })();
  fs.rmSync(dir, { recursive: true, force: true });
  const tests = /^# tests (\d+)/m.exec(out)?.[1];
  const fail = /^# fail (\d+)/m.exec(out)?.[1];
  if (fail !== '0') { console.log(`baseline: the test fails on the unmutated tree (tests ${tests}, fail ${fail})`); process.exit(2); }
  console.log(`baseline: ${tests} tests pass on the unmutated tree`);
}

function find(mut, dir) {
  const file = path.join(dir, mut.file);
  const text = fs.readFileSync(file, 'utf8');
  const count = text.split(mut.from).length - 1;
  if (count === 0) return { verdict: 'NOOP', note: 'the text to change was not found: fix the mutation' };
  if (count > 1) return { verdict: 'AMBIGUOUS', note: `the text to change was found ${count} times: make it unique` };
  const changed = text.replace(mut.from, () => mut.to);
  if (changed === text) return { verdict: 'NOOP', note: 'the change left the file as it was' };
  return { file, changed };
}

function runOne(mut, index) {
  return new Promise((resolve) => {
    const dir = path.join(SCRATCH, String(index));
    copyTree(dir);
    const f = find(mut, dir);
    if (f.verdict) { fs.rmSync(dir, { recursive: true, force: true }); return resolve({ mut, ...f }); }
    fs.writeFileSync(f.file, f.changed);
    if (mut.file.endsWith('.mjs')) {
      try { execFileSync(process.execPath, ['--check', f.file], { stdio: 'ignore' }); } catch { fs.rmSync(dir, { recursive: true, force: true }); return resolve({ mut, verdict: 'INVALID', note: 'the changed file does not parse: it proves nothing' }); }
    }
    const child = spawn(process.execPath, ['--test', TEST], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: clean });
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

const chosen = M.map((mut, i) => ({ mut, i })).filter(({ mut }) => !ONLY || ONLY.test(mut.name));
if (process.env.CHECK_ONLY) {
  const dir = path.join(SCRATCH, 'check');
  copyTree(dir);
  let bad = 0;
  for (const { mut } of chosen) { const f = find(mut, dir); if (f.verdict) { bad += 1; console.log(`${f.verdict.padEnd(9)} ${mut.name}  <- ${f.note}`); } }
  console.log(`checked ${chosen.length} mutation(s): ${bad} cannot be applied`);
  process.exit(bad === 0 ? 0 : 1);
}
baseline();
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
