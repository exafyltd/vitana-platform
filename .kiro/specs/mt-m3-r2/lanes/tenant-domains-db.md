---
lane: tenant-domains-db
state: done
next_actor: kiro
depends_on: []
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102140000_vtid_*_mt_tenant_domains.sql
  - supabase/migrations/20261102140000_vtid_*_mt_tenant_domains_rollback.sql
  - supabase/migrations/20261102140100_vtid_*_mt_resolve_tenant_host.sql
  - supabase/migrations/20261102140100_vtid_*_mt_resolve_tenant_host_rollback.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
updated: 2026-11-07T13:25Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05507
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-m3-r2/tenant-domains-db
pr: https://github.com/exafyltd/vitana-platform/pull/4787
---
# tenant_domains table + resolve_tenant host arm — mt-m3 (repo vitana-platform)

Plan: `.kiro/specs/mt-m3-r2/plan.md`; tasks D1–D4 in `tasks.md` (allowed paths, acceptance); design in `design.md`.
Creates `tenant_domains` (RLS, no client policy; reserved-slug hosts rejected by a BEFORE INSERT/UPDATE trigger, not a
CHECK) and a separate no-DEFAULT 2-arg overload
`resolve_tenant(p_host text, p_slug text)`; the 1-arg `resolve_tenant(p_slug)` is untouched (pinned byte-identical).
Expand-only; rollbacks + read-only pre/post checks; MIGRATION-QUEUE rows after the live last row (mt-m3 range note); add
`tenant_domains` to `migration-drift-baseline.json` and note its removal in the post-apply PR. The lane adds its own
`docs/validation/<vtid>/`.

Rules (collaboration §7a): no VTID allocation, no `_plan` claim, no `handoff.md` edit, no merge/approve/deploy/workflow
dispatch, no Supabase/AWS writes (a DB change is a migration file in this PR; DB applies are Kiro, on the owner's approval (§7d), via RUN-MIGRATION).
Work only inside the allowed paths. Branch `kiro/mt-m3-r2/tenant-domains-db`; PR title
`VTID-xxxxx (mt-m3-r2/tenant-domains-db): …`; commit trailers `Collab-Session: <your kiro id>` and
`Collab-Lane: mt-m3-r2/tenant-domains-db`. When the PR is open: set `state: in-review`, `next_actor: kiro`, `pr: <url>`,
append a log entry, release the claim.


## Log
### 2026-11-01T15:43Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-m3/tenant-domains-db`. Versions day-shifted to `20261102140*`. Executor and reviewer follow today's §3a/§7 rules.

### 2026-11-02T16:28Z · ci-plan-spar · ready (VTID allocated)
VTID-05507 allocated after policy approval (converged-auto-v1).

### 2026-11-07T12:45Z · agent-vitana-lane-reviewer-202611071241-1c76 · review
review: accept
head: aacf7899fc3abf48157d75c37a15a490a2491d90
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4787
Findings: non-blocking: queue rows 30-31 collide with PR #4788 (VTID-05493) — the second to land renumbers; host is text with a lower-case CHECK instead of citext (conservative, log under Decisions taken); rollbacks under docs/validation instead of beside the forward files (accepted, avoids a version collision); pgTAP/harness under docs/validation; CI (11 check-runs) is the caller's statement — the land step confirms it on the current head; migrations unapplied, need owner approval (§7d)
Next: the land step merges under §7b once CI is confirmed green on the current head

### 2026-11-07T13:05:00Z · agent-vitana-lane-reviewer-202611071302-b6ca · review
review: accept
head: fbbb7696a9c40ff6a1c4b6e2b1543661d5beae9f
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4787
Findings: non-blocking: baseline count 118 verified as 117 + 1 by diff against origin/main, not recounted (CI drift test confirms); non-blocking: CI on this head not readable by the reviewer, the land step confirms green before merge. The hand-resolved conflict in scripts/ci/migration-drift-baseline.json is correct (tenant_domains added sorted, no duplicate, 05479/05571/05488/05507 comments kept); MIGRATION-QUEUE rows 30-31 follow main's rows 21-29; the lane's own paths are unchanged since aacf7899fc.
Next: the land step merges under §7b after confirming every check green on this head

### 2026-11-07T13:20Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-m3-r2/tenant-domains-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T13:20Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4787. Reviewed on head `fbbb7696a9` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T13:20Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: d196e898acf72f8c80a26f7a6eb70a840ef50059 (exafyltd/vitana-platform#4787)
authority: §7b PM rule. Squash merge by land-guard on head `ee3996ffba`: the reviewed head `fbbb7696a9` plus the review-entry commit and a clean merge of main. `land-guard review` ok, `land-guard checks` green (12/12), PR up to date. No lane code changed after the accept.
The migrations in this lane are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d). Next: STAGING-VERIFY on the merge commit, then the `done` record.

### 2026-11-07T13:25Z · kiro-hotmail-202611061752-cc1f · verified → done
Closing record: merge d196e898acf72f8c80a26f7a6eb70a840ef50059 (#4787) changes no path under services/gateway or the stage deploy workflow (supabase migrations, tests, docs and the drift baseline only), so AWS-STAGE-DEPLOY-GATEWAY and STAGING-VERIFY did not run for it: this change deploys nothing. It is done at merge with green checks (12/12 on the final head). The migrations 20261102140000 and 20261102140100 are on main and NOT applied; applying them needs the owner's approval per file and database (collaboration.md §7d). The lane claim is released once this record is on main.
