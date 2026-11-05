# VTID-05541 acceptance (eng-gitlab-m2/scm-webhook)
Change types: Backend, Integration, Infrastructure/CI.
Outcome: when GitLab sends a signed merge-request or pipeline event, the gateway records the matching OASIS event once,
with the VTID from the merge request title (or the commit title); an unsigned, stale, altered or replayed delivery is
refused or acknowledged without a second row. Nothing changes for members, and no GitLab event moves a VTID's state in
this milestone.

AC-1 A delivery signed the Standard Webhooks way (`webhook-id`, `webhook-timestamp`, `webhook-signature`; HMAC-SHA256
over `${id}.${timestamp}.${raw}` with the base64 key of `GITLAB_WEBHOOK_SIGNING_TOKEN`) is verified by the shared
`verifySvix` (`connectors/runtime/webhook-signature.ts:59`), which is not edited; the route maps the headers itself.
TEST: internal-gitlab-webhook.test.ts "a signed merge request event is recorded once…", "bytes that JSON re-serialization would change still verify…"
CURL: outputs/curl-proof.txt step 2 (signed push event → 202).
AC-2 A bad signature, a signature over other bytes, a stale timestamp, missing headers and a request with only `svix-*`
headers get 401 JSON and record nothing.
TEST: "a bad signature is refused…", "a signature over other bytes is refused…", "a stale timestamp is refused…", "a request that carries only svix-* headers is refused…"
CURL: outputs/curl-proof.txt steps 1 and 4.
AC-3 Fails closed: a signed delivery while no key is set (or a key that decodes to nothing) gets 500 JSON
`not_configured`; an unsigned request gets 401 whether or not a key is set, so the staging probe has one answer.
TEST: "a signed delivery with no signing key configured fails closed…", "a key that decodes to nothing…", "an unsigned request gets 401 JSON whether or not a key is set…"
CURL: outputs/curl-proof.txt steps 1 and 5.
AC-4 The five events of plan §3.5 map to the five new topics: merge request open and reopen → `scm.gitlab.merge_request.opened`,
merge → `.merged`, close → `.closed`; pipeline success → `scm.gitlab.pipeline.succeeded`, failed → `.failed`.
TEST: internal-gitlab-webhook.test.ts the six "→" cases; map.test.ts "merge_request action … →", "pipeline status … →".
AC-5 The VTID is the first `VTID-\d{5}` in the merge request title (merge request events), or in `merge_request.title`
and then `commit.title` (pipeline events); a longer number is not a VTID. No VTID, another event kind, another action
or another pipeline status → 202 JSON, nothing recorded.
TEST: map.test.ts "a pipeline takes the merge request title first…", "firstVtid takes the first five-digit VTID…", "… is ignored"; internal-gitlab-webhook.test.ts "… is acknowledged with 202 and records nothing".
AC-6 A resend with the same `webhook-id` gives 200 `duplicate` and no second row; when OASIS cannot record the event the
answer is 503 and the same delivery, resent, is processed; an emitter that throws gives 503, never an unhandled error.
TEST: "the same webhook-id twice records one event…", "when OASIS cannot record the event the answer is 503…", "an emitter that throws gives 503…"; map.test.ts createDeliveryIdStore cases.
CURL: outputs/curl-proof.txt step 3.
AC-7 Malformed JSON after a valid signature → 400 JSON; a body over 1 MB → 413 JSON (not Express's HTML page); any content
type is read raw.
TEST: "a signed body that is not JSON gets 400 JSON", "a body over 1 MB gets 413 JSON…", "any content type is read raw…"
CURL: outputs/curl-proof.txt step 6.
AC-8 The raw parser for the path is mounted before `express.json()` in `index.ts`, and the router is mounted at
`/api/v1/internal/gitlab` through the route guard.
TEST: "index.ts mounts the raw parser for the path before express.json() and mounts the router"; "the default router reads GITLAB_WEBHOOK_SIGNING_TOKEN…"
AC-9 The five topics are members of the closed union `CicdEventType` (`types/cicd.ts:139`): `npm run typecheck` fails
otherwise, because `GitlabTopic` is `Extract<CicdEventType, …>`. No existing `cicd.*` topic is emitted, and no rule of
`autopilot-event-mapper.ts` lists `scm.gitlab.*`; that file is not edited.
TEST: map.test.ts "all five topics are new scm.gitlab.* names…", "no rule of autopilot-event-mapper.ts lists a scm.gitlab.* topic…", "the route and the mapper emit no existing cicd.* topic"; outputs/typecheck.txt (exit 0).
AC-10 Staging gets the key only when `vitana/gateway/staging/gitlab-webhook-signing-token` exists (step "Resolve GitLab
webhook signing key" of `AWS-STAGE-DEPLOY-GATEWAY.yml`, before the task definition is built; absent: not wired, the
deploy never fails); production is not wired; `scripts/aws/setup-gitlab-webhook-secret.sh` copies the value from the
engineering account, dry run by default, never printing it.
TEST: test/gitlab-events/staging-wiring.test.ts (4 tests); the 102 gateway suites that read the staging workflow stay green (outputs/workflow-tests.txt).

ROUTE_MOUNT: `services/gateway/src/index.ts` — `internalGitlabWebhook.mountGitlabWebhookParsers(app)` before `app.use(express.json({ limit: '2mb' }))`, and `mountRouterSync(app, '/api/v1/internal/gitlab', internalGitlabWebhook.default, { owner: 'internal-gitlab-webhook' })` next to the other `/api/v1/internal/*` mounts.
FINAL_URL: POST https://preview-aws-gateway.vitanaland.com/api/v1/internal/gitlab/webhook (staging). Production does not get the key in this milestone.
CURL_PROOF: outputs/curl-proof.txt — six requests against the route built from this branch's dist exactly as index.ts mounts it: unsigned 401, signed unmapped 202, resend 200 duplicate, altered body 401, no key 500 `not_configured`, over 1 MB 413; every reply JSON.
OASIS_PROOF: the route writes OASIS events only through `emitOasisEvent` (`services/oasis-event-service.ts:59`), with `vtid`, `type` (one of the five topics), `source: gitlab-webhook`, `status`, `message`, `actor_role: system`, `surface: cicd` and a payload of identifiers (project, iid, branch, SHA, URL, `webhook_id`), never a description or a token (internal-gitlab-webhook.test.ts "a signed merge request event is recorded once…" asserts the exact event). Real rows appear only when the GitLab project webhook is switched on (plan §10, the vitana-v1 cutover); the staging probe sends no signed event, so it writes nothing.

States: key missing (500 `not_configured` for a signed delivery; 401 for an unsigned one); bad or stale signature (401);
duplicate id (200, no second row); unknown event, action or status, or no VTID (202); malformed JSON (400); body too large
(413); OASIS down (503, the resend is processed).
Surfaces: callers: the GitLab project webhooks (switched on at the cutover). Consumers: the OASIS event feed only; the
VTID lifecycle mapper and the Command Hub's reading of `cicd.*` topics are not changed.
Locales: n/a (machine route). Accessibility: n/a.
Contract: request headers `webhook-id`, `webhook-timestamp`, `webhook-signature`, raw JSON body; replies always JSON; no
JWT, the signature is the gate; the five topics of plan §3.5.
Staging proof: `docs/validation/VTID-05541/staging-tests.json` — an unsigned POST is a rejected probe that must answer 401
JSON (never 404 or HTML), plus the route suites as an `existing` test. Not verified on staging with a real signed event:
it would write OASIS rows to the shared database; the mapping is covered by Jest and goes live at the cutover.
Sibling sweep: `AWS-PROD-DEPLOY-GATEWAY.yml` is intentionally unchanged (protected gate file; no hook exists before the
cutover), and `staging-wiring.test.ts` asserts it does not name the key.

Red on base: outputs/red-on-base.txt — the suites run against stub modules that export the same names with no
behaviour: 42 of 69 tests fail, one or more for every new behaviour; the 27 that pass are the "is ignored" cases and file
checks that a do-nothing stub also satisfies. Green: outputs/green.txt (73 tests, the two route suites and the wiring
test). Typecheck: outputs/typecheck.txt. Operator regression (CLAUDE.md 42e): outputs/operator-regression.txt (71/71).

Known red until a prerequisite lands: `npm run test:roles` fails one test, the atlas drift guard
(`test/vtid-04560-role-separation-regression.test.ts:524-528`), because no domain of
`orb/developer/domain-atlas.ts` claims `routes/internal-gitlab-webhook.ts` and that file is outside this lane's paths
(outputs/roles-atlas.txt). Lane `prerequisites` of plan `agentic-delivery` adds the claim (domain `deploy`) and lands
first; this PR is then brought up to date with `main` and must be fully green before review.

Decisions taken inside the plan (for Gate 2):
- An unsigned request gets 401 before the key is looked at, so the staging probe has one answer whether or not the key
  is set, and an unsigned caller learns nothing about the configuration; a signed delivery with no key still gets 500
  `not_configured` (plan §3.5).
- A delivery that OASIS could not record answers 503 and its `webhook-id` is not remembered, so a resend is processed;
  an ignored delivery (202) is remembered.
- The body limit is 1 MB; GitLab merge request events with long descriptions stay far below it.
- The optional secret follows the existing staging pattern exactly (strip-then-add by name in the roll step): like the
  other optional secrets there, removing the secret later does not remove an earlier task definition's reference.
