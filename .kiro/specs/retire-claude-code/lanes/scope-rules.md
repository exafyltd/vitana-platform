---
lane: scope-rules
state: in-review
next_actor: kiro
depends_on: []
executor: kiro
seat: exafyltd
area: frontend
reviewer_seat: jtadic
governance: true
paths:
  - scripts/collab/queue.mjs
  - scripts/collab/queue.test.mjs
  - docs/validation/VTID-*/**
claimed_by: kiro-exafyltd-202610201041-ab5d
branch: kiro/retire-claude-code/scope-rules
pr: https://github.com/exafyltd/vitana-platform/pull/4210
updated: 2026-10-21T07:44Z
vtid: VTID-05259
---
# Lane scope rules: governance lanes, permission changes, legacy claude reviews (platform)
Plan: `.kiro/specs/retire-claude-code/` — `plan.md` and the `tasks.md` section `<!-- lane: scope-rules -->` are
authoritative. VTID: assigned by CI after PLAN-SPAR converges; do not start before `vtid:` is set here.
**Governance lane:** merge only on the owner's explicit per-PR instruction and an approving review from seat `jtadic` on the current head; never from an automation run.

## Log
### 2026-10-20T10:45Z · kiro-exafyltd-202610201041-ab5d · created → ready
Lane drafted with the plan. Next: PLAN-SPAR; once `vtid:` is set, seat exafyltd claims it.

### 2026-10-20T10:51Z · ci-plan-spar · ready (VTID allocated)
VTID-05259 allocated after policy approval (converged-auto-v1).

### 2026-10-20T11:35Z · kiro-exafyltd-202610201041-ab5d · ready → executing
Built S1–S3 in `scripts/collab/queue.mjs`:
- `validateLane`: `governance: true` (true|false) is the only way a Kiro lane declares a governance path. It needs a
  `seat` and a `reviewer_seat` that is a Kiro seat ≠ `seat` (not `claude`). Seats existing in `areas.yaml` is already
  checked by `validateRegistry`. `executor: claude` lanes are unchanged.
- `validateRange`:
  - a governance lane needs an `owner-instruction:` log line to reach `verified`, and a `merge: <sha>` line to reach
    `done`. (Plan wording: both before verified/done. The merge SHA cannot exist before the merge, so it is checked at
    `done`. This is the conservative split, listed under Decisions);
  - a `_plan` commit by the plan's `author_seat` may edit an existing lane only if the same PR changes `plan.md`, and
    never its `state` or `claimed_by`.
- `scopeCheck`:
  - governance files are allowed only from `governance: true` lanes;
  - `governance` added to the permission fields a lane PR cannot change;
  - on governance lanes every build commit must name `seat` and every review entry `reviewer_seat` (unseated and
    `session_…` refused);
  - legacy `reviewer_seat: claude` also accepts a named Kiro seat ≠ `seat`.

Tests (`queue.test.mjs`): 36 pass. The 6 new tests fail on origin/main's `queue.mjs`; the 30 old ones pass on both.
`plan-spar.test.mjs` 10/10.

### 2026-10-20T12:20Z · kiro-exafyltd-202610201041-ab5d · executing (fixes after the independent bypass review)
`semantic_reviewer` (round 1, changes) reproduced 8 bypasses. All 8 are fixed, and the reviewer's harness now shows
each one refused:
1. `_plan` commits on a governance lane PR are exempt only when they touch nothing outside `.kiro/specs/<slug>/`.
2. A `Collab-Review` commit may change only the lane file. A reviewer seat that built in the PR may not review.
3. A lane file new in the PR grants no governance path.
4. vitana-v1 cannot shadow a platform lane: when the lane is new locally, the vitana-platform copy is authoritative.
5. and 6. Removed the plan-author lane-edit exception (see Decisions).
7. `governanceRecord()` counts only new, quoted log lines below the front matter: placeholders, front-matter keys
   and older entries don't count. `merge:` must name a commit of the repo.
8. A legacy `reviewer_seat: claude` lane accepts a Kiro reviewer only when the lane names a `seat`, the reviewer seat
   differs from it, and that seat built nothing.

**Decisions** (narrower than plan Changes item 1; nothing grants more):
- Existing lanes' permission fields can no longer be changed by any `_plan` commit. PLAN-SPAR doesn't re-spar a
  converged plan (F6), so "changes plan.md" guaranteed nothing. A permission change is now a new lane in a new
  `plan(` PR.
- New `executor: claude` lanes are refused.

Tests: 39 pass (9 for VTID-05259). The 30 pre-existing tests are unchanged.

### 2026-10-20T12:55Z · kiro-exafyltd-202610201041-ab5d · executing (round-2 review fixes)
`semantic_reviewer` round 2 (changes) found 6 gaps left by the round-1 fixes. All are fixed, and its harness
(N1–N6) now shows each one refused:
- N1: `merge:` must be a commit already on the base branch (`merge-base --is-ancestor`), so a commit of the PR itself
  doesn't count.
- N2: a lane merged in the other repo writes `merge: vitana-v1@<sha>`. That is verified on that repo's main via
  `gh api …/compare/<sha>...main` and fails closed when it can't be checked.
- N3: `ghFetcher` returns null only on 404 and fails closed on any other error. A lane file that is new in the PR
  now grants **no paths at all** (not just no governance paths) until its plan PR has merged.
- N4: `owner-instruction:` needs real words inside the quotes; whitespace only is refused.
- N5: the `session_…` permission route on `executor: claude` lanes is closed, and legacy `executor: claude` lanes no
  longer reach governance paths. Existing lane permissions now change only through a new lane in a new plan.
- N6: a new `governance: true` lane is created only by the author seat of a **new** plan, in the plan PR where
  PLAN-SPAR approves it. It can't be added to an already converged plan.

**Decisions** (narrower than the plan):
- The 10 open `executor: claude` lanes (health-native ×5, native-g1-wiring ×2, pm-agent p1/p7,
  sparring-floor-retry) can still change non-governance paths. Their governance work needs re-planning as Kiro
  governance lanes.
- The contract change to two existing tests (claude lanes and `session_…` permission changes are now refused) is
  intentional; the PR body states it.

Tests: 40/40.

### 2026-10-20T13:25Z · kiro-exafyltd-202610201041-ab5d · executing (round-3 review fixes)
`semantic_reviewer` round 3 (changes) found 6 issues. All are fixed; its harness repro3 (P1–P3) is now refused, and
N1–N6 and A–H stay refused.
1. New governance lanes: `laneApprovedInPr()` requires the plan to be new, its head state to be `approved` or later
   (not `sparred` or `parked`), and the lane to be in the tree of the **last** `ci-plan-spar` commit with the same
   permissions. A lane added after the approval was never sparred, so it is refused.
2. A plan PR that also builds a lane (#4184 shape) still works for **non-governance** paths, when PLAN-SPAR approved
   that new plan in the same PR with the lane already in it. Governance paths wait until the lane is on main.
3. `merge:` accepts only `vitana-v1@` or `vitana-platform@`. The merge commit's message must name the lane key
   (`<slug>/<lane>`, as every lane PR title does), checked locally and through `gh api` for the other repo.
4. PR body updated (test count, the contract change to two existing tests).

**Accepted limitation (stated in the plan):** a session can forge `Collab-Session: ci-plan-spar`, as it already could
for the VTID-05214 exemptions. Seats and trailers are self-declared under one GitHub identity, so the owner's
explicit per-PR merge instruction stays the boundary for governance changes. The Collab handoff step that runs
validate is still report-only in PR-GATE; making it count is a PR-GATE (governance) change outside this lane.

Tests: 41/41.

### 2026-10-20T13:45Z · kiro-exafyltd-202610201041-ab5d · executing (round-4 review fixes)
`semantic_reviewer` round 4 (changes): 2 bypasses and a PR-body accuracy issue. All fixed, and repro4 Q1–Q2 are
refused:
- The approval is PLAN-SPAR's own: the newest `ci-plan-spar` commit must itself have written an approved state. An
  author writing `approved` after a non-converged round doesn't count, which also covers plan+build.
  `commitsInRange` now uses `--topo-order`. (Checked: PLAN-SPAR's converged commit on #4209, 76042a7f8, wrote
  `approved`.)
- The lane key in the merge message must match as a whole token (`namesLane`), so `cards/ab` doesn't satisfy
  `cards/a` and `x/p10` doesn't satisfy `x/p1`. This applies locally and in `ghMergeVerifier`.
- PR body corrected: validate's rules run in the Collab handoff step, which is still report-only in PR-GATE.

Tests: 42/42.

### 2026-10-20T14:05Z · kiro-exafyltd-202610201041-ab5d · executing (review round 5: approve; non-blocking finding fixed)
`semantic_reviewer` round 5: **approve**. Its one non-blocking finding is fixed: the `merge:` commit must also change at
least one of the lane's `paths` (checked locally via `git diff <sha>^1 <sha>`, and through `gh api` for the other repo).
So the plan commit that declared the lane, or an unrelated commit naming it, no longer counts. The legitimate PLAN-SPAR
flow (repro5 R1) still passes Lane scope. Tests: 43/43.
Next: an independent review entry from seat `jtadic` on the current head, then the owner's explicit merge instruction
(bootstrap merge 2).

### 2026-10-21T07:44Z · kiro-exafyltd-202610201041-ab5d · executing → in-review
T1–T3 are complete at head `ff06a9c3b` (PR #4210). The latest run of every check on that head is green: PR-GATE
(incl. Lane scope), Validator Check, STAGING-TESTS-REQUIRED, unit, impact scan, Phase 2B gates, frontend canonical
source. The first Validator Check run on that head (39416940593) failed only because `VALIDATION_PROFILE` was missing
from the PR body. The two later runs on the same head passed after the body was fixed. This entry changes no code,
scope or tests and does not address the non-blocking follow-ups (owner, 2026-10-20). The merge stays on hold until the
governance review is complete.

Known false positive: queue.mjs validate reports ready → in-review because the base lane file on main is ready and
executing happened only on this branch. Owner accepted it on 2026-10-20 (option 1). No validator change in this PR.

**Timestamp correction.** The headings of the earlier entries are dated ahead of the commits that added them. The
commit times are the authoritative record. The headings stay as written (the log is append-only):

| Entry heading | Added by | Commit time (UTC) |
|---|---|---|
| 11:35Z ready → executing | `bb2ae7a49` | 2026-10-20T10:59Z |
| 12:20Z executing (bypass review fixes) | `26753a2ba` | 2026-10-20T11:10Z |
| 12:55Z executing (round-2 fixes) | `bf5e83d6b` | 2026-10-20T11:18Z |
| 13:25Z executing (round-3 fixes) | `55bb876c0` | 2026-10-20T11:26Z |
| 13:45Z executing (round-4 fixes) | `3ff72d533` | 2026-10-20T11:30Z |
| 14:05Z executing (round-5) | `df6683376` | 2026-10-20T11:36Z |

Next: reviewer seat `jtadic` appends `review: approve|changes` on the new head of this branch (trailer `Collab-Review`,
front matter untouched). Then the owner gives an explicit per-PR merge instruction (bootstrap merge 2). The claim
`collab-claim/retire-claude-code/scope-rules` is released after this push.

### 2026-10-21T15:05Z · kiro-jtadic-202610201149-6b0b · review: approve
Reviewer seat `jtadic`, PR #4210, reviewed head `0c988732c` (code unchanged since `ff06a9c3b`; `0c988732c` changes
only this lane file: `executing → in-review` and the timestamp correction).
- Acceptance S1–S3 / AC-1…AC-7 met. Where the code is narrower than the plan (no `_plan` permission edits; `merge:`
  checked at `done`) the lane log records it under Decisions, and nothing grants more than the plan.
- `node --test scripts/collab/queue.test.mjs` 43/43 at `0c988732c`. Two pre-existing tests changed contract, both
  stricter; none removed.
- This PR's checker: Lane scope ✅. Collab handoff reports only `ready → in-review`, the known false positive the owner
  accepted on 2026-10-20 (option 1).
- Bootstrap: main's `queue.mjs` against this PR reports only the old "governance path … needs executor: claude"
  refusal (2 in Lane scope, 32 in Collab handoff) and nothing else.
- My non-blocking findings (GitHub comment 6290234780) stay open as follow-ups; the timestamp correction above
  addresses finding 1.
Note for the merger: GitHub reports the PR as conflicting with main (`scripts/collab/queue.mjs`,
`scripts/collab/queue.test.mjs`). Resolving that changes the head and the code, so it needs a fresh `jtadic` review on
the new head before merge.
