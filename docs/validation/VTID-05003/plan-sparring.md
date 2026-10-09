# VTID-05003 — plan sparring record

- Plan Sparring Gate (VTID-04868); partner: plan-sparring-partner (independent, read-only).
- Change class: standard. Rounds: 2. **Verdict: CONVERGED.**
- Final plan hash: `f6d41bb41e37bf0bc697747d36af553a6bab74f90944d3fc1c6a844451ba65b7`
- **Owner approval:** 2026-10-09, Gate 1 "Yes" in the Claude Code session (https://claude.ai/code/session_015p5xCULCm9qpV7cEwboKEr).

## Round 1 findings
- F1 [major] `/kiro/status` has no per-user context; a runner call makes it async with new failure modes.
- F2 [major] `_kiroStatusRequested` one-shot guard blocks the re-read on a new thread.
- F3 [major] in-memory credit state is per gateway task.
- F4 [minor] wrapper vs the staging deploy workflow. F5 [minor] event naming. F6 [minor] pre-fill mechanism unspecified. F7 [minor] prod image tag convention unspecified.
- Questions: key-linked caching; accepted limitation for F3; path of the VTID-04999 guard test.

## Round 2
All findings closed; no new blockers or majors.

---
## Planner responses — round 1
- F1 [major] ACCEPTED — status route async on the identity, 2 s runner timeout, 60 s per-user key-linked cache cleared on that user's PUT/DELETE, unreachable ⇒ `unknown` ⇒ default `llm` (A.1).
- F2 [major] ACCEPTED — `fetchKiroStatus(force)` bypasses `_kiroStatusRequested`; `startNewOperatorThread()` forces a re-read; the default is re-applied only while the thread is empty and the user has not chosen (A.3).
- F3 [major] ACCEPTED as option (a) — documented limitation; the session-open model check is authoritative for every turn, the map only picks the default (A.2).
- F4 [minor] ACCEPTED — wrapper keeps CLI and exit codes; the staging workflow does not invoke the script, only its comments change (B.6).
- F5 [minor] ACKNOWLEDGED — no collision, follows the existing `operator.kiro.*` pattern.
- F6 [minor] ACCEPTED — pre-fill via the existing `state.chatInputValue`, discarded like any unsent draft (A.4).
- F7 [minor] ACCEPTED — `staging-<sha12>` → `prod-<sha12>` re-tag of the same manifest, refused if missing (B.7).
- Q1 — yes, 60 s cache (F1). Q2 — yes, accepted limitation (F3). Q3 — exists: `services/gateway/test/vtid-04999-kiro-runner-backend.test.ts`, test "production is never pointed at the staging kiro-runner by this change" (B.8).

## Round 2: all findings closed, no new blockers or majors. Verdict: CONVERGED (2 rounds).

---

## Final plan
## Goal
Owner decision 2026-10-09: Kiro is the **primary engine of the Command Hub Operator** for every
exafy_admin account that has its own Kiro Power key linked (today `dstevanovic@hotmail.com`
0adc6ff6-…, `j.tadic@exafy.io` bc34a5ca-…), "at least while credits last". The Operator
(LLM router → Claude on Bedrock) stays the engine whenever Kiro cannot serve that user. Dev
Autopilot and every other pipeline stay on Bedrock — unchanged.

Change class: **standard** (routes, UI, deploy workflow, production infra).

## Premises (verified)
- Engine is per thread, fixed at creation; a new thread is `llm` unless the user clicks Kiro
  (`app.js` `operatorThreadEngine` / `setActiveOperatorEngine`, VTID-04975).
- Kiro reports its models per session; an empty list means the seat's credits are used up
  (owner, 2026-10-08). Phase 2 (VTID-04999) runner/key store is merged and in prod code, but no runner
  is provisioned yet (checked live 2026-10-09: no token secret, no ECR repo, no ECS service;
  staging `KIRO_ENGINE_ENABLED=false`; prod has no KIRO env).

## Design
### A. Default engine = Kiro when Kiro can serve this user (gateway + Command Hub)
1. `GET /api/v1/operator/kiro/status` (admin) gains, for the **signed-in user**:
   `key_linked` (runner `GET /keys/:id`, never the key) and `credits: 'ok'|'exhausted'|'unknown'`,
   plus `default_engine: 'kiro'|'llm'` = `kiro` iff `enabled && runner_configured && key_linked &&
   credits !== 'exhausted'`. Computed server-side so the rule lives in one place. The route becomes
   async and reads the identity's user id; the runner call has a 2 s timeout and its answer is
   cached per user for 60 s (cache cleared by that user's PUT/DELETE `/kiro/key`). Runner
   unreachable or timeout ⇒ `key_linked:'unknown'` ⇒ `default_engine:'llm'` (never blocks the page).
2. Credit state per user, in the gateway (in-memory map, 1 h TTL; a gateway restart resets to
   `unknown`). **Accepted limitation:** with more than one gateway task the map is per task, so a
   task that has not seen the exhaustion still defaults a new thread to Kiro; the first turn there
   finds the empty model list on session open (authoritative on every new session), answers
   `no_credits` with "Continue in Operator", and marks that task too. The map only chooses the default;
   it never decides a turn: set `exhausted` when a Kiro session opens with an **empty model list**, or a Kiro turn
   fails with a quota/credit error from Kiro (matched on Kiro's error text: `credit`, `quota`,
   `limit reached`, `insufficient`; the raw message is kept). Set `ok` when a session opens with ≥1
   model. Exhaustion on open closes that session and the turn returns `kiro_status:'no_credits'`
   with "Your Kiro credits are used up — new threads use the Operator until they renew." (admin-only
   text, English by design like the other Kiro replies).
3. Command Hub: `startNewOperatorThread()` sets `thread.engine = 'kiro'` when the last
   `/kiro/status` says `default_engine === 'kiro'`; the existing Operator | Kiro switch on the empty
   thread still lets the user pick either. Status is re-read when a new thread starts:
   `fetchKiroStatus(force)` bypasses the one-shot `_kiroStatusRequested` guard and
   `startNewOperatorThread()` calls it with `force=true`. The thread is created immediately from the
   last known status; when the fresh status arrives and the thread is still empty and the user has
   not touched the switch, the default is re-applied.
4. **No silent fallback inside a thread** (CLAUDE.md "never allow silent model fallback"): a Kiro
   thread never quietly answers with Bedrock. On `no_credits` (or `not_connected`) the reply shows the
   reason and a one-click **"Continue in Operator"** that opens a new LLM thread with the user's last
   message pre-filled (not auto-sent): it calls `startNewOperatorThread()` with engine `llm` forced,
   then sets `state.chatInputValue` (the existing chat-input state the textarea renders from). The
   draft is discarded like any unsent input if the user switches threads. Every reply already shows
   its engine badge.
5. OASIS: `operator.kiro.credits_exhausted` (user id, thread id, source `empty_models|error`) once per
   transition, added to the `CicdEventType` union.

### B. Production runner (so the default applies on vitanaland.com, not only staging)
6. `scripts/aws/setup-kiro-runner-staging.sh` → generalised to `setup-kiro-runner.sh --env
   staging|production` (staging names unchanged; production: `vitana-kiro-runner-awsdr`, secret
   `vitana/kiro-runner/production/runner-token`, keys `vitana/kiro/production/users/*`, task role
   `vitana-kiro-runner-prod-task-role`, Cloud Map `kiro-runner-prod.vitana.internal`, prod SG of
   `vitana-gateway-awsdr` read live). The old staging script stays as a thin wrapper
   (`exec setup-kiro-runner.sh --env staging "$@"`, same subcommands and exit codes).
   `AWS-STAGE-DEPLOY-KIRO-RUNNER.yml` does not call the script (only its comments name it); only
   those comments change.
7. `AWS-PROD-DEPLOY-KIRO-RUNNER.yml`: `workflow_dispatch` only, required `reason`, OIDC
   (`AWS_PROD_ROLE_ARN`), required `commit_sha`; promotes the **staging-verified image** with no
   rebuild: the staging workflow pushes `vitana/kiro-runner:staging-<sha12>`; the prod workflow
   refuses unless that tag exists, re-tags it `prod-<sha12>` (ECR put-image with the same manifest)
   and rolls `vitana-kiro-runner-awsdr` to it; preflight like staging, waits for HEALTHY.
8. `AWS-PROD-DEPLOY-GATEWAY.yml`: wires `KIRO_RUNNER_URL`/`KIRO_RUNNER_TOKEN`/`KIRO_ENGINE_ENABLED`
   only when `vitana/kiro-runner/production/runner-token` exists (same absent ⇒ `false` rule), via the
   existing env-merge path; post-deploy check expects the resolved value. The VTID-04999 guard test
   (`services/gateway/test/vtid-04999-kiro-runner-backend.test.ts`, "production is never pointed at
   the staging kiro-runner by this change"; it asserts the prod workflow contains no `KIRO_RUNNER` /
   `kiro-runner`, and its comment already names this follow-up) is replaced to assert prod wiring points only at the
   **production** runner and staging only at staging.
9. Keys are per environment: a key linked on staging is not visible in production; each user links
   once per environment (same Kiro workspace card).

### Order and owner steps
- Owner runs `setup-kiro-runner.sh --env staging provision --apply`, then I deploy runner + gateway
  on staging; each user links their key on staging; STAGING-VERIFY + one real turn per user.
- Gate 2 for production gateway code; owner runs `--env production provision --apply`; I dispatch
  `AWS-PROD-DEPLOY-KIRO-RUNNER.yml` with the verified image, then the prod gateway redeploy; users
  link keys in production.

## Out of scope
Dev Autopilot / any LLM-routing stage (stays Bedrock); a model catalog of our own (models stay
Kiro's); session reattach across gateway tasks (known limitation L-1 of VTID-04999).

## Files in scope
services/gateway/src/services/kiro/{kiro-turn.ts,remote-backend.ts,credit-state.ts(new)},
routes/operator.ts, types/cicd.ts; Command Hub app.js/styles.css/index.html (+ symbol index,
ownership guard, staging probes ?v=); scripts/aws/setup-kiro-runner.sh (new) +
setup-kiro-runner-staging.sh (wrapper); .github/workflows/AWS-PROD-DEPLOY-KIRO-RUNNER.yml (new),
AWS-PROD-DEPLOY-GATEWAY.yml; conversation-flag-pins regenerated; tests; docs/validation/<VTID>/.

## Test plan
- Unit: default_engine truth table (enabled/runner/key/credits); credit state transitions (empty
  models → exhausted + session closed + no_credits reply; ≥1 model → ok; credit-ish Kiro error →
  exhausted; other errors leave it; TTL expiry → unknown); per-user isolation; OASIS event once per
  transition; status never returns the key.
- UI: new thread defaults to Kiro iff `default_engine==='kiro'`; switch still overrides; "Continue
  in Operator" opens an LLM thread with the message pre-filled and does not send; status re-read on
  new thread.
- Workflows: prod runner workflow is dispatch-only, OIDC, refuses without the prod secret/service,
  promotes by tag; prod gateway wires only the production runner, absent ⇒ `KIRO_ENGINE_ENABLED=false`;
  guard test for env separation; YAML + jq validated locally.
- Existing: Kiro suites, operator regression (`npm run test:operator`), full gateway suite.
- STAGING-VERIFY (read-only): `/kiro/status` unauthenticated 401 JSON; Command Hub serves the new
  `?v=` containing the default-engine code.
