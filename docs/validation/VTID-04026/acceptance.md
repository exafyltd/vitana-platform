# VTID-04026 — Vertex Serbian bridge: authenticated sessions close 1007 after the first generation request (the "hold on, I'm reconnecting" loop)

## Reported

Platform owner, live on staging, post-login Serbian ORB voice: Vitana
repeats "hold on, I'm reconnecting" again and again. The previous session
(VTID-04021 handoff, `docs/HANDOFF-VERTEX-SERBIAN-1007-2026-09-17.md`)
traced it to `upstream_ws_close code:1007 reason:"Request contains an
invalid argument."` on ~80% of authenticated `lang:'sr'` sessions and
ruled out the greeting wording (VTID-04014/04015 changed it twice with no
effect) but could not confirm its remaining lead.

## Root cause (measured, not inferred)

1. **The close is not at setup.** On every failing session `setup_complete`
   arrived (`has_upstream_ws:true, upstream_ws_state:1` at `greeting_sent`)
   and the 1007 landed ~290 ms after the FIRST generation request — the
   greeting `client_content`, or, on the sessions whose greeting happened
   to survive, the user's first utterance (`input_transcription` ×N →
   `upstream_ws_close 1007` at `turn_count:1`). That is the exact shape
   `live-system-instruction.ts` already documents for the pre-shutdown
   incident: "a code=1007 'invalid argument' close on the very first
   client_content send (setup itself is accepted)" when the aggregate
   context is too large for Gemini Live.
2. **The instruction is guarded; the tool catalog is not.** The
   `instruction-budget.ts` guard caps `system_instruction` at 30 KB. The
   `tools` array in the same envelope had no bound. Measured on this
   commit's parent (`outputs/tool-catalog-measurements.txt`):

   | session | function declarations | bytes |
   |---|---|---|
   | anonymous, any surface | 2 | 4,907 |
   | authenticated, community surface | 290 | 226,365 |
   | authenticated, admin surface | 134 | 45,542 |

   Anonymous sessions never failed (10/10 in VTID-04021, and again here).
3. **Controlled live isolation.** Same test account, same language, same
   staging deployment, same script, only `current_route` changed
   (`scripts/orb/verify-vertex-serbian-bridge.mjs --route=/admin`, added
   in this VTID). `outputs/live-experiment-staging-2026-09-17.txt`:

   | surface | declarations | turn_complete | 1007 closes |
   |---|---|---|---|
   | community (default) | 290 / 226 KB | **2 / 8** | 6 |
   | admin | 134 / 45 KB | **8 / 8** | 0 |

   Every admin trial produced fluent Serbian; first-audio latency also
   dropped (1.0–1.5 s vs 1.4–2.0 s).
4. Ruled out: an invalid JSON-schema keyword in any declaration (scan of
   all 290, no `default`/`additionalProperties`/`anyOf`/`$ref`/… — the
   only hits are property *names* like `title`), duplicate tool names,
   the voice name (anonymous sessions use the same one and pass), and the
   instruction budget guard itself (the close is post-handshake).

## Fix

`services/gateway/src/orb/live/tools/vertex-tool-catalog-budget.ts` — a
pure first-fit packer: tools named in `VERTEX_BRIDGE_PRIORITY_TOOLS`
(navigation, `end_conversation`, memory, diary, reminders, the guided-
journey/teacher flow, persona hand-off, calendar, messaging, daily logs)
are kept first, the rest in catalog order while they fit, non-declaration
groups (`google_search`) untouched. Default budget 48 KB (inside the
measured-working 45 KB point), `VERTEX_TOOL_CATALOG_BYTE_BUDGET` overrides
it, `0` disables. Applied in `routes/orb-live.ts`'s envelope builder ONLY
when `session.upstreamProvider === 'vertex'` — never keyed on language, so
it cannot widen past the bridge; Nova Sonic and the cascade still get the
full catalog. A trim emits `orb.live.diag stage=vertex_tool_catalog_trimmed`
so it is queryable in `oasis_events` (the instruction guard is console-only,
which is exactly what blocked VTID-04021).

## Acceptance Criteria

AC-1: the guard keeps every priority tool and trims the real authenticated
community catalog to ≤ 48 KB of declaration JSON, with `bytesAfter` equal
to the real wire size.
TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts
  ("authenticated community catalog is far over budget and is trimmed to
  fit, keeping the essentials"; "over budget: priority tools kept first…")

AC-2: the anonymous catalog and any catalog already under budget are
returned untouched (same array instance); the input is never mutated.
TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts
  ("anonymous catalog is already under budget — untouched"; "never mutates
  the input"; "under budget → same array instance")

AC-3: the env override works and a typo cannot silently disable the guard;
`0` disables it explicitly.
TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts
  ("resolveVertexToolCatalogByteBudget" block)

AC-4: the guard is wired in the envelope builder gated on the vertex
provider only (not on `sr`), emits an OASIS diag on trim, and runs before
the NAV-DIAG inventory log.
TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts
  ("wiring (source contract)" block)

AC-5: every priority name exists in the real catalog (a future rename
would otherwise silently demote that tool).
TEST: services/gateway/test/orb/live/tools/vertex-tool-catalog-budget.test.ts
  ("every priority name exists in the real authenticated catalog")

AC-6: surface gating and the rest of the gateway suite are unaffected.
TEST: services/gateway/test/orb/live/tools/surface-gated-catalog.test.ts
  (unchanged, re-run green) and outputs/test-results.txt (full suite)

AC-7 (live, post-merge): re-running
`scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated
--trials=8` against staging on the default (community) surface completes
a turn on every trial with no `upstream_ws_close` 1007, i.e. matches the
admin-surface control above instead of 2/8.
CURL: node scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --trials=8
  **RESULT (2026-09-17 22:57 UTC, staging on d58b4ce, rollout gated on 12/12
  consistent build-info samples): 8/8 turn_complete, 0 x 1007, fluent Serbian
  on every trial, first-audio 0.9–1.6 s.** `oasis_events` shows
  `vertex_tool_catalog_trimmed` on all 8 sessions (290 → 28 declarations,
  226,316 → 49,139 bytes) and a clean close 1000 on each. See
  outputs/live-verification-post-merge-2026-09-17.txt.

## Verification

- Targeted suites: `vertex-tool-catalog-budget.test.ts` (14) +
  `surface-gated-catalog.test.ts` (7) — 21/21 passing.
- `tsc --noEmit`: see commands.log.
- Full gateway suite: see outputs/test-results.txt.
- Live: baseline and control runs above were taken BEFORE this change
  (they are the evidence for the cause); the post-deploy run (AC-7) is the
  evidence for the fix — **done: 8/8 vs the pre-fix 2/8 on the same surface.**

## Deliberately not touched

- The pre-login "thinking text spoken aloud" bug the VTID-04021 handoff
  flagged (visible again in admin trial 1's transcript here) — platform
  owner said not to touch it in this round.
- `VERTEX_AI_LOCATION=global`: the ~80%/20% split on byte-identical
  requests is consistent with the global endpoint routing to backends with
  different effective limits, but that is a hypothesis; shrinking the
  request fixes the failure regardless of which backend serves it.
- Raising the budget above 48 KB: possible once a larger value is observed
  to hold on staging (env override, no redeploy of code needed beyond the
  task-def change).
