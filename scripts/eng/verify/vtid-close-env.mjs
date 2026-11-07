#!/usr/bin/env node
// VTID-05552 (agentic-delivery/verify-on-gitlab) — the `.vtid-close` job (plan agentic-delivery §3.6 step 5).
//
//   node vtid-close-env.mjs run --close-script <scripts/ci/vtid-auto-close.cjs> [--secret-file <file>]
//
// Runs scripts/ci/vtid-auto-close.cjs, unchanged, with the environment GitHub's VTID-AUTO-CLOSE.yml gives it, taken
// from the squash commit the merge bot wrote on `main` (CI_COMMIT_MESSAGE; plan §3.5): PR_TITLE = the merge request
// title, PR_BODY = its description, PR_HEAD_REF = `Source-Branch:`, PR_LABELS = [] (labels are not in the commit),
// PR_REF = <project>!<iid> from `Merge-Request: !<iid>`. A commit without that trailer was not landed by the merge bot,
// so nothing is closed. Only in live mode (DELIVERY_MODE=live): before the cutover GitHub is the only closer.
// GATEWAY_SERVICE_TOKEN comes from --secret-file (the JSON of vitana/ci/gateway-service-token) and is never printed.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TRAILER = /^([A-Za-z0-9][A-Za-z0-9-]*):[ \t]*(.*)$/;

/** Title, description and the trailer block (the last run of `Key: value` lines) of a commit message. */
export function parseSquashMessage(message) {
  const lines = String(message ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
  const title = (lines.shift() || '').trim();
  let end = lines.length;
  while (end > 0 && TRAILER.test(lines[end - 1])) end--;
  const trailers = {};
  for (const l of lines.slice(end)) {
    const [, k, v] = TRAILER.exec(l);
    if (!(k in trailers)) trailers[k] = v.trim();
  }
  const body = lines.slice(0, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return { title, body, trailers };
}

/** The vtid-auto-close.cjs environment of a merge-bot squash commit, or null when the commit is not one. */
export function vtidCloseEnv({ message, projectPath }) {
  const { title, body, trailers } = parseSquashMessage(message);
  const iid = /^!(\d+)$/.exec(trailers['Merge-Request'] || '');
  if (!title || !iid) return null;
  return {
    PR_TITLE: title,
    PR_BODY: body,
    PR_HEAD_REF: trailers['Source-Branch'] || '',
    PR_LABELS: '[]',
    PR_REF: `${projectPath}!${iid[1]}`,
  };
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
    console.error(`[vtid-close] DELIVERY_MODE is "${process.env.DELIVERY_MODE || ''}", not live (shadow mode): nothing is closed; GitHub's VTID-AUTO-CLOSE stays the only closer until the cutover (plan agentic-delivery §3.6 step 8).`);
    return 3;
  }
  if (!a['close-script']) throw new Error('--close-script is required');
  const env = vtidCloseEnv({ message: process.env.CI_COMMIT_MESSAGE, projectPath: process.env.CI_PROJECT_PATH || '' });
  if (!env) {
    console.log('[vtid-close] the commit carries no Merge-Request trailer: it was not landed by the merge bot, so no VTID is closed.');
    return 0;
  }
  let token = '';
  if (a['secret-file']) {
    try {
      token = JSON.parse(readFileSync(a['secret-file'], 'utf8')).GATEWAY_SERVICE_TOKEN || '';
    } catch (e) {
      console.error(`[vtid-close] ${a['secret-file']} unreadable (${e.code || 'not JSON'}): the close runs without the service token`);
    }
    rmSync(a['secret-file'], { force: true });
  }
  console.log(`[vtid-close] ${env.PR_REF}: ${env.PR_TITLE} (source branch ${env.PR_HEAD_REF || 'unknown'})`);
  // vtid-auto-close.cjs never needs the job's ID token.
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/_ID_TOKEN$/.test(k)));
  const r = spawnSync(process.execPath, [resolve(a['close-script'])], {
    stdio: 'inherit',
    env: { ...base, ...env, GATEWAY_SERVICE_TOKEN: token },
  });
  return r.status === null ? 1 : r.status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd !== 'run') throw new Error('usage: vtid-close-env.mjs run --close-script <path> [--secret-file <file>]');
    process.exit(run(rest));
  } catch (e) {
    console.error(`[vtid-close] ${e.message}`);
    process.exit(2);
  }
}
