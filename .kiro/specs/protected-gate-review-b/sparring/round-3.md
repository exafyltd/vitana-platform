# Sparring round 3 — converged

Session: `c221868c-7dc1-400b-b306-1d366d778b2f` · plan hash `b4f06c52845bc0b414d21990feee61e1c5daf134a7bf4787c4348aee64d94613`

## Summary

Round 3 review of the owner-plan protected-gate path plan. Both R2-F1 and R2-F2 were accepted and are substantively addressed in the revision. I verified the key premises and found one new minor issue regarding the `change_class` validation guard. The plan is otherwise well-specified.

## Findings

### R3-F1 [minor]

The plan says `validatePlan` will reject `protected_files:` on a plan that is not `change_class: standard`. However, `change_class` is not currently a recognized or validated field in `validatePlan` (lines 203-218 of queue.mjs). No existing handoff.md in the codebase uses `change_class` as a front-matter key (search returned zero hits in handoff files). `change_class` appears to be a plan-sparring / CI-level concept (seen in plan.md files and pipeline docs), not a handoff front-matter field that `validatePlan` can inspect. If the plan intends to gate `protected_files:` on `change_class`, it needs to either (a) add `change_class` as a validated handoff front-matter field first, or (b) use a different signal that is already available in the handoff front matter, or (c) drop this particular guard (since the real safety comes from the verdict-convergence and protected_files-subset checks anyway).

- `exafyltd/vitana-platform:scripts/collab/queue.mjs:203` — export function validatePlan(fm, slug) {
  const e = [];
  if (!fm) return ['no front matter'];
  if (fm.slug !== slug) e.push(`slug "${fm.slug ?? ''}" must equal the folder name "${slug}"`);
  ...
  if (fm.author_seat !== undefined && !SEAT_RE.test(fm.author_seat)) e.push(`author_seat "${fm.author_seat}" must be 1-12 lowercase letters`);
  return e;
}
- `exafyltd/vitana-platform:.kiro/specs/collab-kiro-governance/handoff.md:1` — ---
slug: collab-kiro-governance
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: owner
state: parked
parked_from: approved
updated: 2026-10-20T13:55Z
sparring_record: .kiro/specs/collab-kiro-governance/sparring/verdict.md
vtids: [VTID-05260, VTID-05261]
---

Suggestion: Either (a) add `change_class` as a validated handoff front-matter field in `validatePlan` as part of this plan's scope, (b) use a different existing field as the guard condition, or (c) drop the `change_class: standard` requirement from the `protected_files:` validation, since the verdict-convergence and subset checks are the real safety mechanisms.

## Acknowledgements of earlier responses

- R2-F1: acknowledged — Accepted and addressed: the plan now explicitly adopts the defense-in-depth dual-implementation pattern with a parity test, matching the existing repo convention.
- R2-F2: acknowledged — Accepted and addressed: the Tests section now lists both gateway jest suites and the 'repository scripts and rules only' qualifier is removed.
