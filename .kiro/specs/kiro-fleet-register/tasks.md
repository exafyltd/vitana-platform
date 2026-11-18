# Tasks — kiro-fleet-register
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/kiro-fleet-register/<lane>`; title
`VTID-xxxxx (kiro-fleet-register/<lane>): …`; trailers `Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`;
evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`).

<!-- lane: seats -->
## Lane `seats` (after VTID-05699 is on `main`)
- [ ] T1 `kiro: <n>` on the four existing seats (hotmail 1, exafy 2, exafyltd 3, jtadic 12).
- [ ] T2 Seats `vitanaland` (4), `office` (5), `support` (6), `admin` (7), `tasks` (8): `surface: pending`, `kiro`; no `account`, no `automation`.
- [ ] T3 Comment block, indented inside `seats:`: slots 9–11 reserved; account / seat / operator / session definitions.

**Acceptance**
- Change types: Tooling/docs.
- Every seat line uses the one-line `{ … }` form; `loadSeats` and the `loadAreas` of `automations.test.mjs` return the same seven seats;
- `loadSeats` returns exactly `jtadic, exafyltd, hotmail, exafy, vitanaland, office, support, admin, tasks`; no seat renamed or removed.
- No seat line has `account` and every seat line has `kiro`; `scripts/collab/areas-no-email.test.mjs` (VTID-05699) passes; the `kiro` values are 1, 2, 3, 4, 5, 6, 7, 8, 12, each once.
- `node --test scripts/collab/automations.test.mjs scripts/collab/queue.test.mjs` passes; preflight passes.
- No automation file, area, GitLab account, token, workflow or permission is added or changed.
