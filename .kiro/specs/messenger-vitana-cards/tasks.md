# Messenger Vitana Cards — Tasks

<!-- lane: companion-enrichment-signals -->
## Lane: companion-enrichment-signals

- [ ] 1. Build bulk enrichment-completion reads in `companion-repository.ts`
      mirroring `fetchJourneyStates` / `fetchActiveDaysSince` (one IN-clause per
      source table across all member ids in the page): profiles enrichment
      fields, any-post, active social connections, enabled calendar app, any
      contact, active device token.
- [ ] 2. Bulk-read the `user_enrichment_cards` dismissal rows for the same ids.
- [ ] 3. Add a `FetchEnrichmentCompletions` seam to the companion tick deps so
      tests can stub it without a DB.
- [ ] 4. Expose the per-member completion map + dismissal rows on
      `MemberContext` in the shape `eligibleEnrichmentCards()` consumes.
- [ ] 5. Unit tests: bulk reads equal the per-member resolver on the same
      fixtures (semantics match, incl. social `is_active && disconnected_at IS
      NULL` and the calendar-app allowlist).

**Acceptance:** `MemberContext` carries correct completion + dismissal state for
every member in a multi-member page, with no per-member query storm, proven by
tests that compare bulk vs the existing per-member resolver.

<!-- lane: companion-enrichment-moments -->
## Lane: companion-enrichment-moments

- [ ] 6. Add 11 `COMPANION_MOMENTS` entries (E1–E11), each eligible only when
      the member is incomplete AND not in a dismissal cooldown for that card,
      gated through `eligibleEnrichmentCards(completions, dismissRows, screen,
      now)`.
- [ ] 7. Set each moment's priority below `vitana_index` (50–70) and
      `guided_journey_step` (65), at/above `feature_tip` (20) / `invite_friend`
      (15); English `intent` per card (never a hardcoded spoken sentence);
      reuse `enrichment-card-tips.ts` copy (no new strings).
- [ ] 8. Do NOT add/alter F1/F2/F3/F7/F8 or the Index/diary moments.
- [ ] 9. Unit tests: incomplete+non-dismissed member → that card eligible;
      completed member → never; dismissed-elsewhere member → suppressed for 7
      days; enrichment never outranks Index/journey; a test pins that
      `COMPANION_MOMENTS` is unchanged except the new E-moments.

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
