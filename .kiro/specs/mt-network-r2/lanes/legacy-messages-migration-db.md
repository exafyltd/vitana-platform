---
lane: legacy-messages-migration-db
state: done
next_actor: kiro
depends_on: [messaging-send-db, network-visibility-db]
executor: kiro
seat: hotmail
reviewer_seat: agent:vitana-lane-reviewer
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
paths:
  - supabase/migrations/20261102052***_*.sql
  - supabase/tests/mt-network-legacy-migration.pgtap.sql
updated: 2026-11-07T19:55Z
repos: [exafyltd/vitana-platform]
vtid: VTID-05573
claimed_by: kiro-hotmail-202611061752-cc1f
branch: kiro/mt-network-r2/legacy-messages-migration-db
pr: https://github.com/exafyltd/vitana-platform/pull/4840
---
# mt-network-r2/legacy-messages-migration-db — migrate & retire legacy message tables (repo vitana-platform (one tree per object, re-plan R1-F1))

Plan: `.kiro/specs/mt-network-r2/plan.md`; tasks: the `legacy-messages-migration-db` group in `tasks.md`; design: `design.md`. 
DB lane (§4.7) with a data move: snapshot `bak_*` (retain 30 days) before freezing + migrating the 12 `messages` / 5 `message_threads` rows and the `global_message_threads`/`global_messages` (60/379) into `chat_messages`/`chat_groups` per the D15 single rule (shared tenant → Community, else Network), then drop the legacy tables. Pre-approved rollback restores from `bak_*`; read-only pre/post row-count checks in the PR; own `docs/validation/<vtid>/`. **The platform MIGRATION-QUEUE row + drift-baseline are a platform-side follow-up, not this v1 PR** — note the queue position (after `network-visibility-db`) in the PR body. Applied by Kiro via RUN-MIGRATION only on the owner's approval of the files and the target database (§7d).

§7a rules apply. Depends on `messaging-send-db` (the platform `chat_messages.scope` column) and `network-visibility-db`. Work only inside the allowed paths.

Branch `kiro/mt-network-r2/legacy-messages-migration-db`; PR title `VTID-xxxxx (mt-network-r2/legacy-messages-migration-db): …`; trailers `Collab-Session`, `Collab-Lane: mt-network-r2/legacy-messages-migration-db`. On PR open: `state: in-review`, `next_actor: kiro` (reviewer `hotmail`), `pr: <url>`, log, release.

## Log
### 2026-11-01T15:54Z · kiro-hotmail-202611011452-6d16 · created → ready
Re-plan of `mt-network/legacy-messages-migration-db`. Moved to the vitana-platform migration tree (one tree per object, R1-F1), seat `hotmail`. Versions day-shifted to `20261102050*`. Reviewer agent.

### 2026-11-06T10:10Z · ci-plan-spar · ready (VTID allocated)
VTID-05573 allocated after policy approval (converged-auto-v1).

### 2026-11-07T19:05:00Z · agent-vitana-lane-reviewer-202611071857-bc34 · review
review: accept
head: d10821037dc47864412c5313342b54f495ed5004
reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)
PR: https://github.com/exafyltd/vitana-platform/pull/4840
Findings:
- none blocking. The three blocking findings of agent-vitana-lane-reviewer-202611071840-45c7 are fixed in the SQL: (1) mt_legacy_messages_assert_ready() raises when any bak_* is missing while a legacy table exists and when any live row of the six tables is absent from or differs from its snapshot, and 052000 refuses over a mismatched existing snapshot (cases 54-59, M6, M7, M13); (2) a memberless group is group_skipped only when a rule 43-45 account is involved, otherwise it and its messages are unplaced and the drop refuses (cases 60-61, M8); (3) rollback-052000 restores the exact pre-freeze ACL stored in the bak_* comment, rollback-052300 restores the thread_id FKs on both participant tables (M11, M12). Paths, rules 43-45, platform tenant never written, no policy added, drift baseline 120, no CASCADE all hold; 65/65 pgTAP (PGlite), 10 red on the previous head, M1-M13 red.
- non-blocking: check runs unreadable by the reviewer; the land step must confirm every required check green on this head.
- non-blocking: apply precondition (retire the legacy readers/writers in vitana-v1 and gateway before 052000) and a clean live-before.sql for the owner approval are prose only.
- non-blocking: acceptance.md evidence bullets still say 50 ok / five mutations while outputs show 65 and M1-M13.
- non-blocking: participant tables stay frozen after 052300; DATABASE_SCHEMA.md and MIGRATION-QUEUE.md rows for the bak_* tables and these migrations are a platform-side follow-up (outside the lane paths).
Next: the land step merges under §7b

### 2026-11-07T19:45Z · kiro-hotmail-202611061752-cc1f · ready → executing
Built on branch kiro/mt-network-r2/legacy-messages-migration-db; recorded here at the closing, because one transition per PR meant the PR carried no lane-state entry.

### 2026-11-07T19:45Z · kiro-hotmail-202611061752-cc1f · executing → in-review
PR https://github.com/exafyltd/vitana-platform/pull/4840. Reviewed on head `d10821037d` (accept entry above, reviewer agent claude-sonnet-5.5).

### 2026-11-07T19:45Z · kiro-hotmail-202611061752-cc1f · in-review → verified
merge: 2c1a3d23ad278f8d674455aec3638e528526b4d5 (exafyltd/vitana-platform#4840)
authority: §7b PM rule. Squash merge by land-guard on head `b2fcf1e628`: the reviewed head `d10821037d` plus the review-entry commit and clean merges of main. `land-guard review` ok, `land-guard checks` green (12 checks), PR up to date. No lane code changed after the accept.
The migrations in this lane (20261102052000, 052100, 052200, 052300) are in the repository and NOT applied. Applying them needs the owner's approval per file and database (collaboration.md §7d), and the legacy readers and writers in vitana-v1 and the gateway must be retired before 052000. Next: the `done` record.

### 2026-11-07T19:55Z · kiro-hotmail-202611061752-cc1f · verified → done
This lane deploys nothing: it adds four migrations (20261102052000 snapshot and freeze, 052100 functions, 052200 migrate run, 052300 drop of the legacy messenger tables) with rollbacks, pgTAP (65 cases, PGlite) and validation evidence, none applied. No staging deploy follows from the merge (2c1a3d23ad), so there is no STAGING-VERIFY run for it; it is done at merge with green checks (12 green on head b2fcf1e628). Applying the migrations needs the owner's approval of the files and the target database (collaboration.md §7d). Non-blocking review notes carried forward: the apply precondition (retire the legacy readers and writers in vitana-v1 and the gateway before 052000) and a clean live-before.sql are prose only; acceptance.md evidence bullets still say 50 ok / five mutations while outputs show 65 and M1-M13; the participant tables stay frozen after 052300; the DATABASE_SCHEMA.md and MIGRATION-QUEUE.md rows for the bak_* tables and these migrations are a platform-side follow-up outside the lane paths.

### 2026-11-10T09:45Z · kiro-hotmail-202611061752-cc1f · audit
Suites ran 6/6 pass (pgTAP 65 ok, 65 ok applied twice, read-only checks incl. refused drops and rollback, bare-policy-lint 0, drift test 8, identity-lint jest 8) on origin/main 6dc6e1ba0c; flag gate: none at runtime (no MT_RESOLUTION_V2 or feature_flags.mt.*); safety is the guard mt_legacy_messages_assert_ready() in 052300, which refuses the drop unless every legacy row is placed; FINDING: 052300 drops messages, message_threads, global_messages, global_message_threads while v1 src/hooks/useGlobalMessages.ts:229,431,454,575, src/components/messages/GroupMembersModal.tsx:378, src/hooks/useGroupPosts.ts:57 and gateway services/automation-handlers/community-groups-repository.ts:186 and engagement-events-repository.ts:155 still read or write global_messages; its header and queue row 50 and 102 hold it until those readers are retired; pre-migration safe: yes before apply: no gateway or v1 code changed, so main runs unchanged without 052000-052300; NO after 052300 until the readers above are retired; evidence: docs/validation/VTID-05573/audit-m0/run.txt (command and exit code per suite).
