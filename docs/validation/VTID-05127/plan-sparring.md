# Plan sparring record — VTID-05127 (phone verification: switching it on is one owner step)

- **VTID:** VTID-05127 (exafyltd/vitana-platform). Follows VTID-05095/05096 (shipped off).
- **Sparring session:** `plan_sparring_sessions.id = 049cb64b-e651-4e85-93d5-3227192a75c3`; VTID allocated with `p_sparring_id` and the plan hash.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Change class:** standard. **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hash (sha256 of the text between the plan markers):** `a0d0d7a6c59cd4fd8e568e09e996a25c911c54f68971f33a7cef3548ee3c1c1c`
- **Owner approval:** Gate 1 in Claude Code session https://claude.ai/code/session_01CRi9L1TVjrdCCLgwFPUCnz, 2026-10-13 — "Yes". Binding exafy_admin approval click pending.
- **Production write in this plan:** none. Nothing is switched on; the owner's switch-on steps are in SWITCH-ON.md.

## Round 1 — NOT CONVERGED (0 blockers, 2 majors, 4 minors, 3 questions)

Partner findings (verbatim titles, abridged): F1 [major] staging strip-list coupling should be pinned by the test; F2 [major] the prod ARN check must be an exact anchored match (sole integrity gate); F3 [minor] repo-variable switch on staging diverges from the Kiro convention; F4 [minor] wiring script needs the checkout first; F5 [minor] request-sender-id idempotency; F6 [minor] secret naming consistent (confirmation). Q1 status permissions; Q2 spend limit is account-wide; Q3 test cases.

## Round 2 — CONVERGED

F1–F6 and Q1–Q3 closed. New: F7 [minor] test plan said "4-combination" while §4 lists 6 cases — fixed.

## Final plan, planner responses and round 2

# Plan — phone verification: make switching it on one owner step

<!-- plan:begin -->
## Goal
VTID-05095/05096 shipped phone verification (SMS code) to production switched OFF
(`PHONE_VERIFY_ENABLED` unset). Turning it on today needs five hand steps with no
code support: a Secrets Manager secret for `PHONE_VERIFY_HMAC_SECRET`, wiring that
secret into both gateway task definitions, an IAM grant `sms-voice:SendTextMessage`
on `vitana-ecs-task-role`, an SMS spend limit, and leaving the AWS SMS sandbox.
This change builds everything except the steps only the owner can do, so the
switch-on becomes: run one script with `--apply`, open one AWS support case
(sandbox exit), set one repository variable.

No application code changes. The gateway already reads every setting at call time
(`services/gateway/src/services/phone-verification/config.ts`).

## Change class
standard (touches `.github/workflows/**` deploy files and adds an IAM/secret
provisioning script).

## Scope (files)
1. `scripts/aws/setup-phone-verify-sms.sh` (new) — dry-run by default, `--apply`,
   `--env staging|prod`, `status` subcommand. Same conventions as
   `setup-gateway-internal-token.sh` / `setup-operator-agent-task-role-grants.sh`:
   - creates (or keeps) Secrets Manager `vitana/gateway/<env>/phone-verify-hmac`,
     value = 64 random hex chars (32 bytes) from `openssl rand -hex 32`; never
     printed; existing secret is NOT rotated unless `--rotate` (rotation
     invalidates only open codes — 10-minute TTL — documented);
   - puts inline policy `vitana-phone-verify-sms` on `vitana-ecs-task-role`
     (shared by staging and prod task defs — read live from the task defs in
     `status`): `sms-voice:SendTextMessage` with Resource scoped to
     `arn:aws:sms-voice:eu-central-1:472838866351:*` (account + region);
   - optional `--monthly-limit-usd N` → `set-text-message-spend-limit-override`;
   - optional `--sender-id Vitana` → for each of DE, AT, CH: `describe-sender-ids`
     first; skip when that sender ID + country already exists with TRANSACTIONAL
     among its message types; otherwise `request-sender-id` (TRANSACTIONAL);
     a conflicting existing registration is reported, never overwritten;
   - `status`: prints account tier from `describe-account-attributes`
     (SANDBOX vs PRODUCTION), spend limits, sender IDs, whether the secret and
     the inline policy exist, and the secret ARN to put in the repo variable;
   - refuses any account/region other than 472838866351 / eu-central-1;
   - runs with the operator's own CLI credentials (CloudShell as admin), never
     the task role; `status` needs sms-voice:Describe*, secretsmanager:DescribeSecret,
     iam:GetRolePolicy, documented in the header;
   - the spend limit is account-wide for End User Messaging SMS; the gateway's
     `sms-sender.ts` is the only SMS sender in this repo today (grep), noted in
     the header so a future second sender knows it shares the limit.
   The sandbox exit is an AWS support case and cannot be scripted; `status`
   says so plainly while the tier is SANDBOX.
2. `.github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml` — new step
   "Resolve phone verification config" in the existing optional-secret pattern
   (`describe-secret vitana/gateway/staging/phone-verify-hmac`, append to
   `connected-apps.json`, merged by name in the roll step):
   - secret absent → `PHONE_VERIFY_ENABLED=false`, no secret ref; deploy never fails;
   - secret present → `PHONE_VERIFY_HMAC_SECRET` wired as a secret ref and
     `PHONE_VERIFY_ENABLED=true` (existing staging convention, as Kiro: the
     secret's presence is the switch; the owner controls staging by creating
     or deleting `vitana/gateway/staging/phone-verify-hmac`).
3. `.github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml` — new step
   "Build task-definition (phone verification)" before step 2/2, Kiro pattern
   (prod deploy role has no `secretsmanager:Describe*`):
   - repo variable `PHONE_VERIFY_HMAC_SECRET_PROD_ARN` must be empty or match the
     anchored ERE
     `^arn:aws:secretsmanager:eu-central-1:472838866351:secret:vitana/gateway/prod/phone-verify-hmac-[A-Za-z0-9]{6}$`
     (bash `[[ $ARN =~ $RE ]]`; anything else fails the step);
   - repo variable `PHONE_VERIFY_PROD_ENABLED` exact 'true' with an empty ARN →
     the step FAILS ("enabled without its secret" — would answer 503 everywhere);
   - ARN set → secret ref wired; `PHONE_VERIFY_ENABLED` = 'true' only when
     `PHONE_VERIFY_PROD_ENABLED` is exactly 'true', else 'false';
   - ARN empty and not enabled → `PHONE_VERIFY_ENABLED=false`, no secret ref.
   `env_overrides` still runs after this step and can force `false` as an
   emergency off-switch without touching repo variables.
   Post-deploy: the existing read-only verify gains no new probe (GET
   `/api/v1/me/phone` needs auth); see test plan.
4. `services/gateway/test/vtid-NNNNN-phone-verify-switch-wiring.test.ts` (new) —
   static workflow test in the style of `vtid-04754-jev-prod-workflow.test.ts`:
   both steps exist, secret is a `valueFrom` (never a plain `value`), prod guards
   the ARN prefix and fails enabled-without-ARN, default is `false`, step sits
   before step 2/2 (so env_overrides can still override), staging never fails
   on an absent secret; `PHONE_VERIFY_ENABLED` / `PHONE_VERIFY_HMAC_SECRET` are
   NOT in the staging roll step's main strip list (so only the connected-apps
   merge-by-name sets them) nor in prod step 2/2's strip list; the wiring script
   exists at `scripts/ci/phone-verify-wiring.sh` and the prod step calls it
   after the job's `actions/checkout`; plus a shell-level test that runs the prod step's
   decision logic (extracted into `scripts/ci/phone-verify-wiring.sh`, called by
   the step) over 6 cases: ARN+enabled → secret+true; ARN+not enabled →
   secret+false; no ARN+enabled → exit≠0; no ARN+not enabled → false, no secret;
   wrong-prefix ARN → exit≠0; right prefix but wrong suffix length / trailing
   text → exit≠0. `PHONE_VERIFY_PROD_ENABLED` values other than exact 'true'
   ('TRUE', ' true', '1') → false.
5. `scripts/ci/phone-verify-wiring.sh` (new, small) — the jq decision logic
   shared by the test and the prod step (keeps the workflow under GitHub's
   20,000-char run limit, VTID-03788 guard).
6. Docs: `.claude/rules/infrastructure.md` §8 (the two repo variables, the
   script), `docs/validation/<VTID>/` (plan-sparring.md, acceptance.md,
   scope.json, staging-tests.json, commands.log, a SWITCH-ON.md runbook with
   the exact owner commands in order).

## Explicitly out of scope
- Turning the feature on. Nothing in this change sets `PHONE_VERIFY_PROD_ENABLED`;
  after merge both environments stay off until the owner acts.
- Any change to the gateway or app code; any migration.
- What's New entry: added in a follow-up PR only once production
  `PHONE_VERIFY_ENABLED=true` is live (owner rule: no cards for features behind
  a flag). Tracked in SWITCH-ON.md as the last step.
- Running the script. No Claude Code session has IAM/Secrets Manager write
  rights on these resources (boundary documented in
  setup-operator-agent-task-role-grants.sh); the owner runs it.

## Order of the owner's switch-on (SWITCH-ON.md)
1. `scripts/aws/setup-phone-verify-sms.sh --env prod --apply --monthly-limit-usd 50 --sender-id Vitana`
   (and `--env staging --apply` if staging should send).
2. AWS support case: SMS production access (sandbox exit), eu-central-1.
3. `status` shows tier PRODUCTION → set repo variables
   `PHONE_VERIFY_HMAC_SECRET_PROD_ARN` (printed ARN) and `PHONE_VERIFY_PROD_ENABLED=true`.
4. Next PUBLISH (or env-only dispatch) carries it; read-only check: unauthenticated
   GET `/api/v1/me/phone` still 401 JSON; owner verifies their own number in the app.
5. Claude opens the What's New PR.

## Test plan
- Jest: the new wiring test (static + 6-case decision test); full gateway
  Jest suite stays green; `bash -n` + shellcheck on both scripts; the script's
  dry-run prints the policy JSON with no AWS write (run locally with no creds —
  must stop at the account check without writing).
- Workflow size guard and existing workflow tests (`vtid-03961`, `vtid-04647`,
  `vtid-04754`, `vtid-04709`) stay green.
- STAGING-VERIFY (read-only): staging deploy logs show
  "phone-verify-hmac not found - PHONE_VERIFY_ENABLED=false"; change suite =
  rejected probe GET `/api/v1/me/phone` without auth → 401 JSON (route still
  mounted after the task-def change) + the Jest wiring test.
- No test sends an SMS; no write to production.
<!-- plan:end -->

## Planner responses — round 1

- F1 [major] ACCEPTED — the wiring test asserts PHONE_VERIFY_ENABLED and
  PHONE_VERIFY_HMAC_SECRET are absent from the staging main strip list and from
  prod step 2/2's strip list (plan §4 updated).
- F2 [major] ACCEPTED — exact anchored ERE with a 6-character
  `[A-Za-z0-9]{6}` suffix, bash `=~`; the test pins the regex and covers
  wrong prefix, wrong suffix length and trailing text (plan §3, §4 updated).
- F3 [minor] ACCEPTED — staging follows the existing convention: secret
  present = enabled. The repo-variable switch stays on prod only, because prod
  is member-facing and the secret must exist before the sandbox exit is done
  (secret provisioned ≠ ready to send). Plan §2 updated.
- F4 [minor] ACCEPTED — verified: `actions/checkout@v4` is a job step
  (AWS-PROD-DEPLOY-GATEWAY.yml:304) before every build step in all modes; the
  test asserts the script path exists and the call comes after the checkout.
- F5 [minor] ACCEPTED — describe-sender-ids first, skip on exact
  sender+country with TRANSACTIONAL, report conflicts, never overwrite (§1).
- F6 — no action (confirmation).
- Q1 — the script runs with the operator's own credentials, never the task
  role; required permissions documented in its header (§1).
- Q2 — the spend limit is account-wide; `sms-sender.ts` is the only SMS sender
  in services/ (grep, excluding node_modules); noted in the script header (§1).
- Q3 — yes, those four plus wrong-prefix and wrong-suffix cases, plus
  non-exact 'true' values (§4).

## Round 2 — partner
F1–F6 and Q1–Q3 closed. New: F7 [minor] test plan said "4-combination" while §4 lists 6 cases → ACCEPTED, fixed. Verdict: CONVERGED.
