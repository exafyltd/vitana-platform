# VTID-04734 — Ranking and recommendations stay commission-free

Plan step 2 of `docs/COMMERCE-SUPPLIER-INFRASTRUCTURE-ARCHITECTURE.md` (§1.2 invariant 6, §7.2): a build-failing guard that the code choosing or ordering what a member is shown never reads a commission, payout or earnings field.

## Change

- `services/gateway/test/vtid-04734-ranking-commission-free.test.ts`, test only. It reads the source of every guarded module and fails on any commercial reference. The guarded modules are:
  - Discover feed and search;
  - the limitations filter;
  - the user-health context;
  - the ORB marketplace tools;
  - every autopilot recommendation analyzer, including the health analyzer;
  - the shopping agent.

  New files in these directories are covered automatically, 50 modules today. The check ignores comments and matches whole words, so "learning" never matches. The VAEA matcher may keep loading `commission_percent`, but its scoring, filter and sort must not use it.
- The audit found no violation, so no product code changes.

## Acceptance criteria

AC-1: every guarded ranking/recommendation module is free of commission, payout and earnings references.
  TEST: services/gateway/test/vtid-04734-ranking-commission-free.test.ts
AC-2: the guard cannot silently become a no-op (at least 25 files, the key modules present).
  TEST: services/gateway/test/vtid-04734-ranking-commission-free.test.ts
AC-3: the detector flags planted commercial identifiers and ignores comments and ordinary words.
  TEST: services/gateway/test/vtid-04734-ranking-commission-free.test.ts
AC-4: a real violation fails the build. Mutation check: appending `p.commission_rate` to `services/feed-ranker.ts` makes the guard report 1 bad file; reverting clears it.
  TEST: services/gateway/test/vtid-04734-ranking-commission-free.test.ts

## Staging

The change is test-only, so there is no runtime behaviour to probe on staging. The staging suite runs this guard.

OASIS_PROOF: none. No event is added or changed; this is a build-time guard.
