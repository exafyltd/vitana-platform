#!/usr/bin/env node
// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover; design.md §6.3-§6.4, §8, §9): may the staging data
// plane be flipped to isolated now? Pure decision over the inputs below; no AWS call. Fails closed.
//
//   node scripts/aws/staging-cutover-gate.mjs --sha <40-hex> --runs <rehearsal runs JSON> --impact <impact.mjs --json> \
//        --busy <file: one URL per queued or running staging deploy / STAGING-VERIFY run>
//
// Environment (the cutover workflow maps the repository variables):
//   STAGING_CUTOVER_APPROVED  must be 'yes' (owner, after a passing rehearsal)
//   PLAN_SPAR_GATEWAY_URL     must be the production gateway: PLAN-SPAR.yml and VTID-ALLOCATE.yml default to the staging
//                             gateway, and an isolated staging gateway would hold a second VTID ledger
//   STAGING_DATA_PLANE        must be unset or 'shared' (the flip is the only way to isolated; the owner sets the
//                             variable to 'isolated' only after a successful flip)
//   STAGING_DB_CLIENT_SG_ID   the stack output DbClientSecurityGroupId (sg-…), attached to both staging services
// Rehearsal: a successful AWS-STAGE-CUTOVER-REHEARSAL.yml run in mode 'run' (run-name "Staging cutover rehearsal run @ <sha>"),
// dispatched on main, on exactly this commit, at most 7 days old.
// Exit: 0 allowed, 1 refused (every reason printed), 2 usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_GATEWAY = 'https://gateway.vitanaland.com';
export const REHEARSAL_MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/** The newest qualifying rehearsal run for `sha`, or null. `runs` = GitHub workflow_runs array. */
export function passingRehearsal(runs, sha, now = Date.now()) {
  const ok = (runs || []).filter((r) => r && r.head_sha === sha && r.conclusion === 'success' && r.status === 'completed'
    && r.event === 'workflow_dispatch' && r.head_branch === 'main'
    && typeof r.display_title === 'string' && r.display_title.startsWith(`Staging cutover rehearsal run @ ${sha}`)
    && now - Date.parse(r.updated_at || r.created_at || 0) <= REHEARSAL_MAX_AGE_MS);
  ok.sort((a, b) => Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0));
  return ok[0] || null;
}

export function decide({ sha, runs, impact, busy, env = process.env, now = Date.now() }) {
  const reasons = [];
  if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) reasons.push(`commit '${sha}' is not a full 40-character SHA`);
  if (env.STAGING_CUTOVER_APPROVED !== 'yes') reasons.push("repository variable STAGING_CUTOVER_APPROVED is not 'yes' (owner approval after a passing rehearsal, design.md §6.3)");
  if (env.PLAN_SPAR_GATEWAY_URL !== PRODUCTION_GATEWAY) reasons.push(`repository variable PLAN_SPAR_GATEWAY_URL is '${env.PLAN_SPAR_GATEWAY_URL || ''}', not ${PRODUCTION_GATEWAY}: PLAN-SPAR and VTID-ALLOCATE would write a second ledger on the isolated staging gateway (design.md §6.4)`);
  const plane = env.STAGING_DATA_PLANE || 'shared';
  if (plane !== 'shared') reasons.push(`repository variable STAGING_DATA_PLANE is '${plane}'; the flip starts from shared (set it to isolated only after a successful flip)`);
  if (!/^sg-[0-9a-f]{8,17}$/.test(String(env.STAGING_DB_CLIENT_SG_ID || ''))) reasons.push('repository variable STAGING_DB_CLIENT_SG_ID is not a security group id (stack output DbClientSecurityGroupId)');
  const run = passingRehearsal(runs, sha, now);
  if (!run) reasons.push(`no successful rehearsal (mode run) of commit ${sha} on main in the last 7 days`);
  if (!impact || typeof impact !== 'object' || !Array.isArray(impact.blockers)) reasons.push('impact report missing or unreadable (scripts/ci/staging-db/impact.mjs --json)');
  else for (const b of impact.blockers) reasons.push(`impact: ${b}`);
  if (!Array.isArray(busy)) reasons.push('the list of running staging deploys / STAGING-VERIFY runs is missing');
  else for (const u of busy) reasons.push(`a staging deploy or STAGING-VERIFY is queued or running (one staging deploy at a time, collaboration.md §8a): ${u}`);
  return { allowed: reasons.length === 0, reasons, rehearsal: run ? run.html_url || run.id : null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const sha = get('--sha'); const runsFile = get('--runs'); const impactFile = get('--impact'); const busyFile = get('--busy');
  if (!sha || !runsFile || !impactFile || !busyFile) { console.log('usage: --sha <sha> --runs <file> --impact <file> --busy <file>'); process.exit(2); }
  const runsDoc = readJson(runsFile);
  let busy = null;
  try { busy = fs.readFileSync(busyFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean); } catch { busy = null; }
  const r = decide({ sha, runs: Array.isArray(runsDoc) ? runsDoc : runsDoc?.workflow_runs, impact: readJson(impactFile), busy });
  for (const x of r.reasons) console.log(`::error::Refused: ${x}`);
  console.log(r.allowed ? `cutover gate: ALLOWED (rehearsal ${r.rehearsal})` : `cutover gate: REFUSED (${r.reasons.length} reason(s)); nothing was changed`);
  process.exitCode = r.allowed ? 0 : 1;
}
