# VTID-04049 — free-text `navigate` must not auto-redirect on a pure vector guess

**Reported live:** Vitana correctly offers "all news / community news / longevity news" when
asked for the News feed (`navigate_to_screen`'s DISAMBIGUATION rule working as designed), but
then lands on a random, unrelated screen instead of the option picked.

**Root cause, confirmed via live `oasis_events` on a different, minutes-old session
(`live-99f9553e-72b3-4731-8d43-797c2ab7f408`):** a Serbian free-text query ("najnovije vesti
otvori ekran" — "open the latest news screen") auto-redirected via the free-text `navigate`
tool to `DISCOVER.CART`. `consultNavigator`'s hybrid keyword+semantic scorer already had a
`MIN_SEMANTIC_ONLY_SIMILARITY` floor for a zero-keyword-support match, but the floor only
demotes *below* its threshold — a generic word like "ekran" (Serbian for "screen") clears
`0.55` easily via ordinary cross-lingual embedding similarity while carrying zero literal
evidence for any particular screen, and once above the floor the `decision` computation only
checked for a close-scoring runner-up, never keyword support, so it resolved `confident` and
auto-navigated.

**Fix:** a match with zero keyword score can no longer resolve to `decision: 'confident'`,
regardless of similarity score. With a viable second candidate it still offers the existing
either/or; with none, it asks the user to clarify (`decision: 'unknown'`,
`blocked_reason: 'no_match'`) instead of silently teleporting. Also fixed
`navigate_to_screen`'s own DISAMBIGUATION worked example (`live-tool-catalog.ts`), which cited
a nonexistent "inbox / AI feed / news" split with no matching real `screen_id`, giving the
model no correct template for the actual News 3-way split.

AC-1 — a zero-keyword-support (pure semantic) match with no viable second candidate never resolves `decision: 'confident'`, and `blocked_reason` is set to `'no_match'` — the exact field orb-tools-shared.ts's auto-redirect gate (`primary && confidence !== 'low' && !blocked_reason`) reads before dispatching a navigate directive, so the caller never actually redirects the user to the guessed screen.
TEST: services/gateway/test/navigator-consult.test.ts

AC-2 — a zero-keyword-support match WITH a viable second candidate still sets `confirmation_needed: true` and never resolves `decision: 'confident'` — it offers the either/or instead of guessing.
TEST: services/gateway/test/navigator-consult.test.ts

AC-3 — the existing keyword-scored confidence bucketing (the vast majority of real traffic — e.g. "how do I track my biology" → high confidence, direct auto-navigate) is byte-for-byte unaffected by this change.
TEST: services/gateway/test/navigator-consult.test.ts (pre-existing `consultNavigator — confidence bucketing` suite, unmodified)

AC-4 — `navigate_to_screen`'s DISAMBIGUATION example cites the real News screen_ids (`HOME.OVERVIEW`, `HOME.NEWS_ALL`, `HOME.NEWS_COMMUNITY`) instead of the nonexistent "inbox / AI feed" pairing, and explicitly instructs reusing the exact screen_id already identified for a picked option rather than re-deriving it from memory.
TEST: services/gateway/test/orb/live/characterization/tool-catalog.characterization.test.ts (characterization snapshot, hand-regenerated — see commands.log)

AC-5 — (live, pre-fix repro) the exact reported failure mode — a semantic-only, cross-language query auto-redirecting to an unrelated screen — is reproduced verbatim by AC-1's test using the real `DISCOVER.CART` screen_id from the live incident.
CURL: GET https://gateway.vitanaland.com/api/v1/events?topic=orb.navigator.requested&limit=15 — see commands.log and outputs/oasis-events-live-repro.json for the recorded response. Not yet independently re-verified against live traffic post-merge; this sandbox has no npm registry access (documented, known limitation — see commands.log) so `tsc --noEmit`/`jest` could not be run locally. CI (which has full registry access) is the executable verification for AC-1 through AC-4.
