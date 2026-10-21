# Plan sparring — VTID-04946..04950 (record lives with VTID-04947)

- Plan hash (sha256 of text between plan markers, first 16 hex): `2aa889d12e06f4a2`
- Partner: plan-sparring-partner, class standard, 3 rounds, verdict **CONVERGED**
- **Owner approval (Gate 1): 2026-10-07, chat: "yes, go"**
- VTIDs: VTID-04946 (credential leak), VTID-04947 (P1 contract), VTID-04948 (P2 PR-GATE), VTID-04949 (P3 staging + prod safety), VTID-04950 (P4 platform parity)

---

# Plan: Two-gate autonomous delivery pipeline with mechanical damage protection

Repos: exafyltd/vitana-v1 (frontend) and exafyltd/vitana-platform (gateway + staging-verify).
Change class: **standard** (touches `.github/`, CLAUDE.md governance, skills). Delivered in 4 phases, one VTID per phase.

<!-- plan:begin -->
## Goals (owner, 2026-10-07)
- **G1 — Only two human questions per change.** Gate 1: the sparred plan. Gate 2: "Staging verified — ready for deployment to production?". Everything between them (VTID, code, tests, PR, merge, staging, fix-forward) runs without asking.
- **G2 — Machines, not trust, protect working code from AI mistakes/hallucinations.** Every claim a session makes must be backed by an executed check; a change cannot silently break, delete or weaken something that works.
- **G3 — Test results are never a discussion.** Pre-merge and post-staging suites must run and pass before the owner hears anything; Gate 2 reports only evidence links.

## Facts this plan is built on (verified in code, file:line)
F1. vitana-v1 PR checks today: full Vitest (`UNIT-TESTS.yml:36-39`), build only inside `i18n-check.yml:62-65` and `PREVIEW-DEPLOY-FRONTEND.yml:106`; **no `tsc` anywhere, no `typecheck` script; eslint runs with `|| echo` (non-blocking) at `i18n-check.yml:123`**; `tsconfig.app.json:25` strict false.
F2. `STAGING-TESTS-REQUIRED` only validates that `docs/validation/<VTID>/staging-tests.json` exists/parses (`vitana-platform scripts/ci/staging-verify/run.mjs:383-419`); it reads the PR title from the event payload, so a re-run after a retitle still fails (seen on vitana-v1 PR #1260).
F3. **No e2e runs pre-merge.** 43 `tests/e2e/staging/*.staging.spec.ts` run only post-merge via STAGING-VERIFY. The per-PR preview (`PREVIEW-DEPLOY-FRONTEND.yml`) uses staging gateway + prod Supabase (read-only use is permitted by rule 48 behind `staging-guard.ts`).
F4. 10 `scripts/*-regression.mjs` exist; **no workflow runs any of them**.
F5. STAGING-VERIFY (`vitana-platform/.github/workflows/STAGING-VERIFY.yml`) runs smoke + every change suite in the prod..commit range, reports to OASIS + job summary only (`:162-215`); **no commit status / PR comment** (`permissions: contents: read`, `:55-57`).
F6. Prod frontend deploy (`AWS-PROD-DEPLOY-FRONTEND.yml`) has **no rollback** (`:265` "deploy already happened; investigate"); gateway prod deploy has auto-rollback (`AWS-PROD-DEPLOY-GATEWAY.yml:1526-1550`).
F7. **16 `apply-*-migration.yml` in vitana-v1 apply SQL to the production DB on push to `main`, with no cutover gate** (e.g. `apply-mentions-migration.yml:16-22,44-63`).
F8. vitana-platform: `UNIT.yml` is a no-op (`:22-24`) though described as required; `CICDL-GATEWAY-CI.yml` build/typecheck/lint end in `|| echo` (`:88,96,100`). Gateway full Jest runs on PRs via `TEST-SUITE.yml:55-56` (includes the 04456/04465/04560 golden suites).
F9. Damage incidents with no mechanical guard yet: unrelated files swept into a PR (VTID-04879 `styles.css`, VTID-04915 `screens.json`/`wallet.json`); two individually green PRs broke main together (VTID-04219); guess-fixes during incidents (03647, 03674-03686 chain); unwired code with green unit tests (03531).
F10. The stops in Claude sessions come from text rules, not permissions (`.claude/settings.json` is `bypassPermissions` in both repos): platform CLAUDE.md IF-THEN 10 "IF uncertain → stop and ask" (`CLAUDE.md:442`), plan-sparring SKILL step 4 owner approval, plus no written durable authorization for merge/ledger writes. 
F11. Security: `tests/e2e/orb-preview.mjs:20-24` hardcodes an anon key and the e2e test user's email/password in the repo.

## Design

### A. Session contract (removes the asking) — Phase 1
A1. New section **"Autonomy contract (two gates)"** at the top of both CLAUDE.md files, unscoped:
- Gate 1 = one message: final sparred plan, every round's findings+answers, verdict, scope manifest, test plan. Owner "yes" (or any plain approval) is the **standing instruction** for every step below for that VTID. It is recorded as an approval line in `docs/validation/<VTID>/plan-sparring.md` (with the plan hash) and in the ledger row metadata. This record is an **audit trail, not the enforcement**; enforcement is the mechanical gates in B–D. `PR-GATE` checks that `plan-sparring.md` exists, has verdict CONVERGED/ESCALATED-approved and an owner-approval line; real DB enforcement comes when the `vtid_ledger` trigger moves log→enforce (out of scope).
- After Gate 1, without asking: allocate VTID(s) (with `-- sparring_record:`), set ledger in_progress/approved, branch, implement, run local checks, push, open PR, mark ready when the pre-merge gate is green, enable auto-merge, watch STAGING-VERIFY, fix forward.
- Gate 2 = one message built only from machine evidence (run URLs, counts, commit range prod..verified). "Yes" → dispatch the prod workflow pinned to the verified commit, then report the post-deploy check result.
- Replace platform IF-THEN 10 with: *uncertain about a fact → verify it read-only in code/data first; uncertain about intent inside the approved plan → choose the most conservative option and list it in Gate 2 under "Decisions taken"; stop and ask ONLY for: (a) scope outside the approved plan that the re-spar (A3) marks as material, (b) any production write not covered by the gates, (c) security/data-loss risk, (d) 3 failed fix-forward attempts on the same failure.*
- Never ask: VTID, branch names, merge timing, re-runs, fixing your own CI, test design.
A2. plan-sparring SKILL: step 4 becomes "Gate 1 message"; step 5 "allocate immediately on yes". Add **step 6: post-merge loop**. Mechanism: the Claude Code cloud session's `send_later` tool (claude-code-remote MCP server; a session-runtime tool, so it is not in either repo) schedules a self check-in. The session arms one about 8 min after merge (staging deploy is about 5–8 min), and re-arms every 5 min, capped at 2 h. Each check-in reads the `staging-verify` commit status (C1) and the STAGING-VERIFY run for the merge commit, then sends Gate 2 or fixes forward. Foreground `sleep` polling is blocked in this harness and is not used. **Fallback** if the session is gone or the 2 h cap is hit: the ready message is still produced by STAGING-VERIFY as the commit status plus a PR comment (C1). Any later session or the Operator Chat can send Gate 2 from that evidence; no work is lost.
A3. **Scope drift without asking:** if implementation needs files outside the scope manifest, the session updates `scope.json` and the plan, then runs one more sparring round with the same partner using the existing verdict vocabulary. CONVERGED → continue. NOT CONVERGED after the round cap → that is the only mid-flight question to the owner.

### B. Pre-merge gate (protects working code) — Phase 2, vitana-v1 first
One required workflow **`PR-GATE.yml`** (single required check `pr-gate`, blocking, no `|| echo`):
B1. **Scope guard**: `docs/validation/<VTID>/scope.json` (schema: `{ "vtid": str, "kind": "fix"|"feature"|"refactor"|"infra"|"docs", "paths": [glob,...], "weakens_tests": [{file,reason}], "red_green_exempt": [{file,reason}] }`). It is generated by `scripts/ci/vtid-scope.mjs init <VTID> --paths ...` from the plan's scope list at allocation, and kept separate from `staging-tests.json`, whose schema is owned by vitana-platform `lib.cjs`. Any changed file outside `paths` fails the check, which stops the VTID-04879/04915 class. **Always allowed without declaring**: `package.json` and `package-lock.json`, `docs/validation/<VTID>/**`, and the ratchet baseline files (only ever lowered). **Exempt**: files only touched by bot-authored commits (`github-actions[bot]`, e.g. I18N-PROPAGATE), and a fixed generated-files allowlist (`src/i18n/**`, `docs/SCREEN_INVENTORY.md`, nav-registry outputs, `docs/validation/<VTID>/**`).
B2. **Typecheck ratchet**: add `typecheck` script (`tsc --noEmit -p tsconfig.app.json`). The first implementation step measures today's error count. Granularity: per-file baseline if 500 or fewer files have errors, otherwise per-directory counts. The PR fails if any count rises; counts may only go down, and the baseline is auto-lowered on merge to main. Same ratchet for **eslint errors** (replaces the `|| echo`).
B3. **Build** (`npm run build`) must pass.
B4. **Full Vitest** + **all `scripts/*-regression.mjs`** (wired; any dead one is deleted in the same phase with a reason).
B5. **Test-weakening guard**: fail if a test file is deleted, `.skip`/`.only` added, or a file's assertion count (`expect(` occurrences) drops — unless `scope.json` declares `"weakens_tests": [{file, reason}]`, which is then printed in Gate 2.
B6. **Proof the new test proves the change (red→green), Vitest only**: for `"kind":"fix"`, CI copies the PR's new or changed **Vitest** test files onto a checkout of the base commit. At least one must fail there and pass on head. E2E specs are never part of this, since no base-code deployment exists. A test that cannot fail on base (e.g. restructured) is listed in `red_green_exempt` with a reason, which is printed in Gate 2. This stops tests that test nothing and fixes that fix nothing.
B7. **Pre-merge e2e on the PR preview**: a new job **inside `PREVIEW-DEPLOY-FRONTEND.yml`** runs after the deploy-and-verify step and reports as the check `preview-e2e`. It runs `smoke.staging.spec.ts` plus the VTID's own `*.staging.spec.ts` against `https://<PREVIEW_CF_DOMAIN>/pr-<n>/`. The preview SPA is built with `VITE_GATEWAY_URL=https://preview-aws-gateway.vitanaland.com/api/v1`, the staging gateway (`PREVIEW-DEPLOY-FRONTEND.yml:54,93`), and prod Supabase from `.env`. That is exactly the staging-verify environment, so rule 48 applies unchanged. `staging-guard.ts` is fetched from vitana-platform `scripts/ci/staging-verify/` with `PLATFORM_DISPATCH_TOKEN`, as `STAGING-TESTS-REQUIRED.yml:44` already does, and copied next to the specs; all writes are aborted. Concurrent PRs only read the shared staging gateway, so they don't interfere. The job is skipped for fork PRs, and a spec skipped for missing data counts as a skip, not a pass, and is listed in Gate 2.
B8. **Up-to-date merge**: auto-merge only on a head that includes current `main` (GitHub "require branches up to date" / or the gate re-runs on main-merge); stops VTID-04219.
B9. Fix F2: `check-pr` reads the title live via `gh api` instead of the event payload.
B10. Branch protection on `main` (both repos): required checks `pr-gate`, `change-suite`, and `Vitest (jsdom)` (frontend) or `TEST-SUITE` (gateway). **`preview-e2e` starts report-only and becomes required after the 3-day observation**; a neutral result counts as passing. Auto-merge is enabled. (Repo settings; done via API in the phase PR's runbook, recorded in docs.)

### C. Post-merge, staging — Phase 3
C1. STAGING-VERIFY additionally posts a **commit status** (`staging-verify`) on the verified commit in the service's repo and a comment on the merged PR (needs `statuses: write` via the existing `PLATFORM_DISPATCH_TOKEN`/app token). The session's post-merge loop (A2) reads this.
C2. Suites on staging: smoke plus every change suite in prod..commit (exists), **plus the full `tests/e2e/staging` set nightly**. This runs as a `schedule:` trigger on STAGING-VERIFY with input `full: true`, emitting `staging.verify.passed|failed` with `metadata.full=true`. Gate 2 also requires a full run younger than 24 h: the session checks the newest such OASIS event and, if it is too old, dispatches a full run before sending Gate 2. Data-dependent specs keep their `test.skip` on missing data.
C3. Fix-forward is automatic up to 3 attempts per failure; the 4th failure escalates with evidence.

### D. Production safety — Phase 3
D1. **Frontend prod auto-rollback**: capture the current task definition before deploy; on post-deploy check failure re-point the ECS service to it and wait until the bundle check passes (same pattern as gateway `:1526-1550`, same kill switch variable).
D2. **Migrations stop auto-applying to prod on merge**:
- Remove the `push` trigger from the 16 `apply-*-migration.yml`, making them dispatch-only.
- **Pre-merge (PR-GATE)**, two lines of defence for every new or changed `supabase/migrations/*.sql`:
  (a) **Transactional by default**: the file is wrapped in `BEGIN; … COMMIT;`. Postgres DDL is transactional, so if the file aborts, nothing of it stays applied.
  (b) **Idempotent always**: `CREATE OR REPLACE`, `IF [NOT] EXISTS`, `DROP … IF EXISTS`, or guarded `DO $$ … $$` blocks, so re-dispatching after any failure is safe.
  - Files that need non-transactional DDL (`CREATE INDEX CONCURRENTLY`, `ALTER TYPE … ADD VALUE`) are declared in `scope.json` as `"non_transactional": [file]`. They must **not** have the wrapper, must still pass (b), and Gate 2 flags them. For these files, partial apply is a residual risk that is recoverable by idempotent re-dispatch.
  - A lint step enforces (a) and (b) and the declaration.
  - **Apply test**: a `services:` container with the `supabase/postgres` image (Supabase roles and extensions), plus a minimal `auth` stub schema (`auth.users`, `auth.uid()`, `auth.jwt()`) seeded first. All repo migrations are then applied in filename order with `psql -v ON_ERROR_STOP=1`. No Supabase CLI stack.
  - Whether the Management API honours the wrapper is not tested against production (absolute rule). It rests on Postgres semantics plus (b) as the fallback.
- **Gate 2**: lists the migrations in the release in filename order. After "yes", the session dispatches them in that order **before** the frontend deploy, and verifies each workflow's schema check. A failed migration stops the line: no frontend deploy, and the owner gets the evidence.
- Schema parity: the ephemeral DB only proves the SQL is valid against the repo's migration history. Drift from production is covered by platform `MIGRATION-DRIFT-CHECK`; this residual risk is accepted.
D3. (moved) Hardcoded credentials in `tests/e2e/orb-preview.mjs` are a separate security VTID, done immediately and outside these phases (see Out of scope).

### E. Platform parity — Phase 4
E1. Replace no-op `UNIT.yml` with a real check or delete it; remove `|| echo` from `CICDL-GATEWAY-CI.yml` (ratchet like B2).
E2. Apply B1/B5/B6/B8 to gateway PRs (same scripts, shared from `scripts/ci/`).
E3. Commit pin + rollback for the other `AWS-PROD-DEPLOY-*.yml` (autopilot-executor, oasis-operator/projector, orb-agent, verification-engine).

### Rollout & safety of the rollout itself
- Each new check ships first in **report-only** mode for 3 days on real PRs (posts results, does not block), then flips to required. Ratchet baselines are generated from `main` at the flip.
- Every gate has a documented kill switch (repo variable) usable only by the owner.
- Measurement: count of owner questions per VTID and post-merge regressions (staging-verify failures, rollbacks) before/after, reported weekly in OASIS.

## VTIDs and sparring
One plan with one sparring record. Four phase VTIDs (P1 session contract, P2 pre-merge gate, P3 staging + production safety, P4 platform parity) all reference the same sparring record and plan hash. The `vtid_ledger` trigger is in `log` mode, so this cannot block allocation; the gate's log row will show 4 allocations on one record. Gate 2 is asked once per phase.

## Out of scope
- Credential leak in `tests/e2e/orb-preview.mjs:20-25` (anon key, test-user email and password): its own security VTID, done right after Gate 1. Remove the secrets, read them from env, rotate the password, and update the `TEST_USER_*` secrets used by STAGING-VERIFY.
- Switching the plan-sparring DB gate from `log` to `enforce` (separate owner decision).
- An isolated staging Supabase project (would allow write tests; separate infra decision).
- Changing Dev Autopilot / operator approval-hold behaviour.
<!-- plan:end -->


## Planner responses (round 1)
- **F1 (blocker) ACCEPTED**: B6 is now Vitest-only, never e2e, with a `red_green_exempt` escape hatch that is printed in Gate 2.
- **F2 (blocker) REJECTED, with evidence and a fallback added**: `send_later` is a tool of the Claude Code cloud session runtime (claude-code-remote MCP server, "Schedule a message to be delivered back into THIS SESSION at a future time"). It is not repo code, which is why grepping the repos finds nothing; this planner session has it loaded. Foreground `sleep` polling is blocked in this harness, so it is not used. A2 now names the mechanism, cadence, cap, and a fallback: STAGING-VERIFY's own commit status and PR comment (C1), so a lost session loses nothing.
- **F3 (major) ACCEPTED**: B7 now names the gateway (staging, `PREVIEW-DEPLOY-FRONTEND.yml:54,93`) and where the guard comes from (fetched like `STAGING-TESTS-REQUIRED.yml:44`). It is a job inside the preview workflow. Same environment and rule 48 as staging-verify. Kept in Phase 2: the backend is the existing staging one, so no new Supabase project is needed.
- **F4 (major) ACCEPTED (b) + partial (a)**: the approval is now called an audit trail. PR-GATE checks for the sparring record and owner-approval line; DB enforcement waits for log→enforce.
- **F5 (major) ACCEPTED**: `scope.json` schema defined; generated by `vtid-scope.mjs`; bot-commit and generated-file exemptions defined. Kept separate from `staging-tests.json` because that schema is validated by platform `lib.cjs`.
- **F6 (major) ACCEPTED**: the migration flow is specified end to end (transactional files, ephemeral apply, Gate 2 ordering, dispatched before the frontend deploy, stop-the-line on failure). Drift residual is covered by MIGRATION-DRIFT-CHECK.
- **F7 (major) ACCEPTED**: one record, four VTIDs, same plan hash; log mode cannot block.
- **F8 ACCEPTED**: the baseline is measured first, with directory granularity if there are more than 500 files.
- **F9 ACCEPTED**: nightly full run via a STAGING-VERIFY schedule with `full: true`, and an OASIS freshness check.
- **F10 ACCEPTED**: split into its own security VTID (Out of scope), still done right after Gate 1.
- **F11 ACCEPTED**: A3 uses the existing CONVERGED/NOT CONVERGED vocabulary.
- **Q2**: the staging gateway (see F3).
- **Q3**: bot-authored commits are exempt (see B1).
- **Q4**: partial success is impossible because each file is one transactional call (see D2).


## Planner responses (round 2)
- **F2 residual (local sessions)**: ACCEPTED. A local session has no `send_later`, so it ends its turn after merge and Gate 2 comes from the C1 commit status and PR comment via the next session or Operator Chat. Noted in A2 by reference.
- **F12 (major) ACCEPTED**: the rule is split into (a) transactional by default, (b) idempotent always, and declared non-transactional files with no wrapper, flagged in Gate 2. The partial-apply residual is stated and mitigated by idempotent re-dispatch. Q2: not testable against production under the absolute rule, so we rely on Postgres semantics with (b) as the fallback.
- **F13 (major) ACCEPTED**: report-only first, then required (stated in B10). A gateway health pre-check gives a neutral result instead of failing. Path filter. 10 min timeout.
- **F14 ACCEPTED**: always-allowed paths added.
- **F15 ACCEPTED (modified)**: a postgres service container instead of `supabase start`. It uses the `supabase/postgres` image plus an `auth` stub, because plain postgres lacks the Supabase roles, extensions and `auth.*` that the migrations reference.

## Planner responses (round 3)
- **F16 ACCEPTED (deferred)**: cache a migration-checkpoint `pg_dump`, refreshed weekly, as a Phase 3 optimization once the apply step exceeds 3 minutes.
- **F17 ACCEPTED**: B5 counts test cases (`it(`/`test(`) as well as `expect(`. A file is flagged only when its test-case count drops, or its assertion count drops while the test-case count stays the same.

## Verdict
**CONVERGED** after 3 rounds (standard cap). 17 findings: 2 blockers, 7 majors, 8 minors. 16 accepted. 1 rejected with evidence (the F2 premise); a fallback was still added, and the partner closed it.
