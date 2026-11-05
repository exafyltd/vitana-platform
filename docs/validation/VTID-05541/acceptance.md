Change types: Backend, Integration, Infrastructure/CI.
# VTID-05541 acceptance (eng-gitlab-m2/scm-webhook)

Outcome: when GitLab sends a signed project-webhook event to `POST /api/v1/internal/gitlab/webhook`, the gateway records
the matching OASIS event once (five new `scm.gitlab.*` topics, plan §3.5); an unsigned, wrongly signed, stale or replayed
delivery records nothing. No JWT: the Standard Webhooks signature is the gate. Staging gets the signing key only when the
secret `vitana/gateway/staging/gitlab-webhook-signing-token` exists. Nothing changes for members, and no GitLab event moves
a VTID's state in this milestone.

AC-1 The route is mounted as plan §3.5 says: `express.raw({ type: '*/*', limit: '2mb' })` plus its JSON error handler on
`/api/v1/internal/gitlab/webhook` before `express.json()`, and the router through the route guard (`mountRouterSync`,
owner `internal-gitlab-webhook`) at `/api/v1/internal/gitlab`.
TEST: services/gateway/test/routes/internal-gitlab-webhook.test.ts "mounts the raw body parser and its JSON error handler for the route before express.json()", "mounts the router at /api/v1/internal/gitlab through the route guard".
CURL: outputs/curl-proof.txt case 1 (the built route, mounted in that order, answers the STAGING-VERIFY probe 401 JSON).

AC-2 A delivery signed like GitLab (`webhook-id`, `webhook-timestamp`, `webhook-signature: v1,<base64>`, HMAC-SHA256 of
`id.timestamp.raw body` with the base64 part of `whsec_<base64>`) is verified by the shared `verifySvix` over the exact
bytes received; the route maps the three headers with `headerValue` (the verifier is not edited) and answers 200 with the
topic, the VTID and the OASIS event id.
TEST: internal-gitlab-webhook.test.ts "%s → 200 and one %s event" (6 cases), "carries the webhook-id into the event and verifies the exact bytes, not a re-serialization".
CURL: cases 2, 7, 8.

AC-3 A bad, missing or stale signature is refused 401 JSON and records nothing: another key, a body altered after signing,
a swapped `webhook-id`, any of the three headers missing, a non-numeric timestamp, a timestamp more than 300 s off in
either direction, and a correctly signed request that carries only `svix-*` headers.
TEST: internal-gitlab-webhook.test.ts "a signature made with another key → 401 signature_invalid", "a body altered after signing → 401 signature_invalid", "a signed webhook-id swapped for another → 401 signature_invalid", "a stale or future timestamp (over 300 s) → 401 timestamp_out_of_tolerance", "without %s → 401 signature_missing" (3 cases), "a correctly signed request carrying only svix-* headers → 401 signature_missing", "a non-numeric timestamp → 401 signature_missing".
CURL: cases 4, 5, 6.

AC-4 The key fails closed: an unsigned request is refused 401 `signature_missing` whether or not the key is set (the
staging probe); a signed delivery with the key unset, empty or `whsec_` alone is 500 `not_configured` JSON and records
nothing; the key is read at request time.
TEST: internal-gitlab-webhook.test.ts "the unsigned staging probe → 401 signature_missing JSON with the key set", "… with no key configured", "a signed delivery with no key configured → 500 not_configured JSON, nothing recorded", "reads the key at request time (a rotated key applies without a restart)".
CURL: cases 1, 15 (no key, unsigned → 401) and 16 (no key, signed → 500 not_configured).

AC-5 The event-to-topic table of plan §3.5: `merge_request` `action` open or reopen → `scm.gitlab.merge_request.opened`,
merge → `…merged`, close → `…closed`; `pipeline` `status` success → `scm.gitlab.pipeline.succeeded`, failed →
`…failed`. The kind comes from the signed `object_kind`, never from the unsigned `X-Gitlab-Event` header. Every other
event, action or status, a VTID-less event and a JSON value that is not an object are acknowledged 202 and record nothing.
TEST: services/gateway/test/gitlab-events/mapper.test.ts "the event-to-topic table of plan §3.5" (6 mapped rows, 7 unmapped actions, 8 unmapped statuses, 6 unknown events); internal-gitlab-webhook.test.ts "decides by the signed body, not by the unsigned X-Gitlab-Event header", "%s → 202 (%s), acknowledged and ignored, nothing recorded" (6 cases).
CURL: cases 2, 7, 8 (mapped) and 9, 10 (202).

AC-6 The VTID is the first whole `VTID-\d{5}` of the merge request title (`merge_request` events), or of
`merge_request.title` and then `commit.title` (`pipeline` events); the description, a commit body or the last commit of a
merge request is never read for it. No VTID → 202 `no_vtid`.
TEST: mapper.test.ts "the VTID" group (6 tests, incl. "firstVtid takes a whole VTID-\d{5} only").

AC-7 Retries are dropped by `webhook-id`: a second delivery with the same id answers 200 `{duplicate:true}` and records
nothing, before its body is looked at; an id is remembered only after its OASIS row was written, so a failed write answers
502 `oasis_emit_failed` and GitLab's retry records it; a concurrent duplicate waits for the first; ids are kept 24 h, at
most 10,000, keyed by SHA-256, per gateway task (plan §8).
TEST: services/gateway/test/gitlab-events/dedupe.test.ts (9 tests); internal-gitlab-webhook.test.ts "a duplicate webhook-id answers 200 and records nothing more", "a retry is dropped by its webhook-id before its body is looked at", "the OASIS write failing answers 502 and leaves the id open, so the retry records it"; oasis-write.test.ts "the database refusing the row → 502, and the same delivery retried writes one row".
CURL: case 3 (duplicate), cases 13 and 14 (sink refuses once → 502; the retry → 200; one row).

AC-8 Every reply of the route is JSON: a verified body that is not JSON is 400 `invalid_json`; a body over 2mb is 413
`payload_too_large` (the raw parser's error answered by `gitlabWebhookBodyErrors`, not Express's HTML page); an OASIS
write that throws is 502 without the error text; anything unexpected is 500 `internal_error`.
TEST: internal-gitlab-webhook.test.ts "malformed JSON with a valid signature → 400 invalid_json", "a body over the limit → 413 payload_too_large, as JSON", "the OASIS write throwing answers 502 without the error text"; every route test checks `application/json`.
CURL: cases 11 (400), 12 (3 MiB → 413 JSON), 13 (502).

AC-9 The OASIS row: one INSERT into `oasis_events` per accepted delivery through the real `emitOasisEvent`, with service
`gitlab-webhook`, status `info` for the merge request topics, `success` / `warning` for the pipeline topics, `task_stage`
`VALIDATOR` for the merge request topics and none for the pipeline topics, and metadata of ids, refs, shas, statuses and
URLs only (strings cut at 512 characters). Never the description, the user, labels, pipeline variables, builds or a commit
message.
TEST: mapper.test.ts "the OASIS event" group (5 tests, incl. "never carries the description, the user, labels, pipeline variables or builds"); services/gateway/test/gitlab-events/oasis-write.test.ts (4 tests: route → real emitOasisEvent → the INSERT body; only fetch is faked).
CURL: the four sink rows at the end of outputs/curl-proof.txt (no leak string found).

AC-10 The five topics are members of the closed union `CicdEventType` (`types/cicd.ts:1220-1224`); the mapper's
`satisfies Record<string, CicdEventType>` and the typed event make the mapper and the route file fail `tsc` without them.
TEST: mapper.test.ts "each topic is a literal of the CicdEventType union in types/cicd.ts", "exports exactly the five topics of plan §3.5, all scm.gitlab.*, none cicd.*"; outputs/red-on-base.txt run C (the lane's files with base cicd.ts: tsc exit 2, 22 errors, the five TS2322 lines); outputs/typecheck.txt (exit 0).

AC-11 W6: no rule of `autopilot-event-mapper.ts` (not edited) lists a topic starting `scm.gitlab.`; each of the five
events, with the status the route gives it, matches no lifecycle rule from any of the 12 autopilot states; no topic the
route emits is a `cicd.*` topic.
TEST: mapper.test.ts "no rule of autopilot-event-mapper.ts lists a topic starting scm.gitlab.", "each of the five events, with the status the route gives it, matches no rule in any state"; internal-gitlab-webhook.test.ts asserts `type.startsWith('cicd.')` is false for every emitted event. Result: both pass (outputs/green.txt); the first is also green on base, as a guard should be.

AC-12 W3: `AWS-STAGE-DEPLOY-GATEWAY.yml` step "Resolve GitLab webhook signing token" (no `if:`, no `secrets.`) resolves
`vitana/gateway/staging/gitlab-webhook-signing-token` and adds one secret reference `GITLAB_WEBHOOK_SIGNING_TOKEN` to
`connected-apps.json` when it exists; absent, it says so and wires nothing; a failed lookup is a `::warning::`; the deploy
never fails on it.
TEST: services/gateway/test/gitlab-events/staging-wiring.test.ts W3 group (6 tests; the step's own `run:` is executed against a stubbed `aws` for absent, denied and present); outputs/workflow-suites.txt (102 suites that read the workflow, 1370 tests, all pass); outputs/static-checks.txt (YAML parse, `bash -n`).

AC-13 W4: `scripts/aws/setup-gitlab-webhook-secret.sh` is a dry run by default (it reads metadata only, never a secret
value, and writes nothing); `--apply` copies the value of `vitana/engineering/gitlab/webhook-signing-token` from the
engineering account into the staging secret through a mode-600 file that is removed on exit, never printed and never on a
command line; it refuses outside account 472838866351, a value not in `whsec_<base64>` form, a missing source, an unknown
argument (there is no production mode), and the engineering session's credentials reach the CLI only through its
environment.
TEST: staging-wiring.test.ts W4 group (12 tests, run against a stubbed `aws` and `env` that record every call); `bash -n` (outputs/static-checks.txt).

AC-14 Sibling sweep: `AWS-PROD-DEPLOY-GATEWAY.yml` is intentionally unchanged and not wired (protected gate file; no
project has a hook before the cutover).
TEST: staging-wiring.test.ts "sibling sweep: AWS-PROD-DEPLOY-GATEWAY.yml is intentionally not wired in this milestone".

ROUTE_MOUNT: services/gateway/src/index.ts:239-243 (`require('./routes/internal-gitlab-webhook')`), index.ts:628
`app.use('/api/v1/internal/gitlab/webhook', express.raw({ type: '*/*', limit: GITLAB_WEBHOOK_BODY_LIMIT }), gitlabWebhookBodyErrors)`
before `app.use(express.json({ limit: '2mb' }))` at index.ts:631, and index.ts:1285
`mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhookRouter, { owner: 'internal-gitlab-webhook' })`;
handler services/gateway/src/routes/internal-gitlab-webhook.ts:101 `router.post('/webhook', requireGitlabSignature, …)`.
No earlier middleware or router catches the path: no router mounted at `/` or `/api/v1` before index.ts:1285 has a
path-less `router.use` or a wildcard route, and `delegatedTokenGuard` (index.ts:636) passes a bearer that is not a JWT.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/internal/gitlab/webhook (POST, staging, after merge). The
production gateway gets the same code at PUBLISH but no key in this milestone, so it answers 401 / 500 `not_configured`.
CURL_PROOF: outputs/curl-proof.txt (script outputs/curl-proof.sh, server outputs/curl-proof-server.cjs): the route built by
`npm run build` of this branch, mounted in the index.ts order on 127.0.0.1, OASIS INSERTs to a local sink. 16 cases:
unsigned probe 401 `signature_missing` (key set and key unset); signed open 200 `scm.gitlab.merge_request.opened`;
duplicate id 200 `{duplicate:true}`; altered body 401 `signature_invalid`; stale 401 `timestamp_out_of_tolerance`;
`svix-*` only 401; merge 200 `…merged`; pipeline failed 200 `scm.gitlab.pipeline.failed`; push 202 `unknown_event`; no
VTID 202 `no_vtid`; not JSON 400; 3 MiB 413 JSON; sink refuses once 502, the retry 200; no key + signed 500
`not_configured`. Sink A received 4 rows (none for the duplicate or the refused attempt), sink B 0.
OASIS_PROOF: the route writes one `oasis_events` row per accepted delivery, through `emitOasisEvent`
(services/gateway/src/services/oasis-event-service.ts:59; INSERT body :101-124) called at internal-gitlab-webhook.ts:118
with the event built by `mapGitlabEvent` (services/gateway/src/services/gitlab-events/mapper.ts:102). Columns: `vtid` (from
the title), `topic` (one of the five), `service` `gitlab-webhook`, `role` `CICD` and `model` (set by emitOasisEvent),
`status`, `message` (for example "GitLab merge request !12 merged in vitana/rehearsal"), `task_stage` (`VALIDATOR` for the
merge request topics), `metadata` {`gitlab_event`, `webhook_id`, `project_id`, `project_path`, `url`, and
`action`, `merge_request_iid`, `state`, `source_branch`, `target_branch`, `head_sha`, `merge_commit_sha` (merge requests)
or `status`, `pipeline_id`, `ref`, `sha`, `source`, `merge_request_iid`, `duration_s` (pipelines), plus `env`}. No token,
signature, description, user, label, variable, build or commit message. Proof: oasis-write.test.ts and the sink rows of
outputs/curl-proof.txt. Ignored, refused and duplicate deliveries write nothing.

States: key missing → 500 JSON `not_configured` for a signed delivery (an unsigned one is 401 first); bad signature → 401
`signature_invalid`; missing header or non-numeric timestamp → 401 `signature_missing`; stale timestamp → 401
`timestamp_out_of_tolerance`; duplicate id → 200 `{duplicate:true}`, no second event; unknown event, unmapped action or
status, or no VTID → 202 `{ignored:true, reason}`; malformed JSON → 400 `invalid_json`; body too large → 413
`payload_too_large`; OASIS write failed → 502 `oasis_emit_failed`, the id stays open for the retry. Staging secret absent →
not wired, deploy green; present → wired on the next staging deploy.
Surfaces: callers: GitLab project webhooks, from the cutover (no project has a hook in milestone 2). Consumers: the OASIS
event feed only. The VTID lifecycle mapper and the Command Hub's reading of `cicd.*` topics are not changed.
Locales: n/a. Accessibility: n/a.
Contract: request side: headers `webhook-id`, `webhook-timestamp`, `webhook-signature` read at
internal-gitlab-webhook.ts:59-63, raw body from index.ts:628, key `GITLAB_WEBHOOK_SIGNING_TOKEN` at :68, passed to
`verifySvix(raw, { id, timestamp, signature }, key)` at :71, which is services/gateway/src/connectors/runtime/webhook-signature.ts:59-81
(`headerValue` :91; tolerance 300 s :19), the same call shape as connectors/wearable/vital.ts:186-191 with `svix-*`.
Event side: the five literals at types/cicd.ts:1220-1224 in `CicdEventType` (:139), required by `CicdOasisEvent.type`
(:1228) and consumed by `emitOasisEvent` (oasis-event-service.ts:59, :101-124); the table at mapper.ts:56-66, the VTID rule
at mapper.ts:68. Deploy side: AWS-STAGE-DEPLOY-GATEWAY.yml:448-465 writes `connected-apps.json`, which the roll step merges
by name into the task definition secrets (:1186, :1353). Replies are JSON only; no JWT.
Staging proof: STAGING-VERIFY runs docs/validation/VTID-05541/staging-tests.json: a rejected probe, an unsigned `POST` to
the route that must answer JSON 401 `{ok:false, error:"signature_missing"}` (never 404 or HTML) with or without the key,
plus the change suite and `npm run test:roles` as `existing` suites (validated with `run.mjs check-pr`, commands.log). Not
verified on staging with a real event: a signed delivery would write OASIS rows to the shared database (CLAUDE.md rule 48);
the mapper is covered by Jest and goes live at the cutover. The workflow step (Infrastructure/CI) first runs in the staging
deploy after the merge: its log line is "vitana/gateway/staging/gitlab-webhook-signing-token not found -
GITLAB_WEBHOOK_SIGNING_TOKEN not wired" until the owner runs `setup-gitlab-webhook-secret.sh --apply` (plan §6 step 7),
then "resolved … -> GITLAB_WEBHOOK_SIGNING_TOKEN". It is not dispatched from this branch (no workflow dispatch from a
builder session); before the merge its own `run:` block is executed by the W3 tests against a stubbed `aws`.
Sibling sweep: `AWS-PROD-DEPLOY-GATEWAY.yml` is intentionally unchanged (protected gate file; no hook exists before the
cutover; AC-14 asserts it). `connectors/runtime/webhook-signature.ts` and `autopilot-event-mapper.ts` are not edited.
Readers that match OASIS topics by substring, checked and left unchanged: routes/vtid.ts:1013-1094 (the VTID list
projection; why the merge request topics carry a stage, Decisions 2), routes/vtid-terminalize.ts:138 (counts any topic
containing `.merged` as merge evidence for a terminalization someone else requests; correct for a real GitLab merge once
hooks exist at the cutover), services/gemini-operator.ts:2640-2648 (summary wording only), routes/events.ts:1167 (stage
status only for events with a stage; the pipeline topics have none).

Red on base (outputs/red-on-base.txt, base 945755f084, no-behaviour stubs outside the repository): run A, the four suites
that import a lane module cannot load and staging-wiring fails 17 of 18; run B, with stubs, 108 tests: 106 fail, 2 pass (the
two guards that are true on base: no lifecycle rule lists `scm.gitlab.*`, production workflow not wired); run C, tsc exit 2
with 22 errors without the five literals.
Green (outputs/green.txt): 108 tests, 108 pass (route 35, mapper 42, dedupe 9, oasis-write 4, staging-wiring 18).
Typecheck exit 0; build exit 0; `npm run test:operator` 71/71 (CLAUDE.md 42e); workflow suites 102/102 suites, 1370 tests;
other suites that read index.ts or cicd.ts or walk the routes 59 suites, 1162 tests, all pass; whole gateway suite 29,267
tests: 29,204 pass, 3 fail, 54 skipped (outputs/full-suite.txt: the atlas red below and two sandbox-environment failures
that fail the same way on base).
Known red: `npm run test:roles` (CLAUDE.md 42h) is 104/105: the atlas drift guard "every gateway route file is claimed by at
least one domain" (test/vtid-04560-role-separation-regression.test.ts:524) fails for the new routes/internal-gitlab-webhook.ts
because no domain of services/gateway/src/orb/developer/domain-atlas.ts claims it yet. That file is outside this lane's
paths; lane agentic-delivery/prerequisites (PR #4690, VTID-05551, open) adds `/^internal-gitlab-webhook$/`. Not worked
around: this lane stays `executing` until that lands and this branch takes `main`.

Decisions taken (inside the plan, the conservative option each time):
1. An unsigned request is refused 401 before the key is read, so the STAGING-VERIFY probe has one answer whatever the key
   state (a write probe may only expect 401 or 403, scripts/ci/staging-verify/lib.cjs:169); a signed delivery with no key is
   500 `not_configured` (plan §9 lists both answers).
2. The merge request topics carry `task_stage` `VALIDATOR`: without a stage `emitOasisEvent` infers `DEPLOY` from "merge"
   (oasis-event-service.ts:23), and the VTID list shows a non-terminal Deploy-stage VTID whose latest event says "merged"
   as Done (routes/vtid.ts:1082-1088). The pipeline topics get no stage (the inference gives none).
3. `scm.gitlab.pipeline.failed` has status `warning`, never `error`: the lifecycle mapper's `*.failed` catch-all moves a
   VTID to failed when the status is `error` (autopilot-event-mapper.ts:484-498).
4. The VTID is a whole token, `\bVTID-\d{5}\b`: `VTID-123456` or `XVTID-12345` is not read as a VTID (an event is ignored
   rather than attached to the wrong VTID).
5. Dedupe is in memory per gateway task (plan §8), 24 h and 10,000 ids, so a Standard Webhooks retry with a new timestamp
   is still dropped; an id counts only after its row was written.
6. Body limit 2mb, as the vendor webhook mount (index.ts:624).
7. Setup script: the engineering account is the ACTIVE account named `vitana-engineering` in AWS Organizations (M1 plan §3,
   account created by `setup.sh`) or `--source-account`; the role is `OrganizationAccountAccessRole` (the role Organizations
   creates) or `--source-role`. During this build the assumed-role credentials were moved off `env`'s argument list into a
   subshell environment; the new test fails on the previous version (commands.log step 9).
8. Once wired, the secret reference stays in the staging task definition like every other connected-apps secret (the roll
   step strips a name only when it is present again, AWS-STAGE-DEPLOY-GATEWAY.yml:1353); the secret is not meant to be
   deleted.
9. staging-tests.json also lists `npm run test:roles`, so STAGING-VERIFY proves the atlas claim on the merge commit.
10. Red on base was run on 945755f084, the branch's merge base; origin/main 29b639da4b adds only VTID-05529, which touches
    no file these tests read or import. `main` is not merged into this branch (the driver brings it up to date before review).
