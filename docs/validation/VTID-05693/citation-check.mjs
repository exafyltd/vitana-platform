#!/usr/bin/env node
// Lane-local citation check (strategy-execution-wave1). Usage: node citation-check.mjs <repo root> <doc.md>...
// Every backticked `path:spec` (spec = N, N-M, or a comma list of both) must name an existing file with at least the
// highest cited line. A backticked `:spec` with no path refers to the last path cited earlier on the same line.
// Prints one line per citation and a summary; exits 1 on any failure. Read-only; no dependencies.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const [root, ...docs] = process.argv.slice(2);
if (!root || docs.length === 0) {
  console.error('usage: node citation-check.mjs <repo root> <doc.md>...');
  process.exit(2);
}
const lineCount = new Map();
function linesOf(file) {
  if (!lineCount.has(file)) lineCount.set(file, readFileSync(file, 'utf8').split('\n').length);
  return lineCount.get(file);
}
function maxLine(spec) {
  return Math.max(...spec.split(',').flatMap((part) => part.split('-').map(Number)));
}
let total = 0;
let failures = 0;
for (const doc of docs) {
  const text = readFileSync(doc, 'utf8').split('\n');
  text.forEach((line, i) => {
    let lastPath = null;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const tok = m[1].trim();
      const full = tok.match(/^([\w./-]+\.[\w]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
      const short = tok.match(/^:(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/);
      let path = null;
      let spec = null;
      if (full) { path = full[1]; spec = full[2]; lastPath = path; }
      else if (short && lastPath) { path = lastPath; spec = short[1]; }
      else if (short) { total += 1; failures += 1; console.log(`FAIL ${doc}:${i + 1} ${tok} (no path earlier on the line)`); continue; }
      else continue;
      total += 1;
      const abs = join(root, path);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        failures += 1;
        console.log(`FAIL ${doc}:${i + 1} ${path}:${spec} (file missing)`);
        continue;
      }
      const have = linesOf(abs);
      const want = maxLine(spec);
      if (want > have) {
        failures += 1;
        console.log(`FAIL ${doc}:${i + 1} ${path}:${spec} (file has ${have} lines)`);
      } else {
        console.log(`ok   ${doc}:${i + 1} ${path}:${spec}`);
      }
    }
  });
}
console.log(`citations: ${total}, failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
