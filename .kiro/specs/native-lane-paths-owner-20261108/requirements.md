# Requirements — lane paths for two owner-approved native test edits (native-lane-paths-owner-20261108)

## R1 — The change
1.1 `.kiro/specs/native-wave2-events-calendar-r3/lanes/events-meetups.md` `paths` gains exactly one line:
`apps/mobile/tests/orb/nav-directive.test.ts`.
1.2 `.kiro/specs/native-wave2-fix-forward-r2/lanes/public-entry.md` `paths` gains exactly two lines:
`apps/mobile/tests/resolve-link.test.ts` and `apps/mobile/tests/public/i18n-routes.test.tsx`.
1.3 No other line of either target changes (`state`, `seat`, `executor`, `reviewer_seat`, `vtid`, `claimed_by`, `updated`,
every log line). No glob is added, so no other test file becomes writable.

## R2 — Authority
2.1 The owner decision of 2026-11-08 (quoted in the lane file) is the authority for the three files. The plan adds no
authority beyond it: what each lane may change inside those files stays limited by the quote and by that lane's PR body.
2.2 The mechanism is the existing `lane_admin` path (VTID-05408, `queue.mjs` `laneAdminCovers`); no rule, script or
workflow changes, and Lane scope is neither loosened nor bypassed.

## R3 — Proof
3.1 Negative: on today's main, a commit of lane `events-meetups` that changes `nav-directive.test.ts` fails Lane scope; the same for
the two `public-entry` files. 3.2 Positive: with this change on main, the same commits pass Lane scope; a third, unrelated
test file is still refused.
