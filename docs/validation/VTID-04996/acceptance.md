# VTID-04996 acceptance

AC-1 Free slots are offered only outside the member's own commitments, other lenses' busy time and connected-calendar busy time; reminders, subscription dates and non-confirmed entries take no time; the entry being moved does not block its own slot.
TEST: services/gateway/test/vtid-04996-calendar-find-a-time.test.ts (skips own commitments...; reminders, subscription dates...; the entry being moved...)

AC-2 Slots lie inside the member's waking hours in their own time zone: outside their quiet hours when set (including a window inside the day), 07:00-22:00 otherwise; the local day follows the autumn clock change.
TEST: services/gateway/test/vtid-04996-calendar-find-a-time.test.ts (quiet hours...; quiet window inside the day; DST)

AC-3 A slot never starts in the past (next quarter hour), never fits where the free stretch is shorter than the duration, stays inside the requested range, and an invalid range (over 14 days) or duration yields nothing.
TEST: services/gateway/test/vtid-04996-calendar-find-a-time.test.ts (gap shorter than duration; never offers the past; range end; touching the next entry)

AC-4 GET /events/gaps with duration/from/to/limit returns {data: slots, count, mode: 'slots'}; invalid values answer 400; without those parameters the day-gap answer is unchanged.
TEST: services/gateway/test/calendar/calendar-routes.contract.test.ts (gaps; slots; slots_bad_duration; slots_bad_range)
