# VTID-04332 — Voice hand-off to Devon works again

Brief: `docs/CUSTOMER-SUPPORT-REBUILD-BRIEF.md` §2.2, §2.3 (root-cause 1 and 5), §3.2, §3.5.

## Root cause addressed

The VTID-03033 HARD RULE in `live-system-instruction.ts` lets the model announce a
hand-off only when the `report_to_specialist` reply begins with
`STATUS: handoff_created.` and treats every other reply as "the hand-off did NOT
happen". No handler returned any `STATUS:` text, so after a successful call the
model was told the hand-off had not happened. On top of that the tool description
and the prompt pushed the model away from calling it at all ("RARE — less than 5%",
a 15-word summary minimum, a propose-then-wait ritual, and a 12-word server-side
rejection).

## Acceptance criteria

AC-1: Every `report_to_specialist` outcome on the Vertex/Nova path (`routes/orb-live.ts`)
   returns a tool message beginning with a STATUS the rule recognizes
   (`handoff_created`, `stay_inline`, `vague`, `failed`, `failed_network`,
   `ticket_filed_no_handoff`); no reply is a hand-written string and no branch returns
   `success:false` (which the grace layer would rewrite into a vague pivot).
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-2: The STATUS set the code can emit equals the STATUS set parsed from the rule's own
   text (drift guard).
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-3: `handoff_created` is returned only when the persona swap was actually queued; a
   filed ticket with no queued swap (or no persona) is `ticket_filed_no_handoff` and
   carries the ticket number.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-4: The shared LiveKit/HTTP path (`orb-tools-shared.ts` `tool_report_to_specialist`)
   returns STATUS-prefixed text for created / vague and a STATUS-prefixed error for
   failed.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-5: ACTION lines are intent, not scripted speech (NEVER-rule 41): no quoted example
   bridge sentences, no persona name spoken.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-6: The tool description drops "RARE — less than 5%" and the 15-word minimum, says a
   bug / broken thing / account problem IS a hand-off case, and asks for one short
   confirmation. The system instruction does the same, and scopes "you ARE the
   instruction manual" to how-to questions only.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-7: The server-side summary minimum is 5 words (was 12): 4 words is vague, a concrete
   5-word report is filed, placeholder summaries are still rejected.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-8: Voice tickets carry `surface` (derived from the session route; `community` when
   unknown, never null), and `structured_fields.tenant_id`, `.language`, `.session_id`,
   `.current_route` (`feedback_tickets` has no tenant_id/language column — none
   invented). The OASIS `feedback.ticket.created` payload carries session id, surface
   and language.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-9: `append_to_ticket` appends `{agent, role, content, ts}` to `intake_messages` of the
   session's hand-off ticket ("current"); refused for Vitana, for a session with no
   hand-off ticket, for another user's ticket, and for an empty note. It is declared
   in the catalog and dispatched in `orb-live.ts` with the session persona and ticket.
   TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-10: A specialist calling `report_to_specialist` is still refused (`STAY_IN_INTAKE`)
    and is pointed to `append_to_ticket`.
    TEST: services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts
AC-11: `append_to_ticket`, `submit_bug_report`, `submit_support_ticket` are on the Nova /
    bridge priority list, so the tools the prompt describes survive the trim, and the
    64 KB Nova budget still keeps every priority tool.
    TEST: services/gateway/test/orb/live/tools/vtid-04097-nova-tool-catalog-budget.test.ts
AC-12: At hand-off the specialist prompt gets a `[TICKET — this hand-off]` block naming
    the ticket, `append_to_ticket`, and the instruction to tell the member their ticket
    number before the conversation ends; the specialist close step includes the ticket
    number as intent, without scripted example sentences.
    TEST: services/gateway/test/routes/orb-live.test.ts
AC-13: System-instruction and tool-catalog characterization snapshots updated
    deliberately; the diff contains only the report_to_specialist / append_to_ticket /
    submit_bug_report text.
    TEST: services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts

## Not in this VTID

- Persona swap on the cascade (Transcribe→Bedrock→Polly/Fish) and the Serbian Vertex
  bridge — separate task. On those paths the gateway still queues the swap and
  reports `handoff_created`; whether the reconnect actually applies Devon there is
  that task's to fix.
- `append_to_ticket` is not in the shared `ORB_TOOL_REGISTRY`: it needs session state
  (active persona, hand-off ticket id) that the shared identity does not carry, so
  exposing it there would drop the specialist-only guard.
- No live verification: nothing was deployed and nothing was run against staging or
  production.

## OASIS

OASIS_PROOF: the existing `feedback.ticket.created` event emitted by `report-to-specialist-core.ts` now carries `session_id`, `surface` and `language` in its payload; no new topic. Asserted in services/gateway/test/vtid-04332-report-to-specialist-status-contract.test.ts (`evt.payload` toMatchObject `{ session_id, surface, language }`).
