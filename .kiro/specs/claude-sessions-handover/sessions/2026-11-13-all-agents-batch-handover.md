# All-agents parallel batch — handover (2026-11-13)

Batch dispatched 2026-11-13 ~17:00–19:00 UTC: 12 tasks (A1–A12) across `exafyltd/vitana-platform` and
`exafyltd/vitana-v1`, run in parallel via sub-agents, plus three items the batch's own cover message flagged as
needing the owner directly. This document is the single state-of-everything record for that batch.

## Open owner questions — keep visible

1. **Production — three unanswered questions from "the last report."** The batch's cover message asked: was a
   change authorized, is a token removed, and is "owner decision 2026-11-13" the owner's own. None of the three
   could be answered from this session: the referenced "last report" never appeared in this session's context, so
   the specific change/token are unidentified, and the third question was declined on principle — no AI session
   self-certifies an "owner decision." **This needs the owner to either restate what change/token/decision is
   meant, or confirm directly.** Not resolved by this batch.
2. **GitLab access is still broken.** Confirmed firsthand, repeatedly, across this session and again in this batch
   (A1/A6/A11 and the dispatching session all hit it independently): every bulk-list GitLab API call succeeds, but
   every single-resource call (by path, by numeric id, and `git clone`/`glab api` alike) returns the same
   gateway-side 403 — `'<resource>' resource match not found for entity '472838866351' instance
   'fe200943-8ad9-5812-8e00-2569216c9331' providerId ...`. This blocks: A6 (cutover MRs `!21`–`!41`), A10 (see
   below), and the GitLab half of A11 (the rehearsal CI settings-blocker). **Needs the gateway's GitLab resource
   routing fixed, or a working connection added, by whoever administers it — not something any session-side retry
   can fix.**
3. **AWS quota — the 96-vCPU increase in the `vitana-engineering` account.** Still needs the actual owner/account
   holder of that separate account to file the Service Quota request. This session's AWS identity
   (`kiro-agent-role`, account `472838866351`) has no role into `vitana-engineering` at all (confirmed via `aws sts
   get-caller-identity`), so there is no session-side workaround.
4. **New: A10 needs a repository-scope decision, separate from GitLab access.** "EXECUTION-STATUS... as an MR" on a
   `kiro/*` branch resolves to `vitana/vitanaland-strategy` on GitLab — a *third* repository, outside the two this
   session is scoped to (`exafyltd/vitana-v1`, `exafyltd/vitana-platform`; see `AGENTS.md`'s explicit "stop and ask
   before touching any other repository" rule). Even if GitLab access is fixed, this repo was never put in scope.
   **Needs an explicit owner confirmation that scope should extend to it**, independent of the GitLab fix above.
5. **Migrations: none were applied, none were proposed in this batch.** Repeating the standing rule that's been
   live all session: `collaboration.md` on `origin/main` still requires a migration to land as a file in a lane PR,
   never applied directly from a session tool, and staging shares the production database so an apply needs the
   owner's explicit per-file approval first. Nothing in A1–A12 touched this. The still-open finding from earlier in
   this session — migration `20261112100000_bridge_sparring_convergence_is_approval.sql` found live in production
   despite its own "NOT APPLIED" header (handover PR #5077, still open) — is unrelated to this batch and remains
   exactly as it was: reported, not resolved, no owner ruling received.

## Task-by-task state

| # | Task | State | Result |
|---|---|---|---|
| A1 | Staging green | **Not green — blocked on infra, not code** | Existing run [43448804915](https://github.com/exafyltd/vitana-platform/actions/runs/43448804915) for `447e46a82ea9`: every test had passed (last: `VTID-05106 › prototype gate`, 16:13:55Z), then the run was **externally cancelled** ~5.5 min later with no visible issuer in the log. Recorded as `staging.verify.failed`/`crashed:true` in OASIS, but it is not a test or deploy failure. |
| A2 | Verify picks the live commit | **Done** | PR [#5080](https://github.com/exafyltd/vitana-platform/pull/5080). `commit_sha` on `STAGING-VERIFY.yml`'s `workflow_dispatch` is now optional; omitted → resolves the live-served commit via the existing `run.mjs stamp` lookup before checking out, same as the nightly job already did. Explicit `commit_sha` behaves exactly as before. New test: 12/17 pass before the fix, 17/17 after. Sparring round 1 ran and was answered (clarified the cross-repo token requirement); convergence/VTID allocation is CI PLAN-SPAR's job from here. |
| A3 | Crashed run | **Done** | Run [43437806241](https://github.com/exafyltd/vitana-platform/actions/runs/43437806241): **infrastructure, not a test failure** — step conclusion `cancelled` (not `failure`), ~4m53s of dead air immediately after a passing test, no OOM/network/Chromium error anywhere in the 46k-line log, job timeout (75 min) not reached. The `crashed:true` OASIS record is a hardcoded fallback the record script writes whenever `results.json` was never produced — not a derived verdict. |
| A4 | PR #5052 | **Done — clean** | Updated onto current `main` via the REST `update-branch` endpoint (plain merge, no force-push, no conflicts): new head `8efd171e0d4`. All 4 Gateway Jest shards + Test Suite Summary now pass. Confirms the original failures were stale-base (pre-#5057/VTID-05785), not real. Not merged. |
| A5 | Open PR triage | **Done** | 244 open PRs total; 104 with a failing check. vitana-v1: 12 stale-base / 14 real failure / 8 environment (of 34). vitana-platform: 22 stale-base / 46 real failure / 2 environment (of 70). Full per-repo PR-number lists are in the sub-agent's report (not duplicated here — ask if you want them inlined). Nothing closed, nothing commented beyond what was needed to justify a non-obvious call. |
| A6 | Cutover MRs | **Blocked** | GitLab access (see open question 2). No MR list possible. |
| A7 | delivery-bedrock lane | **Code done, provisioning blocked** | PR [#5081](https://github.com/exafyltd/vitana-platform/pull/5081). `bedrock.ts` gained an optional assume-role path (`DELIVERY_BEDROCK_ROLE_ARN`), signed with a hand-rolled SigV4 implementation (no STS/credential-provider package is reachable from this lane's dependency tree) — **flagging this specifically for a closer security review given it's hand-written auth-signing code**, even though the sub-agent reports cross-checking it against the `aws4` package during development. `setup-delivery-bedrock.sh` written (dry-run by default) but never executed against real AWS. The actual role creation in the separate `vitana-engineering` account is still blocked (open question 3). |
| A8 | 13-seat inventory | **Done** | Full table in the sub-agent's report. Flags one real discrepancy worth the owner's attention: `agentic-delivery-v2/plan.md` §6 claims "7 Kiro accounts... active," but `areas.yaml` shows only 4 seats (`hotmail`, `exafy`, `exafyltd`, `jtadic`) with a provisioned surface — the other 5 are `pending`. Also: the `vtid_ledger` carries no seat/session attribution on any row checked (every `assigned_to`/`claimed_by` null) — seat history lives only in git, not the ledger. |
| A9 | Handover | **This document.** | |
| A10 | Strategy EXECUTION-STATUS MR | **Blocked** | Out of repo scope *and* GitLab-blocked (open questions 2 and 4). No agent was dispatched at it. |
| A11 | Rehearsal shadow prep | **Partly done, one piece blocked** | No push performed. Resolved ref (`origin/main` = `4c4694b797...`) and the exact push command recorded in `.kiro/specs/shadow-platform-main/shadow-run.md` (written, not committed — a deliberate call by the sub-agent given the doc is 4 lines of substance; full content is in its report if you'd rather have it as a PR). The CI "settings-blocker" piece stays blocked on GitLab access (open question 2) — not guessed at. |
| A12 | Full gateway Jest suite | **Done — clean** | 29,927/29,929 tests pass on `main` @ `4c4694b797`. The 2 failures are the same two pre-existing, environment-caused failures PR #5057 already documented and excluded (`AWS_REGION` env override; missing `openssl` binary in this sandbox) — not regressions. A test-suite side effect (a script-regen test overwriting a committed JSON file) was caught and reverted; nothing else was changed. |

## Process notes for next time

- **Running many parallel agents against one shared checkout directory causes real interference.** A4 and A11 both
  independently observed `/projects/sandbox/vitana-platform`'s checked-out branch and working tree changing mid-task
  from work neither of them did (A7's and A2's branches, respectively, landing in the same directory). No data was
  lost this time — everyone's actual commits/pushes landed correctly — but it's fragile. A12, A2, and this handover
  task avoided it by using a dedicated `git worktree` per task; that should be the default for any future batch
  this size, not an exception.
- **Two independent STAGING-VERIFY runs for community-app (A1's and A3's) were both killed by an external
  cancellation after already passing every test that had run**, within about 3.5 hours of each other, with no
  issuer visible in either log. That's a pattern, not a one-off, and it's the actual reason A1 isn't reporting
  "green" — worth someone looking at what's issuing these cancellations (a concurrency/timeout setting elsewhere, a
  CI-minutes cap, or a person/process cancelling runs) before just re-running STAGING-VERIFY a third time.

## Next priorities
1. Owner: answer the three Production questions and the GitLab/AWS-quota/repo-scope items above — nothing further
   moves on A1 (fully), A6, A10, or the rest of A11 without them.
2. Someone with log/audit access beyond `gh run view`: find what's cancelling community-app STAGING-VERIFY runs
   mid-execution (two instances now, see Process notes).
3. Review PR #5080 (A2) and PR #5081 (A7, especially the hand-rolled SigV4 signing) on their own merits once CI
   sparring/checks finish — neither was merged by this batch.
4. PR #5052 (A4) is clean and ready whenever someone wants to act on it; this batch did not merge it.
5. The 46-PR "real failure" bucket on vitana-platform and 14-PR bucket on vitana-v1 (A5) are the actual actionable
   backlog if the next session's goal is "get more PRs green" — the stale-base ones will likely self-resolve once
   their underlying plans merge.
