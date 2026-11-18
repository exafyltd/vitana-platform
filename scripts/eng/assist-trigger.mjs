// The assist trigger of the merge bot (plan agentic-delivery §3.9, lane merge-queue).
//
// Some jobs must write to a merge request's branch (I18N-PROPAGATE fills every language when the German source changes).
// They need secrets, so they never run on the untrusted class. The bot starts them:
//  - it moves the protected ref `assist/<iid>-<rule>` to `main` (only bot-land and the owner may push there; a normal push,
//    never a force, and with `ci.skip` so the push itself starts nothing), then
//  - starts one pipeline on that ref with the variables ASSIST_MR_IID, ASSIST_MR_HEAD, ASSIST_RULE and ASSIST_SOURCE_BRANCH;
//    the T7 job (lane `pipelines`) runs main's tool on the merge request's files as data and pushes its result as bot-assist.
// Once per head and rule: the newest pipeline the bot started on the ref (source `api`) carries the head it was started
// for. Never after an accept (the result would end the accept's validity) and never for a merge request that changes a
// protected gate file. A merge request with a pending assist waits.
// Rules come from the service list (`config/delivery/services.json`, lane `pipelines`); this module reads only
// `repositories.<project>.services[].assist[] = { rule, paths }`. No file is no rules; a malformed one throws (the tick
// fails closed). Dependency-free Node 20.

import fs from 'node:fs';
import { globToRegex } from '../collab/queue.mjs';

const RULE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH_OK = /^[A-Za-z0-9._/-]{1,200}$/;
const DONE = new Set(['success']);
const FAILED = new Set(['failed', 'canceled']);

/** The protected ref of one merge request and rule. */
export function assistRef(iid, rule) {
  if (!Number.isInteger(iid) || iid < 1) throw new Error(`assist ref: the iid must be a positive integer, not ${JSON.stringify(iid)}`);
  if (!RULE.test(String(rule))) throw new Error(`assist ref: the rule "${rule}" must be lowercase letters, digits and dashes`);
  return `assist/${iid}-${rule}`;
}

/** The assist rules of `project` in the service list → [{ rule, paths }]. */
export function loadAssistRules(file, project) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`${file}: the service list cannot be read (${e.code})`);
  }
  let list;
  try { list = JSON.parse(text); } catch { throw new Error(`${file}: the service list is not JSON`); }
  const services = list?.repositories?.[project]?.services;
  if (services === undefined) return [];
  if (!Array.isArray(services)) throw new Error(`${file}: repositories.${project}.services of the service list must be a list`);
  const out = [];
  for (const svc of services) {
    for (const a of Array.isArray(svc?.assist) ? svc.assist : []) {
      const ok = RULE.test(String(a?.rule)) && Array.isArray(a?.paths) && a.paths.length > 0 && a.paths.every((p) => typeof p === 'string' && p !== '');
      if (!ok) throw new Error(`${file}: an assist rule of ${project} needs a rule name (lowercase letters, digits, dashes) and a list of paths`);
      if (!out.some((r) => r.rule === a.rule)) out.push({ rule: a.rule, paths: [...a.paths] });
    }
  }
  return out;
}

/** The rules whose paths the merge request changes. */
export function matchingRules(files, rules) {
  return (rules || []).filter((r) => files.some((f) => r.paths.some((g) => globToRegex(g).test(f))));
}

/**
 * What the assists of one merge request head need, without IO. `runs` = assistRuns' answer: { <rule>: { head, status } | null }.
 * → { trigger: [rule], pending: [rule], done: [rule], failed: [rule], state: 'none' | 'trigger' | 'pending' | 'done' | 'failed', reason }
 */
export function assistActions({ head, files, rules, runs = {}, accepted = false, protectedFiles = [] }) {
  const out = { trigger: [], pending: [], done: [], failed: [], state: 'none', reason: 'no assist rule applies' };
  const matched = matchingRules(files, rules);
  if (!matched.length) return out;
  let held = '';
  for (const r of matched) {
    const run = runs[r.rule];
    if (run && run.head === head) {
      if (DONE.has(run.status)) out.done.push(r.rule);
      else if (FAILED.has(run.status)) out.failed.push(r.rule);
      else out.pending.push(r.rule);
    } else if (protectedFiles.length) held = 'an assist never starts for a merge request that changes a protected gate file';
    else if (accepted) held = 'an assist never starts after the review accept (its commit would end the accept)';
    else out.trigger.push(r.rule);
  }
  if (out.failed.length) Object.assign(out, { state: 'failed', reason: `assist ${out.failed.join(', ')} failed for this head` });
  else if (out.pending.length) Object.assign(out, { state: 'pending', reason: `assist ${out.pending.join(', ')} is still running for this head` });
  else if (out.trigger.length) Object.assign(out, { state: 'trigger', reason: `assist ${out.trigger.join(', ')} starts for this head` });
  else if (held) Object.assign(out, { state: 'none', reason: held });
  else Object.assign(out, { state: 'done', reason: `assist ${out.done.join(', ')} done for this head` });
  return out;
}

/** The newest pipeline the bot started on each rule's assist ref, with the head it was started for. Reads only. */
export async function assistRuns(ctx, pid, iid, rules) {
  const out = {};
  for (const r of rules) {
    const ref = assistRef(iid, r.rule);
    const list = await ctx.client.get(`/projects/${pid}/pipelines`, { query: { ref, order_by: 'id', sort: 'desc', per_page: 20 } });
    const started = (Array.isArray(list) ? list : []).filter((p) => p?.ref === ref && (p.source === undefined || p.source === 'api') && p.status !== 'skipped');
    const newest = started.sort((a, b) => b.id - a.id)[0];
    if (!newest) { out[r.rule] = null; continue; }
    const vars = await ctx.client.get(`/projects/${pid}/pipelines/${newest.id}/variables`);
    const head = (Array.isArray(vars) ? vars : []).find((v) => v?.key === 'ASSIST_MR_HEAD')?.value ?? null;
    out[r.rule] = { pipeline: newest.id, head, status: newest.status };
  }
  return out;
}

/** Move assist/<iid>-<rule> to main (ci.skip, never a force) and start its pipeline. `ctx.git(args)` runs git in the bot's clone. */
export async function triggerAssist(ctx, { pid, iid, head, rule, mainSha, sourceBranch }) {
  const ref = assistRef(iid, rule);
  if (!SHA.test(head || '') || !SHA.test(mainSha || '') || !BRANCH_OK.test(sourceBranch || '')) throw new Error(`assist ${ref}: bad head, main or source branch`);
  if (ctx.dryRun) { ctx.log({ event: 'would_trigger_assist', mr: iid, rule, head }); return { triggered: false }; }
  try {
    ctx.git(['push', '-q', '-o', 'ci.skip', 'origin', `${mainSha}:refs/heads/${ref}`]);
  } catch (e) {
    throw new Error(`git push of ${ref} was refused (${String(e.stderr || e.message).trim().split('\n').slice(-1)[0]}); no pipeline was started`);
  }
  const variables = [
    { key: 'ASSIST_MR_IID', value: String(iid) }, { key: 'ASSIST_MR_HEAD', value: head }, { key: 'ASSIST_RULE', value: rule }, { key: 'ASSIST_SOURCE_BRANCH', value: sourceBranch },
  ];
  const res = await ctx.client.post(`/projects/${pid}/pipeline`, { body: { ref, variables } });
  ctx.log({ event: 'assist_triggered', mr: iid, rule, head, pipeline: res?.id ?? null });
  return { triggered: true, pipeline: res?.id ?? null };
}
