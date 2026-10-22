# Sparring responses — session 2, round 2

All three findings verified and accepted. The §2/§3 priority contradiction is
resolved to 21–39 everywhere, `repeatAfterDays` is now specified per card, and
the 5th-argument enforcement is made a call-site + test requirement.

```json
[
  {
    "finding_id": "R2-F1",
    "disposition": "accepted",
    "rationale": "Correct contradiction: §2 said 21-39 (the R1-F4 fix) but §3 item 3 still said 20-49, which overlaps diary_nudge (40-50) and undoes the fix. §3 now reads 21-39, strictly above featureTip 20 (no tie) and strictly below diary_nudge floor 40, E1=39 -> E11=21; the §2 table lists explicit priorities 29-39. Priority-pin test asserts absolute values from this range."
  },
  {
    "finding_id": "R2-F2",
    "disposition": "accepted",
    "rationale": "Real gap: no repeatAfterDays meant an incomplete card fires daily (the 7-day cooldown only starts on explicit dismiss, not on an ignored DM); every shipped moment has a non-zero window. Owner decision recorded in the §2 table: profile/setup cards E1/E2/E4/E5/E11 = repeatAfterDays 4; connector/social cards E3/E6/E7/E8/E9/E10 = 7. Added §3 item 4, the moments lane, task 7, and a test: ignored E1 yesterday is not re-offered today."
  },
  {
    "finding_id": "R2-F3",
    "disposition": "accepted",
    "rationale": "Correct: eligibleEnrichmentCards defaults unavailable = new Set(), so TS cannot enforce the 5th arg and an omission silently enables E6/E7. Rather than change the shared signature (option a touches the route too), chosen option (b) hardened: the companion call site passes unavailableEnrichmentCards() explicitly and the lane adds a unit test asserting no E6/E7 when INSTAGRAM_CLIENT_ID/FACEBOOK_CLIENT_ID are unset for a member incomplete on both — the test, not the doc word, is the guarantee. Recorded in plan §2 Enforcement and the moments lane."
  }
]
```

<!-- re-trigger PLAN-SPAR synchronize for head 2447dbdeb (the round-2 answer run
was coalesced by the one-run-per-PR concurrency group and executed against the
round-1 head instead; this no-op edit re-fires the path trigger). -->
