# VTID-04489 — Personalised "Biggest boost" on the profile Vitana Index card

The owner asked for the line under the Index tier to say what drove the
member's Index — running, healthy eating, … — so a shared profile gives the
member something to brag about and others something to compete with. By the
owner's decision it is visible to every signed-in member, with numbers.

## Acceptance criteria

AC-1: the line is public by default and a member can hide it (account_visibility.indexBoost).
TEST: services/gateway/test/vtid-04489-index-boost.test.ts
AC-2: the function is callable by signed-in members only; no JWT returns NULL.
TEST: services/gateway/test/vtid-04489-index-boost.test.ts
AC-3: drivers whose pillar rose rank first; a pillar that fell never outranks more activity.
TEST: services/gateway/test/vtid-04489-index-boost.test.ts
AC-4: only the subject's own rows are read.
TEST: services/gateway/test/vtid-04489-index-boost.test.ts

Live results are in `outputs/live-verification.md`.
