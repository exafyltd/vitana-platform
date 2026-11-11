---
slug: agentic-delivery-v2
author: kiro
author_seat: exafyltd
executor: kiro
next_actor: kiro
state: approved
updated: 2026-11-11T16:42Z
sparring_record: .kiro/specs/agentic-delivery-v2/sparring/verdict.md
vtids: [VTID-05701, VTID-05702, VTID-05703, VTID-05704, VTID-05705, VTID-05706, VTID-05707, VTID-05708, VTID-05709, VTID-05710, VTID-05711, VTID-05712, VTID-05713, VTID-05714]
---
# Handoff — agentic-delivery-v2

Plan: `plan.md`. Tasks: `tasks.md`. Wave 1 has 13 lanes (`lanes/*.md`); Wave 2 lanes are added through `_plan` after Wave 1
lands (plan §19.2). Companion plan: `privacy-ledger-auth` (PR #4958).

## Log

### 2026-11-11T11:10Z · kiro-exafyltd-202611111044-8f1d · drafted
Owner, 2026-11-10 (the delivery request, quoted in `plan.md`) and 2026-11-11 (decisions D1–D12, the correction list,
Phase 0 now). Pushed as a `plan(` PR for PLAN-SPAR. No VTID before convergence; CI allocates them.

Open for the owner before this plan converges: **D13** (DeepSeek last tier versus EU only, plan §14.3; recommended answer:
DeepSeek V3.2 on Bedrock in `eu-north-1`), D9 (token lifetime, recommended 365 days), D10 (cut shape, approved hard cut
stays).

Decisions taken:
1. Wave 1 works on GitHub now (VTID-ON-PR, the Bedrock review workflow, the sparring responder), so the stalls end before
   the GitLab cut; the GitLab parts (`gitlab-mr-vtid`, accounts) are built for the cut.
2. The Bedrock verdict is written as the existing review entry, so the merge rule, Lane scope and the Project Manager stay
   unchanged; moving state out of git is Wave 2.
3. Until D13 is answered, the new delivery stages run without a DeepSeek tier, and the existing partner chain is not changed.
4. The runner quota goes to the `vitana-engineering` account, not `472838866351` (plan §3 C6).
5. Lane `seats` waits for `privacy-ledger-auth/areas-emails` (same file).
6. The GitLab clones asked for on 2026-11-10/11 could not be made from this session (plan §3 C2, Phase 0 P4).

### 2026-11-11T11:27Z · ci-plan-spar · drafted → approved
Converged; approved by policy converged-auto-v1. 14 lane(s) got a VTID and are handed to Kiro.

### 2026-11-11T11:34Z · kiro-exafyltd-202611111044-8f1d · approved (driver: round 2 answered)
Plan driver for this plan. Round 2 converged with one minor finding, answered in `sparring/responses-2.md` without
touching the hashed plan block. This commit also starts the checks that PLAN-SPAR's `GITHUB_TOKEN` push did not.

Open:
- O1 (R2-F1, Phase 0 P2): list the Bedrock inference profiles in the engineering account and invoke
  `eu.anthropic.claude-opus-4-6-v1` once; record the id. In account 472838866351 it is listed ACTIVE (2026-11-11).
  Lane `delivery-bedrock` checks O1 before its chain names Opus 4.6.
- O2 (D13): the plan converged and was approved by policy at 11:21Z while D13 (DeepSeek outside the EU) is still open,
  although line 78 of `plan.md` says it must be answered first. §14.3 applies until the owner answers: no new delivery
  stage gets a DeepSeek tier and the existing partner chain is unchanged. The answer becomes a `_plan` lane if it
  changes a chain.
- O3: `main` now needs one approving review (classic branch protection, admins included, no bypass list) and nothing
  has merged since 6dc6e1ba0c (2026-11-08T18:27Z). No lane of this plan can merge until a reviewer with write access
  approves it.

Corrections: the drafted entry here said 12:00Z by mistake and is corrected to 11:10Z, the commit time of 28c42b0446.
The `ready` entries of the lane files keep the wrong 12:00Z (11:30Z for `retire-vtid-allocate`), because a `_plan`
commit may create a lane file but never edit one; their real times are 11:10Z and 11:20Z.

### 2026-11-11T15:00Z · kiro-exafyltd-202611111044-8f1d · approved (driver: owner answers applied; re-plan held)
Owner answers of 2026-11-11 applied to the plan block: `13698bf924` adds the bridge table (§6.1, D14: the kept list of
`agentic-delivery` §2.2, nothing else stays on GitHub, nothing new is built there) and withdraws lanes `vtid-on-pr`,
`review-workflow` and `review-dispatch-v1`; `adfa21355b` adds the database target (§9.1, D16), the Aurora-clone test
database (§13.3, D1), C2 as hypotheses only, the Sonnet 5.5 quota and DeepSeek `eu-north-1` listings (§14), "D13 does
not block", D15 and heartbeats at most 30 minutes. The plan hash changes.

Re-plan session: PLAN-SPAR does not re-spar a converged session (`scripts/collab/plan-spar.mjs:307`, `:336-347`), so it
runs on a lane-less spec `agentic-delivery-v2-r2` whose plan block is byte-identical to this one (sha256 of the lines from
`<!-- plan:begin -->` to `<!-- plan:end -->`: `8085b412a43d10f75312e1de9bade127a79c55c47e47452819edd1d81498928d`). It is
prepared but not pushed: round 1 of the companion re-plan (`privacy-ledger-auth-r2`, PR #4977, commit `399e9333e8`)
copied one seat account address from `docs/programs/areas.yaml:14` into `sparring/round-1.md`. The owner's rule is "no
email addresses anywhere", and every round that reads that file can copy one again until lane `areas-emails` is on
`main`. Owner stop (privacy), raised in the session report.

Decisions taken:
1. The bridge table is in this plan (§6.1); `agentic-delivery` §2.2 itself is unchanged.
2. The withdrawn lanes keep `state: ready` until their seats park them after this plan merges; a `_plan` commit cannot
   edit a lane file.
3. `gitlab-mr-vtid` allocates through `POST /api/v1/vtid/allocate` with `serviceAuthHeaders()`, not in-process (D16).
4. Driver heartbeats at most 30 minutes apart (owner).

Aurora progress for the owner and Claude Code (D15), all read-only, live AWS read 2026-11-11 14:35-14:41 UTC in
`472838866351`. Newest status source: `.kiro/specs/claude-sessions-handover/sessions/aurora-cutover.md` (committed
2026-10-15, content 2026-10-13); no Aurora commit on `main` since 2026-10-14; nothing moved since 2026-10-13. No source
gives a day estimate for any step ("not estimated").

| Step | State | Blocker | Owner | Verified |
|---|---|---|---|---|
| Schema | partly synced in the 2026-10-09 rehearsal; migrations still target Supabase; 120 migration files added since then not re-diffed | freeze and re-sync in the window | not named | target and counts yes; Aurora DDL no |
| Data | last full load 2026-10-09 (663 tables, 0 errors); no DMS task running; CDC failed 2026-09-15; Aurora data 33 days old | final load in the write-freeze window | owner (window) | yes |
| RLS and grants (part 0) | gate script and unit tests exist; never run live | pass on the clone, before the data host, after every load | not named | no |
| RPCs | 202 inventoried (106 auth-dependent, 42 not in tracked migrations); presence on Aurora unknown | no function-existence check | not named | no |
| Edge functions | 64 on Supabase; Aurora data client merged, switched off | data host, edge-secret flip, unschedule 25 cron jobs and 2 HTTP triggers | not named | code yes |
| Gateway code paths | 711 of 2,006 files call Supabase directly; one switch (`data_backend`), off; the `url-aurora-proxy` secrets do not exist | secrets, production proxy, part-0 pass, window | owner | yes |
| Frontend | 105 of 2,276 files call Supabase directly; `VITE_DATA_API_URL` unset | data host and an app PUBLISH | owner | code yes |
| Auth | stays on Supabase; bridge code merged (#4003); bridge SQL not on production Aurora as of 2026-10-13 | SQL before the production proxy | not named | no |
| Storage | stays on Supabase; reverse CDC needs `rds.logical_replication=1` (live: 0) | reboot, approved 2026-10-10, not done | owner | parameter yes |
| Realtime | not deployed; workflow never run | reboot, IAM, port 4000 rule, Cloudflare token | owner | yes |
| IAM for the cutover workflows | requested, not recorded as done | blocks realtime, proxy, data host, clone | owner | no |
| Production proxy | staging proxy runs; production service does not exist | IAM, auth-bridge SQL | not named | yes |
| Data host | `data.vitanaland.com` not set up | parity pass, token, proxy | owner | yes |
| Side effects | cron, outbox and scheduled-call scripts written; SQL not on Aurora as of 2026-10-13 | unschedule on Supabase at the flip | not named | partly |
| Other services | `data_backend` input on four services; none flipped | gateway first | not named | partly |
| Rehearsal on the clone (part 10) | never run; no clone exists | IAM, rehearsal secret, staging data host | owner or admin | yes |
| Cutover window (part 11) | not scheduled; the date follows a passed part 10 (`docs/validation/VTID-05023/plan-sparring.md:154-157`) | all rows above | owner and Claude Code (D15) | from docs |
| Rollback 12(i) | chosen; tested against a fake `aws` only | logical replication | owner | yes |
| Supabase decommission | not started | the cutover | not named | no status newer than 2026-09-20 |

Open: O1 (Opus 4.6 invoke) unchanged. O2 closed: D13 does not block (owner). O3 unchanged: `main` needs one approving
review; the only merge since 2026-11-08 (#4968) had a human approval.

### 2026-11-11T16:01Z · kiro-exafyltd-202611111044-8f1d · approved (driver: owner spec v5 amendments; re-plan session r2)
The owner spec `agentic-delivery-scope` v5 (2026-11-11) changes the plan block: a privacy line first; D9 and D10
undefined; D13 settled as config (A, B, C; default off); C2 corrected with the W4 reproduction; §11 sparring chain M1,
§12 review chain M4 with two reviews for protected files, §13.2 vision M5, §13.3 Kiro dispatches the clone (W7), §17
prerequisites instead of gates, §20 stops recorded instead of waited on, §19.2 the lanes that move to plan
`agentic-delivery-scope`. The converged hash (`8085b412a4`) no longer matches. PLAN-SPAR does not re-spar a converged
session (`scripts/collab/plan-spar.mjs:307`, `:336-347`), so the re-plan session runs on
`plan(agentic-delivery-v2-r2)`, a lane-less spec on a new branch with a byte-identical block. Its verdict and hash are
recorded here when it lands; the lanes keep VTID-05701 to VTID-05714.

Pre-check before the re-plan (owner decision A): address grep of the block, 0 matches; of the 59 cited files that exist
at `main` (`ba5f26b4d8`), 7 hold address-shaped strings: 4 noreply or example values and 3 credential-URL or bot
templates, none a former seat address and none on a cited line (counts only, nothing printed). The branch merged
`main` first, so this PR's own `docs/programs/areas.yaml` holds seat names only.

### 2026-11-11T16:42Z · kiro-exafyltd-202611111044-8f1d · approved (driver: re-plan session converged)
Re-plan session `f1f9716e-3a3c-40a1-9542-906dda729358` on `plan(agentic-delivery-v2-r2)` (#4982) converged in round 2 and
was approved by policy `converged-auto-v1` at 2026-11-11T16:31:58Z; final plan hash
`d9fa9cf9a448e17ee008f650e832656a9258eccf6d241209a229a09da554abf2` (record:
`.kiro/specs/agentic-delivery-v2-r2/sparring/verdict.md` on that branch). Round 1 had 4 findings, all accepted; the
same block is in this plan (`sha256` of the block `4379341f43503d9f…` in both files). #4982 is closed without merging
(a lane-less plan cannot be `approved` without VTIDs). This plan PR merges under §7b once its checks are green.
