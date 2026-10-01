# VTID-04395 — Support "report by voice" opens the ORB as a support intake

AC-1: A session started with support_report: true opens with the support_report greeting rung on the
normal ladder: a short invitation to describe the problem, no briefing.
TEST: services/gateway/test/services/conversation/vtid-04395-support-report-rung.test.ts

AC-2: The rung outranks the day-close and runs on the safe-fast ladder too.
TEST: services/gateway/test/services/conversation/vtid-04395-support-report-rung.test.ts

AC-3: The directive is an English intent the model composes from (no quoted sentence, no "Say exactly"),
and it points filing at report_to_specialist.
TEST: services/gateway/test/services/conversation/vtid-04395-support-report-rung.test.ts

AC-4: Anonymous sessions and sessions after the first turn never get it (a transparent reconnect does not
re-open the intake).
TEST: services/gateway/test/services/conversation/vtid-04395-support-report-rung.test.ts

AC-5: The ORB widget exposes VitanaOrb.startSupportReport(), sends support_report once on the next start,
and clears it on close.
TEST: services/gateway/test/services/conversation/vtid-04395-support-report-rung.test.ts

OASIS_PROOF: no new OASIS topic; the greeting diag carries wake_opener=support_report so the rung is
measurable in orb.live.diag like every other rung.
