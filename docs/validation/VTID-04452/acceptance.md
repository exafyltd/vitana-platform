# VTID-04452 — ORB live prompt reads memory through one recall()

Plan: `docs/MEMORY-SYSTEM-PLAN.md` Phase 1.

| AC | Statement | Evidence |
|---|---|---|
| AC-1 | With `MEMORY_ORB_RECALL_ENABLED` unset, the ORB live prompt reads memory exactly as before; recall is never called. | TEST: `test/services/memory/recall-bridge-wiring.test.ts` "flag off: recall is never called" (mutation-checked: removing the flag gate fails it) |
| AC-2 | With the flag on, the prompt is built from broker facts, episodes and diary, using the same selection and formatter. | TEST: `test/services/memory/recall-bridge-wiring.test.ts` "flag on: the prompt is built from recall items" |
| AC-3 | Broker disabled, errored or empty → falls back to the legacy read; recall never throws. | TEST: `test/services/memory/recall.test.ts` (not-ok, no_sections_loaded, never throws); wiring test "falls back" |
| AC-4 | The read is role-scoped (personal + own role) and never reads `ai_memory`. | TEST: `test/services/memory/recall.test.ts` "scoped to the session role", "never reads ai_memory" |
| AC-5 | The flag is pinned on staging only. | TEST: `test/vtid-04452-staging-orb-recall-pinned.test.ts` |
| AC-6 | Recall behaviour is unchanged for every golden scenario. | TEST: `test/memory-golden-eval.test.ts` 12/12 |

Not verified live: staging is unreachable (Cloudflare 1016 on the staging
gateway at the time of writing). The live check is the first staging deploy
after merge: `[VTID-04452] orb recall in Nms` lines next to the legacy
`Bootstrap parallel fetch completed in Nms` lines for the same sessions.
