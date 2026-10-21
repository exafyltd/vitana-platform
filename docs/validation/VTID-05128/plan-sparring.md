# Plan sparring record — VTID-05128 (STAGING-VERIFY full-run results reach OASIS)

- Plan hash (sha256 of the text between the plan markers): `d7ccde234ac5bb128c519ca9f4dad470372cda36485f2aa90cf8264956746486`
- Partner: `plan-sparring-partner` agent (independent, read-only), Claude Code session https://claude.ai/code/session_016Y9ADzi2tLSdr8pKgai5sB
- Rounds: 2 — round 1: 2 majors (F2 YAML extraction, F3 trimming contract), 4 minors; round 2: all closed, no new findings
- Verdict: **CONVERGED**
- Owner approval: 2026-10-13, "Yes" in the Claude Code session above (Gate 1)

---

# Plan: STAGING-VERIFY full runs never reach OASIS ("Argument list too long")

**Change class:** standard (touches `.github/workflows/STAGING-VERIFY.yml`)
**Repo:** exafyltd/vitana-platform

<!-- plan:begin -->

## Problem (evidence)
`STAGING-VERIFY.yml` → job `verify` → step "Record result in OASIS" builds the whole OASIS
event as a shell variable and passes it to curl as ONE argv argument: `curl ... -d "$BODY"`
(`.github/workflows/STAGING-VERIFY.yml` ~line 212–216). Linux caps a single argument at
MAX_ARG_STRLEN = 128 KiB. A full run (`full=true`, VTID-04949) carries ~1,060 results in
`metadata.results`, so the body exceeds the cap and bash fails with
`/usr/bin/curl: Argument list too long` (exit 126). Seen on run 38321374295, attempts 1 and 2
(2026-10-12 23:52 and 2026-10-13 00:19 UTC). Consequences:
- full-run results never reach `oasis_events` (`staging.verify.*` with `metadata.full=true`);
- the Gate 2 precondition "newest full run under 24 h" (plan-sparring skill §6, VTID-04949)
  cannot see any full run, passed or failed; the Operator Chat ready/failed message is lost;
- the step goes red for a recording reason, masking the real verdict in the job summary.
Normal (non-full) runs (~20–25 results) are below the cap and are unaffected.

## Fix
1. Move the step's logic into a standalone script `scripts/ci/staging-verify/record-oasis.sh`
   (sparring F2). The workflow step becomes
   `bash runner/scripts/ci/staging-verify/record-oasis.sh` with the same env
   (`SUPABASE_URL`, `SUPABASE_SVC`, `RESULTS`, `RUN_URL`, `SERVICE`, `SHA`) — `runner/` is the
   existing checkout of vitana-platform main that already holds `run.mjs`.
2. The script writes the JSON body to a file (`mktemp` under `$RUNNER_TEMP`, or `/tmp` when unset)
   with the SAME two jq programs as today (results present / runner crashed), and sends it with
   `curl -fsS --data-binary @"$BODY_FILE"` — the body never passes through argv, so the 128 KiB
   per-argument limit no longer applies. The echo line reads the topic with
   `jq -r .topic "$BODY_FILE"`; today's `echo "$BODY" | jq` works (bash builtin, no execve) and
   is changed only for consistency and to avoid expanding a large string (sparring F1).
3. Event content is unchanged (same jq programs), so every consumer reads the same shape.
4. No trimming and no size threshold (sparring F3): with the body sent from a file there is no
   local ceiling. If PostgREST ever rejected a body as too large, curl -f fails the step loudly
   (as today) and the full result stays in the run artifact ("Keep the evidence") — no new
   payload shape for any consumer to handle.
5. Nothing else in the workflow changes (runner, report job, triggers, concurrency, secrets).

## Out of scope (noted, not changed)
- The flaky `fetch failed`/ECONNRESET results and staging being redeployed mid-run during a
  30-minute full run (attempt 2 failed "staging still serves the commit after the run" because
  another merge deployed). Separate problem, separate plan if wanted.
- Other workflows using `-d "$VAR"`: grep found none posting result-sized payloads; not touched.

## Test plan
- New `node:test` suite `scripts/ci/staging-verify/record-oasis.test.cjs` (picked up by the
  required `unit` check, UNIT.yml, which runs every `scripts/**/*.test.cjs`), testing the script
  directly — no YAML extraction (sparring F2):
  - a generated `results.json` with 1,100 results (body well over 128 KiB) and a stub `curl`
    first on PATH that records its argv and copies the `@file` payload: exit 0; no argv
    argument over 128 KiB; the posted body parses with `topic: staging.verify.failed`,
    `metadata.full: true`, all 1,100 results, `run_url`, `workflow: "STAGING-VERIFY.yml"`;
  - a passed results.json → `topic: staging.verify.passed`, `status: success`;
  - no results.json (runner crashed) → `staging.verify.failed` with `crashed: true`;
  - missing `SUPABASE_URL`/`SUPABASE_SVC` → non-zero exit with the existing error message;
  - curl failing (stub exits 22) → the script exits non-zero (failure stays loud).
- Workflow guard (sparring F6): the same suite asserts the "Record result in OASIS" step calls
  `record-oasis.sh` and that `.github/workflows/STAGING-VERIFY.yml` contains no
  `-d "$BODY"`. (No "old script fails" assertion — that would test the kernel, not our code.)
- Existing `vtid-04715-staging-verify-deployed-commit.test.ts` and
  `scripts/ci/staging-verify/lib.test.cjs` stay green.
- Staging: this change deploys nothing (workflow + script) → no Gate 2; done when merged with
  green checks. Proof after merge: dispatch one full run (`STAGING-VERIFY.yml`, `full=true`) and
  confirm read-only that `oasis_events` has a `staging.verify.*` row with `metadata.full=true`
  for it (pass or fail — recording is what this fixes).

## Scope (files)
`.github/workflows/STAGING-VERIFY.yml` (one step), new `scripts/ci/staging-verify/record-oasis.sh`,
new `scripts/ci/staging-verify/record-oasis.test.cjs`, `docs/validation/<VTID>/` (plan record,
acceptance, commands.log, outputs).

<!-- plan:end -->

## Round 1 — Planner responses
- **F1 [minor] echo line** — ACCEPTED. Fix §2 now says the echo works today (bash builtin) and is changed only for consistency / to avoid expanding a large string.
- **F2 [major] YAML extraction** — ACCEPTED. Logic moves to `scripts/ci/staging-verify/record-oasis.sh`; the workflow step calls it; the test runs the script directly (node:test, picked up by the required `unit` check).
- **F3 [major] trimming contract / magic 900 KB** — ACCEPTED (your option: drop it). No trimming, no threshold; with a file body there is no local ceiling, a PostgREST rejection stays a loud failure, the artifact keeps the evidence, no new payload shape.
- **F4 [minor] MAX_ARG_STRLEN precision** — ACKNOWLEDGED, no change.
- **F5 [minor] no Gate 2** — ACKNOWLEDGED (agreed, workflow-only change).
- **F6 [minor] backwards regression guard** — ACCEPTED. Dropped the "old script fails" assertion; added a workflow-text guard (no `-d "$BODY"`, step calls the script) plus the success test.
- **Q1 consumers of metadata.results** — moot after F3: the payload shape is unchanged.
