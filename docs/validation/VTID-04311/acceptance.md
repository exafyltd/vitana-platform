# VTID-04311 — Real specs for bug/ux tickets, no placeholder ever dispatched (+ VTID-04312 reporter notified)

Steps 5 and 6 of `docs/INTAKE-CHANNELS-PLAN.md` (VTID-04306). Companion VTID
in this PR: VTID-04312.

## Why

- The SQL auto-triage (pg_cron `feedback-auto-triage`) moves a triaged bug to
  `spec_ready` with a placeholder spec, and the on-demand LLM draft falls
  back to another placeholder when the router fails. Activate / Approve &
  Fix dispatched any non-empty spec, so a placeholder could become an
  autopilot plan.
- A member who reported a problem was never told it was fixed: status
  changed silently and `/mine` did not return the resolution.

## Acceptance Criteria

AC-1 `isPlaceholderSpec` flags empty specs, the SQL auto-triage placeholder and the LLM-unavailable fallback, and accepts a real spec (the word appearing further down does not count).
TEST: services/gateway/test/vtid-04311-feedback-spec-drafter.test.ts

AC-2 Dispatch refuses a placeholder spec with violation `spec_placeholder` before any VTID allocation or execution.
TEST: services/gateway/test/vtid-04308-feedback-approve-dispatch.test.ts

AC-3 A throttled pass inside the executor tick replaces placeholder specs on `spec_ready` bug/ux tickets with a real Devon draft (triage stage), guarded on `spec_ready`, claimed so prod and staging don't draft the same ticket, capped at 3 attempts, and disabled by `FEEDBACK_SPEC_DRAFT_ENABLED=false`. A fallback draft keeps the placeholder in place.
TEST: services/gateway/test/vtid-04311-feedback-spec-drafter.test.ts

AC-4 When a ticket is resolved (autopilot completion, admin send-answer, admin resolve, tenant answer send, bulk send), the reporter gets one `feedback_ticket_resolved` notification in their locale through notifyUser; a ticket that is not resolved is never announced; the helper never throws.
TEST: services/gateway/test/vtid-04312-feedback-reporter-notify.test.ts

AC-5 `/api/v1/feedback/tickets/mine` returns `resolution_md` / `answer_md` only for resolved tickets, never an unsent draft.
TEST: services/gateway/test/vtid-04312-feedback-reporter-notify.test.ts

AC-6 The existing tenant ticket and feedback pipeline suites stay green.
TEST: services/gateway/test/routes/tenant-specialists.test.ts

## Not verified here

- No live draft or notification was produced from this session: the one
  `spec_ready` bug ticket with a placeholder spec belongs to a real member,
  and sending a real notification to a member from a test is forbidden. The
  first executor tick on staging after deploy will redraft that ticket's
  spec (expect `classifier_meta.spec_drafted_by='devon-llm'`); the first
  real resolution will send the first notification.
- Talk to Vitana does not render the resolution yet (frontend, step 7).
