# Sparring round 3 — converged

Session: `f98b0fe9-6651-4cac-a46d-cba0f846121d` · plan hash `b299a02cad26a7f74ba7a497fcea2c95f1f30de574d2c572d5369a4b28cc79fb`

## Summary

All five accepted findings from rounds 1 and 2 (R1-F1, R1-F2, R2-F1, R2-F2, R2-F3) are adequately addressed in the revised plan. One new minor finding: the lane's `paths` array includes `docs/validation/VTID-*/**`, which is both redundant (queue.mjs `scopeCheck` auto-owns the lane's own VTID folder via `fm.vtid` at line 690) and overly broad (the wildcard covers every plan's validation folder). No blockers or majors remain.

## Findings

### R3-F1 [minor]

`docs/validation/VTID-*/**` in the lane's `paths` array is both redundant and overly broad. The `scopeCheck` function in queue.mjs already auto-owns `docs/validation/<fm.vtid>/` via the `own()` predicate at line 690: `(fm.vtid && f.startsWith('docs/validation/${fm.vtid}/'))`. The design comment at lines 621-622 is explicit: 'A lane PR may only change the files its lane declares in `paths` (plus its own spec folder and its `docs/validation/<VTID>/` evidence)' — validation folders are listed as additional to `paths`, not as members. Meanwhile `globToRegex('docs/validation/VTID-*/**')` (lines 111-127) produces `^docs/validation/VTID-[^/]*(?:/.*)?$`, which matches every plan's validation folder, not just this lane's assigned one — so scopeCheck would permit touching another plan's evidence folder without an error.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:690` — const own = (f) => f.startsWith(`.kiro/specs/${slug}/`) || (fm.vtid && f.startsWith(`docs/validation/${fm.vtid}/`));
    if (paths.length === 0) {
      warnings.push(`lane ${key} declares no paths (pre-VTID-05213 lane): Lane scope reports only, and the Project Manager never merges it`);
    } else {
      for (const f of changed) {
        if (own(f)) continue;
        if (!matchesAny(f, paths)) errors.push(`${f} is outside lane ${key} (paths: ${paths.join(', ')})`);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:621` —  * A lane PR may only change the files its lane declares in `paths` (plus its own spec folder and its
 * `docs/validation/<VTID>/` evidence);
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:111` — /** Glob → RegExp: `**` any path (incl. `/`), `*` within one segment, `?` one char. `dir/**` also matches `dir`. */
export function globToRegex(glob) {
  let re = '';
  const g = String(glob).trim();
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (ch === '*') re += '[^/]*';
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:127` — export const matchesAny = (file, globs) => asList(globs).some((g) => globToRegex(g).test(file));

Suggestion: Remove `docs/validation/VTID-*/**` from the lane's `paths` list. Files under `docs/validation/<assigned-VTID>/` are auto-owned by the lane once the PLAN-SPAR allocator populates `fm.vtid` — no `paths` entry is needed or correct. The three remaining entries (`scripts/dev/context.mjs`, `scripts/dev/context.test.mjs`, `docs/CONTEXT-MAP.md`) are correct and sufficient.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — The revised plan explicitly notes at §2.5 that `session/live-session-controller.ts` is 'a short form of a live file … not stale, sparring R1-F1', and §3.1 now specifies a three-step path resolution (prefix check → repo-root-relative glob → git-ls-files suffix) that prevents false positives for short-form prose references. Fully addressed.
- R1-F2: acknowledged — The revised §7 explicitly states 'command tests use fixture repos, so renaming routes/vtid.ts or a spec breaks nothing. Only the context-map link test reads real files. It fails on the PR that breaks a link.' The blast-radius concern is properly contained to the single test that is responsible for catching that exact break. Fully addressed.
- R2-F1: acknowledged — §3.1 now specifies a separate atlas-pointer resolution pass covering trailing-slash directory checks, zero-match glob = dead, and three resolution bases (services/gateway/src → services/gateway → repo root). `../erp-bridge/` correctly resolves from services/gateway to services/erp-bridge/ (confirmed live). §5 adds fixture tests for directory, glob, `../`, and dead forms. Fully addressed.
- R2-F2: acknowledged — §5 now names the injectable runner pattern `vtid(roots, id, { prs, run })` with a stub in tests returning one PR line. No test calls GitHub; UNIT.yml needs no token. Fully addressed.
- R2-F3: acknowledged — All seven line references corrected to the `code:` array lines and confirmed against the pinned domain-atlas.ts in this review. Fully addressed.
