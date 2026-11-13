# R4H: open merge request hygiene, VTID-05023

Project: vitana/vitana-platform (GitLab project id 2)
Snapshot date: 2026-11-13 (UTC). Base: origin/main at c7e17d64d9.
Scope: report only. Nothing was merged, closed, or edited on any MR.

## Method

- Open MRs came from `GET /projects/2/merge_requests?state=opened` (22 MRs). Head pipeline status and notes came from each MR's detail and notes endpoints.
- "Human note" means a non-system note from an account that is not `group_*_bot` and not the sync bot (`vitana-mirror`). Every non-system note on these MRs is authored by `group_2_bot_428bce64fb66f014b4a1c6032f0e662d`. System notes are GitLab events, not comments.
- SUPERSEDED was tested with `git cherry origin/main <branch>`. A commit counted as already in main when an equivalent patch exists there. No open MR had any commit in main. The merged MRs in scope are !8, !12, !14, !15, !16, and !24.
- DUPLICATE was tested by identical source branch or identical normalized title. None found.
- STALE means no update for more than 14 days and no human note. The oldest last update is 2026-11-10, three days before the snapshot. None found.

## Full list

Notes columns: total notes / non-system notes. Non-system notes are all bot-authored (`group_2_bot`), so no MR has a human note.

| iid | Title | Draft | Source -> target | Head pipeline | Created | Last update | Notes (total / non-system) | Human note | Class | Reason |
|---|---|---|---|---|---|---|---|---|---|---|
| 32 | VTID-05023 welcome skip test and loud-failure warning | yes | cutover/vtid-05023-M4-welcome-skip-test -> cutover/vtid-05623-welcome-trigger | running | 2026-11-13 | 2026-11-13 | 2 / 1 | no | KEEP | Stacked on open !28 by owner decision. Updated today. |
| 31 | VTID-05023 fix governance rules seed (ON CONFLICT without unique constraint) | yes | cutover/vtid-05023-M1-governance-fix -> main | running | 2026-11-13 | 2026-11-13 | 1 / 0 | no | KEEP | Owner decision: stays draft and unmerged. Updated today. |
| 30 | VTID-05023 gateway welcome skips test accounts | yes | cutover/vtid-05023-M5-gateway-welcome -> main | running | 2026-11-13 | 2026-11-13 | 0 / 0 | no | KEEP | Active. Overlaps in purpose with !28 (welcome test-account skip at gateway layer versus DB trigger). Not patch-equivalent, so not SUPERSEDED. Owner should confirm both are wanted. |
| 29 | VTID-05023 rehearsal failure classification (partial, pending full pass) | yes | cutover/vtid-05023-M2-compat-classify -> main | success | 2026-11-13 | 2026-11-13 | 0 / 0 | no | KEEP | Active draft. Updated today. |
| 28 | VTID-05023 welcome-chat trigger skips service and test accounts | yes | cutover/vtid-05623-welcome-trigger -> main | failed | 2026-11-13 | 2026-11-13 | 4 / 1 | no | KEEP | Active. Bot review note 790 requests changes. Base of open !32. |
| 27 | VTID-05023 parity counts script | yes | cutover/vtid-05023-rehearsal-parity-2 -> main | success | 2026-11-12 | 2026-11-13 | 4 / 2 | no | KEEP | Active. Only parity script on an open MR. |
| 26 | DRAFT: staging only, DATA_REST_BASE_MODE=aurora_proxy in gateway-staging-deploy | yes | cutover/vtid-05023-C-staging-aurora-mode -> cutover/vtid-05023-C-rest-switch | failed | 2026-11-12 | 2026-11-12 | 0 / 0 | no | KEEP | Stacked on open !25. Different purpose from !25 (staging deploy versus default-off switch). |
| 25 | VTID-05023 C: DATA_REST_BASE_MODE, REST base switch off by default | no | cutover/vtid-05023-C-rest-switch -> main | success | 2026-11-12 | 2026-11-13 | 4 / 1 | no | KEEP | Active. Base of open !26. |
| 23 | VTID-05023 (test): cover the Aurora compat lint command and PR-GATE step | no | cutover/vtid-05023-J-lint-cli-tests -> cutover/vtid-05023-lane | success | 2026-11-12 | 2026-11-12 | 1 / 0 | no | KEEP | Targets the lane branch, not main. No other MR has this purpose. |
| 22 | VTID-05023 (test): pin the Aurora deploy gates' exit status | no | cutover/vtid-05023-J-gate-exit-tests -> main | success | 2026-11-12 | 2026-11-12 | 1 / 0 | no | KEEP | Distinct from merged !14 (pinned test for secret removal). |
| 21 | VTID-05023 L: rollback dry-run path | no | cutover/vtid-05023-L-rollback-drill -> main | success | 2026-11-12 | 2026-11-12 | 3 / 1 | no | KEEP | Active. Bot note 773 lists owner decisions. |
| 20 | VTID-05023: migration order inventory for the Aurora cutover (pending owner O5) | no | cutover/vtid-05023-G-migration-inventory -> main | success | 2026-11-12 | 2026-11-12 | 2 / 1 | no | KEEP | Active. Waiting on owner O5. |
| 19 | VTID-05023 B: Aurora compatibility layer and AURORA-ONLY skip | no | cutover/vtid-05023-B-compat-layer -> main | success | 2026-11-12 | 2026-11-12 | 1 / 0 | no | KEEP | Active. Not an ancestor of !25 despite overlapping file set. |
| 18 | DRAFT: VTID-05023 F: rehearsal migration runner (Data API, fake-tested) | yes | cutover/vtid-05023-F-rehearsal-runner -> main | success | 2026-11-12 | 2026-11-12 | 2 / 1 | no | KEEP | Active draft. |
| 17 | Draft: VTID-05023 window runbook (option B, readiness only) | yes | cutover/vtid-05023-D-window-runbook -> main | success | 2026-11-12 | 2026-11-12 | 4 / 1 | no | KEEP | Active draft. Bot note 772 lists owner decisions. |
| 13 | plan(VTID-05023): staging Aurora cluster from a read-only Supabase snapshot | no | plan/vtid-05023-staging-aurora -> main | success | 2026-11-11 | 2026-11-11 | 2 / 0 | no | KEEP | Plan document. Not stale (2 days). |
| 11 | Draft: VTID-05023 staging gate fixes: PM-mode probes (05277, 05281) | yes | kiro/staging-verify-manifest-repair/pm-mode-probes -> main | success | 2026-11-11 | 2026-11-11 | 0 / 0 | no | KEEP | Not stale. Covers VTIDs 05277 and 05281, not the same as !9 or !10. |
| 10 | Draft: VTID-05023 staging gate fixes: console probes B (05003, 05004, 05064, 05069, 05071) | yes | kiro/staging-verify-manifest-repair/console-probes-b -> main | success | 2026-11-11 | 2026-11-11 | 0 / 0 | no | KEEP | Not stale. Different VTID set from !9. |
| 9 | Draft: VTID-05023 staging gate fixes: console probes A (04887, 04975, 04984, 04999) | yes | kiro/staging-verify-manifest-repair/console-probes-a -> main | failed | 2026-11-11 | 2026-11-11 | 0 / 0 | no | KEEP | Not stale. Different VTID set from !10. Pipeline failed. |
| 5 | Draft: VTID-05672: staging-verify runs suites in parallel and dedupes shared commands | yes | ccr-0a1941aa-54w7ly -> main | failed | 2026-11-10 | 2026-11-10 | 0 / 0 | no | KEEP | Not stale: last update 3 days ago. Pipeline failed. |
| 4 | docs: Kiro 1 (hotmail) automation file, so the seat wakes on its own | no | claude/kiro1-automation -> main | success | 2026-11-10 | 2026-11-10 | 0 / 0 | no | KEEP | Not stale: last update 3 days ago. Author is `claude-agent`, not a human note. |
| 3 | fix(gateway): raise the Node heap for the image build (GitLab gateway-staging-build OOM) | no | claude/gateway-build-heap -> main | success | 2026-11-10 | 2026-11-10 | 1 / 0 | no | KEEP | Not stale: last update 3 days ago. The Dockerfile heap change is not in main (checked: no `max-old-space` in origin/main). Sync-bot system note only. |

Counts: KEEP 22. DUPLICATE 0. SUPERSEDED 0. STALE 0.

## Proposed closures

None. No MR is a DUPLICATE, SUPERSEDED, or STALE-without-human-note under the rules above, so nothing is proposed for closure. Nothing was closed in this run.

Items the owner may want to review, but which are not proposed for closure:

- !28 and !30 both skip test accounts in welcome flows (DB trigger and gateway layer). Owner should confirm both layers are intended.
- !9, !10, and !11 are three gate-fix MRs with the same branch prefix and disjoint VTID sets. They are not duplicates.

## Notes

- Human notes: none on any open MR. Bot notes are quoted by id only, not by body. Non-system note ids run from 769 to 796 and are all `group_2_bot`. The one sync-bot note on !3 is id 692.
- Lane file: no R4H lane file section exists on origin/main or on `cutover/vtid-05023-lane`. This report is the only file written in this run.
