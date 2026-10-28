# VTID-04024 — the bootstrap pack's open-PR source timed out on the first live W4a turn; fixed at both ends

Context: the first Operator Console turn on staging after W4a (VTID-04018, `2545dcc`) deployed — a read-only question asked from a Claude Code session on 2026-09-17 ~21:55 UTC — returned live build-info for staging (`2545dcc7acef`) and prod (`7ba9a8eebad1`) and the newest change-log row (VTID-04019) correctly, but the open-PR section read verbatim `(unavailable: Open pull requests timed out after 2500ms)`. Two causes, both real: `listOpenPrsWithStatus` (VTID-01154) fetched CI state for each open PR **sequentially** — N+1 GitHub round trips, over the 2.5 s source budget with a handful of PRs — and its `GitHubFeedItem` never carried the PR title, so the pack was rendering the branch name as the title even when it did succeed.

What ships: `listOpenPrsWithStatus` runs the per-PR CI lookups with `Promise.all` and carries `title`; new one-call `listOpenPrsBare`; the pack's open-PR source (`resolvePlatformOpenPrs`) races the enriched list against `OPEN_PRS_ENRICH_BUDGET_MS` (1.5 s) and, if it is late or fails, serves the bare list marked with `OPEN_PRS_FALLBACK_NOTE` instead of rendering the section unavailable — PR numbers and titles are the orientation the pack exists for; CI state is available on demand through `dev_github_feed`.

AC-1 — `resolvePlatformOpenPrs` serves the enriched list when it arrives inside the budget; falls back to the bare list (marked degraded) when the enriched list is late or rejects, without an unhandled rejection; throws with both reasons when the bare list fails too, and with the enriched reason when no bare lister exists; the default budget leaves room for the bare call inside the section timeout.
TEST: services/gateway/test/vtid-04024-bootstrap-pack-open-prs.test.ts

AC-2 — The pack section lists the PRs plus the degraded note (never `(unavailable: … timed out)`) when enrichment hangs and a bare lister exists, inside the section timeout; renders `ci=…`/`mergeable` flags and no note on the normal path; without a bare lister it degrades to unavailable rather than hanging (the W4a suite's hang test, wording updated).
TEST: services/gateway/test/vtid-04024-bootstrap-pack-open-prs.test.ts
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts

AC-3 — `listOpenPrsWithStatus` runs the per-PR CI lookups concurrently (three PRs with 250 ms per lookup finish well under the sequential 750 ms) and carries each PR's title; `listOpenPrsBare` is exactly one GitHub call carrying number/title/branch/url/updated_at.
TEST: services/gateway/test/vtid-04024-bootstrap-pack-open-prs.test.ts
TEST: services/gateway/test/vtid-03835-github-service-read-access.test.ts

OASIS_PROOF: no OASIS topic, payload or consumer change — this VTID touches a GitHub read helper and a prompt-assembly source only. Pinned by the read-access suite above still passing unmodified.

Not verified here: the next operator turn on staging after this deploys — the section should list `exafyltd/vitana-platform#…` rows with `ci=…` and no fallback note; the note appearing instead means the enriched call still exceeds 1.5 s on that host and the budget or `LIMITS.openPrs` should be revisited.
