# VTID-04995 acceptance

AC-1 A proposed time that overlaps one of the member's own confirmed entries reports it with its title; entries that only touch the boundary do not count.
TEST: services/gateway/test/vtid-04995-calendar-conflicts.test.ts (own entry; boundary)

AC-2 Time held in another lens of the same member, and busy time from a connected calendar, is reported as "busy" / "external" with no title and no other detail.
TEST: services/gateway/test/vtid-04995-calendar-conflicts.test.ts (busy and external carry no title)

AC-3 Reminders and subscription dates never count as a conflict; cancelled or pending entries are ignored; the entry being edited or moved never conflicts with itself.
TEST: services/gateway/test/vtid-04995-calendar-conflicts.test.ts (non-commitment sources; exclude)

AC-4 An invalid or empty window has no conflicts and the route answers 400; across the autumn clock change instants decide, not wall-clock hours; a whole-day entry overlaps anything in its day; results are time-ordered and capped.
TEST: services/gateway/test/vtid-04995-calendar-conflicts.test.ts (window, DST, whole-day, cap) and services/gateway/test/calendar/calendar-routes.contract.test.ts (conflicts_bad_window)

AC-5 GET /conflicts composes the same sources as the calendar screen (window read plus external busy) and keeps `has_conflicts`; the response adds `conflicts` (all kinds) and `data` is the member's own overlapping entries.
TEST: services/gateway/test/calendar/calendar-routes.contract.test.ts (conflicts)
