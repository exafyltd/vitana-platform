# VTID-04383 — the resolved-ticket push opens the specific ticket

AC-1: The feedback_ticket_resolved notification's data.url names the ticket
(/comm/talk-to-vitana?ticket=<id>), because the service worker opens data.url as-is on a push tap.
TEST: services/gateway/test/vtid-04312-feedback-reporter-notify.test.ts

AC-2: data.ticket_id is still sent, so the in-app route keeps working.
TEST: services/gateway/test/vtid-04312-feedback-reporter-notify.test.ts
