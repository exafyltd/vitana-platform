# db-i18n seeder: repair unescaped inner quotes (VTID-04845)

The curriculum translation seed (I18N-DB-SEED) rejected the Audiobook Prolog
topic T257 in Polish, Portuguese, Serbian, Turkish and Chinese on two runs
in a row (36984616124, 36997779127), with the same error on the same field
each time: `Expected ',' or '}' after property value in JSON`. The German
source quotes a question (`„Was weißt du über mich?“`), and in those languages
the model writes the closing quote as a plain, unescaped `"` inside the JSON
string value. Splitting the batch reproduces it, so it failed down to a
batch of one. The parser gains a narrow repair next to its existing
control-character repair.

AC-1: A model reply whose string value contains an unescaped `"` is parsed, and the unit is translated instead of reported as a parse failure.
TEST: services/gateway/test/db-i18n/db-i18n.test.ts ("recovers from an unescaped quote inside a JSON string value (VTID-04845)")

AC-2: The value ends at the real closing quote — a following field is never swallowed into the value, and units in one batch stay separate.
TEST: services/gateway/test/db-i18n/db-i18n.test.ts ("ends the value at the real closing quote when another field follows", "repairs inner quotes in a multi-unit batch without merging units")

AC-3: Well-formed replies are untouched (the repair runs only after the plain and control-character parses fail), a genuinely broken reply still fails, and every repaired reply still goes through validateUnit.
TEST: services/gateway/test/db-i18n/db-i18n.test.ts (whole suite, incl. "still reports a failure when the JSON is genuinely unparseable")

## Routes

No route is added or changed. The translator runs inside the I18N-DB-SEED
GitHub workflow from `main`; nothing on the gateway's HTTP surface changes.

## OASIS

No new OASIS event. The seeder's existing `llm.call.*` events are unchanged.
