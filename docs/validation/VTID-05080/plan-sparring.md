# Plan sparring record - VTID-05080

Plan hash (sha256 of the text between the plan markers, as approved): `43887e1d5eaf79e2f4d426d793f97a867b2c076be02cbdfd984f7341643841e9`. Partner: plan-sparring-partner (read-only, independent, Claude Opus, run through the read-only fallback agent because the named agent type was not loaded when round 1 started), 3 rounds, standard class. Verdict: ESCALATED at the round cap (all earlier findings closed; two new majors from round 3, N6/N7, were folded into the plan as amendment C4' and not re-reviewed). Owner approval: in session 2026-10-12, "Yes, approved. Go ahead." in answer to the Gate 1 message (final plan, the three rounds, the files, the test plan, decisions D1-D3 with the recommended defaults). The gate is in log mode; no database sparring record exists for this session, so the VTID was allocated with `p_sparring_id` null and the record referenced by comment; the session is recorded here and in the ledger row's metadata.

## Round 1 (partner findings, summary)
F1 blocker: wrong root cause; bot PR fails STAGING-TESTS-REQUIRED (no VTID in title, run.mjs:388-393). F2 major: pushes made with GITHUB_TOKEN start no workflows. F3 major: stale PR when a later run finds no diff. F4 major: no concurrency control. F5-F7 minor.

## Round 2
F1 stayed open (N1: the named change suite proved nothing, N2: VALIDATOR-CHECK also fails the bot PR). N3 major: `last_synced` yields a date-only diff on almost every trigger. N4 major: checkout with an empty token would break no-diff runs. N5 major: the standing VTID would be terminalised by the first merge.

## Round 3
All earlier findings closed. New: N6 major (a default-run sync check turns every gateway PR red), N7 major (STAGING-VERIFY would run the sync check against later commits). Fix adopted: C4'.

## Planner responses
Every finding was ACCEPTED. The full plan and responses are the text below.

---

# Plan: REGEN-SCREENS-CATALOG — one rolling PR that can run checks and merge, without daily no-op PRs

Change class: **standard** (touches `.github/workflows/`, excluded from `light`)
Scope: `.github/workflows/REGEN-SCREENS-CATALOG.yml`; `services/gateway/scripts/regen-screens-catalog.mjs` (last_synced only, see C1);
one new jest test + one extracted shell helper under `scripts/ci/`; `docs/validation/<VTID>/` (acceptance.md with AC/TEST lines, commands.log, outputs/, staging-tests.json, plan-sparring.md); `docs/CHANGELOG.md` row.

<!-- plan:begin -->
## Problem (verified in code, rounds 1-2)
`REGEN-SCREENS-CATALOG.yml` runs on pushes to main touching `app.js`, `services/gateway/specs/screens-overrides.json` or the regen script (`:15-24`), on
`repository_dispatch` from vitana-v1 and manually. Each run with a diff creates `auto/screens-catalog-<UTC>`, opens a NEW PR and enables auto-merge (`:84,87-96`).
Duplicates: every run diffs against its own checkout of main, which does not contain the still-open earlier PR. (Merging a bot PR does not re-trigger the workflow.)
Why none merge (only #998 ever did, 2026-04-30; eight closed unmerged):
- B1. The PR touches gateway deploy paths; STAGING-TESTS-REQUIRED fails it because the title has no VTID (`run.mjs:388-393`, `lib.cjs:39-40,105-112`).
- B2. PRs and pushes made with GITHUB_TOKEN start no workflows, so no checks run (#3978 had 0 statuses); `checkout@v4` persists GITHUB_TOKEN credentials.
- B3. VALIDATOR-CHECK runs on the PR (it touches `navigation-config.js`, `VALIDATOR-CHECK.yml:32-37`) and requires body markers + an evidence pack (`:94-106,146-173`).
- B4. `regen-screens-catalog.mjs:424-430,442` writes `last_synced: <today>` and compares bytes, so any run on a new day yields a diff that changes only the date. Today's
  design would open or update a PR, re-run CI and redeploy staging for a date bump on almost every app.js change.

## Change
C1 (regen script, minimal): build the output once with `last_synced` equal to the value already in the file; if bytes equal the current files there is no change;
  only when something else differs set `last_synced` to today. A date-only diff can no longer exist. `--check` therefore stays deterministic.
C2 (workflow):
  1. `concurrency: { group: regen-screens-catalog, cancel-in-progress: false }`.
  2. Checkout stays on the default token with `persist-credentials: false`. The no-diff path and its cleanup need no PAT.
  3. Push/PR step (only when `changed == 'true'`): fail loudly with an explanation if `SCREENS_CATALOG_PR_TOKEN` is empty. Otherwise set the push remote URL to use that PAT
     so the push and the PR-creating `gh` calls use the PAT and start workflows. One stable branch `auto/screens-catalog`: `git checkout -B`, commit, then
     `git push --force-with-lease=auto/screens-catalog:<sha>` where `<sha>` is `git ls-remote` output, or EMPTY when the branch does not exist (meaning "must not exist").
  4. Open a PR only when `gh pr list --head auto/screens-catalog --base main --state open` returns 0. API failure -> warning. Auto-merge failure -> warning.
     Title: `chore(screens): auto-regenerate catalog from sources (DEV-COMHU-0413) (VTID-<STANDING>)`. The commit message carries the same VTID.
     Body carries every VALIDATOR-CHECK marker: `VTID`, `VALIDATION_PROFILE: gateway_backend`, `SCOPE_ALLOWLIST` (the two generated files), `ACCEPTANCE:` (the standing
     VTID's acceptance.md), `MERGE_PAYLOAD_PREVIEW`, `OASIS_IMPACT: no`, and `VTID_AUTO_CLOSE: no` (C3).
  5. Step on `changed == 'false'`: if an open PR exists on `auto/screens-catalog`, close it with a comment and delete the branch, using GITHUB_TOKEN (no workflow start needed).
  6. The shell logic of steps 3-5 lives in `scripts/ci/regen-screens-catalog-pr.sh` (called by the workflow) so it can be tested locally.
C3 (governance): the VTID allocated for THIS work is also the standing "automated screens-catalog sync" VTID named in the title. The bot PR body sets `VTID_AUTO_CLOSE: no`
  and this workflow PR sets it too, so VTID-AUTO-CLOSE (`VTID-AUTO-CLOSE.yml:3-11`) never terminalises it. The first line of its ledger description states it is a standing, never-terminal VTID.
C4' (round-3 amendment, supersedes the placement in C4): the new `--check` jest test is OPT-IN (`describe.skip` unless `REGEN_SCREENS_CHECK=1`, exposed as
  `npm run test:screens-catalog-sync`) so it never turns ordinary gateway PRs red and never blocks other people's Gate 2. It runs inside the REGEN workflow before the push and in the
  bot PR's CI. `staging-tests.json` holds only checks independent of sync timing: the existing 04986 test, a jest wrapper around `validate-dev-frontend-spec.mjs`, and an http GET of
  `/command-hub/navigation-config.js` expecting 200. Helper ordering: run `git ls-remote` after the PAT remote URL is set; delete the branch via `gh api -X DELETE` with GITHUB_TOKEN; no `set -x`.
  Main today: `--check` reports drift that is ONLY `last_synced` (2026-10-08 -> 2026-10-12, one line), so this PR commits no catalog drift; C1 removes that class of diff.
C4 (evidence/tests, rule 47): new jest test `services/gateway/test/vtid-<STANDING>-regen-screens-catalog-check.test.ts` runs
  `node scripts/regen-screens-catalog.mjs --check` with `VITANA_V1_ROOT` pointing at a missing directory (existing ADMIN rows are kept, `regen-screens-catalog.mjs:298-303`),
  so the DEV rows, `navigation-config.js` and the overrides are verified against main's own sources; plus a test of the C1 rule (date-only change is "no change"), and tests of the
  extracted shell helper against a local bare repo with a fake `gh` (no PR / PR open / no-diff close / empty lease / merged-then-rerun). `staging-tests.json` lists this new test first
  and `vtid-04986-screen-inventory-in-sync.test.ts` second. `acceptance.md` has AC entries each with a `TEST:` line pointing at them.

## Owner decisions at Gate 1
D1. Bot catalog PRs auto-merge under the standing VTID (recommended), or review-only (drop `gh pr merge --auto`; one rolling PR stays open until a human merges it).
D2. Does the repo secret `SCREENS_CATALOG_PR_TOKEN` exist (fine-grained PAT or GitHub App token with contents + pull-requests write)? If not, create it. Without it no check can run on
    a bot PR, the new step fails loudly on a diff, and the catalog cannot be updated by the bot.
D3. A standing, never-terminal VTID for automated catalog syncs (a new governance pattern).

## Edge cases
- PR merged but branch kept: next run force-pushes from main, list returns 0, a new PR opens; a closed PR with a force-pushed branch is never re-opened by script.
- Concurrent runs: serialised; the lease fails visibly if the branch moved between ls-remote and push.
- First run / after step 5 deleted the branch: empty lease.
- Branch protection / which checks are required on main is not readable from the session; acceptance criteria prove each gate on the real PR instead of assuming it.

## Out of scope
STAGING-TESTS-REQUIRED / VALIDATOR-CHECK / STAGING-VERIFY logic (no bot exemption, rule 47 unchanged), other regen outputs, historical duplicates (already closed).

## Test plan
- Local: `actionlint` + YAML parse; `bash -n` and shellcheck on the helper; the C4 jest tests; `vtid-04986-screen-inventory-in-sync.test.ts`; `run.mjs check-pr` on the manifest; gateway `tsc` untouched.
- Real PR behaviour is proven on the first natural bot PR after merge, which writes only a bot branch and a PR (no database, no production, no write to main by the session). No synthetic main change is made.
  Accept when that PR shows (1) one open PR on `auto/screens-catalog`; (2) check runs on its head (B2); (3) STAGING-TESTS-REQUIRED and VALIDATOR-CHECK pass (B1, B3);
  (4) a following trigger moves its head without opening a second PR; (5) with D1 = auto-merge it merges and STAGING-VERIFY passes on the merge commit, and the VTID stays open.
- Until a natural diff occurs, B1-B3 are verified by the local tests and by `check-pr` / validator scripts run against a rendered copy of the PR body and title.
<!-- plan:end -->

## Planner responses (round 1)
(unchanged; F1-F7 accepted, see round 2 file history) F1 root cause rewritten; F2 token handling; F3 close-on-no-diff; F4 concurrency + lease; F5 edge cases; F6 test plan; F7 owner question.

## Planner responses (round 2)
- N1 [blocker] ACCEPTED. The named 04986 test only asserts four retired tab ids; it proves nothing about sync. C4 adds a real `--check` test (missing v1 root keeps ADMIN rows) and keeps 04986 as second entry.
- N2 [blocker] ACCEPTED. B3 added; C2.4 puts every VALIDATOR-CHECK marker in the PR body with profile `gateway_backend`; C4 acceptance.md has AC/TEST lines; acceptance (3) includes VALIDATOR-CHECK.
- N3 [major] ACCEPTED. The regen script's scope is expanded (C1): keep the existing `last_synced` unless something else changed. Verified at `regen-screens-catalog.mjs:424,430,442`.
- N4 [major] ACCEPTED. Default checkout with `persist-credentials: false`; PAT only in the push/PR step; step 5 uses GITHUB_TOKEN; a missing secret cannot break no-diff runs.
- N5 [major, governance] ACCEPTED. C3 + `VTID_AUTO_CLOSE: no` on both PRs; new owner decision D3.
- F4 residual (empty lease) ACCEPTED, stated in C2.3. F6 residual (how to create a diff): no synthetic diff; natural first diff plus local tests (see Test plan).
- Q1: not readable from the session; plan proves each gate on the real PR. Q2: yes, C1 is in scope. Q3: see Test plan, no write to main.

