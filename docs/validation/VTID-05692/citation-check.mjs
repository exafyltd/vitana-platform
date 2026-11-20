#!/usr/bin/env node
// Lane-local citation check (strategy-execution-wave1, docs-only lanes).
// Extracts every `path:line[-line][,line[-line]...]` citation from the given Markdown files and verifies, at a
// pinned commit, that the file exists and has at least as many lines as the highest cited line, and that every
// range is ascending. Read-only: it only runs `git cat-file` and `git show` against local checkouts.
//
// Usage:
//   node citation-check.mjs --repo <dir> --pin <sha> --doc <file.md> [--doc ...]
//        [--alias <prefix>=<dir>@<ref> ...] [--no-emdash] [--no-email]
// An alias maps a cited path prefix (for example `vitanaland-strategy/`) to another checkout and ref.
// Exit 0 when every citation resolves and the optional text checks pass, 1 otherwise, 2 on usage errors.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const docs = [];
const aliases = [];
let repo = '.';
let pin = null;
let noEmdash = false;
let noEmail = false;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--repo') repo = args[++i];
  else if (a === '--pin') pin = args[++i];
  else if (a === '--doc') docs.push(args[++i]);
  else if (a === '--alias') {
    const m = /^([^=]+)=(.+)@([^@]+)$/.exec(args[++i] || '');
    if (!m) { console.error('bad --alias, want <prefix>=<dir>@<ref>'); process.exit(2); }
    aliases.push({ prefix: m[1], dir: m[2], ref: m[3] });
  } else if (a === '--no-emdash') noEmdash = true;
  else if (a === '--no-email') noEmail = true;
  else { console.error(`unknown argument ${a}`); process.exit(2); }
}
if (!pin || docs.length === 0) { console.error('need --pin and at least one --doc'); process.exit(2); }

// path: at least one segment with an extension; line spec: N, N-M, comma-separated.
const CITE = /(?<![\w/.@-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)(?![\w-])/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const lineCache = new Map();

function resolve(path) {
  for (const al of aliases) if (path.startsWith(al.prefix)) return { dir: al.dir, ref: al.ref, rel: path.slice(al.prefix.length) };
  return { dir: repo, ref: pin, rel: path };
}

function lineCount({ dir, ref, rel }) {
  const key = `${dir}\0${ref}\0${rel}`;
  if (lineCache.has(key)) return lineCache.get(key);
  let n = null;
  try {
    execFileSync('git', ['-C', dir, 'cat-file', '-e', `${ref}:${rel}`], { stdio: 'ignore' });
    const text = execFileSync('git', ['-C', dir, 'show', `${ref}:${rel}`], { maxBuffer: 1 << 28 }).toString('utf8');
    n = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    n = null;
  }
  lineCache.set(key, n);
  return n;
}

let total = 0;
let failures = 0;
for (const doc of docs) {
  const text = readFileSync(doc, 'utf8');
  for (const m of text.matchAll(CITE)) {
    total++;
    const [cite, path, spec] = m;
    const target = resolve(path);
    const n = lineCount(target);
    const problems = [];
    if (n === null) problems.push(`file not found at ${target.ref.slice(0, 10)}`);
    else {
      for (const part of spec.split(',')) {
        const [a, b] = part.split('-').map(Number);
        const hi = b ?? a;
        if (a < 1) problems.push(`line ${a} < 1`);
        if (b !== undefined && b < a) problems.push(`range ${part} descends`);
        if (hi > n) problems.push(`line ${hi} > ${n} lines`);
      }
    }
    if (problems.length) { failures++; console.log(`FAIL ${doc}: ${cite} (${problems.join('; ')})`); }
    else console.log(`ok   ${cite} (${n} lines)`);
  }
  if (noEmdash) {
    const k = (text.match(/\u2014/g) || []).length;
    if (k) { failures++; console.log(`FAIL ${doc}: ${k} em dash(es)`); } else console.log(`ok   ${doc}: no em dash`);
  }
  if (noEmail) {
    const found = text.match(EMAIL) || [];
    if (found.length) { failures++; console.log(`FAIL ${doc}: ${found.length} e-mail address(es)`); } else console.log(`ok   ${doc}: no e-mail address`);
  }
}
console.log(`citations=${total} failures=${failures}`);
process.exit(failures ? 1 : 0);
