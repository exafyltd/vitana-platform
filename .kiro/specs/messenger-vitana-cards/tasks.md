# Messenger Vitana Cards — Tasks

<!-- lane: companion-enrichment-moments -->
## Lane: companion-enrichment-moments

- [ ] 1. Add a batched enrichment-completion read to the companion signal
      builder and expose the incomplete-card set on `MemberContext`.
      - Reuse the enrichment completion resolver / `eligibleEnrichmentCards()`.
      - One batched read per member page; no new table.
- [ ] 2. Add `COMPANION_MOMENTS` entries for E1–E11, each gated on the member
      being incomplete for that card, with English intent (never a hardcoded
      spoken sentence) and priority from the enrichment engagement order.
      - Reuse `enrichment-card-tips.ts` copy; add no new strings.
- [ ] 3. Add moments for F1 (guided-journey step, reuse existing), F7 (invite,
      gated on `user_active_days` engagement), F8 (feature tip, existing
      picker).
- [ ] 4. Unit tests: incomplete member → card eligible; completed member →
      never; priority order; follows `vtid-05100-companion-delivery.test.ts`.

**Acceptance:** a member missing an enrichment action is offered exactly that
card (highest-priority incomplete one) on the Messenger surface; a member who
has completed it is never offered it; all existing companion tests stay green;
no new un-localized strings.

<!-- lane: companion-weekly-reminders -->
## Lane: companion-weekly-reminders

- [ ] 5. Add a distinct Messenger-scoped "Improve your Vitana Index" moment with
      `repeatAfterDays: 7` (do not retune the shared `vitana_index` moment).
- [ ] 6. Add a "Make a diary entry" weekly moment (`repeatAfterDays: 7`), gated
      on diary recency (existing `diary_entries` signal).
- [ ] 7. Unit tests: a weekly moment is not re-picked within 7 days and is
      eligible after, driven by `companion_messages_ledger`.

**Acceptance:** both reminders reappear on a 7-day cadence via the existing
ledger, with no new cadence mechanism or table, and do not change the cadence
of the same cards on other surfaces.

<!-- lane: messenger-surface-wiring -->
## Lane: messenger-surface-wiring

- [ ] 8. Confirm/complete the companion tick evaluating these moments for the
      Messenger surface and the consistent use of the `messenger_companion`
      pacer surface key.
- [ ] 9. Document the run-mode (shadow default) and add a read-only staging test
      under `docs/validation/<VTID>/` that signs in as the test user and
      asserts the Vitana thread renders a card payload (no production writes;
      shadow/staff mode only).
- [ ] 10. Confirm one-per-day pacing and pause behaviour on `messenger_companion`
      with a unit test.

**Acceptance:** the Messenger surface delivers at most one personalized card per
member per day, respects pauses, and is verifiable without any write to
production; this plan does not enable member-facing live sends.
