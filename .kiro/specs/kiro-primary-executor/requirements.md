# Requirements — kiro-primary-executor

1. A Kiro session carries a workstream's routine steps end to end without handing them to Claude Code or the owner
   (plan §A, §B).
2. Merging a non-governance lane needs no per-PR owner instruction when the §B.4 conditions hold; it is recorded with
   `merge:` and `authority: §7d standing`.
3. Kiro applies a migration only through `RUN-MIGRATION.yml`, only for a file the owner approved, recorded with its
   sha256, from an interactive session (§B.6).
4. Production deploys and cutovers, governance-lane merges and direct live-system writes from session tools stay as
   today (§C).
5. The owner is asked only for the §D list, in the five-part format; the lane is parked and other work continues.
6. Both repos carry the same `collaboration.md`; every always-loaded text and every seat automation says the same.
7. No product code changes.
