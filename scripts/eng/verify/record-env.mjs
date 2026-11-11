#!/usr/bin/env node
// VTID-05552 (agentic-delivery/verify-on-gitlab) — the `.record` job (plan agentic-delivery §3.6 step 4, §3.11 Writers).
//
//   node record-env.mjs run --record-script <scripts/ci/staging-verify/record-oasis.sh> --out <verify output dir> --secret-file <file>
//
// Runs scripts/ci/staging-verify/record-oasis.sh, unchanged, with the inputs GitHub's STAGING-VERIFY.yml gives it, from
// GitLab variables, the `.staging-verify` artifact and the vitana/ci/oasis-recorder secret (JSON with the GitHub
// secret names SUPABASE_URL and SUPABASE_SERVICE_ROLE). WORKFLOW = gitlab:<project>/staging-verify names the host
// that verified the run (the input lane prerequisites adds, VTID-05551). Only in live mode (DELIVERY_MODE=live): before
// the cutover GitHub is the only writer of staging.verify.* rows. Without the secret, record-oasis.sh itself refuses,
// so the job is red and the result stays in the verify job's artifact.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** metadata.workflow of a row written by the GitLab job of `projectPath`. */
export const gitlabWorkflow = (projectPath) => `gitlab:${projectPath}/staging-verify`;

/**
 * The record-oasis.sh environment. `ci` = the job's variables; `secret` = the parsed oasis-recorder secret or null;
 * `outDir` = the verify job's output directory (results.json); `target` = its target.json ({service, sha}) or null.
 */
export function recordEnv({ ci = {}, secret = null, outDir, target = null }) {
  return {
    SUPABASE_URL: ci.DATA_REST_URL || (secret && secret.SUPABASE_URL) || '',
    SUPABASE_SVC: (secret && secret.SUPABASE_SERVICE_ROLE) || '',
    RESULTS: join(outDir, 'results.json'),
    RUN_URL: ci.CI_PIPELINE_URL || '',
    SERVICE: (target && target.service) || ci.VERIFY_SERVICE || '',
    SHA: (target && target.sha) || ci.CI_COMMIT_SHA || '',
    WORKFLOW: gitlabWorkflow(ci.CI_PROJECT_PATH || ''),
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[\w-]+$/.test(argv[i] || '')) throw new Error(`unexpected argument ${argv[i]}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function run(argv) {
  const a = parseArgs(argv);
  if (process.env.DELIVERY_MODE !== 'live') {
    console.error(`[record] DELIVERY_MODE is "${process.env.DELIVERY_MODE || ''}", not live (shadow mode): nothing is recorded; GitHub's STAGING-VERIFY stays the only writer of staging.verify.* rows until the cutover (plan agentic-delivery §3.6 step 8).`);
    return 3;
  }
  for (const k of ['record-script', 'out']) if (!a[k]) throw new Error(`--${k} is required`);
  const outDir = resolve(a.out);
  const target = readJson(join(outDir, 'target.json'));
  if (!target && !existsSync(join(outDir, 'results.json'))) {
    console.log(`[record] ${outDir} has no target.json and no results.json: the verify job did not start, so there is nothing to record.`);
    return 0;
  }
  const secret = a['secret-file'] ? readJson(a['secret-file']) : null;
  if (a['secret-file']) rmSync(a['secret-file'], { force: true });
  if (!secret) console.error(`[record] the oasis-recorder secret ${a['secret-file'] || '(no --secret-file)'} is missing or not JSON`);
  const env = recordEnv({ ci: process.env, secret, outDir, target });
  // record-oasis.sh never needs the job's ID token.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_ID_TOKEN$/.test(k)));
  const r = spawnSync('bash', [resolve(a['record-script'])], { stdio: 'inherit', env: { ...base, ...env } });
  return r.status === null ? 1 : r.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd !== 'run') throw new Error('usage: record-env.mjs run --record-script <path> --out <dir> --secret-file <file>');
    process.exit(run(rest));
  } catch (e) {
    console.error(`[record] ${e.message}`);
    process.exit(2);
  }
}
