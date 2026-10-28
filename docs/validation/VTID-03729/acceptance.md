# VTID-03729 — wire cascade context into the Voice Lab decision probe

`GET /api/v1/voice-lab/nova/decision` is documented as answering "would THIS
caller's next ORB session ride Nova?" with the exact selector the live
session path uses — it is the tool for manually verifying VTID-03723's fix
without opening a paid stream. Found, immediately after VTID-03723 deployed
to staging, that this probe never populated the selector's `cascade` context
field (unlike `orb-live.ts`'s real session path), so it could never report
`cascaded_language_rescue` for pl/pt/ru/ar/zh — a false negative in the exact
tool meant to confirm the root-cause fix worked.

---

AC-1 — `lang=pl`/`lang=pt` with the cascade enabled report `cascaded`,
matching what a real session would do

TEST: `services/gateway/test/routes/voice-lab-nova-decision-cascade.test.ts` —
"lang=pl with the cascade enabled reports cascaded_language_rescue, not a
forced-Nova verdict"
TEST: same file — "lang=pt with the cascade enabled also reports
cascaded_language_rescue"
Output: outputs/targeted-tests.txt

AC-2 — `lang=sr` (no Polly voice, even with the cascade on) correctly stays
off the cascade path and forces Nova instead — never vertex

TEST: same file — "lang=sr (no Polly voice, even with the cascade on) is NOT
reported as cascaded — falls to forced Nova, never vertex"
Output: outputs/targeted-tests.txt

AC-3 — the cascade flag is genuinely load-bearing at this route now, not
merely present and ignored

TEST: same file — "lang=pl with the cascade OFF forces Nova rather than
reporting cascaded" — asserts the OPPOSITE reason from AC-1's `lang=pl`
case for the identical language, gated only by the env flag
Output: outputs/targeted-tests.txt

AC-4 — Nova-native languages are unaffected by the cascade flag either way

TEST: same file — "lang=en (Nova-native) is unaffected by the cascade flag
either way"
Output: outputs/targeted-tests.txt

AC-5 — the VTID-03723 invariant (never `provider: 'vertex'`) holds at this
route too, across every language and both cascade-flag states

TEST: same file — "provider is never vertex regardless of lang or cascade
flag (VTID-03723 invariant, re-asserted at this route)" — 11 languages x 2
flag states = 22 assertions in one test
Output: outputs/targeted-tests.txt

AC-6 — no regression to the route's existing auth-rule tests, or the wider
gateway suite

TEST: `services/gateway/test/routes/voice-lab.test.ts` — full file, unchanged
Output: outputs/targeted-tests.txt
TEST: `npx tsc --noEmit` — clean, zero errors
Output: outputs/tsc.txt

---

## Deliberately out of scope

No other Voice Lab or diagnostic endpoint was audited for the same gap in
this pass — `/nova/decision` was found and fixed because it was the specific
endpoint used to verify VTID-03723 live. A broader sweep for other
diagnostic routes that call `selectUpstreamProvider()` without full context
is a reasonable follow-up but not attempted here.
