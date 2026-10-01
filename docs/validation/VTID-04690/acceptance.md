# VTID-04690 — remember_fact with the stored value, not the member's

Found by the live memory suite (VTID-04600, pass 3, B-CONF-03, staging build
`19a1080`, session `live-3214787c`). Paul's birthday "May 5" was stored. The
member said "Merk dir, Paul hat am siebten Mai Geburtstag" (heard correctly).
Nova called `remember_fact` with `fact_value: "May 5"` — the stored value, not
the one just said — got `STATUS: already_known`, answered "das habe ich schon
notiert – am 5. Mai", and on the member's confirmation ("Der siebte Mai ist
richtig") claimed it had confirmed the 7th while calling nothing. No question
was asked and no value changed. The remember backstop (VTID-04591) stood down
because the tool had been called.

Fix: the live handler records a `remember_fact` answer of
`STATUS: already_known`. At turn_complete the backstop then checks the
member's own words: it extracts the facts and runs `runRememberFact` on them.
A different value becomes `conflict` — nothing is written, the model gets a
`[memory-check]` note saying it sent the stored value, and the conflict is
opened so the member's next answer is applied. When the member really
repeated the stored value, every result is `already_known` and nothing is
injected. Nova only, behind `ORB_REMEMBER_BACKSTOP_ENABLED` like the rest of
the backstop.

AC-1: remember_fact answered already_known and the member's words carry a different value: conflict, nothing written, marked note injected, conflict opened.
TEST: services/gateway/test/services/memory/vtid-04690-stored-value-echoed.test.ts

AC-2: The member's confirmation on the next turn saves the new value.
TEST: services/gateway/test/services/memory/vtid-04690-stored-value-echoed.test.ts

AC-3: When the member really repeated the stored value, or the tool saved/asked, nothing changes.
TEST: services/gateway/test/services/memory/vtid-04690-stored-value-echoed.test.ts

AC-4: The existing backstop behaviour is unchanged.
TEST: services/gateway/test/services/vtid-04591-remember-backstop.test.ts

AC-5 (live, staging): B-CONF-03 passes — one current paul_birthday row holding May 7.
TEST: scripts/memory-verification/run-live.mjs
