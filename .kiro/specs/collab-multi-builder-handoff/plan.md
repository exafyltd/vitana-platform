# Plan — collab-multi-builder-handoff

Let several sessions of a lane's own builder seat work on the lane **one after another**, without weakening lane
ownership, review separation, scope or tests.

<!-- plan:begin -->
## Goal (owner, 2026-10-22)
"Fix Collab handoff first. Allow multiple legitimate Kiro builder sessions to work sequentially on the same lane,
without weakening lane ownership or review separation." No special case for any PR. Governance-only change.
Pinned: `exafyltd/vitana-platform@5f76b3ab2`.

## Today (verified in code)
- `validateRange` (`scripts/collab/queue.mjs:528`) collects every `Collab-Session` of the commits carrying a lane's
  `Collab-Lane` (`sessionsByLane`, `:564`–`:573`; `pm-agent` excluded). More than one session fails: "commits from
  N sessions … — one session per lane" (`:595`). `claimed_by` is compared with the **first** session of the set
  (`:602`–`:603`).
- Commits come from `commitsInRange` (`:490`, `git log --no-merges`), so merges of `main` into a lane branch are not
  counted. Review entries carry `Collab-Review`, not `Collab-Lane`, and are not counted either.
- Seat ownership is a separate rule: `scopeCheck` refuses a commit on the lane file from a session whose seat
  (`seatOf`, `:69`) is not the lane's `seat` (`:715`); lane permissions come from the base revision (`PERM`, `:679`);
  `validateLane` requires `reviewer_seat` ≠ `seat` (`:227`).
- Claims are refs pushed without force (`claim`, `:874`), so two sessions can never hold a lane at once; another
  session's claim is released only by its holder or after 24 h with `--stale` (`release`, `:893`).
- Seat automations start a **new session id on every run**, so a lane built or re-verified over several runs collects
  several sessions of the same seat and fails Collab handoff even though only one ran at a time. Collab handoff now
  counts toward the merge (§7b), so such a lane cannot land. Example: commerce-step-owner/gateway-step-owner (#4198),
  five `kiro-exafy-…` sessions, 2026-10-19 → 2026-10-21.

## Premise checks (files to read)
Each premise above is checkable by reading these files at the pinned ref:
1. `scripts/collab/queue.mjs` lines 560–605 — `sessionsByLane`, the "one session per lane" error, the `claimed_by` check.
2. `scripts/collab/queue.mjs` lines 488–500 — `commitsInRange` (`git log --no-merges`, the trailers read).
3. `scripts/collab/queue.mjs` lines 60–70 and 704–720 — `SESSION_RE`, `seatOf`, and `scopeCheck`'s seat rule.
4. `scripts/collab/queue.mjs` lines 674–690 — `PERM` and the base-revision fold-back.
5. `scripts/collab/queue.mjs` lines 870–910 — `claim` (no-force push) and `release` (holder or 24 h `--stale`).
6. `scripts/collab/protected-gate-files.json` — `scripts/collab/queue.mjs` is listed.
7. `scripts/collab/queue.test.mjs` lines 88–125 — the fixture helpers (`fixture`, `commit` with trailers, `seedSpec`).

## Change (lane `sequential-builders`, `scripts/collab/queue.mjs` only)
Replace the single-session rule in `validateRange` with this one. A lane's **builder sessions** are the sessions of
the commits in range whose `Collab-Lane` is the lane, excluding `pm-agent` and `ci-plan-spar` (as today).
1. **One session:** unchanged — pass, and `claimed_by` (if set) must equal it.
2. **Two or more sessions** pass only when ALL hold; each failing rule is its own error message:
   a. **Same declared seat.** The lane declares `seat` (read from the merge-base revision of the lane file when it exists
      there, else head — the base-revision rule) and every builder session is a seat session whose `seatOf` equals it.
      A session without a seat (`kiro-YYYYMMDDHHMM-…`, `session_…`, `agent-…`) fails, so the old single-session rule
      still governs Claude, reviewer-agent and seat-less sessions.
   b. **No reviewer as builder.** No builder session equals `reviewer_seat`'s seat, is a reviewer-agent id, or has
      written a review entry on this lane (a `Collab-Review: <lane>` commit in range, or a review entry header
      `### … · <session> · review…` in the lane file at head).
   c. **No overlap.** In commit order (`--topo-order --reverse`), each session's commits form one contiguous run
      (A A B B passes; A B A fails), and each run starts no earlier (committer date) than the previous run ends.
   d. **Every takeover logged.** Every builder session is named in the lane log at head — as an entry author
      (`### <time> · <session> · …`) or in an entry's text written by a later session of the same seat.
   e. **Current holder.** `claimed_by` (if set) equals the **last** builder session.
3. Unchanged: the claim mechanism (one holder at a time, release or the 24 h `--stale` rule), `scopeCheck` (paths,
   governance, protected files, seat of lane-file commits, base-revision `PERM`), the reviewer rules and `Collab-Verdict`
   requirements, trailers on every commit, branch naming, and every test and CI gate. No path, permission or
   seat-field change; nothing special-cased by slug, lane or PR.

## Tests (`scripts/collab/queue.test.mjs`, fixture repos as the existing `validateRange` tests)
Each new case is written first and recorded failing on `origin/main` where today's behaviour differs (case 1).
1. Builder session A (seat s) commits, logs a release; B (seat s) logs the takeover and commits; `claimed_by` B → pass.
2. A and B interleave (A, B, A) → fail (overlap).
3. A (seat s) then C from another seat t continues → fail (seat), and `scopeCheck` still fails on C's lane-file commit.
4. A (seat s) then a session of `reviewer_seat` continues with `Collab-Lane` → fail; also a reviewer-agent id → fail;
   also a seat-s session that already wrote a review entry → fail.
5. Sequential same-seat builders where one commit changes a file outside the lane's `paths` → `scopeCheck` fails.
6. A single-builder lane → pass (unchanged), incl. the `claimed_by` check.
Plus: B not named in the lane log → fail (takeover not logged); `claimed_by` = A after B took over → fail.
Run: `node --test scripts/collab/queue.test.mjs scripts/collab/plan-spar.test.mjs scripts/collab/plan-driver.test.mjs`.
Change suite `docs/validation/<VTID>/staging-tests.json`: one `existing` entry running those suites (CI script only;
nothing on staging changes).

## Lane and review
- `sequential-builders` — `executor: claude` because `scripts/collab/queue.mjs` is a protected gate file (`scopeCheck`
  refuses it for any other executor; `scripts/collab/protected-gate-files.json`); built by the exceptions seat
  `exafyltd` while Claude Code is unavailable (§7), so `seat: exafyltd`. Reviewer `reviewer_seat: jtadic`: the reviewer
  agent reviews only `executor: kiro` lanes (`validateLane`), as with the merged `collab-queue-perf/queue-batch-read`
  lane (`executor: claude`, seat reviewer). Being a protected file, it merges only with the normal protected-file
  review on the current head: a legacy Claude review, or the owner's explicit instruction naming the PR, plus every
  check green.
- Paths: `scripts/collab/queue.mjs`, `scripts/collab/queue.test.mjs`, `docs/validation/**`.

## Out of scope
The rule text (`collaboration.md` already says one claim holder per lane, which this keeps); claim or release
behaviour; scope-check; any other check; #4198 itself (it is re-synced after this merges and judged by the general
rule like any lane).

## Risks
- A looser check lets two builders work at once: prevented by (c) and by the claim ref; only one session can hold the
  claim, and interleaved commits fail.
- A wrong-seat or reviewer session sneaks in as a builder: (a) and (b), plus `scopeCheck`'s seat rule.
- A takeover is invisible: (d) requires every builder session in the lane log.
<!-- plan:end -->
