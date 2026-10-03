# VTID-04863 — The stored date is spoken as stored; a false "already known" is not heard (live B-CONF-06)

Memory suite layer B on staging `e36e486`, 2026-10-01, B-CONF-06 failed both runs (sessions `live-afce4968`, `live-b3063b00`). `spouse_birthday = 1997-11-04` was stored, and the member said "merk dir, meine Frau hat am vierten November 1999 Geburtstag".

1. Nova called `remember_fact` with the stored value `1997-11-04`, not the value the member said. The tool answered `already_known`, and the member heard *"Ich weiß bereits … neunzehnhundertneunundneunzig"*.
2. The turn_complete re-check (VTID-04690) ran the member's own words, found `spouse_birthday: conflict`, and sent the note. The note said the stored value was "1997-11-04". Nova still spoke the stored year as 1999: *"Ich habe den vierten November neunzehnhundertneunundneunzig im Speicher, aber du hast … neunzehnhundertneunundneunzig gesagt."*

## Change

- **`remember-fact-tool.ts`:**
  - `readableValue()` turns an all-digit stored date into words ("1997-11-04" → "4 November 1997"). Values like "May 5" stay as written.
  - `describeDifference()` names what differs ("They differ only in the year: the stored year is 1997, the member said 1999").
  - The conflict and already_known instructions use both, and ask the model to name both values exactly as written. The stored data is unchanged.
- **`remember-confirm-gate.ts`, `maybeHoldAlreadyKnownReply()`:**
  - When `remember_fact` answers `already_known` for a value the member's own words do not carry, the reply is held with the VTID-04702 hold (`already_known_check`) until the turn_complete re-check. Spoken numbers cannot be compared, so a date is held unless its digits are in the words.
  - If the re-check finds a conflict and sends its note, the held reply is dropped. If it finds nothing new, the held reply plays.
  - "Bello" said again is not held.

AC-1: The conflict instruction for the B-CONF-06 values carries "4 November 1997", "4. November 1999" and the year difference.
TEST: services/gateway/test/services/memory/vtid-04861-04863-remember-save-fixes.test.ts

AC-2: In the live B-CONF-06 sequence, the "already known" reply is never forwarded and is replaced after the re-check. If the re-check finds nothing new, it plays. B-DUP-01's "Bello" plays at once. The hold is off with `ORB_REMEMBER_HOLD_ENABLED=false`.
TEST: services/gateway/test/orb/live/session/vtid-04862-04863-remember-confirm-gate.test.ts

AC-3: The memory conformance suite (layer A) still passes.
TEST: services/gateway/test/memory-verification-conformance.test.ts

## Live check after merge

Re-run memory suite layer B on staging (`scripts/memory-verification/run-live.mjs --only B-DUP-01,B-CONF-01,B-CONF-06 --runs 2 --pause-reset`).
