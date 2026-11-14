# Sparring round 2 — converged

Session: `5f2b3055-4acc-4eb6-be8e-6b1f1f4c44df` · plan hash `ac2bba601b5f4ed161225d06b9d07be0311d2e532e1c27a84d903a51dff71e10`

## Summary

Round 2 review of the revised plan. All three R1 findings were accepted and are addressed in the revision. The "Premise evidence" section and Task 0 adequately mitigate the unverifiable vitana-v1 premises (R1-F2). The citation correction (R1-F3) is done. The evidence-file scope (R1-F1) is addressed in substance — `scopeCheck` at queue.mjs:1025 auto-exempts all files under `docs/validation/<VTID>/` via `own(f)`, so the lane scope need not even list them. One new minor finding about plan-text notation that could cause confusion when lane files are created.

## Findings

### R2-F1 [minor]

The plan's Lanes table describes the docs scope as a single brace-expansion glob `docs/validation/VTID-*/{acceptance.md,commands.log,scope.json,staging-tests.json,plan-sparring.md}`. The `globToRegex` function (queue.mjs:124) escapes `{` and `}` as literal regex characters; it does not support brace expansion. If the lane `.md` files are created with this single path entry (rather than 5 individual entries like crash-port.md uses for its 3), the glob will match nothing. Functionally this is harmless because `scopeCheck` line 1025 auto-exempts all files under `docs/validation/<VTID>/` via `own(f)`, but it is misleading in the plan text and could confuse the lane creator. The cited model (crash-port.md) lists docs paths individually, not as a brace set.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:113` — export function globToRegex(glob) {
  let re = '';
  const g = String(glob).trim();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (re.endsWith('/.*')) re = `${re.slice(0, -3)}(?:/.*)?`;
  return new RegExp(`^${re}$`);
}
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1023` — const paths = asList(fm.paths);
const changed = git(repo, ['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean);
const own = (f) => f.startsWith(`.kiro/specs/${slug}/`) || (fm.vtid && f.startsWith(`docs/validation/${fm.vtid}/`));
if (paths.length === 0) {
  warnings.push(`lane ${key} declares no paths ...`);
} else {
  for (const f of changed) {
    if (own(f)) continue;
    if (!matchesAny(f, paths)) errors.push(`${f} is outside lane ${key} ...`);
- `exafyltd/vitana-platform:.kiro/specs/native-wave3-release-r2/lanes/crash-port.md:12` — paths:
  - apps/mobile/src/telemetry/**
  - apps/mobile/tests/telemetry/**
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
updated: 2026-11-08T12:07Z

Suggestion: In the plan text (and, more importantly, in the lane files that will be generated), list each docs/validation path as a separate entry — matching the crash-port.md convention — rather than using brace expansion. E.g.:
  - docs/validation/VTID-*/acceptance.md
  - docs/validation/VTID-*/commands.log
  - docs/validation/VTID-*/scope.json
  - docs/validation/VTID-*/staging-tests.json
  - docs/validation/VTID-*/plan-sparring.md
Alternatively, since own(f) auto-exempts all files under docs/validation/<VTID>/, the docs paths could be omitted entirely (crash-port omits acceptance.md and commands.log for the same reason).
