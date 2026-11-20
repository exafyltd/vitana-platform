#!/usr/bin/env node
/**
 * gate-audit — post-merge audit of protected gate merges on `main` (VTID-05780, plan autonomous-to-staging-r2, lane
 * protect-gate-workflow). PROTECTED GATE FILE.
 *
 *   node scripts/collab/gate-audit.mjs --repo <checkout> --gh <owner/repo> [--since '14 days ago'] [--ref origin/main]
 *                                      [--summary <file>] [--json]
 *
 * For every first-parent commit of <ref> in the window that changes a protected gate file (queue.mjs
 * PROTECTED_GATE_PATHS), find the PR it merged (`repos/<gh>/commits/<sha>/pulls`), fetch `refs/pull/<n>/head` into the
 * checkout and check, with the land-guard.mjs functions themselves (parseReviewEntry, localAfter,
 * protectedReviewCurrent, protectedAcceptModels, builderSessions — imported, not copied), that the merge carried two
 * reviewer-agent accepts from two chain models and two sessions, neither a builder session, valid for the PR's final
 * head, and that the merge commit's tree equals that head's tree. A commit listed in BOOTSTRAP passes with its reason.
 * Exit 0 = every protected merge in the window is authorised; exit 1 = at least one is not (listed), or the audit could
 * not run. The checkout needs the full history (fetch-depth: 0) and origin/main.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROTECTED_GATE_PATHS } from './queue.mjs';
import {
  builderSessions, laneKeyOf, localAfter, parseReviewEntry, protectedAcceptModels, protectedReviewCurrent,
  protectedTouched, PROTECTED_ACCEPTS_REQUIRED,
} from './land-guard.mjs';

/**
 * Protected merges on main that are authorised without two valid accepts. Each entry names the reason; nothing else
 * passes. Kept in this protected file (not a separate JSON) so that widening it needs the two-model rule itself.
 * Every entry is a merge from before this audit and the exact-head rule (this lane) existed; under them it would fail,
 * because its authority was the rule of its time (collaboration.md §3a: owner instruction naming the plan, or the
 * earlier two-model rule) and not two accepts recorded from distinct sessions on the exact merged head.
 */
// The list is exactly the protected merges the audit reported on origin/main 1d6126bff4 for the 14-day window when this
// lane was built (docs/validation/VTID-05780/outputs/gate-audit-before.txt). Each one leaves the default window within
// 14 days; the entries then have no effect and may be removed under the two-model rule.
export const BOOTSTRAP = Object.freeze([
  { sha: 'a206af8ab96e54d077272f8181437aad51dbad93', pr: 4495, reason: 'before the two-model rule (VTID-05765) landed; merged by jtadic-netizen under the rule of its time (collaboration.md §3a)' },
  { sha: 'f9e38effff6ec66f4fac880ac0dff6a2db3bac20', pr: 4416, reason: 'before the two-model rule (VTID-05765) landed; merged by the owner account exafyltd under the rule of its time (collaboration.md §3a)' },
  { sha: 'e4bdc45f2634333b0a4a65c71b14841ce7493db1', pr: 4369, reason: 'before the two-model rule (VTID-05765): rules PR merged by the owner account exafyltd' },
  { sha: 'ba709c6248c99fe05ef3b60567d0d3d86df2e61e', pr: 4530, reason: 'before the two-model rule (VTID-05765) landed; merged by the owner account exafyltd from a head behind main (rule of its time, collaboration.md §3a)' },
  { sha: 'abe2d7a59f23c3067fd421e135f9c3df2ebfefb6', pr: 4377, reason: 'before the two-model rule (VTID-05765) landed; merged by jtadic-netizen from a head behind main (rule of its time, collaboration.md §3a)' },
  { sha: '9e6fed60a4e3f05e904a21d0b35678550a7f189e', pr: 4866, reason: 'before the two-model rule (VTID-05765): rules PR merged by the owner account exafyltd' },
  { sha: 'd7c1d9668a2421bfd375194bfa9d7f1bbd5f103e', pr: 4867, reason: 'before the two-model rule (VTID-05765): CI PR merged by the owner account exafyltd' },
  { sha: 'e7077f27c3cf82f2c78bf6dab86fcb0397cb1f1a', pr: 5002, reason: 'bootstrap of the two-model rule itself (VTID-05765): owner directive 2026-11-11 naming plan autonomous-to-staging' },
  { sha: 'e4b4b48511d0356a4a2a508e3adf20b4420d1d80', pr: 5003, reason: 'GATE-INVARIANTS.yml and its test were not yet protected when it merged (VTID-05763); protected by VTID-05780' },
  { sha: '53c087911bc56ba49d9f0907391c7c9f805651e5', pr: 5013, reason: 'after VTID-05765, before this audit: merged by the owner account exafyltd without two recorded accepts (owner authority, collaboration.md §3a); flagged in VTID-05780 evidence' },
  { sha: 'a199f9ac9a4427b8358bd97d8db6367debcff0eb', pr: 5021, reason: 'after VTID-05765, before this audit: merged by the owner account exafyltd without two recorded accepts (owner authority, collaboration.md §3a); flagged in VTID-05780 evidence' },
]);

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const git = (repo, ...a) => run('git', ['-C', repo, ...a]);

/** First-parent commits of `ref` since `since` that change a protected gate file → [{ sha, files }] (oldest first). */
export function protectedMerges(repo, { ref = 'origin/main', since = '14 days ago', globs = PROTECTED_GATE_PATHS } = {}) {
  const shas = git(repo, 'rev-list', '--reverse', '--first-parent', `--since=${since}`, ref).split('\n').filter(Boolean);
  const out = [];
  for (const sha of shas) {
    const parent = (git(repo, 'rev-list', '--parents', '-n', '1', sha).split(' ')[1]) || null;
    if (!parent) continue; // the root commit (initial import) merges nothing
    const files = git(repo, 'diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', parent, sha).split('\n').filter(Boolean);
    const prot = protectedTouched(files, globs);
    if (prot.length) out.push({ sha, parent, files: prot });
  }
  return out;
}

/**
 * Is one protected merge authorised? `pr` = { number, title, head: { sha } } or null. → { ok, reason, models }.
 * The PR head must be present in `repo` (fetchHead is called when it is not).
 */
export function auditMerge(repo, { sha, parent, pr }, { fetchHead = null } = {}) {
  if (!pr) return { ok: false, reason: 'no pull request merged this commit (direct push to main)', models: [] };
  const head = pr.head?.sha;
  if (!/^[0-9a-f]{40}$/.test(head || '')) return { ok: false, reason: `PR #${pr.number}: no head sha`, models: [] };
  try { git(repo, 'cat-file', '-e', `${head}^{commit}`); } catch {
    if (fetchHead) fetchHead(pr.number);
    try { git(repo, 'cat-file', '-e', `${head}^{commit}`); } catch { return { ok: false, reason: `PR #${pr.number}: head ${head.slice(0, 8)} not available`, models: [] }; }
  }
  if (git(repo, 'rev-parse', `${sha}^{tree}`) !== git(repo, 'rev-parse', `${head}^{tree}`)) {
    return { ok: false, reason: `PR #${pr.number}: the merge commit's tree differs from the PR's final head ${head.slice(0, 8)} (not the reviewed content)`, models: [] };
  }
  const key = laneKeyOf(pr.title);
  if (!key) return { ok: false, reason: `PR #${pr.number}: title names no <slug>/<lane>`, models: [] };
  const range = parent ? `${parent}..${head}` : head;
  const messages = git(repo, 'log', '--format=%B%x00', range).split('\0').map((m) => m.trim()).filter(Boolean);
  const [slug, lane] = key.split('/');
  let laneText = '';
  try { laneText = git(repo, 'show', `${head}:.kiro/specs/${slug}/lanes/${lane}.md`); } catch { /* none */ }
  const builders = builderSessions(laneText, messages, key);
  const memo = new Map();
  const entries = [];
  for (const m of messages) {
    const e = parseReviewEntry(m);
    if (!e || e.review !== key || !/^[0-9a-f]{40}$/.test(e.reviewedHead || '')) continue;
    if (!memo.has(e.reviewedHead)) {
      let ok = false;
      try {
        const w = localAfter(repo, e.reviewedHead, head, key);
        ok = protectedReviewCurrent(e.reviewedHead, head, w.after, key, w).ok;
      } catch { ok = false; }
      memo.set(e.reviewedHead, ok);
    }
    entries.push({ ...e, current: memo.get(e.reviewedHead) });
  }
  const models = protectedAcceptModels(entries, { builders });
  if (models.length < PROTECTED_ACCEPTS_REQUIRED) {
    return { ok: false, reason: `PR #${pr.number} (${key}): ${models.length} valid accept model(s) on the merged head (${entries.length} review entr${entries.length === 1 ? 'y' : 'ies'}); needs ${PROTECTED_ACCEPTS_REQUIRED} from different chain models and sessions, no builder`, models };
  }
  return { ok: true, reason: `PR #${pr.number} (${key}): accepts from ${models.join(', ')} on the merged head`, models };
}

/** The PR that merged `sha`, via the GitHub API (null when none). */
export function ghPrFor(gh, sha) {
  const list = JSON.parse(run('gh', ['api', `repos/${gh}/commits/${sha}/pulls`]) || '[]');
  return list.find((p) => p.merge_commit_sha === sha) || list.find((p) => p.merged_at) || null;
}

/** → { checked: [...], violations: [...], bootstrapped: [...] }. */
export function audit({ repo, since, ref, lookupPr, fetchHead, bootstrap = BOOTSTRAP }) {
  const boot = new Map(bootstrap.map((b) => [b.sha, b]));
  const checked = [];
  const violations = [];
  const bootstrapped = [];
  for (const m of protectedMerges(repo, { since, ref })) {
    if (boot.has(m.sha)) { bootstrapped.push({ ...m, reason: boot.get(m.sha).reason }); continue; }
    const r = auditMerge(repo, { ...m, pr: lookupPr(m.sha) }, { fetchHead });
    (r.ok ? checked : violations).push({ ...m, ...r });
  }
  return { checked, violations, bootstrapped };
}

function opts(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) o[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  return o;
}

export function main(argv) {
  const o = opts(argv);
  if (!o.repo || !o.gh || o.repo === true || o.gh === true) { console.error('usage: gate-audit.mjs --repo <checkout> --gh <owner/repo> [--since <date>] [--ref <ref>] [--summary <file>] [--json]'); return 1; }
  let res;
  try {
    res = audit({
      repo: o.repo,
      since: o.since && o.since !== true ? o.since : '14 days ago',
      ref: o.ref && o.ref !== true ? o.ref : 'origin/main',
      lookupPr: (sha) => ghPrFor(o.gh, sha),
      fetchHead: (n) => { try { git(o.repo, 'fetch', '-q', 'origin', `refs/pull/${n}/head`); } catch { /* reported as unavailable */ } },
    });
  } catch (e) {
    console.error(`gate-audit: could not run — ${String(e.stderr || e.message).trim().split('\n')[0]}`);
    return 1;
  }
  const line = (x) => `${x.sha.slice(0, 10)} ${x.reason} [${x.files.join(', ')}]`;
  const text = [
    `gate-audit: ${res.checked.length} authorised, ${res.bootstrapped.length} bootstrap, ${res.violations.length} violation(s)`,
    ...res.checked.map((x) => `  ok        ${line(x)}`),
    ...res.bootstrapped.map((x) => `  bootstrap ${line(x)}`),
    ...res.violations.map((x) => `  VIOLATION ${line(x)}`),
  ].join('\n');
  console.log(o.json ? JSON.stringify(res, null, 2) : text);
  for (const v of res.violations) console.log(`::error::gate-audit: protected merge ${v.sha.slice(0, 10)} not authorised: ${v.reason}`);
  if (o.summary && o.summary !== true) fs.appendFileSync(o.summary, `### Post-merge audit of protected gate merges\n\n\`\`\`\n${text}\n\`\`\`\n`);
  return res.violations.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
