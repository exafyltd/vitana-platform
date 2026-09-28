# VTID-04685 — a hypothetical is not stored as a fact

Found by the live memory suite (VTID-04600, B-NOISE-01, staging build `477fe7c`).
"Wenn ich einen Hund hätte, würde er Max heißen" was stored as
`user_preference_dog_name=Max` — the background extractor's naming.

Fix:
- `isHypothetical()` recognises the conditional mood ("wenn/falls … hätte/wäre/
  würde", "if I had/were … would", "si tuviera …"). A plain future ("wenn ich
  morgen Zeit habe") is not matched.
- The inline extractor drops any extracted value the member said only inside a
  hypothetical or a forget request (`valueOnlyInNonStatements`). A value the
  member also states plainly is kept.
- The extraction prompt says that a hypothetical and a forget request are not
  facts. The voice MEMORY line says a wish or "what if" is not saved.

AC-1: Conditional-mood sentences in German, English and Spanish are recognised; plain statements and plain futures are not.
TEST: services/gateway/test/services/memory/vtid-04685-hypothetical-not-a-fact.test.ts

AC-2: A value said only in a hypothetical or a forget request is dropped; a value also stated plainly is kept; assistant lines never count.
TEST: services/gateway/test/services/memory/vtid-04685-hypothetical-not-a-fact.test.ts

AC-3: The extractor filters through valueOnlyInNonStatements and its prompt carries both rules.
TEST: services/gateway/test/services/memory/vtid-04685-hypothetical-not-a-fact.test.ts

AC-4 (live, staging): B-NOISE-01 passes — nothing is stored with the value "Max".
