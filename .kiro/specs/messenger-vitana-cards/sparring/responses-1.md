# Sparring responses — round 1

All six substantive findings verified against the code and accepted; the two
minors accepted as documentation/scope corrections. The plan block in `plan.md`
was rewritten accordingly: the only net-new scope is the 11 E1–E11 enrichment
moments gated through `eligibleEnrichmentCards` (completion + dismissal), plus a
new bulk-read lane; all shipped moments (F1/F2/F3/F7/F8 and the Index/diary
cadences) are retained unchanged, the parallel weekly-reminder lane is dropped,
and the staging assertion is replaced with the `disabled-on-staging` pattern.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: moments.ts:276 already exports guidedJourneyStep (F1), inviteFriend (F7), featureTip (F8) in COMPANION_MOMENTS (VTID-05101). Re-adding them would duplicate entries and corrupt pickMoment ranking. Plan rewritten: lane companion-enrichment-moments adds ONLY E1-E11; F1/F7/F8 removed from scope and explicitly retained unchanged (plan §2)."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: vitanaIndex (repeatAfterDays:3, priority 50-70) and diaryNudge (repeatAfterDays:4) already exist in COMPANION_MOMENTS. pickMoment has no surface-specific lists, so parallel weekly moments would be out-ranked and never win. The companion-weekly-reminders lane is dropped entirely. The owner's weekly-reminder intent is already met by the shipped moments; any different cadence is a one-line repeatAfterDays change, out of this plan (plan §2, 'Explicitly NOT in scope')."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: config.ts:84 returns mode 'disabled-on-staging' unconditionally on staging; VTID-05100 staging-tests.json asserts exactly that. A delivered-card assertion on staging is impossible. Plan §5 now uses the established pattern: GET /api/v1/companion/status = disabled-on-staging, with moment selection proven by offline unit/integration tests."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified: loadEnrichmentCardState (completion-resolver.ts:232) runs ~8 per-member queries; no bulk form exists, unlike signals.ts fetchMemberSignals which is bulk per page. The 'one batched read' claim was false. Plan now has a dedicated lane companion-enrichment-signals that builds bulk reads in companion-repository.ts (inChunks/inChunksPaged, one IN-clause per table) and adds a FetchEnrichmentCompletions tick-deps seam. This is called out as the single biggest piece of real work (plan §3, §4)."
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified: card-catalog.ts eligibleEnrichmentCards(completions, dismissRows, screen, now) applies a 7-day cooldown and the header (lines 7-10) states 'done or dismissed anywhere disappears everywhere', naming the Messenger companion engine as the intended consumer. Plan now fetches user_enrichment_cards dismissal rows in the same bulk read and gates every enrichment moment through eligibleEnrichmentCards (completion AND dismissal), not completion alone (plan §2, §3, §5)."
  },
  {
    "finding_id": "R1-F6",
    "disposition": "accepted",
    "rationale": "Verified: diaryNudge.build returns null when ctx.diaryLastEntryDate is falsy ('never wrote inside the window'), so it cannot nudge a member who never wrote. Chosen option (a): the summary's 'if the member never writes a diary entry' language is removed. This plan does not add a never-started diary moment; the diary reminder remains the shipped lapsed-habit nudge. A diary-introduction moment, if wanted, is a separate decision (plan §1 summary reworded, §2)."
  },
  {
    "finding_id": "R1-F7",
    "disposition": "accepted",
    "rationale": "Verified: COMPANION_MOMENTS is consumed only by companion-service.ts pickMoment; there are no 'other surfaces'. The 'distinct Messenger weekly moment' rationale is removed along with the whole weekly-reminders lane (see R1-F2). No parallel Index moment is added."
  },
  {
    "finding_id": "R1-F8",
    "disposition": "accepted",
    "rationale": "Verified: morningGreeting emits cardType 'F4' at priority 10, repeatAfterDays 0. A future usage-gated F4 would collide. F4 is out of scope for this plan (held for a later plan); the collision is recorded as a Phase/precondition note in plan §6 risk 4 so the follow-up F4 plan changes the greeting's card type when it ships."
  }
]
```
