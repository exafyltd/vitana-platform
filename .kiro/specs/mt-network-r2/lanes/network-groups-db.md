---
lane: network-groups-db
state: done
next_actor: kiro
depends_on: [messaging-send-db, legacy-messages-migration-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102054***_*.sql
  - docs/multitenancy/MIGRATION-QUEUE.md
  - scripts/ci/migration-drift-baseline.json
  - services/gateway/test/mt-network-groups-db.pgtap.test.ts
updated: 2026-11-08T14:31Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05579
---
# mt-network-r2/network-groups-db — chat_groups scope + add_group_member (M3, flagged) (repo vitana-platform)

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `network-groups-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7): add `chat_groups.scope`/`chat_group_members.scope`, participant-only RLS, `add_group_member()` DEFINER (≤20, invite-only between connections, creator tenant as context, no system fan-out — D27). Rollback + pre/post checks + MIGRATION-QUEUE row (LAST) in this PR; own `docs/validation/<vtid>/`. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `messaging-send-db` and `legacy-messages-migration-db` (legacy group threads already migrated into `chat_groups`). Work only inside the allowed paths.

Branch `kiro/mt-network-r2/network-groups-db`; PR title `VTID-xxxxx (mt-network-r2/network-groups-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/network-groups-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `jtadic`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/network-groups-db`. Versions day-shifted to `20261102050*`. Reviewer agent.

### 2026-11-06T10:10Z · ci-plan-spar · ready (VTID allocated)
VTID-05579 allocated after policy approval (converged-auto-v1).

### 2026-11-08T11:30Z · agent-vitana-lane-reviewer-202611081128-cd1d · review
review: accept
head: c8d6c78effcc19fb2de834221d969594ea79d793
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4850
Findings: none blocking. The blocking finding of the previous review on 394875b4f2 is fixed: add_group_member and add_group_member_as refuse every non-network group with 42501 not_network_group before the membership check; the community branch is removed; pgTAP cases 73-77 rewritten (red on the old head per red-community-old-head.txt, 92/92 green incl. double apply, jest 22/22), mutation M16 retargeted and caught. Non-blocking items addressed: the vitana.chat_group_rpc claim corrected (a guard, not authentication; tightening deferred), the 054200 non-SELECT-policy precondition added to live-before.sql. Standing rules hold: RLS with auth.uid(), tenant context, rules 43-45, SECURITY DEFINER lockdown, drift baseline 120 unchanged, MIGRATION-QUEUE rows 63-65 appended without altering existing rows. Non-blocking: check runs unreadable by the reviewer; the land step must confirm every required check green on this head.
Next: the land step merges under §7b

### 2026-11-08T13:28Z · agent-vitana-lane-reviewer-202611081328-bb8e · review
review: accept
head: 91810216bcef703fc91546400c4c5397639dc365
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4850
Findings: none blocking. Re-review after review-entry commit 634e52ddcf and a clean merge of origin/main. The PR's own diff vs origin/main (38 files) holds only this lane's files: migrations 20261102054000/054100/054200, services/gateway/test/mt-network-groups-db.pgtap.test.ts, docs/validation/VTID-05579/**, MIGRATION-QUEUE.md rows 63-65 and the lane file log. The lane content is identical to the previously accepted head c8d6c78eff (empty diff over migrations, test and docs/validation/VTID-05579). No protected gate file is in the PR's own diff (CLAUDE.md, VTID-ALLOCATE.yml and plan-sparring SKILL.md came from main only). MIGRATION-QUEUE.md differs from main by exactly three appended lines, rows 63-65, each present once after row 62; rows 1-62 including the VTID-05609 renumbering are untouched. Non-blocking: check runs unreadable by the reviewer (GraphQL pass-through unsupported); the land step must confirm every required check green on this head.
Next: the land step merges under §7b

### 2026-11-08T13:47Z · agent-vitana-lane-reviewer-202611081347-f5ba · review
review: accept
head: 147761e868248b3545a77a1ca75f4cabec532091
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4850
Findings: none blocking. Re-review after the new review-entry commit and a merge of origin/main (main tip e1a153890a). Between 91810216bc and 147761e868 the only differences in the lane's files are two. First, the lane file gains the 91810216bc review entry (+8 lines). Second, MIGRATION-QUEUE.md changes only because main moved: the 22-line diff against the old head is main's own rows. The PR's own diff against main (`git diff origin/main...147761e868`, 38 files, 3220 insertions) holds only this lane's files: migrations 20261102054000/054100/054200, services/gateway/test/mt-network-groups-db.pgtap.test.ts, docs/validation/VTID-05579/**, MIGRATION-QUEUE.md and the lane file. MIGRATION-QUEUE.md differs from main by exactly 3 added lines, rows 63, 64 and 65, each present once and placed after row 62. No existing row is altered. Migrations, test and docs/validation/VTID-05579 have an empty diff against the originally accepted c8d6c78eff. No protected gate file (CLAUDE.md, .github, .claude, scripts/collab, .kiro/agents, .kiro/steering) is in the PR's own diff. Non-blocking: check runs are unreadable by the reviewer (GraphQL pass-through unsupported); the land step must confirm every required check is green on this head.
Next: the land step merges under §7b

Collab-Session: agent-vitana-lane-reviewer-202611081347-f5ba
Collab-Review: mt-network-r2/network-groups-db
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
Collab-Reviewed-Head: 147761e868248b3545a77a1ca75f4cabec532091

### 2026-11-08T14:18Z · agent-vitana-lane-reviewer-202611081418-3e2e · review
review: accept
head: ad090d47c6d2dccb00913170564612e4792db442
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4850
Findings: none blocking. Re-review of the head reached after the prior accept on 147761e868. Since that head there are three commits: the review-entry commit d349e802b3 (lane file only, +14 lines) and two merges of origin/main (5ef8f40fc2, ad090d47c6). The head is up to date with main (merge-base = origin/main e9168deed9). The PR's own diff against main (git diff origin/main...ad090d47c6, 38 files, 3234 insertions) holds only this lane's files: migrations 20261102054000/054100/054200, services/gateway/test/mt-network-groups-db.pgtap.test.ts, docs/validation/VTID-05579/**, docs/multitenancy/MIGRATION-QUEUE.md and the lane file. git diff c8d6c78eff ad090d47c6 over the migrations, the test and docs/validation/VTID-05579 is empty, so the lane content is identical to the accepted c8d6c78eff. MIGRATION-QUEUE.md differs from main only by rows 63, 64 and 65, appended once after row 62; no existing row is altered. No protected gate file (scripts/collab/protected-gate-files.json) is in the PR's own diff. Non-blocking: the main-side files from #4869 (VTID-05504: .github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml, .kiro/specs/mt-m3-r2/lanes/morning-health-pertenant.md, docs/validation/VTID-05504/**, commit 1ec3d5bf) and #4879 (VTID-05520, merge 932da573be: MT-LOCAL-STACK.yml, scripts/mt/stack/**, supabase/tests/local-stack/**, docs/validation/VTID-05520/**, package.json, pnpm-lock.yaml) and their closing records arrive only via merges of origin/main and are not part of this lane. Non-blocking: the reviewer cannot read check runs (GitHub GraphQL pass-through unsupported); the land step must confirm every required check is green on this head.
Next: the land step merges under §7b

Collab-Session: agent-vitana-lane-reviewer-202611081418-3e2e
Collab-Review: mt-network-r2/network-groups-db
Collab-Verdict: accept
Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
Collab-Reviewed-Head: ad090d47c6d2dccb00913170564612e4792db442

### 2026-11-08T14:27Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-network-r2/network-groups-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-08T14:27Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4850. Reviewed on head `ad090d47c6` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-08T14:27Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: b670aa2b992bf5410315202f77e93974d2f39c6d (exafyltd/vitana-platform#4850)
authority: §7b PM rule. Squash merge by land-guard; `land-guard review` ok, `land-guard checks` green, PR up to date. No lane code changed after the accept.
Next: the `done` record.

### 2026-11-08T14:31Z · kiro-hotmail-202611061752-cc1f · verified → done
Deploys nothing: the lane adds migrations 20261102054000, 20261102054100 and 20261102054200 only, so there is no staging deploy and no Gate 2.
The three migrations are unapplied. Applying them needs the owner's approval of the files and the target database (§7d), after the VTID-05573 apply.
Closed: merged under §7b with green checks (exafyltd/vitana-platform#4850).

### 2026-11-10T09:45Z · kiro-hotmail-202611061752-cc1f · audit
Suites ran 7/7 pass (pgTAP 92 ok, 92 ok applied twice, read-only checks, jest 22, bare-policy-lint 0, drift test 8, identity-lint jest 8) on origin/main 6dc6e1ba0c; flag gate: none at runtime (no MT_RESOLUTION_V2 or feature_flags.mt.* in 054000-054200); 054000 adds scope defaulting to 'community', 054100 adds six RPCs with no caller in gateway or v1, 054200 restates the two participant-read policies (membership test unchanged); pre-migration safe: yes, the merge changed no gateway or v1 code (migrations, queue, one jest file); row 63 needs the VTID-05573 legacy rows applied first (queue); evidence: docs/validation/VTID-05579/audit-m0/run.txt (command and exit code per suite).
