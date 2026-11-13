#!/usr/bin/env node
// VTID-05781 (plan autonomous-to-staging-r2, lane staging-cutover; design.md §5.5, §8): run the STAGING-VERIFY gateway
// smoke suite (scripts/ci/staging-verify/smoke/gateway.json, the same checks and the same evaluation as STAGING-VERIFY,
// lib.cjs evaluateHttp/httpRequestInit) against one staging base URL: the -iso candidate host during a rehearsal, the
// live staging host after a flip. Read-only: GETs and rejected probes with an invalid bearer only. A production host
// is refused (lib.cjs assertStagingTarget, CLAUDE.md rule 48).
//
//   node scripts/aws/staging-cutover-smoke.mjs --base https://… [--suite <json>] [--attempts 4] [--wait-ms 15000] [--out <file>]
//
// Each failing check is retried (Aurora auto-pause resume, design.md §2), then the run fails. Exit 0 all pass, 1 fail, 2 usage.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const lib = require(path.join(ROOT, 'scripts/ci/staging-verify/lib.cjs'));
export const DEFAULT_SUITE = 'scripts/ci/staging-verify/smoke/gateway.json';
const READ = new Set(['GET', 'HEAD']);

async function once(base, t, fetchImpl, timeoutMs) {
  const init = lib.httpRequestInit(t);
  if (!READ.has(init.method) && !t.rejected_probe) return { problems: [`${init.method} ${t.path} is not a read or a rejected probe; refusing to send it`] };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(base + t.path, { ...init, signal: ctl.signal, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = null; }
    const ev = lib.evaluateHttp(t, { status: res.status, contentType: res.headers.get('content-type'), json, body: text });
    if (!ev || !Array.isArray(ev.problems)) return { problems: ['evaluateHttp returned no problem list'], status: res.status };
    return { problems: ev.problems, status: res.status };
  } catch (e) {
    return { problems: [`request failed: ${e.message}`] };
  } finally { clearTimeout(timer); }
}

export async function runSmoke({ base, suite, attempts = 4, waitMs = 15000, timeoutMs = 30000, fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const origin = lib.assertStagingTarget(base);
  const tests = (suite.tests || []).filter((t) => t.kind === 'http');
  if (!tests.length) throw new Error('suite has no http tests');
  const results = [];
  for (const t of tests) {
    let r;
    let a = 0;
    while (a < attempts) {
      a += 1;
      r = await once(origin, t, fetchImpl, timeoutMs);
      if (r.problems.length === 0) break;
      if (a < attempts) await sleep(waitMs);
    }
    results.push({ name: t.name, path: t.path, pass: r.problems.length === 0, problems: r.problems, status: r.status ?? null, attempts: a });
  }
  return { base: origin, total: results.length, passed: results.filter((r) => r.pass).length, results };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const get = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const base = get('--base');
  if (!base) { console.log('usage: --base https://… [--suite file] [--attempts n] [--wait-ms ms] [--out file]'); process.exit(2); }
  let suite;
  try { suite = JSON.parse(fs.readFileSync(path.resolve(ROOT, get('--suite', DEFAULT_SUITE)), 'utf8')); } catch (e) { console.log(`usage error: ${e.message}`); process.exit(2); }
  runSmoke({ base, suite, attempts: Number(get('--attempts', 4)), waitMs: Number(get('--wait-ms', 15000)) }).then((r) => {
    for (const x of r.results) console.log(`${x.pass ? 'PASS' : 'FAIL'} ${x.name} (${x.path})${x.pass ? '' : `: ${x.problems.join('; ')}`}`);
    console.log(`smoke ${r.base}: ${r.passed}/${r.total} passed`);
    const out = get('--out');
    if (out) fs.writeFileSync(out, JSON.stringify(r, null, 2));
    process.exitCode = r.passed === r.total ? 0 : 1;
  }, (e) => { console.log(`::error::smoke refused: ${e.message}`); process.exitCode = 2; });
}
