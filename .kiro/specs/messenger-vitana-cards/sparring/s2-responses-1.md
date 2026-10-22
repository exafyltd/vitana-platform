# Sparring responses — session 2, round 1

New sparring session (plan text changed after the round-3 fixes). The partner
confirmed the structural fixes are sound and raised five findings; all verified
against the code and accepted. Plan, lanes and tasks updated.

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Verified: test/vtid-05101-companion-generators.test.ts:198 strictly .toEqual's the 6-key COMPANION_MOMENTS list, loops expect(c).not.toBeNull() over a `rich` fixture with no eligibleEnrichmentCardTypes, and asserts intent matches /^(Warmly greet|Greet) the member/. Adding 11 moments breaks all three. Plan §2 now mandates updating this test in the companion-enrichment-moments PR: extend `rich` with eligibleEnrichmentCardTypes, move to the 17-key set (or split the F pin), relax the intent-prefix regex. Added as task 8a and to the moments lane."
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified: pickMoment drops any candidate whose topic is a toggle the member turned off (moments.ts:291; topics default community=true, business=false). Owner-facing decision made: setup/profile cards (E1/E2/E4/E5/E8/E9/E10/E11) = topic null (fire regardless); social-action cards (E3 post, E6/E7 social connect) = topic 'community'. Added a topic column to the §2 table + a test that a community-off member gets none of E3/E6/E7."
  },
  {
    "finding_id": "R1-F3",
    "disposition": "accepted",
    "rationale": "Verified: eligibleEnrichmentCards filters completions.get(t) === false (card-catalog.ts:210); undefined !== false, so a member with no profiles row would get zero enrichment cards. computeCompletions avoids this via facts.profile ?? {} and signals.ts seeds journey:null per member. Plan §3 item 1, the signals lane, and task 1 now mandate initializing every member's completion map to false for all 11 types before applying rows, with a no-profile-row test fixture asserting E1/E2/E4/E5/E11 = false (eligible)."
  },
  {
    "finding_id": "R1-F4",
    "disposition": "accepted",
    "rationale": "Verified: diaryNudge priority is 40 + min(10, days-3) = 40-50 (moments.ts:182), not 50-70. Enrichment at 45-49 could outrank a lapsed diary, contradicting 'health-first'. Chosen option (a): cap enrichment at 39. Band corrected to 21-39 (E1=39 -> E11=21), strictly below diary_nudge (40), vitana_index (50-70), guided_journey_step (65). Priority-pin test asserts absolute values incl. a lapsed-diary case where diary_nudge wins. Plan §2, moments lane, tasks 7/9 updated."
  },
  {
    "finding_id": "R1-F5",
    "disposition": "accepted",
    "rationale": "Verified: companion files carry a VTID in their JSDoc (companion-service.ts:42 'VTID-05099', signals.ts 'VTID-05101'). The new files/OASIS payload/tick field will carry the VTID CI PLAN-SPAR allocates on convergence. Recorded in plan §2 'VTID attribution'; Kiro does not hand-allocate (collaboration.md §7a)."
  }
]
```
