# Messenger Vitana Cards ΓÇö Tasks

<!-- lane: companion-enrichment-signals -->
## Lane: companion-enrichment-signals

- [ ] 1. Build bulk enrichment-completion reads in `companion-repository.ts`
      mirroring `fetchJourneyStates` / `fetchActiveDaysSince` (one IN-clause per
      source table across all member ids in the page): profiles enrichment
      fields, any-post, active social connections, enabled calendar app, any
      contact, active device token. Initialize every member's completion map to
      `false` for all 11 types BEFORE applying rows (R1-F3) ΓÇö a member with no
      profiles row must be `false`/eligible, not `undefined`.
- [ ] 2. Bulk-read the `user_enrichment_cards` dismissal rows for the same ids.
- [ ] 3. Add a `FetchEnrichmentCompletions` seam to the companion tick deps so
      tests can stub it without a DB. The seam MUST use `Promise.allSettled` /
      `unavailable[]` like `fetchMemberSignals` and MUST NEVER throw (it joins
      the `Promise.all` at `companion-service.ts:131`).
- [ ] 4. In the tick loop (real `now` in scope, before building `ctx`) call
      `eligibleEnrichmentCards(completions, dismissRows, 'messenger', now,
      unavailableEnrichmentCards())` and expose the result on `MemberContext` as
      `eligibleEnrichmentCardTypes: ReadonlySet<EnrichmentCardType>` (R3-F1).
      Moments never construct a `Date` from `localDate`.
- [ ] 5. Unit tests: bulk reads equal the per-member resolver on the same
      fixtures (semantics match, incl. social `is_active && disconnected_at IS
      NULL` and the calendar-app allowlist); AND when the profiles bulk query
      rejects, the seam returns an empty map + `unavailable:
      ['enrichment_profiles']` and does not throw.

**Acceptance:** `MemberContext` carries correct completion + dismissal state for
every member in a multi-member page, with no per-member query storm, proven by
tests that compare bulk vs the existing per-member resolver.

<!-- lane: companion-enrichment-moments -->
## Lane: companion-enrichment-moments

- [ ] 6. Add 11 `COMPANION_MOMENTS` entries (E1ΓÇôE11), each gated only by
      `ctx.eligibleEnrichmentCardTypes.has('Ex')` (the pre-computed set from
      task 4). Moments do NOT call `eligibleEnrichmentCards` or build a `Date`.
- [ ] 7. Assign each moment an explicit companion-scale priority in **21ΓÇô39**
      (below `diary_nudge` min 40, above `feature_tip` 20), E1=39 ΓåÆ E11=21. Do
      NOT reuse `EligibleEnrichmentCard.priority` (1-based ΓÇö opposite scale).
      Set each moment's `topic` per the plan table (`null` for
      E1/E2/E4/E5/E8/E9/E10/E11, `'community'` for E3/E6/E7). Each `intent` is an
      English composer instruction (featureTip pattern); pass
      `ENRICHMENT_CARD_TIPS[Ex].title.en`/`.description.en` as `facts`
      (`card_title`/`card_description`), never as the `intent` string (R3-F2).
      Set `repeatAfterDays` per the ┬º2 table ΓÇö 4 for E1/E2/E4/E5/E11, 7 for
      E3/E6/E7/E8/E9/E10 (R2-F2), and the exact priorities 29ΓÇô39 from the table.
- [ ] 8. Do NOT add/alter F1/F2/F3/F7/F8 or the Index/diary moments.
- [ ] 8a. Update `test/vtid-05101-companion-generators.test.ts` in the same PR
      (R1-F1): extend the `rich` fixture with `eligibleEnrichmentCardTypes` (all
      11), move the key-set assertion to 17 keys (or split the F-moment pin),
      relax/split the intent-prefix regex so enrichment intents pass.
- [ ] 9. Unit tests: incomplete+non-dismissed+available member ΓåÆ that card
      eligible; completed member ΓåÆ never; dismissed-elsewhere member ΓåÆ
      suppressed 7 days; **with Meta OAuth env unset, no E6/E7 moment regardless
      of completion**; **community-off member gets none of E3/E6/E7**; **a
      freshly-lapsed-diary member gets diary_nudge, not an enrichment card**; a
      no-profile-row member is eligible for E1/E2/E4/E5/E11 (false-init,
      R1-F3); **an ignored (not completed, not dismissed) E1 yesterday is not
      re-offered today (repeatAfterDays, R2-F2)**; enrichment never outranks
      Index/journey/diary; priority-pin test asserts absolute values (29ΓÇô39); a
      test pins `COMPANION_MOMENTS` unchanged
      except the new E-moments.

**Acceptance:** a member missing a setup step is offered exactly that enrichment
card (highest-priority eligible), a completed or recently-dismissed member is
not, and no shipped moment's behaviour or ranking changes.

<!-- lane: messenger-companion-verification -->
## Lane: messenger-companion-verification

- [ ] 10. Document the run-mode (shadow/`disabled-on-staging` default; live
      sends are a separate owner step, not enabled here).
- [ ] 11. Staging test under `docs/validation/<VTID>/`: GET
      `/api/v1/companion/status` asserts `mode: disabled-on-staging` (read-only,
      matching VTID-05100/05101). No attempt to assert a delivered card.
- [ ] 12. Offline integration test: end-to-end moment selection for an
      incomplete member yields the enrichment card DM payload shape
      (`metadata.card.kind='vitana_card'`, right `card_type`); a complete member
      yields none.

**Acceptance:** the Messenger enrichment behaviour is verifiable entirely
offline / read-only, with no write to production and without enabling live
member DMs.
