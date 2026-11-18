# Sparring round 2 — in_progress

Session: `95453804-2153-4c96-b410-aec841af9f7c` · plan hash `35ec0114507454430a8a240b41d6a89c71984535fec2d4bfb72a97215f8100cb`

## Summary

All three R1 findings were accepted and properly addressed in the revised plan. However, the existing lane spec file (`seats.md`) at the pinned commit contradicts the revised plan on the seat assignment, which would cause a scope-check failure at merge time. One new finding raised.

## Findings

### R2-F1 [blocker]

The plan declares the lane as `seat exafy`, but the existing lane spec `.kiro/specs/agentic-delivery-v2/lanes/seats.md` (already on main at the pinned commit) has `seat: exafyltd`. Because `seat` is a PERM field (`queue.mjs:1000`), scope-check pins it to the trusted (merge-base) value (`queue.mjs:1021`). A builder running as `kiro-exafy-*` would be rejected at line 1049 ('session (seat exafy) edits lane …, which belongs to seat exafyltd'). The builder cannot change the `seat` field in their own PR (it's a PERM field, line 1004/1018). Additionally, the lane spec's `paths:` lists automation files (`.kiro/automations/delta.md` through `kilo.md`) and `scripts/collab/automations.test.mjs` — work the plan explicitly says is out of scope ('No automation file'). The lane spec description also says 'Twelve Kiro seats' vs the plan's nine, and uses NATO-alphabet names (delta, echo, …) that don't appear in the plan.

- `exafyltd/vitana-platform:.kiro/specs/agentic-delivery-v2/lanes/seats.md:1` — seat: exafyltd
...
paths:
  - docs/programs/areas.yaml
  - .kiro/automations/exafy.md
  - .kiro/automations/exafyltd.md
  - .kiro/automations/jtadic.md
  - .kiro/automations/delta.md
  - .kiro/automations/echo.md
  - .kiro/automations/foxtrot.md
  - .kiro/automations/golf.md
  - .kiro/automations/hotel.md
  - .kiro/automations/india.md
  - .kiro/automations/juliet.md
  - .kiro/automations/kilo.md
  - scripts/collab/automations.test.mjs
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:999` — const PERM = ['executor', 'seat', 'reviewer_seat', 'paths'];
...
const changed = PERM.filter((k) => JSON.stringify(asList(trustedFm[k])) !== JSON.stringify(asList(fm[k])));
...
if (changed.length && !permAllowed) {
  errors.push(`lane ${key}: ${changed.join(', ')} changed in a lane PR...`);
}
if (!permAllowed) fm = { ...fm, ...Object.fromEntries(TRUSTED_PINNED.map((k) => [k, trustedFm[k]])) };
- `exafyltd/vitana-platform:scripts/collab/queue.mjs:1049` — } else if (fm.seat && seat && seat !== fm.seat) {
    errors.push(`${short}: ${k.session} (seat ${seat}) edits lane ${key}, which belongs to seat ${fm.seat}`);

Suggestion: Either (a) correct the plan to say `seat exafyltd` (matching the existing lane spec), or (b) update the lane spec's `seat`, `paths`, and description to match the plan before the builder starts — using a lane-admin lane or a separate preparatory commit from the correct seat. The plan must also reconcile the NATO-alphabet seat names in the lane spec with the descriptive names (vitanaland, office, support, admin, tasks) in the plan.

## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed: revised plan correctly says 'nine seats' throughout §6 and §7.
- R1-F2: acknowledged — Accepted and addressed: revised plan correctly treats Kiro 7-8 as seats (admin, tasks with surface: pending) and only Kiro 9-11 as reserved in the comment block.
- R1-F3: acknowledged — Accepted and addressed: citation corrected to automations.test.mjs:30.

## Next

Planner: answer every finding above in `sparring/responses-2.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
