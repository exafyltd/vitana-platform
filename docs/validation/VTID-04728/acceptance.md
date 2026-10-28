# VTID-04728 — bootstrap pack reads the change log from docs/CHANGELOG.md

AC-1: The Operator Console bootstrap pack's change-log section is built from `docs/CHANGELOG.md` (where VTID-04253 moved the CHANGE LOG), and falls back to `CLAUDE.md` only when that file is missing or has no rows.
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts — "compresses the newest change-log rows…" and "caches the fetched sections…" (4 reads per build)

## OASIS

OASIS_PROOF: no OASIS change; the pack is prompt text for the Operator Console.
