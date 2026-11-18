---
lane: provision-test-flags-subset
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/tests/vtid_05150_provision_tenant.test.sql
updated: 2026-11-08T13:05Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05610
---
# provision-test-flags-subset — feature_flags expectation tolerates erp key — mt-schema-queue-followup-r2

Plan: `../plan.md` and the `provision-test-flags-subset` group of `../tasks.md`. The VTID comes from PLAN-SPAR on convergence, never by hand.
Rules (§7a): no VTID allocation, no merge outside §7b, no deploy, no live write. Branch
`kiro/mt-schema-queue-followup-r2/provision-test-flags-subset`; PR title `VTID-xxxxx (mt-schema-queue-followup-r2/provision-test-flags-subset): …`.

## Log
### 2026-11-07T20:00Z · kiro-hotmail-202611061752-cc1f · created → ready
Created with the plan.

### 2026-11-07T19:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05610 allocated after policy approval (converged-auto-v1).

### 2026-11-07T20:45Z · agent-vitana-lane-reviewer-202611072031-0a34 · review
review: accept
head: d04f1d47ecf948d36191facd68084fb7a713bb70
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4856
Findings: non-blocking: the erp key's content is no longer pinned in vtid_05150_provision_tenant.test.sql (line 145; accepted by the plan; confirm VTID-05506's tests pin erp.bootstrap_requested). Non-blocking: reviewer could not read the check runs (gh GraphQL unsupported, gh api denied), so the land step must confirm all required checks are green on this head. Evidence verified: old assertion red with 141000 and green without; new assertion green with and without; rogue-key mutation red in both cases; the jev object is still pinned exactly; the diff stays within paths.
Next: the land step merges under §7b once every required check is confirmed green on this head and the PR is up to date with main

### 2026-11-08T12:05Z · agent-vitana-lane-reviewer-202611081205-47ea · review
review: accept
head: b61f8d42130276231d34a9744e978f81e4da8f3a
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4856
Findings: non-blocking: earlier erp note closed. docs/validation/VTID-05506/pgtap/vtid_05506_erp_monitoring.test.sql on origin/main pins erp.bootstrap_requested = true (assertions 01, 02, 14). The PR's own diff against origin/main is still only supabase/tests/vtid_05150_provision_tenant.test.sql, docs/validation/VTID-05610/** and this lane log. Its content is identical to the head accepted before, d04f1d47ec: jev is pinned exactly and feature_flags - 'jev' - 'erp' = '{}'. No protected gate file is in the PR's own diff. Non-blocking: reviewer could not read the check runs (gh GraphQL unsupported, gh api not allowed), so the land step must confirm every required check is green on this head.
Next: the land step merges under §7b once every required check is confirmed green on this head and the PR is up to date with main

### 2026-11-08T13:00Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-schema-queue-followup-r2/provision-test-flags-subset; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-08T13:00Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4856. Reviewed on head `7250af9501` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-08T13:00Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: d132e0976e1cf0353d0d204afdee092076e26be9 (exafyltd/vitana-platform#4856)
authority: §7b PM rule. Squash merge by land-guard; `land-guard review` ok, `land-guard checks` green (11 checks), PR up to date. No lane code changed after the accept.
The change is tests and validation evidence only (supabase/tests/vtid_05150_provision_tenant.test.sql). Next: the `done` record.

### 2026-11-08T13:05Z · kiro-hotmail-202611061752-cc1f · verified → done
This lane deploys nothing: docs and tests only. No staging deploy follows from the merge (d132e0976e), so there is no STAGING-VERIFY run for it; it is done at merge with green checks (11 green).
