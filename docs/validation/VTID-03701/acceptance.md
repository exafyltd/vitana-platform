# VTID-03701 (follow-up) — recover from raw control chars in LLM JSON output

**Profile:** `gateway_backend`

**VTID note:** this reuses VTID-03701 (the Bedrock credential-wiring fix,
PR #3162) rather than a freshly-allocated VTID. This session has no live
gateway/Supabase access to self-allocate one (`allocate_global_vtid` needs a
DB write this session cannot reach), and per CLAUDE.md IF-THEN rule 9
("rules conflict → prefer stricter rule") plus the established precedent in
this repo's own changelog (e.g. the 2026-08-20 VTID-03646 entry), continuing
under the parent VTID's identity is the documented fallback rather than
fabricating a number. This is genuinely a distinct defect from #3162
(content-parsing, not credentials) found while verifying #3162 end-to-end —
flagged here rather than silently folded in.

---

AC-1 — a raw control character inside an LLM JSON string value no longer
fails the unit

Live evidence: I18N-DB-SEED run 32730591018 (`zh`, both DB-content
surfaces, dispatched right after #3162 merged) reported 45 of 91 zh
failures as `Expected ',' or '}' after property value in JSON at position
N` — zero of these on `ar` in the same session. Root cause: Claude
occasionally emits a literal newline inside a JSON string value instead of
the escaped `\n`. `parseJsonObject()` now retries once against a copy that
re-escapes any raw control character (0x00-0x1F) found inside a JSON
string literal before giving up.

TEST: `test/db-i18n/db-i18n.test.ts` → "recovers from a raw newline
embedded in a JSON string value (VTID-03701-follow-up)". Evidence:
`outputs/tests.txt`.

AC-2 — this is a narrow, mechanical repair, not a general malformed-JSON
parser — a genuinely broken response still fails, with its original
diagnostic

Sanitizing raw control characters inside strings cannot and must not paper
over a truncated or otherwise malformed response (the case
`translateUnits`'s existing batch-splitting logic already owns). On a
still-unparseable response after the sanitize retry, the ORIGINAL
`JSON.parse` error is surfaced (not the sanitized attempt's error), so a
real truncation/refusal keeps its true diagnostic and position.

TEST: `test/db-i18n/db-i18n.test.ts` → "still reports a failure when the
JSON is genuinely unparseable, sanitization or not". Evidence:
`outputs/tests.txt`.

AC-3 — the fix is load-bearing, not a no-op that happened to pass

Mutation-verified: disabling the sanitize retry (forcing it to rethrow the
original error unconditionally) turns AC-1's test red with exactly the
un-recovered parse error (`Bad control character in string literal in
JSON at position 21`); restoring the retry turns it green again, byte-for-
byte identical to the pre-mutation file.

TEST: manual mutation pass, recorded in `commands.log`. Evidence:
`outputs/mutation-verify.txt`.

AC-4 — no regression to the rest of the db-i18n suite or the gateway
typecheck

TEST: full `test/db-i18n/db-i18n.test.ts` suite (59/59) and `npx tsc
--noEmit` (clean). Evidence: `outputs/tests.txt`. Full gateway suite
(689/690 suites, 1 pre-existing skip, 13138/13173 tests) was also run
locally before opening the PR — not re-captured here since AC-1/AC-2/AC-4
already isolate the changed surface; see the PR body for the full-suite
summary.

---

**Not yet independently re-confirmed against a live `zh` dispatch post-merge**
— the next `I18N-DB-SEED.yml` run for `zh` (planned immediately after this
PR merges) is the live confirmation that the JSON-parse failures actually
disappear from real Bedrock output, not just the reproduced-locally case
above.
