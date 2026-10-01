# VTID-04385 — the member sees the ticket number after a spoken report

AC-1: When report_to_specialist files a ticket on a voice session, the gateway sends one
support_ticket_filed frame (ticket_id, ticket_number, kind, url=/comm/talk-to-vitana?ticket=<id>)
on the session's SSE / WebSocket transport.
TEST: services/gateway/test/vtid-04385-support-ticket-filed-signal.test.ts

AC-2: When a typed submit_* tool files a ticket, the generic ORB dispatch sends the same frame;
a needs-details ask, a failure or any other tool sends nothing.
TEST: services/gateway/test/vtid-04385-support-ticket-filed-signal.test.ts

AC-3: The structured tool result used for AC-2 is never sent to the model.
TEST: services/gateway/test/vtid-04385-support-ticket-filed-signal.test.ts

AC-4: The ORB widget turns the frame into a vitana:support-ticket-filed window event; the Command Hub
cache-bust names the change.
TEST: services/gateway/test/vtid-04385-support-ticket-filed-signal.test.ts

OASIS_PROOF: no new OASIS topic; the frame is client transport only. feedback.ticket.created is unchanged.
