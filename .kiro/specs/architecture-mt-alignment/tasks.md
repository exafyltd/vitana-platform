# Tasks — architecture-mt-alignment
Authoritative plan: `plan.md`. VTIDs from CI PLAN-SPAR. Branch `kiro/architecture-mt-alignment/<lane>`; title
`VTID-xxxxx (architecture-mt-alignment/<lane>): …`; trailers `Collab-Session`, `Collab-Lane`; author `kiro-agent[bot]`;
evidence in `docs/validation/<VTID>/` (`acceptance.md`, `commands.log`, `scope.json`).

Common acceptance:
- Change types: Tooling/docs.
- Only the lane `paths` change; no code, schema, migration, flag, RLS, MT spec, `CLAUDE.md` or `areas.yaml` change.
- Every `file:line` resolves at the pins (citation script run in `commands.log`); the strategy SHA is recorded.
- Every statement carries one status class: Verified operational (only with a run id); Verified implemented, not
  operational; Implemented but incomplete; Designed but not implemented; Deprecated/superseded; Unknown.
- Every needed change is a "proposed follow-up" (title, files, owner, gate), never presented as done.

<!-- lane: arch-map-verify -->
## Lane `arch-map-verify`
- [ ] T1 Paths check script over the 41 modules of `02-PLATFORM/module-ownership.json` at `e5dd629`.
- [ ] T2 Per module: entry points/interfaces with file:line, status check, tenant awareness check, verdict.
- [ ] T3 Missing modules and missing dependency edges; corrections list for the strategy owner.

**Acceptance**
- 41 of 41 modules have a verdict (confirmed / corrected / Unknown) and the counts add up.
- Every "Verified operational" either keeps a run id that was re-read or is downgraded with the reason.

<!-- lane: mt-alignment -->
## Lane `mt-alignment`
- [ ] T1 MT contracts at the pin with file:line and status class.
- [ ] T2 Open MT specs and lanes with protected paths and hot files.
- [ ] T3 18-workstream table: contracts consumed, must-not-duplicate, conflicts with open MT lanes; follow-ups.

**Acceptance**
- 18 of 18 workstreams in the table; each conflict names the MT spec and file.
- No duplicate resolver, identity, membership or authorisation model is proposed.
