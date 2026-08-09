# VTID-03556 — Acceptance (ORB apology branch localization)

Scope of THIS PR: gateway-only (`services/gateway/src/services/conversation/compute-greeting-decision.ts`
+ `services/gateway/test/services/conversation/**`). No routes, DB, or infra touched.

AC-1 — The legacy "apology" greeting branch (wasFailure + bucket in {reconnect, recent}) speaks
in the session's language instead of a hardcoded English literal
  TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
        ("legacy apology branch: wasFailure + reconnect (lang=de — VTID-03556 regression)" — asserts
        the directive contains "Entschuldige" and does NOT contain "Sorry about that" for a
        German-locale context, which is the exact regression reported live)

AC-2 — The branch still speaks correctly for every other already-supported ORB language
  TEST: same file, "legacy apology branch: wasFailure + reconnect (lang=en)" (English, unchanged
        wording) and "legacy apology branch: wasFailure + recent (lang=fr)" (French)

AC-3 — An unrecognized/unsupported locale degrades safely to English rather than throwing or
producing an empty directive
  TEST: same file, "legacy apology branch falls back to English for an unknown lang"

AC-4 — No other branch of buildLegacyGreetingPrompt (bucket ladder, anonymous intro) changed
behavior — this is a scoped fix to the one unlocalized branch
  TEST: services/gateway/test/services/conversation/compute-greeting-decision.golden.test.ts
        full file (40 tests, all pre-existing non-apology-branch cases pass byte-identical;
        snapshot diff limited to the 1 renamed + regenerated apology-branch entry plus the 3 new
        cases)

AC-5 — Gateway suite, typecheck, and build are unaffected
  TEST: npm test (116 suites / 1653 passing) && npm run build (via CI's Build Gate)
  See ./commands.log and ./outputs/ for captured results. `tsc --noEmit` reports the same 3
  pre-existing unrelated errors in src/index.ts present on main before this branch (confirmed via
  `git stash`), so this PR does not change the typecheck error count.

---

This VTID's own scope never touches `services/gateway/src/routes/**` (see
above). The PR this VTID ships alongside also carries VTID-03557, which DOES
touch `services/gateway/src/routes/orb-live.ts` — no new route is mounted by
that change either (existing WS session handler, internal logic only); its
own ROUTE_MOUNT/FINAL_URL/CURL_PROOF record lives in
`docs/validation/VTID-03557/acceptance.md`. Recorded here too since the
Route Mount Evidence Gate resolves its target VTID from whichever VTID
pattern appears first in the PR title:

ROUTE_MOUNT: services/gateway/src/routes/orb-live.ts — no new router.*() call
added; see docs/validation/VTID-03557/acceptance.md for the full record
FINAL_URL: wss://{gateway}/api/v1/orb/live/ws (pre-existing, unchanged)
CURL_PROOF: N/A — no new HTTP endpoint (see VTID-03557's acceptance.md)
