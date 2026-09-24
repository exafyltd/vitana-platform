# VTID-04456 — Customer support pipeline regression suite

Owner ask (2026-09-24): a test that verifies any new update to customer
support does not damage the existing pipeline. It must cover a bug reported
by a community member in the app, a bug reported by voice to Vitana, and a
bug raised while the member is talking to Devon.

## What it is

`services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts`
runs the **real code of every stage**, in the order a real ticket goes
through them, over one in-memory copy of the database
(`services/gateway/test/support-pipeline/fake-platform.ts`, which serves both
supabase-js and raw PostgREST `fetch` calls from the same tables):

intake (app route / `report_to_specialist` / typed `submit_bug_report`)
→ Vitana→Devon hand-off (STATUS contract, male-voice gate, persona swap)
→ Devon enriches the ticket (`append_to_ticket`)
→ classifier + SQL auto-triage (placeholder spec), emulated database side
→ spec drafter replaces the placeholder
→ auto-dispatch → execution bridge: recommendation, VTID, execution
→ PR title `… (FB-…, VTID-…)`
→ completion reconciler: resolved and member notified, or reopened on a failed fix.

Only the edges are stubbed: the spec-writing LLM, the Dev Autopilot executor,
the VTID ledger RPC, the reporter notification, OASIS emission (captured) and
the persona-registry lookup.

It runs in the existing `Gateway (Jest)` CI job on every gateway PR, so a
change that breaks the pipeline cannot merge green. Locally:
`npm run test:support` (this suite and the three nearest support suites).

## Acceptance criteria

AC-1: A community member's in-app bug report is filed for that member, announced (`feedback.ticket.created`), and goes through spec → auto-dispatch → PR title with FB number and VTID → resolved, with the member notified. A failed fix reopens the ticket (`needs_more_info`, `feedback.ticket.fix_failed`) instead of closing it.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-2: A bug reported to Vitana by voice files a triaged ticket routed to Devon, with surface, session, route, language and app version; the Live Handoffs row and the created event are written; Vitana gets `STATUS: handoff_created` only when the hand-off is actually queued; Devon joins with the specialist voice role. The same ticket is fixed and resolved end to end.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-3: When the pipeline has no male voice for the language, Devon does not join (`ticket_filed_no_handoff`), and the ticket is still fixed and resolved.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-4: The typed voice tool `submit_bug_report` files through the same path and is fixed the same way; a vague report files nothing.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-5: In a conversation with Devon: Devon appends his findings to the hand-off ticket (Vitana cannot, and Devon cannot write to another member's ticket); the spec writer receives Devon's note; a second bug the member raises becomes its own ticket and is fixed under its own VTID; handing back returns Vitana quietly.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-6: Safety rails hold: a placeholder spec never reaches Dev Autopilot; an armed kill switch stops dispatch before a VTID is allocated; auto-dispatch is off unless the flag is exactly `true`; a ticket from the human-only Support screen is never auto-triaged.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

AC-7: The emulated auto-triage matches the migration that last defines `auto_triage_pending_feedback_tickets()` (selection clauses, bug branch, placeholder heading), so the fake cannot drift from the database silently.
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts

## Evidence that the suite catches breakage

`outputs/mutation-run.txt`: ten deliberate regressions were applied one at a
time to the real source, and the suite failed on every one. The source was
restored after each.

OASIS_PROOF: test-only change. No OASIS topic is added or changed; the suite asserts the existing `feedback.ticket.created`, `feedback.ticket.dispatched`, `feedback.ticket.resolved` and `feedback.ticket.fix_failed` events are emitted under the ticket's own VTID.
