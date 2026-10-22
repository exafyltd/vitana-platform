# Sparring responses — round 2

All three findings verified against the code and accepted. The plan block,
lanes, and tasks now require the `unavailable` fifth argument, a non-throwing
`allSettled` contract for the enrichment seam, and explicit companion-scale
priorities (not the catalog ordering).

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Verified: card-availability.ts unavailableEnrichmentCards() returns {E6,E7} whenever the Meta OAuth clients are unset (every current stack), and routes/enrichment-cards.ts:82 always passes it as the 5th arg to eligibleEnrichmentCards(). Omitting it would DM a Connect-Instagram/Facebook card that 400s on tap. Plan §2/§3, both lanes, and tasks now mandate passing unavailableEnrichmentCards() as the 5th argument, the E6/E7 eligibility rows note 'OAuth client configured', and a test asserts no E6/E7 moment when INSTAGRAM_CLIENT_ID/FACEBOOK_CLIENT_ID are absent."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Verified: fetchMemberSignals uses Promise.allSettled and never throws; it joins the Promise.all at companion-service.ts:131, so a throwing enrichment seam would reject the whole tick and decide zero members. Plan §3 item 1, the companion-enrichment-signals lane, and tasks now require the FetchEnrichmentCompletions seam to follow the allSettled/unavailable[] pattern, never throw, and return a SignalsResult-analogous shape; a test asserts a rejected profiles query yields an empty map + unavailable:['enrichment_profiles'] with the tick continuing."
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "Verified: eligibleEnrichmentCards() returns priority = ENRICHMENT_PRIORITY.indexOf(t)+1 (1..11, lower=better), while pickMoment sorts descending (higher wins; greeting 10). Using the catalog priority directly would rank E1-E9 below the greeting and they'd never win. Plan §3 item 3, the moments lane, and tasks now state EligibleEnrichmentCard.priority must NOT be used as MomentCandidate.priority; each moment gets an explicit companion-scale priority in 20-49 (E1 highest -> E11 lowest), and the priority-pin test asserts absolute values."
  }
]
```
