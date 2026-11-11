# Tasks — kiro-fleet-register
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/kiro-fleet-register/<lane>`; title
`VTID-xxxxx (kiro-fleet-register/<lane>): …`; trailers `Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`;
evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`).

<!-- lane: seats -->
## Lane `seats`
- [ ] T1 `kiro: <n>` on the four existing seats (hotmail 1, exafy 2, exafyltd 3, jtadic 12).
- [ ] T2 Seats `vitanaland` (4), `office` (5), `support` (6): `account`, `surface: pending`, `kiro`; no `automation`.
- [ ] T3 Comment block: slots 7–11 reserved; account / seat / operator / session definitions.

**Acceptance**
- Change types: Tooling/docs.
- `loadSeats` returns exactly `jtadic, exafyltd, hotmail, exafy, vitanaland, office, support`; no seat renamed or removed.
- Every seat line has `account` and `kiro`; the `kiro` values are 1, 2, 3, 4, 5, 6, 12, each once.
- `node --test scripts/collab/automations.test.mjs scripts/collab/queue.test.mjs` passes; preflight passes.
- No automation file, area, GitLab account, token, workflow or permission is added or changed.
