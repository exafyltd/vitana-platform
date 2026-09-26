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
  → STAGING-VERIFY (automatic, triggered by the successful deploy)
       ├─ smoke suite for the deployed service (always)
       └─ change suite for this VTID (always, see §3)
  → result recorded in OASIS: staging.verify.passed | staging.verify.failed
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
  the one allowed exception) and navigate, open, render and read. A network
  guard aborts every non-`GET` request to the gateway and Supabase REST except
  sign-in, and the test fails if the guard had to abort anything it did not
  expect.
- Anything that needs a write — posting, liking, messaging, profile edits,
  onboarding steps, wallet, ticket creation — is verified by unit/integration
  tests in CI (in-memory or local Supabase), never on staging.
- No suite ever points at production (`vitanaland.com`, `gateway.vitanaland.com`).

If a change cannot be verified read-only and has no CI-level test that covers
it, that is a **blocker to raise**, not a reason to skip verification.

---

## 3. The test suites

### 3.1 Smoke suite (per service, always runs)

Maintained once per deployable, lives with the workflow that runs it.

| Service | Minimum checks |
|---|---|
| gateway | `/alive`; `/api/v1/admin/health` reports `env=staging`; build-info reports the merge commit; one route-exists probe per top-level router (JSON, never `text/html`); ORB health endpoint |
| community app | shell loads; served `assets/index-*.js` is the new build (sampled, see vitana-v1 CLAUDE.md); bundle bakes the staging gateway URL; login page renders; one signed-in read-only page per role renders without console errors |

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
  "service": "gateway | community-app",
  "tests": [
    { "kind": "http", "method": "GET", "path": "/api/v1/…",
      "expect_status": 200, "expect_json_path": "ok", "expect": true },
    { "kind": "playwright", "spec": "e2e/…/my-change.staging.spec.ts" },
    { "kind": "existing", "ref": "npm run test:roles" }
  ]
}
```

- `http` — read-only request against the staging host, with expected status /
  content type / JSON field.
- `playwright` — a spec file in the same PR, run against the staging host
  under the §2 network guard.
- `existing` — an already-maintained suite that covers the change; name it
  and say why it covers it.

**If the suite does not exist, building it is part of the change.** A PR that
deploys and has no `staging-tests.json` is not ready to merge. The test is
written in the same PR as the code, never after the deploy.

---

## 4. What "passed" means

All of these, on one run:

1. The commit under test is the merge commit, confirmed from the staging
   host itself (build-info / served chunk), before and after the run. If
   staging moved to another commit during the run, the result is void —
   re-run on the new commit.
2. Every smoke check and every change-suite test is green.
3. The §2 network guard aborted nothing unexpected.

The result is recorded as an OASIS event (`staging.verify.passed` /
`staging.verify.failed`) with `vtid`, `service`, `commit`, per-test results
and the workflow run URL. That event is the single source both channels read.

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
| Suites usable as `existing` refs (`test:support`, `test:operator`, `test:roles`, E2E specs) | exist |
| This process, rules in both CLAUDE.md files | VTID-04610 |
| `STAGING-VERIFY.yml` (both repos), smoke suites, `staging-tests.json` runner, network guard | to build (follow-up VTID) |
| `staging.verify.*` OASIS events, Operator Chat message + Publish action | to build (follow-up VTID) |
| VALIDATOR-CHECK: deploying PR without `staging-tests.json` fails | to build (follow-up VTID) |
| `E2E-TEST-RUN.yml`: stop defaulting to `vitanaland.com`, stop triggering from the prod deploy | to fix (follow-up VTID) |

**Until STAGING-VERIFY exists, the rule still applies by hand:** after the
staging deploy finishes, the session runs the smoke checks and the change's
`staging-tests.json` against staging itself (read-only, §2), reports the
result per test in the session, and only then asks the ready question.
