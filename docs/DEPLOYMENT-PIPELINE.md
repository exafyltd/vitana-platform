# Deployment Pipeline — Merge → Staging → Verify → Publish (VTID-04610)

**Canonical process for every change that deploys, in both repos**
(`exafyltd/vitana-platform` and `exafyltd/vitana-v1`). `CLAUDE.md` in each
repo carries the short standing rule (platform Part 1 rules 46–50); this file
carries the detail. If the two ever disagree, the stricter one wins and this
file gets fixed.

Owner decisions (2026-09-26), not to be re-asked:

1. The "ready for production?" message goes to **two places only**: the
   **Claude Code session** that merged the change, and the **Command Hub
   Operator Chat**. Not DevOps Chat, not push, not email, not a PR comment.
2. A "yes" to that message goes **directly to PUBLISH** — no second
   human in between.
3. `CLAUDE.md` size cleanup is a separate change, not part of this one.

---

## 1. The pipeline

```
PR reviewed + approved
  → merge to main
  → staging deploy (automatic, existing)
       platform: AWS-STAGE-DEPLOY-GATEWAY.yml   → preview-aws-gateway.vitanaland.com
       frontend: AWS-STAGE-DEPLOY-FRONTEND.yml  → preview-aws.vitanaland.com
  → deploy check (existing): env=staging and build-info / served chunk = the merge commit
  → STAGING-VERIFY (automatic — .github/workflows/STAGING-VERIFY.yml in vitana-platform)
       gateway:  workflow_run of "AWS Stage Deploy Gateway (ECS)" (success only)
       frontend: repository_dispatch `community-app-staging-deployed`, sent by
                 vitana-v1 AWS-STAGE-DEPLOY-FRONTEND.yml's last step
       ├─ smoke suite for the deployed service (always)
       └─ change suites of every commit between production and this commit (§3.2)
  → result recorded in OASIS: staging.verify.passed | failed | superseded
       ├─ passed → ready message to Claude Code + Operator Chat (§5)
       │            "Staging verified — ready for deployment to production?"
       │            → yes → PUBLISH (§6) → production deploy check (§7)
       └─ failed → no production prompt; fix, merge, redeploy, re-verify (§8)
```

Nothing reaches production without (a) a green STAGING-VERIFY on the exact
commit being promoted and (b) an explicit "yes" to the ready message.

A change that deploys nothing (docs only, a test only, a workflow that no
deploy path watches) has no staging deploy and therefore no STAGING-VERIFY and
no production prompt. Say so in the PR instead of inventing a verification.

---

## 2. Hard constraint — staging suites are read-only

Staging is **not isolated**. The staging gateway and every staging/preview
frontend run against the **production Supabase project** (see
`exafyltd/vitana-v1` CLAUDE.md "Why no host is exempt", platform Part 1 rules
31–32). A write on staging is a write in front of real members.

So every automated staging test is read-only by construction:

- HTTP checks use `GET`/`HEAD`, or a `POST` that is rejected before any side
  effect (e.g. an auth-required route answering `401 application/json` — the
  §15 "route exists" probe).
- Browser tests may sign in as the documented test user (the auth session is
  the one allowed exception) and navigate, open, render and read. They run
  behind `scripts/ci/staging-verify/staging-guard.ts`, which aborts every
  non-read request to any gateway or to Supabase except sign-in, aborts
  **every** request to a production host, and fails the test if it had to
  abort anything the spec did not declare with
  `test.use({ allowAbortedWrites: [/…/] })` (a telemetry beacon, say — it is
  still aborted, nothing is written). The runner copies the guard next to each
  spec on every run, so no repo can carry a weakened copy.
- Anything that needs a write — posting, liking, messaging, profile edits,
  onboarding steps, wallet, ticket creation — is verified by unit/integration
  tests in CI (in-memory or local Supabase), never on staging.
- No suite ever points at production (`vitanaland.com`, `gateway.vitanaland.com`).

If a change cannot be verified read-only and has no CI-level test that covers
it, that is a **blocker to raise**, not a reason to skip verification.

---

## 3. The test suites

### 3.1 Smoke suite (per service, always runs)

Maintained once per deployable in `scripts/ci/staging-verify/smoke/<service>.json`
(same format as a change suite). Before any test, the runner confirms on
several consecutive samples that staging serves the deployed commit
(gateway: `build-info.git_commit`; community app: the
`<meta name="vitana-app-version">` stamp), and again after the last test.

| Service | Checks today |
|---|---|
| gateway | `/alive`; admin health + build-info report `env=staging`; ORB, Nova Sonic, autopilot, VTID ledger, scheduler and operator health; OASIS tasks list; an auth-required read answers 401 JSON; the PUBLISH route exists (auth-rejected probe) |
| community app | app shell + version stamp; SPA deep-link fallback; `/nav-registry.json`; staging gateway reachable; browser: the pre-login landing boots with no uncaught errors, and the served bundle talks to the staging gateway (`tests/e2e/staging/smoke.staging.spec.ts` in vitana-v1) |

Still to add: a signed-in read-only page per role (needs the test-user
secrets, which STAGING-VERIFY already passes to browser tests).

A smoke suite failure is a failed verification like any other.

### 3.2 Change suite (per VTID, always runs)

Every PR that deploys must carry — or point to — the tests that prove **this
change** works on staging:

```
docs/validation/<VTID>/staging-tests.json
```

```json
{
  "vtid": "VTID-XXXXX",
  "service": "gateway",
  "tests": [
    { "kind": "http", "name": "new route answers", "path": "/api/v1/foo/health",
      "expect_status": 200, "expect_json": { "ok": true } },
    { "kind": "http", "name": "write route exists", "method": "POST",
      "path": "/api/v1/foo", "rejected_probe": true, "expect_status": 401 },
    { "kind": "playwright", "spec": "e2e/staging/foo.staging.spec.ts", "cwd": "e2e" },
    { "kind": "existing", "ref": "npm run test:roles", "cwd": "services/gateway",
      "reason": "pins the role matrix this change edits" }
  ]
}
```

- `http` — against `target` `gateway` (default for the gateway) or `frontend`
  (default for the community app). Fields: `method` (`GET`/`HEAD`),
  `expect_status` (default 200), `expect_content_type` (default
  `application/json` for gateway `/api` paths), `expect_json` (dotted path →
  exact value), `expect_body_contains`. A `POST`/`PUT`/`PATCH`/`DELETE` is
  accepted only as `"rejected_probe": true` with `expect_status` 401/403; it
  is sent with an invalid token, and a 2xx answer fails loudly as an accepted
  write.
- `playwright` — a `*.staging.spec.ts` in the same repo that imports
  `{ test, expect } from './staging-guard'` (the runner supplies that file).
  `cwd` is the directory whose `package.json` provides `@playwright/test`
  (`e2e` in vitana-platform, `.` in vitana-v1). Base URL = the staging host;
  `STAGING_GATEWAY_URL`, `STAGING_FRONTEND_URL`, `TEST_USER_EMAIL` and
  `TEST_USER_PASSWORD` are in the environment.
- `existing` — a CI-level suite (`npm run <script>`, `npx jest <paths>`,
  `npx vitest run <paths>`, nothing else), run without any secret, with a
  `reason` saying why it covers the change.

**If the suite does not exist, building it is part of the change.** A PR that
deploys and has no `staging-tests.json` is not ready to merge — the
`STAGING-TESTS-REQUIRED` check (both repos) fails it: a PR that touches the
service's deploy paths must name a VTID in its title whose manifest exists and
validates. The test is written in the same PR as the code, never after the
deploy. Worked example: `exafyltd/vitana-v1`
`docs/validation/VTID-04616/staging-tests.json`.

**Which suites run.** Every commit between the commit production serves and
the verified commit that touches the service's deploy paths contributes its
VTIDs' suites — so a verification proves everything a PUBLISH would ship, not
only the last merge. Commits merged before the rule took effect
(`ENFORCE_SINCE` in `lib.cjs`, 2026-09-27) without a suite are listed as
"smoke only" and do not fail the run; a later commit without one does.

**If the suite does not exist, building it is part of the change.** A PR that
deploys and has no `staging-tests.json` is not ready to merge. The test is
written in the same PR as the code, never after the deploy.

---

## 4. What "passed" means

All of these, on one run:

1. The commit under test is the merge commit, confirmed from the staging
   host itself (build-info / version stamp), before and after the run. If
   staging moved to a newer commit, the result is `superseded` — no prompt;
   the newer deploy gets its own verification, which covers this commit's
   suites too (§3.2).
2. Every smoke check and every change-suite test is green.
3. The §2 network guard aborted nothing unexpected.

The result is recorded as one OASIS event — topic `staging.verify.passed` /
`failed` / `superseded`, `service` `staging-verify-<service>`, `vtid` = the
verified commit's VTID, `message` = the ready message, `metadata` = commit,
per-test results, missing/invalid suites, the commit list that would ship,
production commit and run URL. A runner crash is recorded as `failed`. That
event is the single source both channels read; the run keeps
`results.json` / `message.md` as an artifact for 30 days.

A flake is not a root cause. One re-run is allowed only when the job died
before any test ran (runner/checkout/install) — the same rule as PR CI.

---

## 5. The ready message

Sent only on `staging.verify.passed`, to exactly two channels:

- **Claude Code** — the session that merged the change keeps watching until
  STAGING-VERIFY for its merge commit finishes (workflow run / OASIS event,
  with a scheduled check-in if it has the means). Merging is not the end of
  the task; the verification result is. The session then asks the developer
  in the conversation.
- **Command Hub Operator Chat** — the verification result appears in the
  Operator Chat as a message from the pipeline, with the same content and a
  Publish action.

Content, in this order:

1. `Staging verified — ready for deployment to production?`
2. VTID(s), service(s), verified commit, link to the STAGING-VERIFY run.
3. What passed (smoke + change suite, counts).
4. **What would ship**: every commit between the commit currently live in
   production (prod build-info / prod chunk) and the verified commit, with
   author and VTID. PUBLISH promotes the whole verified staging build, so the
   developer must see everything their "yes" covers.

On `staging.verify.failed` the same channels get the failing checks and the
statement that nothing will be offered for production until it is green.

---

## 6. "Yes" → PUBLISH

A "yes" from the developer goes straight to PUBLISH — the same promotion the
Command Hub button performs (`POST /api/v1/operator/publish`: promotes the
build staging serves; gateway via `AWS-PROD-DEPLOY-GATEWAY.yml` in
`promote-staging` mode with `expected_commit` pinned, frontend via its prod
workflow).

- **From Operator Chat** — the Publish action calls the PUBLISH endpoint
  under the chat user's exafy_admin session.
- **From Claude Code** — the session dispatches the same prod workflows PUBLISH
  dispatches, pinned to the verified commit (`expected_commit` /
  `commit_sha`), with `reason` naming the VTID and the STAGING-VERIFY run.

Guards, both channels:

- The commit promoted must be the commit that passed. If staging now serves a
  newer, unverified commit, PUBLISH is refused until that commit has its own
  green STAGING-VERIFY and its own ready message.
- The "yes" covers the commit list shown in the ready message and nothing
  else. That list is what makes this compatible with platform IF-THEN 26: the
  developer approved every commit in the range explicitly.
- Anything other than a clear yes (a question, "later", silence) is not a yes.

---

## 7. After PUBLISH

Production gets the **deploy check only** (§15 in platform CLAUDE.md,
"Verifying a frontend deploy actually shipped" in vitana-v1 CLAUDE.md):
build-info / served chunk equals the promoted commit on every sample, `/alive`
answers. **No test suite runs against production** — the absolute rule in
vitana-v1 CLAUDE.md applies unchanged. The outcome is reported back on the
same two channels.

---

## 8. When verification fails

- No production prompt, no PUBLISH, no exception.
- The change owner (the Claude Code session, or the operator agent for work
  it queued) root-causes it: a real defect is fixed forward on a new PR →
  merge → staging → STAGING-VERIFY again. A wrong test is fixed in the same
  way, with the reason stated in the PR.
- Never skip, disable or loosen a test to get green; never promote around a
  red result.

---

## 9. Status — what exists and what is being built

| Piece | State |
|---|---|
| Staging deploys on merge, deploy check | exists |
| PUBLISH endpoint + prod workflows | exists |
| This process, rules in both CLAUDE.md files | VTID-04610 |
| `STAGING-VERIFY.yml` (vitana-platform, both services), runner `scripts/ci/staging-verify/`, smoke suites, network guard, frontend dispatch from vitana-v1 | VTID-04613 |
| `staging.verify.*` OASIS events + ready message (read by the Claude Code session) | VTID-04613 |
| `STAGING-TESTS-REQUIRED` pre-merge check (both repos) | VTID-04613 |
| `E2E-TEST-RUN.yml` / `e2e/playwright.config.ts` default to staging, refuse production hosts, dispatched runs read-only | VTID-04613 |
| Operator Chat: show `staging.verify.*` as a pipeline message with a Publish action | to build (next VTID) |
| Signed-in read-only page per role in the community-app smoke suite | to build |

**How a Claude Code session follows its merge.** After merging, find the run
named `STAGING-VERIFY <service> @ <merge sha>` (or the `staging.verify.*`
OASIS event with `metadata.commit` = the merge sha). A frontend run appears
only after the frontend staging deploy has finished. Relay its `message`
verbatim — it already carries the question, the results and the commit list —
and wait for the developer's answer. Until the Operator Chat piece exists, the
Claude Code session is the only channel that asks.
