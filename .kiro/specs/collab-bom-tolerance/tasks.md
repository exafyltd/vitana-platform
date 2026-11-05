# Tasks — collab-bom-tolerance
<!-- lane: bom-strip -->
Repo `exafyltd/vitana-platform`. Code starts only after the VTID is allocated (plan § Lanes).
- [ ] T1 Test first: add the three tests of plan § Change 2 to `scripts/collab/queue.test.mjs`. On `origin/main` run
      `node --test scripts/collab/queue.test.mjs` and save the output to `docs/validation/<VTID>/red-on-base.txt`: only
      the BOM test fails, on `null` from `parseFrontMatter`.
- [ ] T2 `scripts/collab/queue.mjs` `parseFrontMatter`: strip one leading U+FEFF before the `^---` match (plan
      § Change 1). No other line changes.
- [ ] T3 Green on head: `node --test scripts/collab/queue.test.mjs` passes in full; `node scripts/collab/queue.mjs
      validate --base origin/main --head HEAD` and `scope-check --base origin/main --head HEAD` exit 0. Commands and summaries in `docs/validation/<VTID>/commands.log`.
- [ ] T4 PR titled `VTID-xxxxx (collab-bom-tolerance/bom-strip): …`; every required check green on its head;
      reviewer-agent accept on the head; merge only on the owner's instruction naming the plan (§3a).
Acceptance:
- Change types: Tooling (collab validator), tests, validation records.
- **Outcome** — a lane or handoff file whose first bytes are `EF BB BF ---` parses to the same front matter as the
  same file without the BOM.
- **Contract** — a file without a BOM parses byte-for-byte as before; a file with no front matter (or a BOM followed by
  no front matter) still returns `null`; the `lanes without a handoff.md` check is unchanged.
- Red on base for the reason fixed, green on head; diff only inside the lane paths; no test skipped or loosened; files
  UTF-8 without BOM.
