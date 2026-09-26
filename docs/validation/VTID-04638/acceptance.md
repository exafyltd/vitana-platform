# VTID-04638 — a confirmed correction leaves one current fact

Found by the live memory suite (VTID-04600, B-CONF-03, staging build `1335b48`).
"Paul's birthday is May 5" was in the Memory Garden. The member said "Paul hat am
siebten Mai Geburtstag"; Vitana asked which date is right; the member said "der
siebte Mai ist richtig"; Vitana confirmed the update. Afterwards both values were
current:

| fact_key | value | entity | source |
|---|---|---|---|
| paul_birthday | May 5 | self | user_stated_via_memory_garden_ui |
| paul_birthday | 7. Mai | disclosed | user_stated |

`write_fact` supersedes only rows with the same `(fact_key, entity)`. A Garden
add writes `entity=self`; `remember_fact` about another person writes
`entity=disclosed`. Recall then held both dates.

Fix: after a confirmed replace, `runRememberFact` retires every other current row
of that key (`supersedeOthers`, whatever the entity). `write_fact` itself is
unchanged.

AC-1: A confirmed replace of a Garden-added fact about another person leaves exactly one current row, holding the new value.
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-2: The scenario fails when the supersede step is removed (mutation check, see commands.log).
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-3: Existing remember_fact, backstop and conformance suites stay green.
TEST: services/gateway/test/memory-verification-conformance.test.ts

AC-4 (live, after staging deploy): B-CONF-03 re-run on staging stores May 7 only.
TEST: scripts/memory-verification/run-live.mjs
