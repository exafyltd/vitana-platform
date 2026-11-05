# Sparring round 2 — converged

Session: `f08364e1-8cd8-468e-b6ec-5df7bf0bef92` · plan hash `9369dc457c3ea57c0d3323a30a2a19d7f3dc7e8ace64e448f27c17f30b403b61`

## Summary

Round 2 review of the revised plan. R1-F1 was accepted and the revision addresses it well: the plan now requires slugs to be taken from `git ls-tree` on the actual tree (main or PR head) and recorded with their source, and the test asserts regex validity and uniqueness. I verified the key premises in the revised plan against the pinned code and they hold. One new minor finding about `desktop-redesign`'s `repos` field.

## Findings

### R2-F1 [minor]

The plan says the `program-registry` lane will add `vitana-platform:desktop-spotlight-finish` to `desktop-redesign` and add `vitana-platform` to its `repos`. However, `validatePrograms` (`:798-813`) does not check that every spec's repo prefix matches the programme's `repos` list — it only validates the `<repo>:<slug>` format and uniqueness. Adding `vitana-platform` to `repos` is harmless and likely correct for documentation, but if the builder forgets it, no CI check will catch the omission. The plan should note this is a documentation-only concern, not a gated validation, so the builder doesn't skip it thinking CI will catch it.

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:798` — export function validatePrograms(programs) {
    const e = [];
    const owner = new Map();
    for (const { id, path: p, fm } of programs) {
      if (!fm) { e.push(`${p}: no front matter`); continue; }
      if (fm.id !== id) e.push(`${p}: id "${fm.id ?? ''}" must equal the folder name "${id}"`);
      if (!fm.title) e.push(`${p}: title is required`);
      if (!PROGRAM_STATUSES.includes(fm.status)) e.push(`${p}: status must be one of ${PROGRAM_STATUSES.join('|')}`);
      if (!/^[1-5]$/.test(String(fm.priority ?? ''))) e.push(`${p}: priority must be 1-5`);
      for (const sp of asList(fm.specs)) {
        if (!/^[a-z0-9-]+:[a-z0-9][a-z0-9-]*$/.test(sp)) { e.push(`${p}: spec "${sp}" must be <repo>:<slug>`); continue; }
        if (owner.has(sp)) e.push(`${p}: spec ${sp} already belongs to programme ${owner.get(sp)}`);
        else owner.set(sp, id);
      }
    }
    return e;
  }
- `exafyltd/vitana-platform:docs/programs/desktop-redesign/program.md:1` — ---
id: desktop-redesign
title: Spotlight desktop redesign
status: active
priority: 3
repos: [vitana-v1]
specs:
  - vitana-v1:desktop-spotlight

Suggestion: In the `program-registry` lane instructions and its test, explicitly assert that `vitana-platform` appears in the `desktop-redesign` programme's `repos` list after the edit, since no CI gate enforces repo-spec consistency.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and properly addressed. The revised plan now requires slugs to be taken from `git ls-tree` on the actual tree (main or PR head), recorded with source in commands.log, and the test asserts regex match and uniqueness. This is a solid fix.
