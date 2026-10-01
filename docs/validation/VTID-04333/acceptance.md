# VTID-04333 — The member ticket number travels with its VTID; bug tickets auto-dispatch

Slices 3 (ID chain) and 6 (pipeline) of `docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md`
§4, plus owner decision §3.5.1 (auto-start every bug fix).

## Why

- The member is told `FB-YYYY-MM-NNNNNN`; the supervisor works in VTIDs,
  findings, executions and PRs. The only link back to the ticket was the
  `[FB-…]` prefix on the finding title (brief §2.6). PR titles carried the
  VTID only, `feedback.ticket.resolved` was filed under the fixed
  `VTID-02669`, the failure branch emitted nothing, and no admin API returned
  `linked_vtid` / `linked_finding_id` / the execution.
- 43 tickets sat in `triaged` because auto-triage only moved p3 bugs to
  `spec_ready`, and every real spec still waited for an "Approve & Fix" click.

## API fields added (consumed by the Command Hub, VTID-04334)

- Dev Autopilot `GET /api/v1/dev-autopilot/executions` (each execution),
  `GET /queue` (each finding), `GET /pending-approvals` (each
  recommendation), `GET /findings/:id` (`finding`):
  `feedback_ticket: { ticket_id: string, ticket_number: string | null, linked_vtid: string | null } | null`
- Feedback admin `GET /api/v1/admin/feedback/tickets` and
  `GET /api/v1/admin/feedback/tenants/:tenantId/tickets` (each ticket):
  `linked_vtid`, `linked_finding_id`, `linked_pr_url`, and
  `latest_execution: { id, status, stage, failure_stage, pr_url, pr_number, created_at, updated_at, completed_at } | null`.
  `GET /api/v1/admin/feedback/tickets/:id`: top-level `latest_execution`
  (same shape; `ticket` is `select *`, so it already has the `linked_*`).
- Tenant `GET /api/v1/admin/tenants/:tenantId/tickets/:id`: `latest_execution`
  (same shape) next to the existing `execution`.
- `stage` = the execution status (`cooling`, `running`, `awaiting_approval`,
  `ci`, `merging`, `deploying`, `verifying`, `completed`) or, for
  `failed`/`failed_escalated`/`reverted`/`cancelled`/`auto_archived`, the
  `failure_stage` when one is recorded.

## Acceptance Criteria

AC-1 When the execution came from a feedback ticket, the PR title carries the FB number next to the VTID (`… (FB-…, VTID-…)`, each id added only when missing, within the 240-char cap), the body carries one `Member report: FB-…` line (also when the model body already had the validator tokens), and `outputs/execution.json` records `ticket_number`. A non-ticket execution is unchanged and every VALIDATOR-CHECK text gate still passes.
TEST: services/gateway/test/dev-autopilot-pr-contract.test.ts

AC-2 The ticket number is resolved from `spec_snapshot.feedback.ticket_number`, falling back to one `feedback_tickets` read keyed by `source_ref` `feedback_ticket:<id>`; a non-feedback finding never triggers a read and a failed read never throws. Both executors (single-shot and agent) pass it to the PR contract.
TEST: services/gateway/test/vtid-04333-feedback-ticket-ref.test.ts

AC-3 `feedback.ticket.resolved` is emitted under the ticket's own `linked_vtid` (fixed `VTID-02669` only when the ticket has none) with `payload.ticket_number`; the failure branch emits `feedback.ticket.fix_failed` (status warning) with ticket number, execution id, execution status and failure stage.
TEST: services/gateway/test/vtid-04333-feedback-completion-events.test.ts

AC-4 A successful dispatch emits `feedback.ticket.dispatched` under the ticket VTID with ticket number, recommendation id, execution id and whether it was an auto-dispatch; the recommendation's `spec_snapshot.feedback` is stamped with `linked_vtid` and `ticket_number`; a refused dispatch emits nothing. Route events for approve / activate / bulk approve file under the ticket VTID when one exists.
TEST: services/gateway/test/vtid-04333-feedback-bridge-ticket-ref.test.ts

AC-5 The admin ticket list, tenant ticket list and ticket detail return `linked_vtid`, `linked_finding_id`, `linked_pr_url` and `latest_execution` (newest execution per finding).
TEST: services/gateway/test/feedback-pipeline.test.ts

AC-6 The Dev Autopilot executions, queue, pending-approvals and finding-detail APIs carry `feedback_ticket` (null when the finding did not come from a ticket).
TEST: services/gateway/test/routes/dev-autopilot.test.ts

AC-7 With `FEEDBACK_AUTO_DISPATCH_ENABLED=true` (exact string), the spec-drafter pass dispatches the tickets it just drafted and any other `spec_ready` bug/ux_issue ticket with a real spec and no linked finding, as actor `auto-dispatch`, through `approveAndDispatchTicket`. It does nothing while the kill switch is armed or the config is unreadable, caps dispatches per pass (default 2), claims each ticket guarded on `spec_ready`, records a refusal and emits `feedback.ticket.auto_dispatch_blocked`, stops after 3 attempts, and never touches another kind, a placeholder spec, or a linked ticket. With the flag off the drafter behaves as before.
TEST: services/gateway/test/vtid-04333-feedback-auto-dispatch.test.ts

AC-8 The kill switch still blocks a feedback-lane finding inside the bridge's safety gate (the second gate behind the pre-check in AC-7).
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts

AC-9 Migration `20260923130000_vtid_04333_auto_triage_all_bug_priorities.sql` moves bug AND ux_issue tickets of every priority to `spec_ready` with a spec whose first line keeps `(placeholder)`, and keeps the support-question / account-issue branches and the human-only `surface='support'` exclusion.
TEST: services/gateway/test/vtid-04333-feedback-auto-dispatch.test.ts

AC-10 `FEEDBACK_AUTO_DISPATCH_ENABLED=true` is pinned strip-then-add on the staging gateway workflow only, never on prod; the workflow still passes the bash-syntax / run-block size guard.
TEST: services/gateway/test/vtid-04333-staging-feedback-auto-dispatch-pinned.test.ts
TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

AC-11 The existing spec-drafter, dispatch, reporter-notify, tenant ticket and workflow pin suites stay green.
TEST: services/gateway/test/vtid-04311-feedback-spec-drafter.test.ts

## Not done / not verified here

- The migration is shipped as a file only; it was not applied to any
  database (the coordinating session applies it after review).
- Nothing was deployed or run against staging or production. The first real
  signal is a staging tick log line `auto_dispatched=N` and a
  `feedback.ticket.dispatched` event under a ticket VTID.
- `DATABASE_SCHEMA.md` does not document `auto_triage_pending_feedback_tickets()`
  or `feedback_tickets`, so it was not changed.
- Tickets filed from the Support → Contact screen (`surface='support'`) stay
  in the human-only queue: auto-triage never moves them to `spec_ready`, so
  they are never auto-dispatched. Whether a member's bug report from that
  screen should join the automatic path is an owner decision.
- Command Hub rendering of these fields is VTID-04334.
