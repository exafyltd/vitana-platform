# VTID-04604 — voice create_calendar_event needs an ask and a confirmation
AC-5: refused before the member has spoken in the session (complements VTID-04509's opening-turn guard, now for every path).
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
AC-6: refused without confirmed=true (answers needs_confirmation, nothing written).
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
AC-7: refused for a past start (the live stray event was dated 2026-04-15) or an invalid date.
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
AC-8/9/10: allowed when asked + confirmed + future; the guard runs before createCalendarEvent; the tool declares `confirmed`.
TEST: services/gateway/test/vtid-04602-04604-go-live.test.ts
Tool-catalog bytes: the new description is 2 bytes SHORTER than before, so every surface declares exactly the same tool set
(a +34-byte first draft evicted play_music / get_my_subscription on member sessions and get_goal_progress on the Serbian bridge — caught by the VTID-04542 payload-identity snapshots and fixed before commit).
