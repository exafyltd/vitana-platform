# VTID-04382 — typed submit_* tickets carry the same context as report_to_specialist

AC-1: A typed ticket filed with no enabled specialist stores surface (from the member's current route),
and structured_fields tenant_id, language, session_id and current_route.
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts

AC-2: That ticket's feedback.ticket.created event carries surface, language and session_id.
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts

AC-3: A typed ticket routed to a specialist passes surface, session_id and current_route to the shared core.
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts

AC-4: The ORB tool dispatch (orb-live generic path and dispatchOrbToolForVertex) forwards current_route
and is_mobile, so the surface is not silently lost.
TEST: services/gateway/test/vtid-04382-typed-ticket-context.test.ts

AC-5: An unknown route files on the community surface, never NULL.
TEST: services/gateway/test/orb-tools/feedback-settings-tools.test.ts
