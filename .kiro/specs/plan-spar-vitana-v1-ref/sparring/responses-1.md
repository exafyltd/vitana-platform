# Sparring round 1 — planner responses

Session: `b9c548f7-6f0e-4151-81f1-48a0b8a42d85` · plan hash `7e751e70f5f117b58d9ac9d13c16692b68b6e94bc8221e4483163739eca7976c`

All four findings are accurate against the merged code and are accepted. The plan block in `plan.md`
has been updated to pin an explicit merge rule between the always-on CLI arg and `spar_refs` (F1),
restrict cross-repo resolution to verbatim 40-hex SHAs for the unreadable private repo (F2), move ref
resolution inside the create/retry/replan branch (F3), and make `step()`'s reading of `handoff.md` and
the trigger requirement explicit (F4).

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed in the merged code: main() already builds extraRefs = { 'exafyltd/vitana-v1': v1Sha } from the always-on --extra-ref-vitana-v1 arg (plan-spar.mjs:317-318) that PLAN-SPAR.yml unconditionally resolves from vitana-v1@main (workflow lines 85-89), and that map is passed into step() and spread into the single client.create (plan-spar.mjs:192-196). spar_refs targets the same key, so precedence was genuinely undefined and the 'byte-identical no-op' claim was false relative to production CI (which already sends extra_refs). Plan now pins an explicit code-level merge rule: start from the CLI arg map, then overlay parsed spar_refs so a plan's declared companion ref wins for the exafyltd/vitana-v1 key, and restates the no-op strictly against step()'s default extraRefs = null case, not production CI."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Confirmed: the cross-repo read credential PLAN_SPARRING_GITHUB_TOKEN is server-side only (github-tools.ts:11-14); PLAN_SPAR_PUSH_TOKEN and github.token are scoped to vitana-platform and cannot read the private exafyltd/vitana-v1, so a branch/tag resolution via GET /repos/{owner}/{repo}/commits/{ref} would 404/403 and then abort under the fail-loud contract. Only a verbatim 40-hex SHA (which needs no API call) actually resolves cross-repo. Plan now restricts resolveRef to SHA-only for any repo other than the plan's own --repo (vitana-platform): a non-SHA companion ref is a loud declaration error, no commits API call is made cross-repo, and branch/tag resolution is documented as out of scope until a CI-accessible contents:read credential for vitana-v1 exists."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Confirmed: extra_refs is consumed only by client.create; a later client.round forwards nothing (the gateway pins refs from the stored round's repo_refs, plan-sparring-service.ts:356-358). Computing/resolving the ref once before the if (!cur || retryInfra || replan) branch would make a later round fail-loud on a moved/deleted companion ref even though that round never needs it, blocking the planner from answering findings. Plan now resolves the ref and applies the fail-loud contract only inside the create/retry/replan branch where client.create is actually called; round/waiting_for_planner/nothing_to_do paths never touch spar_refs."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Confirmed: step() reads/parses plan.md as the create input (plan-spar.mjs:168+), not handoff.md, which it only writes in the converged/escalated branches; and the workflow paths: filter (lines 26-28) plus detectSlug (lines 42-49) match only .kiro/specs/*/plan.md and sparring/*responses-*.md, never handoff.md, so a spar_refs edit in handoff.md alone would neither be parsed nor trigger the workflow. Plan now states explicitly that step() will newly read handoff.md front matter for spar_refs (added to the lane's scope), and requires a spar_refs declaration to accompany a plan.md or responses change so the existing trigger fires — extending the paths/detectSlug to include handoff.md is recorded as a documented follow-up rather than built in this lane."
  }
]
```
