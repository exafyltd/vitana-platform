#!/usr/bin/env node
/**
 * VTID-05800 — allocate a fresh VTID from anywhere, in one command.
 *
 * Owner decision 2026-11-15: any person, machine or process may allocate a VTID at any time. No sparring record, CI
 * run, admin role or token is needed (CLAUDE.md ALWAYS 2b and §4.1).
 *
 *   node scripts/dev/new-vtid.mjs ["<title>"] [--module <m>] [--layer <l>] [--source <s>] [--gateway <url>]
 *                                 [--json] [--no-workflow]
 *
 * Every argument is optional. It asks each gateway in turn, POST /api/v1/vtid/allocate, and the first one that
 * allocates wins: --gateway, VTID_GATEWAY_URL, GATEWAY_URL, then staging, then production. A credential is never
 * needed: GATEWAY_SERVICE_TOKEN (Authorization) and VTID_ALLOC_SECRET (X-VTID-Alloc-Secret) are sent when set, only
 * so the gateway records who allocated. When no gateway allocates and the GitHub CLI works, it runs the VTID-ALLOCATE
 * workflow of exafyltd/vitana-platform (which holds the service token) and reads its VTID_RESULT line.
 *
 * Prints the VTID on stdout (or one JSON line with --json). Exit 0 allocated, 1 not allocated, 2 usage.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const STAGING_GATEWAY = 'https://preview-aws-gateway.vitanaland.com';
export const PRODUCTION_GATEWAY = 'https://gateway.vitanaland.com';
export const WORKFLOW_REPO = 'exafyltd/vitana-platform';
export const WORKFLOW_FILE = 'VTID-ALLOCATE.yml';
const VTID_RE = /^VTID-\d{5}$/;

const USAGE = 'usage: node scripts/dev/new-vtid.mjs ["<title>"] [--module <m>] [--layer <l>] [--source <s>] [--gateway <url>] [--json] [--no-workflow]';

export function parseArgs(argv) {
  const opts = { title: '', module: 'TASK', layer: 'DEV', source: 'cli', gateway: '', json: false, workflow: true };
  const words = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--module') opts.module = value();
    else if (a === '--layer') opts.layer = value();
    else if (a === '--source') opts.source = value();
    else if (a === '--gateway') opts.gateway = value();
    else if (a === '--title') opts.title = value();
    else if (a === '--json') opts.json = true;
    else if (a === '--no-workflow') opts.workflow = false;
    else if (a === '-h' || a === '--help') opts.help = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else words.push(a);
  }
  if (!opts.title && words.length) opts.title = words.join(' ');
  return opts;
}

/** The gateways to try, in order, without duplicates or empty entries. */
export function gatewayList(opts, env = process.env) {
  const list = [opts.gateway, env.VTID_GATEWAY_URL, env.GATEWAY_URL, STAGING_GATEWAY, PRODUCTION_GATEWAY]
    .map((u) => String(u || '').trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...new Set(list)];
}

export function requestBody(opts) {
  const body = { source: opts.source || 'cli', layer: opts.layer || 'DEV', module: opts.module || 'TASK' };
  if (opts.title && opts.title.trim()) body.title = opts.title.trim();
  return body;
}

export function requestHeaders(env = process.env) {
  const headers = { 'Content-Type': 'application/json' };
  if (env.GATEWAY_SERVICE_TOKEN) headers.Authorization = `Bearer ${env.GATEWAY_SERVICE_TOKEN}`;
  if (env.VTID_ALLOC_SECRET) headers['X-VTID-Alloc-Secret'] = env.VTID_ALLOC_SECRET;
  return headers;
}

/** One gateway: { ok: true, vtid } or { ok: false, reason }. Never throws. */
export async function allocateOnGateway(url, opts, { fetchImpl = globalThis.fetch, env = process.env, timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/api/v1/vtid/allocate`, {
      method: 'POST',
      headers: requestHeaders(env),
      body: JSON.stringify(requestBody(opts)),
      signal: controller.signal,
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    const vtid = json && typeof json.vtid === 'string' ? json.vtid : '';
    if (res.status === 201 && json && json.ok === true && VTID_RE.test(vtid)) return { ok: true, vtid };
    return { ok: false, reason: `HTTP ${res.status}${json && json.error ? ` ${json.error}` : ''}` };
  } catch (err) {
    return { ok: false, reason: err && err.name === 'AbortError' ? 'timeout' : String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

const ghDefault = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

/** The VTID-ALLOCATE workflow through the GitHub CLI: { ok: true, vtid, run } or { ok: false, reason }. */
export async function allocateViaWorkflow(opts, { gh = ghDefault, sleep = sleepDefault, now = Date.now, polls = 60, everyMs = 5000, requestId } = {}) {
  const id = requestId || `new-vtid-${randomBytes(6).toString('hex')}`;
  try {
    gh(['api', '-X', 'POST', `repos/${WORKFLOW_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
      '-f', 'ref=main',
      '-f', `inputs[title]=${opts.title || ''}`,
      '-f', `inputs[module]=${opts.module || 'TASK'}`,
      '-f', `inputs[source]=${opts.source || 'cli'}`,
      '-f', `inputs[request_id]=${id}`]);
  } catch (err) {
    return { ok: false, reason: `workflow dispatch failed: ${String(err && err.message ? err.message : err).split('\n')[0]}` };
  }
  const since = now() - 60_000;
  for (let i = 0; i < polls; i++) {
    await sleep(everyMs);
    let runs = [];
    try {
      runs = JSON.parse(gh(['api', `repos/${WORKFLOW_REPO}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&per_page=20`])).workflow_runs || [];
    } catch { continue; }
    const run = runs.find((r) => String(r.display_title || r.name || '').includes(id) && Date.parse(r.created_at) >= since);
    if (!run || run.status !== 'completed') continue;
    if (run.conclusion !== 'success') return { ok: false, reason: `workflow run ${run.id} ended ${run.conclusion}` };
    let log = '';
    try { log = gh(['run', 'view', String(run.id), '--repo', WORKFLOW_REPO, '--log']); } catch (err) {
      return { ok: false, reason: `cannot read the log of run ${run.id}` };
    }
    const m = /VTID_RESULT=(VTID-\d{5})/.exec(log);
    return m ? { ok: true, vtid: m[1], run: run.id } : { ok: false, reason: `run ${run.id} printed no VTID_RESULT` };
  }
  return { ok: false, reason: 'the workflow run did not finish in time' };
}

/** Gateways first, then the workflow. { ok, vtid, via, tried[] }. */
export async function allocateVtid(opts, deps = {}) {
  const env = deps.env || process.env;
  const tried = [];
  for (const url of gatewayList(opts, env)) {
    const r = await allocateOnGateway(url, opts, { fetchImpl: deps.fetchImpl, env, timeoutMs: deps.timeoutMs });
    if (r.ok) return { ok: true, vtid: r.vtid, via: url, tried };
    tried.push(`${url}: ${r.reason}`);
  }
  if (opts.workflow !== false) {
    const w = await allocateViaWorkflow(opts, deps);
    if (w.ok) return { ok: true, vtid: w.vtid, via: `workflow ${WORKFLOW_FILE} run ${w.run}`, tried };
    tried.push(`workflow ${WORKFLOW_FILE}: ${w.reason}`);
  }
  return { ok: false, vtid: null, via: null, tried };
}

export async function main(argv, deps = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (err) {
    console.error(`new-vtid: ${err.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) { console.log(USAGE); return 0; }
  const r = await allocateVtid(opts, deps);
  if (opts.json) console.log(JSON.stringify(r));
  else if (r.ok) console.log(r.vtid);
  if (!r.ok && !opts.json) console.error(`new-vtid: no VTID allocated\n  ${r.tried.join('\n  ')}`);
  return r.ok ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
