# VTID-04862 — A conflicting value is never written before the member answers (live B-CONF-01)

Memory suite layer B on staging `e36e486`, 2026-10-01, B-CONF-01 run 1, session `live-49485c50`. Paul's birthday was stored as 5 May, then the member said "merk dir, Paul hat am siebten Mai Geburtstag".

- 07:57:29.605: Nova called `remember_fact(7. Mai, confirm_replace=true)`. The answer was `STATUS: conflict`, nothing saved, and the conflict was marked pending.
- 07:57:29.848: 240 ms later, Nova called it again with `confirm_replace=true`. The answer was `STATUS: saved`, replacing "5. Mai".
- Vitana then asked "Welcher ist der richtige Geburtstag?", but 7 May was already written.

The tool's pending-conflict check cannot tell the model's retry from the member's answer. The live session can.

## Change

`orb/live/session/remember-confirm-gate.ts`, wired in `upstream-message-handler.ts`:

- Every member utterance records `memberSpokeAt`.
- A `remember_fact` result of `STATUS: conflict`, or a remember-backstop note that asked about a conflict, records `rememberConflictAskedAt`.
- `confirm_replace` on a `remember_fact` call counts only when `memberSpokeAt > rememberConflictAskedAt`. Otherwise it is dropped (diag `remember_confirm_replace_dropped`) and the call runs as an ordinary one. That returns `conflict` again, and Vitana asks.

The tool itself is unchanged, so other channels and the conformance suite behave as before.

AC-1: The live sequence produces two conflicts and no write.
TEST: services/gateway/test/orb/live/session/vtid-04862-04863-remember-confirm-gate.test.ts

AC-2: After the member answers, `confirm_replace` counts.
TEST: services/gateway/test/orb/live/session/vtid-04862-04863-remember-confirm-gate.test.ts

AC-3: The memory conformance suite (layer A) still passes.
TEST: services/gateway/test/memory-verification-conformance.test.ts
