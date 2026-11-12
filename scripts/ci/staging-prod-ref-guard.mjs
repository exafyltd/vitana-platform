#!/usr/bin/env node
// VTID-05782 (plan autonomous-to-staging-r2, lane staging-db-provision; design.md §4, plan §3.3): the staging
// production-reference guard. It lists every production identifier found in the staging workflows, the staging
// scripts and infra/staging-db/**, so the isolated staging data plane can never name a production resource.
//
//   node scripts/ci/staging-prod-ref-guard.mjs [--report|--enforce] [--json] [--files <file|dir> ...]
//
// --report (default) prints the findings and exits 0; --enforce exits 1 when there is any finding; 2 = usage error.
// Without --files it scans the default staging set (DEFAULT_TARGETS). Directories are walked; test files and
// test fixtures, this file itself and its data file ALLOW_LIST are never part of the default set (nor of a walked directory).
//
// One exception, and only for CloudFormation templates (JSON, read as JSON even when named .yaml): an identifier
// inside a policy Statement whose Effect is "Deny" is not a finding — that statement exists to refuse production
// (infra/staging-db/stack.yaml DenyProduction / DenyProdSecrets). Anything outside a Deny statement counts.
//
// The literal identifiers below are pinned by the gate invariant (scripts/collab/gate-invariants.test.mjs
// REQUIRED_PROD_REFS): removing one fails that check.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SELF = 'scripts/ci/staging-prod-ref-guard.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Production identifiers (design.md plan §3.3). `id` names the finding; `re` is matched per line / per JSON string. */
export const PRODUCTION_IDENTIFIERS = Object.freeze([
  { id: 'supabase-project-ref', literal: 'inmkhvwdcuyhnxkgfvsb', label: 'production Supabase project ref' },
  { id: 'aurora-cluster', literal: 'vitana-aurora-prod', label: 'production Aurora cluster' },
  { id: 'prod-role-secret', literal: 'AWS_PROD_ROLE_ARN', label: 'production deploy role (GitHub secret/variable)' },
  { id: 'aurora-prod-secret', literal: 'vitana/aurora/prod/postgrest-authenticator-uri', label: 'production PostgREST authenticator secret' },
  { id: 'aurora-prod-secret-prefix', literal: 'vitana/aurora/prod/', label: 'production Aurora secret prefix' },
  { id: 'supabase-prod-secret-prefix', literal: 'vitana/supabase/prod/', label: 'production Supabase secret prefix' },
  { id: 'gateway-awsdr-secret-prefix', literal: 'vitana/gateway-awsdr/', label: 'production gateway secret prefix' },
  { id: 'rds-proxy', literal: 'vitana-rds-proxy-prod', label: 'production RDS proxy' },
  { id: 'alb', literal: 'vitana-alb-prod', label: 'production load balancer' },
  { id: 'kms-key', literal: 'arn:aws:kms:eu-central-1:472838866351:key/1cd1f8d1-fc05-4de8-acdd-76e76b8a39d1', label: 'production KMS key' },
  { id: 'kms-key-id', literal: '1cd1f8d1-fc05-4de8-acdd-76e76b8a39d1', label: 'production KMS key id' },
  { id: 'awsdr-service', pattern: '\\b[a-z0-9][a-z0-9-]*-awsdr\\b', label: 'production ECS service (*-awsdr)' },
].map((e) => Object.freeze({ ...e, re: new RegExp(e.pattern || esc(e.literal), 'g') })));

/** The default scan set: staging workflows, staging scripts and the staging database stack. */
export const DEFAULT_TARGETS = Object.freeze([
  { dir: '.github/workflows', match: /^(AWS-STAGE-.*|STAGING-DB-SCHEMA)\.ya?ml$/ },
  { dir: 'scripts/aws', match: /staging.*\.(sh|py|mjs|json)$/ },
  { dir: 'scripts/ci/staging-db', match: /\.(mjs|sh|sql|json)$/, recursive: true },
  { dir: 'infra/staging-db', match: /.*/, recursive: true },
]);

/** The guard's own data: the list of reviewed production references inside the schema bundle (read by build-schema.mjs). */
export const ALLOW_LIST = 'infra/staging-db/bundle-prod-ref-allow.json';
export const isExcluded = (rel) => rel === SELF || rel === ALLOW_LIST || /(^|\/)fixtures\//.test(rel) || /\.test\.(mjs|cjs|js)$/.test(rel);

function walk(abs, out) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(abs).sort()) if (e !== 'node_modules' && e !== '.git') walk(path.join(abs, e), out);
  } else if (st.isFile()) out.push(abs);
}

/** Files of the default set under `root`, as repo-relative paths. */
export function defaultFiles(root = REPO_ROOT) {
  const out = [];
  for (const t of DEFAULT_TARGETS) {
    const d = path.join(root, t.dir);
    if (!fs.existsSync(d)) continue;
    const files = [];
    if (t.recursive) walk(d, files);
    else for (const e of fs.readdirSync(d).sort()) { const f = path.join(d, e); if (fs.statSync(f).isFile()) files.push(f); }
    for (const f of files) {
      const rel = path.relative(root, f).split(path.sep).join('/');
      if (t.match.test(path.basename(f)) && !isExcluded(rel)) out.push(rel);
    }
  }
  return [...new Set(out)].sort();
}

function lineFindings(text, file) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    for (const p of PRODUCTION_IDENTIFIERS) {
      p.re.lastIndex = 0;
      let m;
      while ((m = p.re.exec(line))) out.push({ file, line: i + 1, id: p.id, match: m[0], label: p.label });
    }
  });
  return out;
}

const isStatementList = (v) => Array.isArray(v) && v.every((s) => s && typeof s === 'object' && 'Effect' in s);

/** JSON CloudFormation template: scan every string (and key) except those inside an Effect=Deny statement. */
function jsonFindings(doc, file) {
  const out = [];
  const visit = (v, ptr, inDeny) => {
    if (typeof v === 'string') {
      if (inDeny) return;
      for (const f of lineFindings(v, file)) out.push({ ...f, line: null, pointer: ptr });
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${ptr}/${i}`, inDeny || (isStatementList(v) && x && x.Effect === 'Deny')));
    } else if (v && typeof v === 'object') {
      const deny = inDeny || (v.Effect === 'Deny' && ('Action' in v || 'NotAction' in v));
      for (const [k, x] of Object.entries(v)) {
        if (!deny) for (const f of lineFindings(k, file)) out.push({ ...f, line: null, pointer: `${ptr}/${k}` });
        visit(x, `${ptr}/${k}`, deny);
      }
    }
  };
  visit(doc, '', false);
  return out;
}

/** Findings for one file's text. A `{`-leading .json/.yaml/.yml text that parses as JSON is treated as a template. */
export function scanText(text, file = '<text>') {
  if (/\.(json|ya?ml)$/i.test(file) && /^\s*\{/.test(text)) {
    let doc = null;
    try { doc = JSON.parse(text); } catch { doc = null; }
    if (doc !== null) return jsonFindings(doc, file);
  }
  return lineFindings(text, file);
}

/**
 * Expand a list of files/dirs (repo-relative or absolute) into repo-relative files. A file named explicitly is always
 * scanned; inside a named directory the exclusions of the default set apply (tests, fixtures, this file, ALLOW_LIST).
 */
export function expandTargets(targets, root = REPO_ROOT) {
  const out = [];
  for (const t of targets) {
    const abs = path.isAbsolute(t) ? t : path.join(root, t);
    if (!fs.existsSync(abs)) throw new Error(`no such file or directory: ${t}`);
    if (fs.statSync(abs).isDirectory()) {
      const files = [];
      walk(abs, files);
      for (const f of files) { const rel = path.relative(root, f).split(path.sep).join('/'); if (!isExcluded(rel)) out.push(rel); }
    } else out.push(path.relative(root, abs).split(path.sep).join('/'));
  }
  return [...new Set(out)].sort();
}

export function scanFiles(files, root = REPO_ROOT) {
  const findings = [];
  for (const rel of files) findings.push(...scanText(fs.readFileSync(path.join(root, rel), 'utf8'), rel));
  return findings;
}

export function parseArgs(argv) {
  const a = { mode: 'report', json: false, files: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === '--report') a.mode = 'report';
    else if (x === '--enforce') a.mode = 'enforce';
    else if (x === '--json') a.json = true;
    else if (x === '--files') { a.files = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) a.files.push(argv[++i]); }
    else throw new Error(`unknown argument: ${x}`);
  }
  if (a.files && a.files.length === 0) throw new Error('--files needs at least one file or directory');
  return a;
}

export function run(argv, { root = REPO_ROOT, log = console.log } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { log(`usage error: ${e.message}`); return 2; }
  let files;
  try { files = args.files ? expandTargets(args.files, root) : defaultFiles(root); } catch (e) { log(`usage error: ${e.message}`); return 2; }
  const findings = scanFiles(files, root);
  if (args.json) log(JSON.stringify({ mode: args.mode, files: files.length, findings }, null, 2));
  else {
    for (const f of findings) log(`${args.mode === 'enforce' ? 'ERROR' : 'REPORT'} ${f.file}${f.line ? `:${f.line}` : ` ${f.pointer}`}: ${f.label} (${f.match})`);
    log(`staging-prod-ref-guard: ${files.length} file(s) scanned, ${findings.length} production reference(s) (${args.mode})`);
  }
  return args.mode === 'enforce' && findings.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
