# VTID-04018 — W4a: the Operator Console's session bootstrap pack (gap analysis §4.1)

Context: `docs/OPERATOR-CONSOLE-GAP-ANALYSIS-2026-09-17.md` §4.1. The console's codebase knowledge was a hand-typed six-bullet constant (`CODEBASE_OVERVIEW_BLOCK`, VTID-03930) refreshed by hand. A Claude Code session starts every turn with CLAUDE.md, the service map, the schema, the recent change log and what is live. This VTID gives the operator model the same start, from real sources, on every turn — main turn and tool-result turn alike — cached for 5 minutes, bounded to ~30–40 KB, and fail-open per source.

Sources (each independently bounded and timed out at 2.5 s): CLAUDE.md Part 1 rules (read from GitHub — the gateway container has no CLAUDE.md); `config/service-path-map.json`; `DATABASE_SCHEMA.md` `###` table headings; the newest 20 CHANGE LOG rows compressed to one line each; live `/api/v1/admin/build-info` for the gateways named in `OPERATOR_BOOTSTRAP_BUILD_INFO_URLS`; open PRs on both repos (platform with CI state); the last 10 `deploy.*`/`dev_autopilot.*` OASIS events; and the tool catalog rendered from the declarations the model is actually given this turn (never a hand-typed list). Gated on `OPERATOR_BOOTSTRAP_PACK_ENABLED=true` (default off). The VTID-03930 block stays — the pack supplements it.

AC-1 — Pure renderers: Part 1 rules are extracted and bounded (never the change log); change-log rows compress to `date VTID: first sentence`; the schema index lists `###` headings; the path map renders as `key → path`; the tool catalog is one line per declaration (first sentence); PRs, events and build-info render one line each; the flag and the build-info targets parse strictly (https only).
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts

AC-2 — Assembly: a dated header, one `###` section per source, `(unavailable: …)` for a failed source, `(empty)` for an empty one, clipped at `PACK_MAX_CHARS` with an explicit truncation note.
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts

AC-3 — Fail-open: a throwing or hanging source becomes one unavailable line within the source timeout and does not block the other sections; a single unreachable build-info target is one line, not a failed section; a broken deps set yields an empty pack, never a throw; the pack is `''` when the flag is off and no source is called.
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts

AC-4 — Cache: fetched sections are reused for `BOOTSTRAP_TTL_MS` (5 min), concurrent builds coalesce into one fetch round, the tool catalog is rendered per call from that turn's declarations, and the cache expires after the TTL.
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts

AC-5 — Wiring: `callVertexWithTools` appends the pack after the VTID-03930 orientation block and passes the same tool definitions it rendered; `sendToolResultsToVertex` carries the same pack (§4.1 "same prompt for tool-result turns"); the VTID-03930/03892/03838 prompt suites still pass; the staging workflow pins the flag and the two build-info targets and prod does not.
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts
TEST: services/gateway/test/vtid-03930-operator-codebase-overview.test.ts

Not verified here: the pack assembled against live GitHub/Supabase/build-info on staging — the first operator turn after the staging deploy is the exercise (look for the "Session bootstrap pack (VTID-04018) — assembled …" header in the served system prompt via the operator debug path, and for `(unavailable: …)` lines that name a source to fix). The §4.1 item "memory recall against the thread summary" is not in this VTID — thread summaries are W4b (server-side threads, §4.3).
