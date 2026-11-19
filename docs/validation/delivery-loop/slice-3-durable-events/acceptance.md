Change types: Backend.
# Delivery loop, slice 3: GitLab issue intake, failed-pipeline facts, durable event recording

No approved lane or VTID covers this slice yet (VTIDs come only from CI PLAN-SPAR; none was invented). It is part of the WIP merge request
"delivery loop" and needs `plan(delivery-loop)` before it can merge.

Mission items: (1) intake: GitLab issue events become delivery events; (3) failure detection: pipeline webhook events reach the delivery
event system with authenticated processing and durable recording.

AC-1 A GitLab issue that carries the intake label (`DELIVERY_INTAKE_LABEL`, default `agent-task`) becomes `scm.gitlab.issue.opened`
(open, reopen), `scm.gitlab.issue.labeled` (an update that adds the label) or `scm.gitlab.issue.closed`, under `BOOTSTRAP-DELIVERY` or the
VTID its title names. The row names the issue (project, iid, id, state, url, confidential) and the intake / agent- / delivery- / priority-
labels (at most 10); never the title, the description or a user. An issue without the label is answered 202 `not_intake`; other work item
types and `work_item` events are ignored.
TEST: services/gateway/test/delivery/gitlab-delivery-mapping.test.ts, describe "delivery loop intake" (14 tests); the privacy corpus and the
"no delivery event can move a VTID" corpus now include issue events.

AC-2 A failed pipeline carries `failed_jobs` (id, name, stage, failure_reason, exit_code of each job that failed and was not allowed to
fail, lowest id first, at most 20) and every pipeline names its merge request's branches and URL (`mr_source_branch`, `mr_target_branch`,
`mr_url`). `jobs` is unchanged. No job log, runner or user. The event stays `warning`, never `error`, so no VTID is moved.
TEST: gitlab-delivery-mapping.test.ts, describe "delivery loop failure detection" (9 tests); "no topic ending in .failed or .error is
written with status error".

AC-3 Durable recording: an event with an `idempotency_key` is inserted with a row id derived from (env, topic, key) and
`Prefer: resolution=ignore-duplicates`; a second write of the same fact adds no row, answers `ok` with `duplicate: true` and is not projected
to the timeline again. An event without a key is written exactly as before (random id, `Prefer: return=representation`, response body not
read). The id derivation is pinned by an independently computed vector.
TEST: services/gateway/test/oasis-event-idempotency.test.ts (15 tests).

AC-4 The GitLab delivery stage writes each event with its `dedupe_key` as the key, so a fact that reaches two gateway tasks (a webhook retry
on another task, a second delivery) is one OASIS row and the second task answers `{ ok, duplicate: true }`. A delivery whose write failed
half-way is completed by its retry on another task: rows already there are skipped, the rest are written. A custom emit (tests) is called as
before. The 502 on a failed write and the signature check (401/500, before anything is read) are unchanged.
TEST: gitlab-delivery-oasis-write.test.ts, describe "durable recording" (5 tests) and "the delivery loop events through the stage" (3);
gitlab-delivery-webhook.test.ts "an event that OASIS already held", "the default writer gives each event its dedupe_key".

AC-5 Nothing else moved: the delivery, gitlab-events, internal webhook, atlas route-claim and project-manager suites pass, and the full
gateway suite result is in outputs/full-gateway-suite.txt. `tsc --noEmit` is clean (outputs/tsc.txt). Tests changed on purpose: the OASIS
fake of gitlab-delivery-oasis-write.test.ts now models PostgREST on the primary key (the old fake answered `[]` to every insert, which now
means duplicate); the two "events of mapper.ts are kept as they are" tests list the new additive fields; the privacy and lifecycle
corpora gained issue and failed-pipeline cases. No assertion was loosened.

RED ON BASE: outputs/red-on-base.txt: with the four source files at their pre-slice state, 40 of the slice's new or changed tests fail.

What this does NOT prove (stated, not hidden):
- PostgREST itself. The fake models what PostgREST does for the primary key (ON CONFLICT DO NOTHING returns no row); that behaviour is
  from the PostgREST / PostgreSQL documentation, not from a live call. `oasis_events.id` is `uuid PRIMARY KEY` with no partitioning and no
  trigger (supabase/migrations/20251209000000_add_task_stage.sql). No database or PostgREST is reachable from this session.
- Dedupe lasts as long as the rows: oasis_events keeps 14 days (oasis_events_cleanup_batched). A key older than that is written again.
- Live GitLab. The project webhooks do not exist yet (0 hooks on every project), the signing secret is not provisioned, and the hook
  declaration (`scripts/eng/gitlab-settings.mjs`) does not list issue events yet; that is a later slice and the owner's step (live write).
  The rehearsal project may not have a webhook at all (schema rule), so its intake is read by polling the GitLab API, not by this path.
