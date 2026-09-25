# VTID-04591 — Voice memory: the gateway runs remember_fact when Nova does not

Measured on staging 2026-09-25 (build edcad39), German voice sessions as the test user,
same utterances ("Merk dir bitte, mein Geburtstag ist der neunte September 1969" /
"Und merk dir: Mein Bruder Paul hat am fünften Mai Geburtstag"):

| session | remember_fact called | what Vitana said |
|---|---|---|
| sessionK (d6c34724) | yes, both turns | birthday: profile answer ✅ / Paul: write failed (fixed by VTID-04588) |
| sessionL (694a3e2d) | no | "ich kann Informationen über andere Personen nicht speichern" ❌ — the extractor had saved it |
| sessionM1 (2c50cffc) | no | "Ich habe dein Geburtsdatum notiert" ❌ — a profile field, not saved |
| sessionM2 (fdbac42c) | — | Nova content-filter block at open (separate, known Nova issue) |
| sessionM3 (b4504122) | no | no answer to the turn |

Prompt wording cannot make a tool call reliable, so the outcome no longer depends on it.

## Acceptance criteria

AC-1: a remember request is detected in DE/EN/ES/SR; an ordinary statement, "remembered", and the gateway's own note are not.
TEST: services/gateway/test/services/vtid-04591-remember-backstop.test.ts
AC-2: without a remember_fact call in the turn, the gateway extracts the facts and runs the remember_fact rules: own profile field → profile_owned and no write; new fact → saved; different stored value (also under another key) → conflict and no write.
TEST: services/gateway/test/services/vtid-04591-remember-backstop.test.ts
AC-3: the model receives the STATUS lines as a marked system note (Nova text turn) telling it to state the real outcome and correct its earlier answer; the note is never recorded as member speech.
TEST: services/gateway/test/services/vtid-04591-remember-backstop.test.ts
AC-4: when the model did call remember_fact, the backstop stands down.
TEST: services/gateway/test/services/vtid-04591-remember-backstop.test.ts
AC-5: a conflict the gateway reported is remembered for the session; the member's next turn is applied only when it names one of the two values.
TEST: services/gateway/test/services/vtid-04591-remember-backstop.test.ts
AC-6 (live, staging): the same German utterances produce a correct spoken outcome whether or not Nova calls the tool.
UI: live German voice session on preview-aws-gateway.vitanaland.com as the test user, see outputs/live-staging.md

Nova only (the Vertex bridge answers injected client_content twice). Off switch: `ORB_REMEMBER_BACKSTOP_ENABLED=false`.

OASIS_PROOF: each backstop run emits `orb.live.diag` with `stage=remember_backstop` and `{trigger, statuses, injected}` (asserted in services/gateway/test/services/vtid-04591-remember-backstop.test.ts, "runs the rules and hands the model the result"). The live rows are recorded in outputs/live-staging.md after the staging deploy.
