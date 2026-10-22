# Messenger Vitana Cards — Plan

Deeply-personalized, one-per-day Vitana recommendation cards in the direct
Vitana chat inside the Messenger, delivered by the existing Vitana Companion
Messages engine.

<!-- plan:begin -->

## 1. Summary

Vitana is the member's everyday life companion. The direct Vitana chat
(`/inbox/u/00000000-0000-0000-0000-000000000001`) should carry the same
Unified Card System recommendations the member already sees in the News Feed
and on other screens — but **deeply personalized**: a card is shown only when
it is relevant to *this* member. If the member has not connected their
calendar, Vitana suggests connecting it; once connected, that card never shows
again. If the member never writes a diary entry, Vitana nudges them weekly.

This is **mostly reuse**. The hard part — a per-member engine that picks one
card per day for the Vitana DM thread, respects completion/usage signals,
paces itself, and composes a warm note — already exists and is deployed as the
**Vitana Companion Messages engine** (VTID-05099/05100/05101,
`services/gateway/src/services/companion/`). This plan extends that engine's
moment list and wires the enrichment completion signals into it; it does not
build a new delivery system, a new card renderer, or a new pacer.

**Decisions taken (owner, this conversation):**
- **One card per day** in the Vitana chat (the companion engine's existing
  one-moment-per-member-per-local-day model). Not a multi-card strip.
- **Lab tests are OUT of scope** — a separate follow-up plan
  (`messenger-vitana-cards-labs`), because no lab-upload table or card type
  exists and it carries health-data/consent work.
- **Usage-gated feature cards (F4 voice, F5 matches, F10 media) are held for
  Phase 2**, not shown ungated in Phase 1. Rationale: the owner's intent is
  "promote only if unused"; showing them ungated would violate that. They ship
  when their usage signal exists.

## 2. Scope

### In scope (Phase 1 — ship now, signals already exist)
Wire these cards into the companion moment list for the Messenger surface,
each gated on its existing completion signal so it shows only when relevant:

| Card | Gate (show only if…) | Signal (exists today) |
|---|---|---|
| E1 Upload profile photo | no avatar | `profiles.avatar_url` |
| E2 Add bio | bio ≤ 50 chars | `profiles.bio` |
| E3 Make first post | no post | `profile_posts` |
| E4 Add interests | none | `profiles.interests` |
| E5 Set location | none | `profiles.location` |
| E6 Connect Instagram | not connected | `social_connections` |
| E7 Connect Facebook | not connected | `social_connections` |
| E8 Connect calendar | no calendar connected | `connected_app_settings` |
| E9 Import contacts | none | `contacts` |
| E10 Enable notifications | no active token | `user_device_tokens` |
| E11 Add cover image | none | `profiles.cover_url` / `universal_intent_cover_url` |
| F7 Invite a friend | engaged member | `user_active_days` |
| F8 Did You Know (feature tip) | tip not yet shown | `feature-tips` + `companion_messages_ledger` |
| F1 Guided Journey step | in guided journey | `user_guided_journey_state` |

Plus two **recurring weekly** moments (reappear regardless of completion, via
`repeatAfterDays: 7`, reusing the companion ledger — no new mechanism):

| Card | Cadence | Signal |
|---|---|---|
| Improve your Vitana Index | weekly | index snapshot |
| Make a daily diary entry | weekly (nudge if lapsed) | `diary_entries` recency |

### Phase 2 (same plan, after a usage signal is built/activated)
- **F4 Talk to Vitana** — show only if the member has never used voice.
  Requires `voice_session_facts` (migration `20261001120000_vtid_04776`) to be
  **applied + backfilled** first. Until then, F4 is not added to the Messenger
  moment list.
- **F5 Find a Match** — show only if the member does not use Matches. Requires
  a durable "ever engaged with Matches" signal (today only "unseen today"
  exists in `daily_matches`). Build the signal, then wire the card.
- **F10 Upload Video/Music** — show only if the member has not uploaded media.
  Requires a "has uploaded media" signal. Build, then wire.

### Out of scope
- **Lab tests** — follow-up plan `messenger-vitana-cards-labs`.
- **A pinned `EnrichmentCardStrip` header in the chat** — rejected in favour of
  the one-per-day companion DM (owner decision). The frontend `messenger`
  catalog stub stays inert.
- **Boost cards G1/G2/G3 in the messenger** — not added; the companion engine's
  single personalized pick already covers the profile-completion / streak
  intents through its own moments. Revisit only if the owner asks.

## 3. Architecture (reuse map)

The companion engine already does everything the delivery needs:
- **Selection:** `services/gateway/src/services/companion/moments.ts`
  (`COMPANION_MOMENTS`, `pickMoment`) — picks one moment per member per local
  day; each moment has `cardType`, an English `intent` (§13b spoken-intent
  rule — never a hardcoded sentence), `priority`, and `repeatAfterDays`.
- **Personalization context:** `signals.ts` builds `MemberContext` (usage
  signals, batched per page of members). `tipAlreadyCovered()` in `moments.ts`
  already demonstrates "don't promote what they use" (suppresses the
  vitana-index tip when an index exists, the diary tip when a diary entry
  exists).
- **Completion signals (E1–E11):** the enrichment completion resolver
  (`services/gateway/src/services/enrichment/completion-resolver.ts`,
  `card-catalog.ts` `eligibleEnrichmentCards()`) already computes which
  enrichment cards are incomplete for a member, from source tables only. This
  plan injects that result into `MemberContext` so the enrichment moments gate
  on it.
- **Delivery:** `delivery.ts` inserts the card as a Vitana DM with
  `metadata.card = { kind:'vitana_card', card_type, params }` into the
  `/inbox/u/<vitana-bot>` thread; `MessageBubble.tsx` (vitana-v1) renders it
  inline (VTID-05100, live).
- **Pacing:** `guide/presence-pacer.ts` `canSurfaceProactively(id,
  'messenger_companion')` enforces one touch per surface per day, pauses, and
  caps; `backoff.ts` adds unreplied back-off. `delivery.ts` already records the
  touch. No new pacer.
- **Copy:** `data/enrichment-card-tips.ts` (E/G cards, all gateway locales) and
  `data/feature-tips.ts` (feature/tip cards). New moments reuse existing copy;
  any genuinely new string is added with full locale coverage (the
  locale-coverage test enforces it).

**Net new backend code is small:** new `COMPANION_MOMENTS` entries for the
enrichment cards + the two weekly reminders, and a `MemberContext` field
carrying the enrichment-completion map (one extra read, batched with the
existing signal reads). No schema change in Phase 1.

## 4. Lanes

- **Lane `companion-enrichment-moments`** (gateway):
  inject the enrichment completion map into `MemberContext`
  (`signals.ts`/`companion-repository.ts`), add `COMPANION_MOMENTS` entries for
  E1–E11 gated on incompleteness and for F1/F7/F8, each with English intent and
  priority. No new copy where a tip/enrichment entry already exists.
  Paths: `services/gateway/src/services/companion/**`,
  `services/gateway/test/**`.
- **Lane `companion-weekly-reminders`** (gateway):
  add the two recurring moments — "Improve your Vitana Index" and "Make a diary
  entry" — with `repeatAfterDays: 7`, gated/paced via the existing ledger;
  confirm the Index moment's existing `repeatAfterDays` is reconciled (it uses
  3 today) or add a distinct weekly Messenger moment so other surfaces are
  unaffected. Paths: `services/gateway/src/services/companion/**`,
  `services/gateway/test/**`.
- **Lane `messenger-surface-wiring`** (gateway + verification):
  confirm the companion engine targets the Messenger surface for these moments
  and that `screen='messenger'`/`messenger_companion` plumbing is consistent;
  add the staging test and run-mode note (the engine defaults to shadow mode —
  Phase 1 must state how it is enabled for verification without writing to
  production). Paths: `services/gateway/src/services/companion/**`,
  `services/gateway/test/**`, `docs/validation/**`.

Lanes are independent except that `companion-weekly-reminders` and
`companion-enrichment-moments` both edit `moments.ts` — declared as a shared
file; they are sequenced, not parallel, per §8a hot-file rule.

## 5. Testing

- Unit: each new moment is selectable only when its gate says the member is
  incomplete / has not used the feature; completed members never get it
  (follow `vtid-05100-companion-delivery.test.ts` and the completion-resolver
  tests).
- Weekly cadence: a moment with `repeatAfterDays: 7` is not re-picked within 7
  days and is eligible after, driven by the `companion_messages_ledger`.
- Pacer: one touch per member per day on `messenger_companion`; a paused member
  gets nothing.
- Delivery shape: the DM carries `metadata.card.kind='vitana_card'` with the
  right `card_type`; `MessageBubble` renders it (existing vitana-v1 test).
- Locale coverage: any new copy passes the enrichment/feature tip
  locale-coverage test.
- Staging: a read-only staging test under `docs/validation/<VTID>/` that signs
  in as the test user and asserts the Vitana thread can render a card payload
  (no writes to production; shadow/staff mode only).

## 6. Risks and open questions

1. **Companion run mode.** The engine defaults to shadow (decides, logs, sends
   nothing) unless `COMPANION_SEND_ENABLED` + mode is flipped. Phase 1 must
   verify selection logic in staff/shadow mode and must NOT enable live sends
   as part of this plan without an explicit owner step — enabling member-facing
   DMs is a product go-live, separate from wiring the moments.
2. **"Same cards as the feed" vs one-per-day.** Reconciled by owner decision:
   one per day. The feed still shows several; the chat shows one personalized
   pick. Not a code gap.
3. **Index moment `repeatAfterDays` today is 3.** Changing it to 7 affects
   other surfaces. Mitigation: add a distinct Messenger weekly moment rather
   than retune the shared one, unless sparring prefers reconciliation.
4. **`user_active_days` is undocumented** (referenced in code, absent from
   `DATABASE_SCHEMA.md`). Confirm it is populated before relying on the F7
   invite gate; if not, drop F7 from Phase 1.
5. **Phase 2 depends on `voice_session_facts` being applied** — that migration
   is committed but not applied and needs owner approval (naming the file and
   database) per the collaboration migration rule. Phase 2 lanes are not
   started until that is done.

<!-- plan:end -->
