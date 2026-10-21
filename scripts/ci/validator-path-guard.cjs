#!/usr/bin/env node
/**
 * VTID-03696 — VALIDATOR-CHECK's path-ownership guard, as testable code.
 *
 * WHY THIS IS A SCRIPT AND NOT INLINE SHELL
 *
 * This guard has been silently broken TWICE, and both times the failure was a
 * parsing trap rather than a logic error:
 *
 *   - VTID-03505: a heredoc written at column 0 terminated the YAML block
 *     scalar, so the whole workflow was unparseable. Runs completed in the same
 *     second they started, with zero jobs and a bare red X. PR governance was
 *     unenforced for at least 30 consecutive runs on every branch including
 *     main, and nothing in the Actions UI said why.
 *   - VTID-03549: a multi-line awk program with a newline after `!(` was
 *     invalid awk, so awk exited 1 and (under `bash -e`) the gate failed on
 *     EVERY PR it triggered on, regardless of content.
 *
 * A gate that fails open is unenforced; a gate that fails closed on everything
 * gets muted. Both happened here. Neither is detectable by reading the YAML,
 * and neither had a test. So the logic lives in a plain module with unit tests
 * (`services/gateway/test/scripts/validator-path-guard.test.ts`) and the
 * workflow just calls it.
 *
 * WHAT WAS ACTUALLY WRONG WITH THE RULES (the VTID-03696 fix)
 *
 * VTID-03525 scoped the workflow's `paths:` trigger to four trees, so the gate
 * stops firing on PRs it cannot judge. But the guard still evaluated EVERY file
 * in the PR against the profile allowlist. The two disagreed, and the gap is
 * not cosmetic:
 *
 *   A PR touching `services/gateway/src/**` AND `scripts/**` triggers the gate
 *   and is rejected for the `scripts/**` files — while the IDENTICAL
 *   `scripts/**` files in a PR that happens not to touch `services/gateway/src`
 *   are never judged at all, because the workflow does not fire.
 *
 * So the old behaviour did not protect `scripts/`. It only punished changes
 * that were honest enough to touch a governed tree in the same PR. Neither
 * accepted profile admits any path under `scripts/`, `.github/`, `supabase/`
 * or repo-root docs, so no profile choice could satisfy such a PR — it was
 * structurally unpassable, which is how a governance gate gets muted a third
 * time.
 *
 * The fix: the guard judges exactly the surface the trigger selects (REMIT).
 * Files outside REMIT are REPORTED, never rejected. If those trees should be
 * governed, they need their own gate — that is a real gap, and naming it
 * honestly is better than a rule that fires only by accident.
 *
 * `services/gateway/test/` is in REMIT here and must also be in the workflow's
 * `paths:` trigger. VTID-03549 allowlisted it because the Acceptance Mapping
 * Gate REQUIRES `TEST:` tokens and those jest suites live there — a profile
 * that forbids shipping the tests it demands can never be satisfied.
 *
 * EXIT CODES (the workflow documents these; keep them stable)
 *   0  approved
 *   20 a `.env` file is committed — repo-wide, no remit scoping, no escape
 *   21 unknown VALIDATION_PROFILE
 *   22 an IN-REMIT file falls outside the declared profile's allowlist
 *   23 a lockfile changed without a DEPENDENCY_CHANGE: declaration in the body
 */

'use strict';

/**
 * The trees this gate governs. MUST match the workflow's `paths:` trigger —
 * that is the whole point of this module. If they drift, the gate goes back to
 * judging files it was never triggered to look at.
 */
const REMIT = [
  'services/gateway/src/',
  'services/gateway/dist/',
  'services/gateway/openapi/',
  'services/gateway/test/',
  'docs/validation/',
];

/**
 * Per-profile allowlists, applied ONLY to in-remit files.
 *
 * `command_hub_frontend` is deliberately narrower than REMIT: it exists to say
 * "this PR touches the command-hub frontend and nothing else in the gateway",
 * so a `services/gateway/src/routes/` change under that profile is a real
 * violation and must still be exit 22.
 */
const PROFILES = {
  command_hub_frontend: [
    'services/gateway/src/frontend/command-hub/',
    'services/gateway/dist/frontend/command-hub/',
    'docs/validation/',
  ],
  gateway_backend: [
    'services/gateway/src/',
    'services/gateway/dist/',
    'services/gateway/test/',
    'services/gateway/openapi/',
    'docs/validation/',
  ],
};

const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

/**
 * A committed `.env`. Matches a bare `.env` or any `*.env`, but NOT
 * `.env.example` / `.env.sample` — those are checked-in templates and are
 * meant to be edited. The original regex (`\.env$`) already behaved this way;
 * it is spelled out here because "we blocked .env.example by accident" is an
 * easy and very annoying regression.
 */
const DOTENV = /(^|\/)[^/]*\.env$/;

function isUnder(file, prefixes) {
  return prefixes.some((p) => file.startsWith(p));
}

/**
 * @param {object} args
 * @param {string} args.profile           VALIDATION_PROFILE from the PR body
 * @param {string[]} args.changedFiles    repo-relative paths
 * @param {boolean} args.dependencyChangeDeclared  body contains DEPENDENCY_CHANGE:
 * @returns {{code:number, messages:string[]}}
 */
function evaluate({ profile, changedFiles, dependencyChangeDeclared }) {
  const messages = [];
  const files = changedFiles.map((f) => f.trim()).filter(Boolean);

  // 1. A committed .env is never acceptable, in any tree, under any profile.
  //    Deliberately NOT remit-scoped: a leaked secret does not care which
  //    directory it landed in, and this is the one rule where the blast radius
  //    justifies judging outside the gate's own surface.
  const dotenv = files.filter((f) => DOTENV.test(f));
  if (dotenv.length > 0) {
    messages.push('REJECTED: .env file committed');
    dotenv.slice(0, 25).forEach((f) => messages.push(`  ${f}`));
    return { code: 20, messages };
  }

  // 2. Profile must be known before its allowlist can mean anything.
  const allowlist = PROFILES[profile];
  if (!allowlist) {
    messages.push(`REJECTED: unknown VALIDATION_PROFILE=${profile}`);
    messages.push(`  known profiles: ${Object.keys(PROFILES).join(', ')}`);
    return { code: 21, messages };
  }

  const inRemit = files.filter((f) => isUnder(f, REMIT));
  const outOfRemit = files.filter((f) => !isUnder(f, REMIT));

  // 3. Dependency changes are DECLARED, not forbidden.
  //
  //    The old rule rejected any lockfile outright. A gateway feature that adds
  //    a dependency is a legitimate, routine change, so that rule made the gate
  //    unsatisfiable for an entire class of correct PRs — and an unsatisfiable
  //    gate is one someone eventually deletes. Requiring the author to say so
  //    in the body keeps the "this PR is bigger than its profile suggests"
  //    signal while leaving a way to be honest about it.
  const lockfiles = files.filter((f) => LOCKFILE.test(f));
  if (lockfiles.length > 0 && !dependencyChangeDeclared) {
    messages.push('REJECTED: lockfile changed without a DEPENDENCY_CHANGE: declaration');
    lockfiles.slice(0, 25).forEach((f) => messages.push(`  ${f}`));
    messages.push('  Add a line to the PR body, e.g.:');
    messages.push('    DEPENDENCY_CHANGE: added @aws-sdk/client-s3 for the narration cache S3 store');
    return { code: 23, messages };
  }
  if (lockfiles.length > 0) {
    messages.push(`NOTE: dependency change declared (${lockfiles.length} lockfile(s)) — not blocking`);
  }

  // 4. The actual ownership check, on the gate's own surface only.
  const violations = inRemit.filter((f) => !isUnder(f, allowlist));
  if (violations.length > 0) {
    messages.push(`REJECTED: in-remit files outside the ${profile} allowlist (showing first 25)`);
    violations.slice(0, 25).forEach((f) => messages.push(`  ${f}`));
    return { code: 22, messages };
  }

  // 5. Out-of-remit files are reported, never rejected. Printed so a reviewer
  //    can see what this gate did NOT look at, rather than silently implying
  //    the whole PR was validated.
  if (outOfRemit.length > 0) {
    messages.push(`NOT JUDGED — ${outOfRemit.length} file(s) outside this gate's remit:`);
    outOfRemit.slice(0, 25).forEach((f) => messages.push(`  ${f}`));
    if (outOfRemit.length > 25) messages.push(`  ...and ${outOfRemit.length - 25} more`);
    messages.push("  These trees have no governance gate of their own. That is a real gap,");
    messages.push('  not an approval — see VTID-03696.');
  }

  messages.push(`APPROVED: ${inRemit.length} in-remit file(s) match the ${profile} allowlist`);
  return { code: 0, messages };
}

/**
 * Does this diff actually ADD a route registration or a router mount?
 *
 * The Route Mount Evidence Gate used to fire whenever any file under
 * `src/routes/` (or `src/index.ts` / `src/app.ts`) was touched, and then demand
 * ROUTE_MOUNT: / FINAL_URL: / CURL_PROOF: markers. But editing a route FILE is
 * not the same thing as adding a ROUTE: VTID-03692 changed a branch inside an
 * existing WebSocket handler in `routes/orb-live.ts` and added no route at all.
 *
 * Demanding a curl proof for a route that does not exist does not produce
 * evidence — it produces invented evidence, because the only way to satisfy the
 * gate is to write down a URL nobody can call. A gate that can only be passed
 * by making something up is worse than no gate: it launders a guess into a
 * green check.
 *
 * So the trigger is the real signal — an ADDED line that registers a route or
 * mounts a router. Removals and context lines do not count. When a route IS
 * added, the evidence requirement is untouched and still has full force.
 *
 * @param {string[]} addedLines  lines from `git diff` that begin with '+'
 */
const ROUTE_REGISTRATION = /\b(router|app)\s*\.\s*(get|post|put|patch|delete|all|options|head|use)\s*\(/;

function routeEvidenceRequired(addedLines) {
  return addedLines
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .some((l) => ROUTE_REGISTRATION.test(l));
}

/**
 * Which changed files can actually violate a Content-Security-Policy?
 *
 * The CSP gate scanned EVERY changed file for `<script`, `style=`, `.style`,
 * `eval(`, `unsafe-inline` and CDN asset URLs. Those patterns only mean
 * something in code a browser executes. Applied to YAML, lockfiles, markdown
 * and CI scripts they are just strings, and the gate produced two false
 * positives that are worth naming because one of them is a trap:
 *
 *  1. `.github/workflows/VALIDATOR-CHECK.yml` matched `<script`, `.style` AND
 *     `unsafe-inline` — because the workflow file CONTAINS THE PATTERN LIST
 *     ITSELF. The gate flags its own source. That means the CSP gate rejected
 *     any PR that edits VALIDATOR-CHECK.yml, i.e. **the validator could not be
 *     modified without the validator failing the change.** It never surfaced
 *     because the file is rarely touched and, before VTID-03696, the path guard
 *     rejected such PRs several steps earlier anyway.
 *  2. `services/gateway/package-lock.json` matched the CDN-asset URL pattern on
 *     a registry URL. A lockfile is not served to anyone.
 *
 * So the scan is scoped to the surface a CSP actually governs: the command-hub
 * frontend trees, which is the only browser-served code this repo ships from
 * the gateway. Everything else is out of scope by construction rather than by
 * luck.
 */
const CSP_SURFACE = [
  'services/gateway/src/frontend/',
  'services/gateway/dist/frontend/',
];

function cspScanTargets(files) {
  return files
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => isUnder(f, CSP_SURFACE));
}

/**
 * VTID-03714 — the CSP gate scanned whole FILE CONTENT, not the diff.
 *
 * `cspScanTargets` correctly narrowed WHICH FILES to look at (VTID-03696),
 * but the step that consumed its output still read each target file's full
 * content with `open(f).read()` and pattern-matched against that. A large,
 * long-lived file like `orb-widget.js` accumulates legitimate `.style.cssText`
 * DOM manipulation and doc-comment `<script src=...>` examples over time —
 * none of it new — so ANY PR touching that file failed this gate regardless
 * of what the PR actually changed. Confirmed live on PR #3167 (VTID-03711):
 * the diff itself matched zero patterns; the whole-file scan still rejected
 * on 4 lines nobody had touched.
 *
 * This is the same defect shape the Route Mount Evidence Gate already had
 * fixed for it (VTID-03696): judging the whole file instead of the diff
 * produces false rejections, and a gate that rejects PRs for content they
 * didn't touch eventually gets muted or bypassed by someone. The fix mirrors
 * `routeEvidenceRequired()` exactly — filter to lines a `git diff` reports as
 * ADDED (skip removed lines, context lines, and the `+++` file header), and
 * pattern-match only those.
 *
 * The diff handed to this function is expected to already be restricted to
 * `CSP_SURFACE` paths (via `git diff ... -- <CSP_SURFACE paths>`), so every
 * added line here is inherently browser-served content — no additional
 * per-file filtering is needed at this layer.
 *
 * @param {string[]} diffLines  lines from `git diff`, CSP_SURFACE-scoped
 * @returns {{pattern:string, line:string}[]} one entry per violation found
 */
const CSP_PATTERNS = [
  /<script(?![^>]*\bsrc=)/i,
  /style\s*=/i,
  /\.style\b/i,
  /\beval\s*\(/i,
  /new\s+Function\s*\(/i,
  /unsafe-inline/i,
  /https?:\/\/[^\s"']+\.(js|css)/i,
];

/**
 * A real unified-diff file header is always `+++ b/path` (or `+++ a/path`,
 * `+++ /dev/null`) — git always emits a space after the header's `+++`. An
 * added SOURCE line that happens to start with `++` (e.g. `++counter;`)
 * renders as `+` (the diff marker) followed by `++counter;`, i.e.
 * `+++counter;` — no space after the third `+`. Testing only `startsWith
 * ('+++')` conflated the two and silently dropped any such added line.
 */
function isDiffFileHeader(raw) {
  return raw === '+++' || raw.startsWith('+++ ') || raw.startsWith('+++\t');
}

function cspViolationsInAddedLines(diffLines) {
  // Group maximal contiguous runs of added lines and match against the
  // JOINED block, not each line independently. A pattern can legitimately
  // span an added line break (e.g. `eval` on one line, `(userInput)` on the
  // next) — the whole-file scan this replaces caught that because `\s` in
  // JS regex matches `\n` too. Matching line-by-line would silently lose
  // that coverage. Only genuinely CONTIGUOUS added lines are joined: a
  // context or removed line between two `+` lines means something else
  // sits between them in the real file, so the run ends there.
  const runs = [];
  let current = [];
  for (const raw of diffLines) {
    if (raw.startsWith('+') && !isDiffFileHeader(raw)) {
      current.push(raw.slice(1));
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  }
  if (current.length > 0) runs.push(current);

  const violations = [];
  for (const run of runs) {
    const block = run.join('\n');
    for (const pattern of CSP_PATTERNS) {
      const match = block.match(pattern);
      if (match) violations.push({ pattern: pattern.source, line: match[0] });
    }
  }
  return violations;
}

module.exports = {
  evaluate,
  routeEvidenceRequired,
  cspScanTargets,
  cspViolationsInAddedLines,
  isDiffFileHeader,
  CSP_SURFACE,
  CSP_PATTERNS,
  REMIT,
  PROFILES,
  LOCKFILE,
  DOTENV,
  ROUTE_REGISTRATION,
};

// CLI: node validator-path-guard.cjs <changed_files.txt> <profile> <pr_body.txt>
//      node validator-path-guard.cjs --route-evidence-required <diff.txt>
//        exit 0 = a route was added, evidence IS required
//        exit 1 = no route added, the evidence gate should be skipped
// CLI: --csp-targets <changed_files.txt>  → prints the files worth CSP-scanning
// CLI: --csp-added-lines <diff.txt>  → CSP_SURFACE-scoped diff; prints any
//      violations found in ADDED lines only, exit 1 if any, else exit 0
if (require.main === module && process.argv[2] === '--csp-targets') {
  const { readFileSync } = require('node:fs');
  let files = [];
  try {
    files = readFileSync(process.argv[3], 'utf8').split('\n');
  } catch {
    files = [];
  }
  cspScanTargets(files).forEach((f) => console.log(f));
  process.exit(0);
}

if (require.main === module && process.argv[2] === '--csp-added-lines') {
  const { readFileSync } = require('node:fs');
  const diffPath = process.argv[3];
  let diff = '';
  try {
    diff = readFileSync(diffPath, 'utf8');
  } catch {
    diff = '';
  }
  const violations = cspViolationsInAddedLines(diff.split('\n'));
  if (violations.length === 0) {
    console.log('No CSP pattern hits in added lines.');
    process.exit(0);
  }
  violations.forEach((v) => console.log(`REJECTED: CSP pattern hit in an added line :: /${v.pattern}/\n  ${v.line}`));
  process.exit(1);
}

if (require.main === module && process.argv[2] === '--route-evidence-required') {
  const { readFileSync } = require('node:fs');
  const diffPath = process.argv[3];
  let diff = '';
  try {
    diff = readFileSync(diffPath, 'utf8');
  } catch {
    diff = '';
  }
  const required = routeEvidenceRequired(diff.split('\n'));
  console.log(
    required
      ? 'Route registration ADDED — route-mount evidence is required.'
      : 'No route registration added — route-mount evidence not required for this diff.',
  );
  process.exit(required ? 0 : 1);
}

if (require.main === module) {
  const { readFileSync } = require('node:fs');
  const [filesPath, profile, bodyPath] = process.argv.slice(2);
  if (!filesPath || !profile) {
    console.error('usage: validator-path-guard.cjs <changed_files.txt> <profile> [pr_body.txt]');
    process.exit(2);
  }
  const changedFiles = readFileSync(filesPath, 'utf8').split('\n');
  let body = '';
  try {
    body = bodyPath ? readFileSync(bodyPath, 'utf8') : '';
  } catch {
    body = '';
  }
  const { code, messages } = evaluate({
    profile,
    changedFiles,
    dependencyChangeDeclared: /DEPENDENCY_CHANGE:/.test(body),
  });
  messages.forEach((m) => console.log(m));
  process.exit(code);
}
