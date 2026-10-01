# VTID-04496 — Navigation rebuild, Phase 0: golden set + baseline

Owner-approved rebuild of ORB user navigation (plan and decisions:
`docs/navigation-rebuild/PLAN.md`). Phase 0 changes no runtime code: it adds
the measuring stick the rebuild is judged against.

## Acceptance criteria

AC-1: A golden utterance set covers all 11 shipped locales with explicit
"open" requests, "where is" questions and non-navigation small talk, and
keeps every September 2026 production navigation failure as a permanent case.
TEST: services/gateway/test/nav-golden/golden-set.integrity.test.ts

AC-2: The golden set cannot drift from the catalog — unknown screen ids,
duplicate case ids, expect/forbid clashes and empty expectations fail CI.
TEST: services/gateway/test/nav-golden/golden-set.integrity.test.ts

AC-3: A resolver-agnostic harness scores any navigator against the set
(correct / right screen wrong behaviour / clarified / silent / wrong screen /
false action, per locale and per intent), and the legacy navigator is run
through it exactly as `tool_navigate` acts on its result.
TEST: services/gateway/test/nav-golden/nav-golden-baseline.test.ts

AC-4: The legacy baseline is recorded (`baseline.legacy.json`) and ratcheted:
the legacy navigator may not get worse while the rebuild is in progress.
TEST: services/gateway/test/nav-golden/nav-golden-baseline.test.ts

## Result

Baseline (keyword path, embeddings off — the lower bound of production):
167 cases; 44% reach the right screen; explicit "open" 37%; 0 of 53 "where
is" questions get an offer (all 33 hits redirect immediately); 9 non-en/de
locales 2 of 50; 4 of 7 small-talk utterances trigger a redirect. Full
report: `outputs/golden-baseline-report.txt`.

Known limit, stated plainly: the news → cart production failure comes from
the DB-catalog + embeddings path, which this deterministic run does not
exercise (it reports that case as silent). It stays in the set as a
permanent case and will be exercised by the Phase 2 resolver, which uses
recorded embeddings.

OASIS_PROOF: n/a — no runtime change, no event emitted.
