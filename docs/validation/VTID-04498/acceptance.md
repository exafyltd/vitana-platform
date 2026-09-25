# VTID-04498 — Real "Top X%" badge on the profile Vitana Index card

The owner asked for the "Top X%" badge back. The old badge (removed in
VTID-04470) was the score's share of 999, not a rank. This one is a real rank
in the member's community, and it is shown only when it means something.

## Acceptance criteria

AC-1: no rank is shown with fewer than 20 members in the cohort.
TEST: services/gateway/test/vtid-04498-index-standing.test.ts
AC-2: no badge when nobody scores lower than the member (tied at the starting score).
TEST: services/gateway/test/vtid-04498-index-standing.test.ts
AC-3: the badge is shown only for a rank in the top half.
TEST: services/gateway/test/vtid-04498-index-standing.test.ts
AC-4: a percentage is returned only when the badge is to be shown.
TEST: services/gateway/test/vtid-04498-index-standing.test.ts
AC-5: service and test accounts never shape the rank.
TEST: services/gateway/test/vtid-04498-index-standing.test.ts
AC-6: signed-in callers only; no JWT returns NULL.
TEST: services/gateway/test/vtid-04498-index-standing.test.ts

Live results are in `outputs/live-verification.md`.
