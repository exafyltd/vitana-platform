# VTID-04093 — Acceptance Mapping

T1b of the Command Hub cleanup program. Resolved as **delete**, not
wire-up: the whole gated Memory Garden / old-Intelligence panel block was
confirmed to be a fabricated-mock-data duplicate of `renderMemoryOpsView`
(VTID-02636) — real, backend-wired to `/api/v1/admin/memory/*`, and
already mounted live under the same `intelligence-memory-dev` nav slot
(`renderMemoryOpsView`'s own comment: *"replaces the legacy mock
renderers"*).

AC-1 — All 21 function declarations and 2 constant object literals in the
T1b-gated block (`refreshMemoryGarden`, `renderMemoryGardenView`,
`renderMemoryGardenCard`, `renderLongevityFocusPanel`,
`renderLongevitySignal`, `renderDiaryEntryModal`,
`renderCategoryDetailModal`, `getCategorySubcategories`,
`renderUnifiedIntelligencePanel`, `escapeHtmlSafe`,
`renderKnowledgeGraphView`, `getKnowledgeGraphIcon`, `renderRecallView`,
`renderInspectorView`, `renderEmbeddingsView`, `fetchMemoryGardenProgress`,
`fetchLongevitySummary`, `fetchCategoryMemories`, `fetchMemoryFacts`,
`fetchRelationshipGraph`, `fetchBehavioralSignals`, `MEMORY_GARDEN_ICONS`,
`LONGEVITY_MESSAGES`) are deleted, with zero remaining textual occurrence
of any of their names anywhere in app.js.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-2 — The dead `moduleKey === 'memory-garden'` branch in
`triggerGlobalRefresh` (the only other reference to the retired
`'memory-garden'` module key — confirmed absent from `SECTION_LABELS`, so
this branch was already unreachable dead code) is removed.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-3 — `renderMemoryOpsView` (VTID-02636), the real replacement, and its
`intelligence-memory-dev` nav mount are untouched.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-4 — Every prior VTID's test that pinned "this block must survive
untouched pending T1b" (VTID-04063/T1d, VTID-04064/T5b, VTID-04065/T5c,
VTID-04066/T5d) is updated to reflect the resolved decision, not deleted
wholesale — each keeps its own still-relevant assertions and only the
now-obsolete "must still exist" guard is replaced with an explanatory
comment pointing at this VTID.
TEST: services/gateway/test/command-hub/{t1d-dead-functions-removed,t5b-gcp-static-screens-gated,t5c-no-fabricated-fallback-rows,t5d-stale-gcp-labels-fixed}.test.ts

AC-5 — `memory-garden-placeholder-banner.test.ts`, which tested
functionality exclusively inside the now-deleted `renderMemoryGardenView`,
is deleted (its subject matter no longer exists).
TEST: manual — `git status` shows the file removed; no test references it.

AC-6 — Orphaned CSS: `scripts/find-dead-css-classes.mjs --fix` removes
every rule that became dead as a direct result of this deletion (the
`.admin-not-wired-banner` class it reuses, `memory-garden-*`,
`intelligence-container`, `knowledge-graph-*`, etc.), and `--check`
reports in-sync afterward (idempotent).
TEST: services/gateway/test/scripts/find-dead-css-classes.test.ts (pre-existing suite, re-run against this diff)

AC-7 — Cache-bust bumped on both `styles.css` and `app.js` tags in
index.html, kept in sync.
TEST: services/gateway/test/command-hub/t2-no-zero-caller-functions.test.ts

AC-8 — `node --check`, `tsc --noEmit`, and `npm run build` are all clean.
TEST: manual — see commands.log.

## Manual verification (commands.log has full output)

- Dependency analysis before deletion: every one of the 23 removed names
  checked for live callers OUTSIDE the block being deleted (not just
  zero-caller by the guard's narrower function-only scan) — confirmed each
  one's only reachable caller was itself another name in the same block, or
  the now-confirmed-unreachable `moduleKey === 'memory-garden'` branch.
- `state.memoryGarden`'s initial-state object literal (line ~4197) is
  deliberately NOT removed — it is still read at one other live site
  (`state.memoryGarden ? Object.keys(state.memoryGarden).length : '—'`,
  an unrelated stat card), so removing it would break that card. Left
  exactly as-is; out of this VTID's scope.
- Full `test/command-hub/` + `test/scripts/find-dead-css-classes.test.ts`
  suite: 15/15 suites, 242/242 tests passing, 0 failures.
- `docs/AURORA-B3-DEAD-RPC-CALLSITE-AUDIT.md` mentions
  `renderMemoryGardenView` by name as historical context for an unrelated
  backend RPC finding — a docs file recording history, not live code;
  deliberately left untouched.
