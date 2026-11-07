// `npm test` of the rehearsal repository, and so the body of the required CI job `unit` (infra/gitlab-engineering/ci/rehearsal.gitlab-ci.yml).
// 1. Runs every test/**/*.test.mjs with `node --test` (no install, no dependency); the exit code of this script is the exit code of the tests.
// 2. Then, whatever the tests said, prints the negative controls of acceptance A2 (scripts/negctl.mjs): one line `NEGCTL <name> PASS|FAIL`
//    each, preceded by `negctl: <name>: <detail>`. They are read from the job trace by scripts/eng/rehearse.mjs and never change the exit code.
// 3. Last, one `NEGCTL-INFO baseline ...` line: whether the job can reach GitLab at all (information only; it is not a control).
// Environment: NEGCTL_TIMEOUT_MS (100 to 10000, default 3000) shortens the waits of the network controls; only tests set it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runAll, checkBaseline, formatLine, formatInfo, DEFAULT_TIMEOUT_MS } from './negctl.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every *.test.mjs under dir, sorted, as paths relative to ROOT (so node --test prints short names). */
export function findTests(dir = path.join(ROOT, 'test')) {
  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith('.test.mjs')) found.push(path.relative(ROOT, p));
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return found;
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'rehearsal.config.json'), 'utf8')); } catch { return {}; }
}

function timeoutFromEnv(env) {
  const n = Number(env.NEGCTL_TIMEOUT_MS);
  return Number.isInteger(n) && n >= 100 && n <= 10000 ? n : DEFAULT_TIMEOUT_MS;
}

export async function main(env = process.env) {
  const tests = findTests();
  let status = 1;
  if (tests.length === 0) {
    console.log('ci-test: no test files found under test/');
  } else {
    const r = spawnSync(process.execPath, ['--test', ...tests], { cwd: ROOT, stdio: 'inherit', env });
    status = r.status ?? 1;
  }
  console.log('ci-test: negative controls (plan eng-gitlab-m2, acceptance A2)');
  const timeoutMs = timeoutFromEnv(env);
  const [results, baseline] = await Promise.all([runAll({ env, config: readConfig(), timeoutMs }), checkBaseline({ env, timeoutMs })]);
  for (const result of results) {
    console.log(`negctl: ${result.name}: ${result.detail}`);
    console.log(formatLine(result));
  }
  console.log(formatInfo(baseline));
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
