# VTID-05547 acceptance (agentic-delivery/gateway-delivery)
Change types: Backend, Integration, UI.

Lane `gateway-delivery` of plan `agentic-delivery` (vitana-platform), tasks G1-G4 of `.kiro/specs/agentic-delivery/tasks.md`; plan §3.11
(the record), §3.12 (Command Hub: the Delivery screen), §3.13 (the guards), §10 (measurement). Builder session
`kiro-exafy-202611021438-cff7` (seat exafy). Built on the stacked base `4c3d2341f2b` (origin/main plus the sibling lanes); the lane
commit now sits on `origin/main` `7fd4106862d` (cherry-picked; the sibling lanes are on main). Every check below that depends on the
code was re-run on that tree; the red-on-base recording stays from `4c3d2341f2b` (the 12 gateway files that differ between the two
bases are memory, ORB and approvals files; `test/delivery` imports none of them directly).

Outcome: every GitLab delivery step the two project webhooks send appears once in OASIS with its VTID (merge request, push,
review entry, lane-file change, pipeline, landing, staging deploy, rollback, cut tag, moved pull request). After the cut
(`DELIVERY_HOST_<REPO>=gitlab`) the gateway never merges or updates a branch on GitHub for that repository: it refuses with
`merge_moved_to_gitlab` and records `delivery.merge.refused`. The owner opens Command Hub → Delivery and sees both
repositories' merge queues, pipelines, staging deploys and the latest STAGING-VERIFY, read only from `vtid_ledger` and
`oasis_events`. The flag is unset on staging and production, so merging this lane changes no merge behaviour.

States: no events yet (an empty state per repository, with GitHub wording before the cut); route error (inline alert with
Retry); slow response (a loading note, role status); unknown GitLab event (202 ignored, with the reason); duplicate (200,
one row); shadow events (marked `metadata.mode: shadow`, hidden unless `?include_shadow=1` or the toggle); flag unset (no
change); flag set (merge refused, nothing sent to GitHub).

Surfaces: Command Hub → Delivery → Merge queue / Pipelines / Releases at 1400×900 and 390×844 (`outputs/*.png`);
`GET /api/v1/delivery/summary` and `/metrics` (callers: the Command Hub with an exafy_admin session, or a service token);
`POST /api/v1/internal/gitlab/webhook` (callers: the two project webhooks); the merge guard (callers: `safeMerge` in
`routes/cicd.ts`, the Project Manager, Dev Autopilot's watcher and bridge, and `approvals.ts` / `execute.ts` through
`/api/v1/github/autonomous-pr-merge`).

Locales and accessibility: the Command Hub is an English admin surface like its other modules (no member-visible text, no
LLM text). Named tabs and tables with column scope, real buttons, a labelled checkbox, the page's keyboard order, AA contrast
measured on the theme (pills 4.6 to 6.9, links 5.75, secondary cells 5.71; the stylesheet's `status-success`, `status-error`
and `status-info` measure 4.48, 3.40 and 3.29 and are not used), and every state also carried by its label.

Contract (file:line on this branch):
- Route: `routes/delivery.ts` `createDeliveryRouter` :85, `GET /summary` :101, `GET /metrics` :138, both behind
  `requireServiceOrAdmin` (exafy_admin or service token; no token is 401 JSON); read page `EVENT_READ_LIMIT` :39; mount
  `index.ts:1542` (`mountRouterSync(app, '/api/v1/delivery', deliveryRouter, { owner: 'delivery' })`).
- Webhook stage: `services/gitlab-events/delivery-stage.ts` `createGitlabDeliveryStage` :48, mounted `index.ts:1292` just before
  the unchanged M2 router mount `index.ts:1294`; the signature check is M2's `requireGitlabSignature`, called unchanged.
- Mapper: `services/gitlab-events/delivery-mapper.ts` `mapGitlabDelivery` :714; M2's `mapper.ts` events are kept and only get
  the delivery fields added.
- Guard: `services/delivery-host.ts` (`deliveryHostFor` :52, `checkGithubMerge` :61, `MergeMovedToGitlabError` :69,
  `MERGE_MOVED_TO_GITLAB` :30); the two calls in `services/github-service.ts` :681 (`update_branch`) and :700 (`merge`).
  The refusal is a thrown `MergeMovedToGitlabError` (code `merge_moved_to_gitlab`) after one `delivery.merge.refused`
  event, not a return value (Decisions 1).
- Topics: the eleven new members of `CicdEventType` (`types/cicd.ts:139`) at :1232-:1242.
- Command Hub: `app.js` `NAVIGATION_CONFIG` entry :3364, `SECTION_LABELS` :3562, `deliveryModule` :8012, the render switch
  :8054; `delivery.js` (`DeliveryScreen`, `render` :359, `root.DeliveryScreen` :377); `index.html` :7 and :32 (`?v=` bump);
  `navigation-config.js` (regenerated, `module: "delivery"`) and `specs/dev-screen-inventory-v1.json` (three `DEV-*` screens).

AC-1 A `main` pipeline event whose commit has the landing trailers gives one `delivery.landed`, a fact with one key whether it
is seen at running, success or failed; seconds from accept to land are `null` (never 0) when the trailer or time is missing;
no `Merge-Request` trailer, another ref or a tag gives no landing.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "a main pipeline with the trailers gives one delivery.landed",
"the landing seen at running, success and failed has the same dedupe key (one fact)", "seconds from accept to land are null,
never 0, when the trailer or the commit time is missing or odd", "a main pipeline without the Merge-Request trailer gives no
delivery.landed", "a pipeline of another ref, or of a tag, gives no landing and no deploy event"; and
services/gateway/test/delivery/gitlab-delivery-webhook.test.ts "a main pipeline records the pipeline, the landing and the staging deploy, in order, and replies with all three".

AC-2 The deploy job of a main pipeline gives `staging.deploy.completed` with the commit, or `staging.deploy.failed` with
status `warning` (never `error`); the rollback job gives `staging.deploy.rolled_back`; a canceled or skipped deploy job and a
failed rollback job give nothing; a deploy job with no service suffix and an unrelated job name are read correctly.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "the deploy job success gives staging.deploy.completed with
the commit", "the deploy job failure gives staging.deploy.failed with status warning, never error", "the rollback job gives
staging.deploy.rolled_back", "a deploy job that was canceled or skipped, and a failed rollback job, give no staging.deploy
event", "a deploy job found on a canceled pipeline still counts when it finished", "a deploy job with no service suffix, and an
unrelated job name, are read correctly".

AC-3 A queue-label change gives `scm.gitlab.merge_request.updated` (moving between two labels records both); a new head gives it
with `new_head: true`; an update that changes neither is ignored (`unmapped_action`); one without a VTID in the title is ignored
(`no_vtid`); opened, merged and closed keep M2's events and add the lane key and the queue label.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "a queue label change gives scm.gitlab.merge_request.updated",
"moving from one queue label to another records both", "a new head (oldrev) gives scm.gitlab.merge_request.updated with new_head
true", "an update that changes neither the queue label nor the head is ignored (unmapped_action)", "an update without a VTID in the
title is ignored (no_vtid)", "opened, merged and closed keep the events of mapper.ts and add the lane key and the queue label".

AC-4 Pipeline `running` and `canceled` give `scm.gitlab.pipeline.started` and `.canceled`; other statuses are ignored; success
and failed with no VTID anywhere use `BOOTSTRAP-DELIVERY` (a nightly run); the VTID is the merge request title's first, then the
commit title's; each job is summarised by name, status, wait and run seconds and nothing else of the builds.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "pipeline running and canceled give
scm.gitlab.pipeline.started and .canceled", "other pipeline statuses are ignored (unmapped_status)", "success and failed with no
VTID in either title use BOOTSTRAP-DELIVERY (a nightly run)", "the VTID of a pipeline is the merge request title first, then the
commit title", "pipeline events carry each job's name, status, wait and run seconds, and nothing else of the builds", "jobsOf
bounds the list and tolerates odd input".

AC-5 The tags `delivery/cutover-<repo>` give `scm.migration.cutover` (another tag, another repository's tag and a deleted tag are
ignored); a merge request opened with a "Moved from <pull request URL>" line gives `scm.migration.pr_moved` next to
`scm.gitlab.merge_request.opened`, also for a plan pull request with no VTID (under `BOOTSTRAP-DELIVERY`), and only for a pull
request of the two repositories.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "the tags delivery/cutover-<repo> give scm.migration.cutover",
"another tag, a tag of another repository, and a deleted tag are ignored", "a merge request opened with a \"Moved from <PR URL>\"
line gives scm.migration.pr_moved, next to scm.gitlab.merge_request.opened", "a moved plan pull request with no VTID in its title
still gives scm.migration.pr_moved, under BOOTSTRAP-DELIVERY", "only a GitHub pull request of the two repositories counts as
moved".

AC-6 Shadow runs are marked `metadata.mode: shadow` (a run is shadow unless this gateway delivers the repository on GitLab, or
`DELIVERY_MODE=shadow` is a pipeline variable, or the project is not one of the two); a shadow run writes no `staging.deploy.*`
and no `delivery.landed` (GitHub stays the only writer of deploy and verification rows until the cut), but its pipeline,
merge request, push and tag rows carry the mode.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "a run is shadow unless this gateway delivers the repository
on GitLab", "DELIVERY_MODE=shadow in the pipeline variables makes the run shadow even when the flag is set; other values change
nothing", "a shadow run writes no staging.deploy.* and no delivery.landed, but its pipeline row is marked shadow", "a project that
is not one of the two repositories (a rehearsal) is always shadow", "pushes, merge requests and tags carry the mode too"; and
services/gateway/test/delivery/gitlab-delivery-oasis-write.test.ts "a shadow delivery is written, marked shadow, with no deploy and no landing row".

AC-7 Every event has a VTID or `BOOTSTRAP-DELIVERY`, `metadata.dedupe_key`, `plane: delivery`, `host: gitlab` and a mode; it never
carries the description, the user, labels other than the queue label, the changes, pipeline variables or raw builds; long strings
are cut to 512 characters; hostile payloads never throw; the rows written to `oasis_events` hold the same.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "every event has a VTID or BOOTSTRAP-DELIVERY,
metadata.dedupe_key, plane delivery, host gitlab and a mode", "the dedupe key is stable for the same fact and differs for a
different state", "never carries the description, the user, labels other than the queue label, the changes, pipeline variables or
raw builds", "long strings are cut to 512 characters and odd fields become null", "an unknown event, hostile payloads and
non-objects are ignored and never throw", "an unknown project still maps, under an unknown-project scope"; and
services/gateway/test/delivery/gitlab-delivery-oasis-write.test.ts "a main pipeline: three rows, each with the delivery metadata
and the right stage", "the stored metadata never holds the description, the user, a variable or a raw build"; the readers of the payload in
services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "parseTrailers takes the last whole-line \"Key: value\" for each wanted key and nothing else", "queueLabel finds the queue-* label among objects or strings, and only those", "laneKeyOf reads the lane from a title with a VTID and nothing else".

AC-8 Exactly once: a duplicate webhook-id answers 200 `duplicate` and records nothing more (also when the same id comes with
another body); the same fact from another delivery is one row (a duplicate `dedupe_key` records nothing); a failing second event
answers 502 and the retry of the same delivery writes only what is missing; an OASIS write that throws answers 502 without the
error text; the stage answers the delivery itself, so M2's router behind it never writes a second, plain event.
TEST: services/gateway/test/delivery/gitlab-delivery-webhook.test.ts "a duplicate webhook-id answers 200 duplicate and records
nothing more", "a webhook-id that was recorded is a duplicate for good: another body with that id records nothing and reads
nothing", "the same fact from another delivery (another webhook-id) is one row: a duplicate dedupe_key records nothing", "the
second event failing answers 502, and the retry of the same delivery writes only what is missing", "the OASIS write throwing
answers 502 without the error text", "the stage answers the delivery itself: the M2 router behind it does not emit a second, plain
event"; and services/gateway/test/delivery/gitlab-delivery-oasis-write.test.ts "the OASIS write failing answers 502 and the retry
records the row".

AC-9 A push to an agent branch gives `scm.gitlab.push` with the VTID of its branch's merge request (taken from the index, then a
read-only OASIS lookup, then the commit titles, then `BOOTSTRAP-DELIVERY`); a pushed commit with `Collab-Verdict` gives one
`delivery.review.recorded`; a commit that changes a lane file gives one `delivery.lane.updated` per lane file; other branches,
non-branch refs and a deleted branch are ignored; at most 20 commits and 100 events of one push are read.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "a push to an agent branch gives scm.gitlab.push with the
VTID of its branch's merge request", "a branch this task has not seen is looked up through the injected lookup; a failing lookup
falls back to the commit titles, then BOOTSTRAP-DELIVERY", "a pushed commit with Collab-Verdict gives one
delivery.review.recorded", "a verdict other than accept or changes, or a reviewed head that is not 40 hex, is not trusted", "a
pushed commit that changes a lane file gives one delivery.lane.updated per lane file", "a review entry commit gives the push, one
review and one lane update", "pushes to other branches, to refs that are not branches, and a deleted branch are ignored", "looks at
no more than 20 commits and 100 events of one push"; and services/gateway/test/delivery/gitlab-delivery-webhook.test.ts "a push
with a review entry records the push, the review and the lane update", "a merge request opened and then pushed to: the push takes
the VTID of the merge request seen by this task", "asks the merge request rows of the branch and returns the VTID of the newest", "answers null for no row, an upstream error, a throw, a VTID that is not VTID-\d{5}, no project and no credentials", "a push handled by a task that has not seen the merge request uses the lookup"; and
services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "the index is not asked twice for a branch it knows, and a lookup is not used when the index has the VTID", "the agent branches are kiro, claude, assist and pm-agent", "the branch index keeps the newest entries and drops the oldest first", "a merge request event teaches the index its branch, and only with a VTID in the title"; and
services/gateway/test/delivery/gitlab-delivery-oasis-write.test.ts "a push with a review entry: push, review and lane rows; the review row names the lane, verdict and model".

AC-10 No delivery event can move a VTID: no rule of `autopilot-event-mapper.ts` lists a `scm.gitlab.*`, `scm.migration.*` or
`delivery.*` topic or `staging.deploy.rolled_back`; none of the corpus's events, with the status given, matches a rule in any
state; no `.failed` or `.error` topic is written with status `error`; merge request topics carry the `VALIDATOR` stage so the word
"merge" does not infer Deploy.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "no rule of autopilot-event-mapper.ts lists a scm.gitlab.*,
scm.migration.* or delivery.* topic, or staging.deploy.rolled_back", "none of the events of the corpus, with the status given,
matches a rule in any state", "no topic ending in .failed or .error is written with status error", "the merge request topics carry
the VALIDATOR stage, so the word \"merge\" does not infer the Deploy stage"; and
services/gateway/test/delivery/gitlab-delivery-oasis-write.test.ts "the merge request topics are written with the VALIDATOR stage, never an inferred Deploy stage".

AC-11 Every topic the layer writes is a literal of `CicdEventType`; M2's events are kept as they are (the delivery fields are added,
nothing is changed or removed); the pipeline event built for a delivery with no VTID has the shape M2 gives one with a VTID.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts "every topic this layer writes is a literal of the
CicdEventType union in types/cicd.ts", "the events of mapper.ts are kept as they are: the delivery fields are added, nothing is
changed or removed", "the pipeline event built for a delivery with no VTID has the shape mapper.ts gives one with a VTID".

AC-12 The M2 signature check is unchanged and every reply is JSON: unsigned 401 `signature_missing` with the key set and not set;
signed with no key 500 `not_configured`; wrong key, altered body, stale timestamp and `svix-*`-only headers 401; unmapped event
202 with the reason; malformed JSON 400; oversize 413; a method other than POST falls through to Express.
TEST: services/gateway/test/delivery/gitlab-delivery-webhook.test.ts "the unsigned staging probe → 401 signature_missing JSON, with
the key set and with no key configured", "a signed delivery with no key configured → 500 not_configured, nothing recorded", "a
signature made with another key, an altered body, a stale timestamp and svix-* headers only are refused 401", "an event it does
not map is acknowledged and ignored with the reason (202)", "malformed JSON with a valid signature → 400 invalid_json", "a body
over the limit → 413 payload_too_large, as JSON", "any method but POST falls through to Express (no GET handler, no HTML error page
from the stage)".

AC-13 `index.ts` mounts the stage as middleware just before M2's unchanged router mount and after the raw-body parser, and mounts
the Delivery routes once, through the route guard.
TEST: services/gateway/test/delivery/gitlab-delivery-webhook.test.ts "mounts the stage as middleware on the webhook path, just
before the unchanged M2 router mount, after the raw body parser", "mounts the Delivery read routes once, through the route guard";
and the unchanged M2 suites (`test/routes/internal-gitlab-webhook.test.ts`, `test/gitlab-events`) in `outputs/staging-existing-suites-local.txt`.

AC-14 With `DELIVERY_HOST_<REPO>=gitlab`, `mergePullRequest` and `updatePullRequestBranch` for that repository make no GitHub
call, refuse with `merge_moved_to_gitlab` and emit one OASIS event (`delivery.merge.refused`, `BOOTSTRAP-DELIVERY` when the title
has no VTID); the other repository is not affected; a failing OASIS write never stops the refusal.
TEST: services/gateway/test/delivery/delivery-host-guard.test.ts "mergePullRequest makes no GitHub call, refuses with
merge_moved_to_gitlab and emits one OASIS event", "updatePullRequestBranch makes no GitHub call, refuses and emits one OASIS
event", "a commit title without a VTID gives the BOOTSTRAP-DELIVERY VTID; the first VTID of a title with several is used", "the
other repository is not affected by this repository's flag", "a failing OASIS write never stops the refusal", "means GitLab only
for the value \"gitlab\" (any case, trimmed); unset, empty and anything else mean GitHub", "is named after the repository, upper-cased, other characters as \"_\"", "is per repository: one flag does not move the other", "checkGithubMerge is the same decision as plain data, with no event", "assertGithubMergeAllowed takes the environment and the emitter as dependencies".

AC-15 With the flag unset (or `github`, empty, anything else) both calls behave exactly as before: same URL, method, body and token,
same answer, a GitHub error reaches the caller unchanged.
TEST: services/gateway/test/delivery/delivery-host-guard.test.ts "mergePullRequest calls GitHub with the same URL, method, body and
token, and returns its answer", "updatePullRequestBranch calls GitHub with the same URL, method and body", "a flag set to github,
empty or something else changes nothing", "a GitHub error still reaches the caller unchanged (the guard does not catch it)".

AC-16 `safeMerge` and the Project Manager's merge report the refusal as blocked, not as an error loop: `safeMerge` answers
`refused` with one `safe_merge.blocked` event, no `executed` event and no GitHub merge call; the Project Manager records
`merge_refused`, does not set the lane done and throws nothing; with the flag unset both merge and record as before.
TEST: services/gateway/test/delivery/delivery-host-guard.test.ts "safeMerge with the flag set: refused, one safe_merge.blocked
event, no executed event, no GitHub merge call", "the Project Manager with the flag set: merge_refused, the lane is not set done,
nothing is thrown", "safeMerge with the flag unset merges and records the merge as before", "the Project Manager with the flag
unset still merges and sets the lane done".

AC-17 Route auth: no token is 401 JSON and nothing is read; a wrong bearer is 401 and a signed-in non-admin 403; the gateway
service token and an exafy_admin session get 200; the default router answers 401 without reading anything.
TEST: services/gateway/test/delivery/delivery-route.test.ts "no token → 401 JSON, and nothing is read", "a wrong bearer → 401; a
signed-in non-admin → 403", "the gateway service token and an exafy_admin session → 200", "the default router answers 401 without a
token and never reads anything".

AC-18 The summary is built only from `vtid_ledger` and `oasis_events` fakes (nothing else is fetched): the delivery topics of the
window and the ledger rows of the VTIDs shown; queue order from the labels (updating, ready by accept time, waiting; blocked and
paused last, no position); merged, closed and unlabelled merge requests are off the queue; both repositories are always present
(empty state); the latest pipeline per merge request and the state of main; staging deploys and STAGING-VERIFY per service from
GitHub-era and GitLab rows; shadow rows hidden unless asked; one row per `dedupe_key`; the host of each repository from the flag;
refused merges counted; the window is clamped and a full page of 3000 events is reported as truncated; an unreachable source
answers 502 JSON with no error text.
TEST: services/gateway/test/delivery/delivery-route.test.ts "reads the delivery topics of the window from OASIS and the ledger rows
of the VTIDs it shows, and nothing else", "the queue order comes from the labels: updating, then ready by accept time, then
waiting; blocked and paused last with no position", "a merged or closed merge request, and one with no queue label, are not in the
queue; each repository has its own queue", "both repositories are always present, empty when there are no events (the empty
state)", "the latest pipeline per merge request, the state of main, and the job counts", "releases: the latest staging deploy per
service (GitHub-era and GitLab rows) and the latest STAGING-VERIFY per service", "shadow rows are left out unless
?include_shadow=1; a duplicate dedupe_key is one row", "reports the host of each repository from the cut flag, and the refused
GitHub merges", "the window: ?hours is clamped to 1..720 and a bad value uses the default; a full page is reported as truncated",
"one read is a bounded page of the newest 3000 events: a full page is reported as truncated, a page short of it is not", "an
unreachable source answers 502 JSON with no error text, for both routes", "postgrestReaders reads with GET, the service role and
the topic and window filters; the ledger only for the VTIDs asked", "postgrestReaders fails closed: no credentials, or an upstream
error status, is an error (the route turns it into 502)", "dedupeRows keeps the earliest row of a key, and every row with no key", "the builders tolerate rows with missing or odd metadata".

AC-19 A metric without a source is `null`, never 0 (all eleven figures are `null` with no events; `cost_per_day` is always `null`);
the figures with a source are computed (nearest-rank percentiles); change failure counts a landing followed from the landing to 24
hours after it by a red main of the same repository, or by a failed STAGING-VERIFY naming its VTID; landing to verify takes the
first result at or after the landing that names its VTID; time to restore runs from the first red main to the next green one of
the same repository; shadow rows never count.
TEST: services/gateway/test/delivery/delivery-route.test.ts "with no events every figure is null", "computes the figures that have
a source", "change failure: a landing followed within 24 hours by a red main or a failed STAGING-VERIFY of its VTID", "change
failure: a red main of the same repository from the landing to 24 hours after it, or a failed STAGING-VERIFY naming its VTID",
"landing to verify: the first STAGING-VERIFY result at or after the landing that names its VTID", "time to restore: the first failed
main pipeline of a repository to its next successful one; other refs and other repositories do not restore it", "shadow rows never
count in a figure", "spread is nearest-rank and null for nothing", "buildMetrics on its own takes rows, now and the window".

AC-20 The Delivery module is in `NAVIGATION_CONFIG` (app.js), the regenerated `navigation-config.js` and the screen inventory, with
tab keys that collide with no screen id (`pipeline-runs`, shown as "Pipelines", because `pipelines` is `DEV-PIPELINES` of Agents);
the CI's dev frontend spec validator accepts it; the render switch hands every Delivery tab to `deliveryModule.view`, which loads
`delivery.js` on demand from the same origin (one script element however many tabs open, an alert and a retry on the next tab
when it does not load).
TEST: services/gateway/test/delivery/command-hub-delivery.test.ts "the Delivery module is in NAVIGATION_CONFIG: app.js, the
regenerated navigation-config.js and the screen inventory agree", "the Delivery tab keys do not collide with any other screen id
(the key \"pipelines\" would be DEV-PIPELINES of Agents)", "the dev frontend spec validator accepts the module (the same check the
CI runs)", "the render switch hands every Delivery tab to deliveryModule.view, which loads delivery.js on demand from the same
origin", "the first tab adds one same-origin script element; a tab opened while it loads adds none; both draw when it has loaded",
"once loaded no element is added again; the screen is drawn at once", "a script that does not load shows an alert, and the next
tab that opens tries again".

AC-21 CSP: `delivery.js` has no `innerHTML`, inline handler, `eval`, inline style or embedded script or style tag and calls only its
own origin; `index.html` keeps its script list and has no inline script or style (`delivery.js` is loaded by `app.js`, so it is not
a tag and not in `modules.json`); `app.js` and `styles.css` were bumped together to a new `?v=` that keeps the old marker as its
prefix (CLAUDE.md IF–THEN 25), and every staging suite that names the old version follows (VTID-04696).
TEST: services/gateway/test/delivery/command-hub-delivery.test.ts "delivery.js: no innerHTML, no inline handler, no eval, no inline
style, no embedded script or style tag", "index.html keeps its script list and has no inline script or style; delivery.js is not a
tag of it and not in modules.json", "app.js and styles.css were bumped together, to a new value that keeps the old marker as its
prefix"; and services/gateway/test/vtid-04696-staging-checks-follow-asset-bumps.test.ts (unchanged) in
`outputs/staging-existing-suites-local.txt`, with `outputs/asset-bump-follow.txt` (30 suites, only the version token changed).

AC-22 The three tabs draw from the real response of the route: Merge queue (a section and a named table per repository, the VTID
title from the ledger, a "Landing paused" pill, GitHub wording for a repository not cut over), Pipelines (the state of main and
the latest pipeline per merge request), Releases (staging deploys, STAGING-VERIFY results, https run links only, a pointer to
PUBLISH).
TEST: services/gateway/test/delivery/command-hub-delivery.test.ts "draws one section and one named table per repository from the
real summary, in queue order, with the VTID title from the ledger", "a repository that still delivers on GitHub says so instead of
drawing an empty table (the empty state)", "a repository on GitLab with nothing waiting says \"Nothing is waiting to land.\"",
"shows the state of main per repository and the latest pipeline per merge request", "a repository still on GitHub says its
pipelines appear after the cut", "lists the staging deploys and the STAGING-VERIFY results, links only https run URLs, and points
at PUBLISH", "says so when there is no deploy and no verification in the window".

AC-23 Loading, error, retry, refresh and shadow: a loading note with role status; an error shows an alert with the reason and a
Retry button; opening a tab after an error (also after a failed refresh inside 30 seconds) tries again; a network failure is an
error too; Refresh fetches again and the shadow toggle fetches with `include_shadow=1`; a second render within 30 seconds reuses
the data; the refused GitHub merges, a truncated read and the data source are noted.
TEST: services/gateway/test/delivery/command-hub-delivery.test.ts "shows a loading state with role status until the data arrives",
"an error shows an alert with the reason and a Retry button that fetches again", "opening a tab again after an error tries again,
without a click on Retry", "opening a tab after a failed refresh tries again even within 30 seconds, while the data of the first
load is still held", "a network failure is shown as an error too", "the Refresh button fetches again; the shadow toggle fetches
with include_shadow=1 and says so", "a second render of a tab within 30 seconds reuses the data; after that it fetches again; an
unknown tab shows the merge queue", "notes the refused GitHub merges, a truncated read, and where the numbers come from".

AC-24 Accessibility and the existing stylesheet: every table is named and has column headers with scope; controls are real buttons
and a labelled checkbox; every class used is a class of `styles.css` (plus its two hooks); every row is one line (monospace
no-wrap cells, a clipped title with its full text in the tooltip); every state draws with a pill of the AA family; the measured
contrast of every pill, link and secondary cell is at least 4.5:1 (ALWAYS 40); only https URLs become links.
TEST: services/gateway/test/delivery/command-hub-delivery.test.ts "every table is named and has column headers with scope;
controls are real buttons and a labelled checkbox", "every class it draws with is a class of styles.css, except its two hooks
delivery-view and delivery-repo", "every row is one line: identifiers use the monospace no-wrap cell, a ledger title is clipped
with its full text in the tooltip", "every state draws with a pill of the AA family: five variants, each shown with its label", "AA
contrast (ALWAYS 40): the text colour of every pill, link and secondary cell it draws with is at least 4.5:1 on the table
background", "only https URLs become links; fmtDuration and fmtAgo read as text".

AC-25 The module was looked at, not only tested: screenshots of Merge queue, Pipelines and Releases at 1400×900 and 390×844 (plus
scrolled and, on the phone, sidebar-collapsed views), drawn by the real Command Hub files from the real route over invented rows,
with no console error. Seen: the Delivery item between Operations and Governance; tabs Merge Queue, Pipelines, Releases; one
section per repository with "· GitLab" or "· GitHub" and the "Landing paused" pill; one-line rows with clipped titles; no page-level
horizontal overflow at 390 px. At 390 px the Command Hub's own 260 px sidebar leaves about 130 px for content (existing shell), so
the table scrolls inside the module once the sidebar is collapsed (content 292 px).
UI: docs/validation/VTID-05547/outputs/shoot-report.json (screenshots `outputs/desktop-*.png` and `outputs/mobile-*.png`, 15 images)
Proof: `outputs/shoot-report.json` and `outputs/desktop-*.png`, `outputs/mobile-*.png` (15 images).

AC-26 Staging proof (G3): `docs/validation/VTID-05547/staging-tests.json` is valid for `run.mjs check-pr`; its read-only probes
are: `GET /api/v1/delivery/summary` and `/metrics` without a token answer 401 JSON (and the summary with the runner's invalid
bearer), `/command-hub/delivery.js` is served, `app.js` carries the Delivery section and the loader, `/command-hub/` names the
bumped `app.js` and `styles.css`, an unsigned `POST /api/v1/internal/gitlab/webhook` answers JSON 401 `signature_missing`, an
unauthenticated `POST /api/v1/github/safe-merge` answers 401; and four `existing` suites (the lane suites, the neighbours of the
changed files, the Command Hub bundle guards, `npm run test:roles`). No signed event and no merge is sent: staging shares the
production database.
Proof: `outputs/staging-manifest-check.txt` (validator result, strings found in the served sources), `outputs/preflight-check-pr.txt` (check-pr: change suite present and valid) and
`outputs/staging-existing-suites-local.txt` (the four suites: 165, 350, 855 and 105 tests green).
TEST: docs/validation/VTID-05547/staging-tests.json (valid for run.mjs check-pr, outputs/preflight-check-pr.txt); its probes run at STAGING-VERIFY

AC-27 Typecheck and regressions (G4), re-run on origin/main `7fd4106862d` + this commit: the gateway typechecks (npm ci install,
`pnpm run typecheck`, as CICDL-GATEWAY-CI); `npm run test:operator` (71), `npm run test:support` (4 suites, 87) and
`npm run test:roles` (105) are green; every gateway Jest file that imports or reads a file this lane changes, plus `test/delivery`,
`test/command-hub`, `test/navigation` and `test/nav-golden` (187 files, 3,245 tests): 3,099 passing, 17 skipped (unchanged files,
skipped on main too), 129 failing, all of them in the 5 suites of `outputs/pending-vectors.txt` and all for the one reason that the 18
texts of the three new voice screens have no stored vector yet (Open item 1); the whole script suite as UNIT.yml runs it (48 files)
passes on Node 22 and on Node 20: 1,088 tests, 1,086 pass, 0 fail, 2 skipped. The earlier whole gateway Jest run (all four CI shards,
1771 files, 29,548 tests: 29,486 passing, 54 skipped, 6 todo, 2 failing, see Open items 1 and 6) was taken on the stacked base before
the voice screens were added.
Proof: `outputs/gateway-typecheck.txt`, `outputs/test-operator.txt`, `outputs/test-support.txt`, `outputs/test-roles.txt`,
`outputs/gateway-related-jest.txt`, `outputs/pending-vectors.txt`, `outputs/gateway-full-jest.txt`, `outputs/unit-all.txt`,
`outputs/unit-all-node20.txt`.
TEST: `pnpm run typecheck` and the suites of outputs/gateway-typecheck.txt, outputs/test-operator.txt, outputs/test-support.txt, outputs/test-roles.txt

AC-29 Path ownership (COMMAND-HUB-GUARDRAILS.yml "Path Ownership Guard"): `VTID-05547` is in `ALLOWED_VTID_PATTERN` of
`scripts/ci/command-hub-ownership-guard.js` with a comment naming the Command Hub files this lane changes, so the guard passes for
this branch and title. `services/gateway/src/navigation/data/command-hub-screens.json` and `scripts/ci/command-hub-ownership-guard.js`
are inside the lane's `paths` since #4722 (VTID-05563, lane nav-paths, which also added `nav-embeddings.bin` and `.json`).
Proof: `outputs/ownership-guard.txt`.
TEST: scripts/ci/command-hub-ownership-guard.js; result in outputs/ownership-guard.txt

AC-28 The tests are not vacuous: 132 mutations of the lane's code (guard, mapper, stage, summary, route, mounts, topics, the screen,
the loader, the page and the cache-buster) are each caught by a named test case, 0 survive; the first run caught 119 of 126 and
the seven gaps were closed with tests, none by changing source.
Proof: `outputs/mutation-run.txt` and the harness `outputs/mutate-gateway-delivery.mjs` (wrapper `outputs/mutate-gateway-delivery.sh`).
TEST: outputs/mutate-gateway-delivery.mjs (wrapper outputs/mutate-gateway-delivery.sh); result in outputs/mutation-run.txt

Red on base (the lane HEAD `4c3d2341f2b` with the final tests, the new source files stubbed to do nothing and `delivery.js` empty):
`outputs/red-on-base.txt` 165 tests, 149 failed, 16 passed, 0 suites that did not run. The 16 that pass on base are deliberate
no-change guards (signature check, malformed/oversize/GET replies, flag-unset merge behaviour, the other repository, no mapper rule
for delivery topics, the dev spec validator, index.html's script list); they pass on base and on the new code.
Green (final code): `outputs/green.txt` 6 suites, 165 tests.

Open items:
1. Stored vectors for the three Delivery voice screens. `src/navigation/data/command-hub-screens.json` now has one entry per Delivery
   tab (`DEVHUB.DELIVERY.MERGE_QUEUE`, `DEVHUB.DELIVERY.PIPELINE_RUNS`, `DEVHUB.DELIVERY.RELEASES`), so "has exactly one screen per tab
   of NAVIGATION_CONFIG" holds; their 18 texts have no vector yet in `src/navigation/data/nav-embeddings.bin` / `.json`, so the 5 suites
   of `outputs/pending-vectors.txt` (129 tests) fail with `no stored vector for "<text>"` until the vectors are added (Decisions 15).
   This builder wrote no vector: they come from a Bedrock call, and a made-up vector would corrupt the file.
2. Done: `scripts/ci/command-hub-ownership-guard.js` allows `VTID-05547` (AC-29). The earlier `outputs/outside-lane-paths.patch` is
   applied and removed.
3. `services/gateway/specs/command-hub-symbol-index.json` is a generated index and is now stale for `app.js`; nothing enforces it
   (regenerate with `services/gateway/scripts/generate-command-hub-symbol-index.mjs`).
4. `safeMerge` reports the refusal through its existing catch: `result: refused`, HTTP 500, `reason: internal_error`, with
   `details.error` starting `merge_moved_to_gitlab` and a `cicd.github.safe_merge.blocked` event. A 409 with the code needs a change
   in `routes/cicd.ts`, which is outside the paths.
5. The Project Manager's `githubUpdateBranch` (`services/project-manager/writers.ts:227-230`) calls GitHub directly, so it is not behind
   the guard; plan §3.13 covers it with `PM_AGENT_ENABLED=false` in the staging deploy, and branch protection.
6. `test/vtid-04226-eventbridge-test-contract-schedules.test.ts` fails in this sandbox only: it runs `scripts/aws/setup-gateway-internal-token.sh`,
   which needs `openssl`, absent here. It fails the same way on the lane base tree.

Decisions taken inside the plan (for Gate 2):
1. §3.13 The guard refuses by throwing `MergeMovedToGitlabError` (code `merge_moved_to_gitlab`) after one `delivery.merge.refused`
   event. A return value would let `routes/cicd.ts` (which reads `.sha` of the result in five places) report a merge that did not happen.
   Not in `evaluateGovernance`: `autopilot-validator.ts` also calls it and would raise events; the plan says two guard calls.
2. §3.11 The webhook is an additive middleware stage (`createGitlabDeliveryStage`) mounted before M2's unchanged router, not an edit of
   M2's `mapper.ts` or route: M2's tests pin that mapper, the exact payloads and the exact mount line, they are outside the paths, and the
   route guard allows one handler per endpoint. It reuses M2's `requireGitlabSignature`, so the signature check is the same code.
3. §3.11 Every `*.failed` and `*.error` topic is written with status `warning` (the lifecycle mapper moves a VTID to failed on status
   `error`); `scm.gitlab.merge_request.*` and `delivery.merge.refused` carry `task_stage: VALIDATOR` so "merge" does not infer Deploy.
4. §3.6 step 8, §3.11 Shadow is decided by `DELIVERY_MODE=shadow`, a flag other than `gitlab`, or a project outside the two repositories; a
   shadow run writes no `staging.deploy.*` and no `delivery.landed` (other readers use `staging.deploy.*` by topic; GitHub stays their only
   writer until the cut). Deploy facts come from `builds[]` of the final pipeline event; job events are not implemented.
5. §3.11 Pushes get their VTID from the in-memory branch index, then an injected read-only OASIS lookup, then the commit titles, then
   `BOOTSTRAP-DELIVERY`. Topics added: `scm.gitlab.merge_request.updated`, `scm.gitlab.push`, `scm.gitlab.pipeline.started`,
   `scm.gitlab.pipeline.canceled`, `scm.migration.pr_moved`, `scm.migration.cutover`, `delivery.review.recorded`, `delivery.lane.updated`,
   `delivery.landed`, `delivery.merge.refused`, `staging.deploy.rolled_back`. Not added (they come with their writers):
   `delivery.lane.state_changed`, `delivery.gate2.sent`, `delivery.heal.*`, `delivery.improve.*`.
6. §3.12 `delivery.js` is loaded on demand by `app.js` (a same-origin script element, the precedent is `loadLivekitClient`), not by a tag in
   `index.html` plus a `modules.json` entry: VTID-05072's manifest test requires `index.html`'s script list to equal `modules.json`, which is
   outside the paths. So `/command-hub/` does not itself contain `delivery.js` (G3 says "`/command-hub/` loads `delivery.js`"): the staging
   probes show `/command-hub/` naming the bumped `app.js`, `app.js` carrying the loader, and `delivery.js` served.
7. §3.12 The glue in `app.js` is one `var deliveryModule = {…}` object, not top-level function declarations: VTID-05073's test (b) pins the set
   of top-level function names of the Command Hub bundle against a frozen fixture outside the paths.
8. §3.12 The tab key is `pipeline-runs` (label "Pipelines"): `pipelines` would be the screen id `DEV-PIPELINES` of Agents → Pipelines, and the
   catalog script's `idOverrides` is outside the paths.
9. §3.12, IF–THEN 25 `app.js?v=` and `styles.css?v=` are `20261121-vtid-05082-vtid-05547` (the old marker stays a prefix, so suites that
   pin it as a substring pass). The 30 other staging suites that name the old version were updated, as VTID-05082's bump did: only the version
   token changed in 68 places (`outputs/asset-bump-follow.txt`).
10. ALWAYS 40 The screen uses the Testing & QA pill family and the existing link and secondary-text classes, measured on the theme, instead of
    the stylesheet's status badges that fail 4.5:1. It ships no stylesheet.
11. §3.5 The queue order is rebuilt from the labels (updating, ready by oldest label start, waiting; blocked and paused last, no position). It
    approximates the bot's order; the bot's own order is not in OASIS.
12. §10 A figure with no source is `null`. `change_failure_rate` uses the signals `red_main` and `staging_verify_failed` and says
    `missing_signals: ["revert", "production_rollback"]`; `cost_per_day` is always `null` (it stays in CloudWatch).
13. §3.12 One read is the newest 3000 events of the topics in the window (default 168 h, at most 720 h); a full page is reported as `truncated`
    and the screen says so.
14. §3.13, §8.2 step 7 Staging proof for "flag unset behaves as before": the Jest suites, plus a rejected probe of `safe-merge`; a real merge on
    staging would write to the shared database.
15. §3.12 (voice navigation of the Delivery tabs) The 18 vectors of the three new screens come from a one-off owner run of the same
    Titan v2 call (`test/nav-golden/build-embeddings.ts`) in CloudShell, merged offline with the bundled vectors in
    `nav-embeddings.bin` / `.json`, because regenerating needs Bedrock and no agent session may call AWS. Until they land, the 5 suites of
    `outputs/pending-vectors.txt` fail; with them, they must pass with no other change.

## Route evidence (VTID-05547 mounts two read routes)

ROUTE_MOUNT: `GET /api/v1/delivery/summary` and `GET /api/v1/delivery/metrics` (new, `services/gateway/src/routes/delivery.ts`,
mounted in `services/gateway/src/index.ts` with `mountRouterSync(app, '/api/v1/delivery', ...)`; service token or exafy_admin, no
other method). The GitLab webhook stage is middleware before the existing route `POST /api/v1/internal/gitlab/webhook`, not a new route.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/delivery/summary (staging, unauthenticated GET; not yet called: the probe
runs at STAGING-VERIFY and is in staging-tests.json).
CURL_PROOF: pending STAGING-VERIFY. The expected answer of the unauthenticated GET is 401 application/json (route exists), not an HTML
404. Until that run this line is a claim to be checked, not evidence.
