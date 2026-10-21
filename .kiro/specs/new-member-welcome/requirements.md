# Requirements — New-member welcome experience (MAXINA community)

Author: kiro (session kiro-202610150924-9ecd), at the owner's direct request 2026-10-15.
Status: drafted — awaiting plan sparring (VTID-04868) and owner Gate 1 before any VTID/code.

This refines the already-approved **Vitana Onboarding Assistant (VOA)** plan
(`docs/plans/VITANA-ONBOARDING-ASSISTANT-PLAN.md`): it is VOA slice 4 (team welcome
DMs + social bridge) generalised to three senders, plus a refinement of the new-member
News Feed card (§4.5.2 / VTID-04574). Nothing existing is deleted; the newcomer's own
auto-"Hello" DM fan-out (VTID-03089) stays.

## Context that already exists (verified against main 2026-10-15)

- `fire_welcome_chat_on_membership()` — live DB trigger, sends the newcomer's own intro
  DM to all members; idempotent via `app_users.welcome_chat_sent`; skips
  `service_bot_accounts` ∪ `notification_test_actors`.
- VOA staggering primitives: `onboarding_touch_ledger` + `claim_onboarding_touch()` RPC
  (one touch per member per LOCAL day, DB-race-proof) and the EventBridge-driven
  `POST /api/v1/scheduled-notifications/onboarding-coach-tick`.
- VOA §4.5.5 already specifies a "Welcome DM from Mariia" sent only by the gateway tick,
  from a configurable `VOA_WELCOME_SENDER_USER_ID`, with its own `claim_mariia_welcome`
  RPC for send-once. This requirement generalises that to **three** named senders.
- `NewMemberCard.tsx` (vitana-v1, VTID-04574) renders a card whose "Say hello" button
  today opens a DM thread; newcomers sourced from `global_community_profiles` (last
  7 days, visible, excludes bot/test); greeted members hidden via `fetchGreetedMemberIds`
  (DMs only, today).
- Comments: direct Supabase inserts to `profile_post_comments` under RLS; comment
  notifications are already per-recipient localised (`_notif_user_locale`). No grouping
  of comment notifications exists yet.
- Short-text generation pattern: `services/gateway/src/services/companion/composer.ts` —
  English intent → Bedrock-only → `buildLocalizedSystemPromptForLang(prompt, locale)` →
  output validation. Satisfies CLAUDE.md rule 41 (never hardcode a spoken/user-facing
  composed sentence).

## Resolved account configuration (read-only lookup 2026-10-15, production VITANA)

| Role | Handle | user_id | vitana_id | display_name | notes |
|---|---|---|---|---|---|
| Mariia Maksina | @mariia04 | 67c971fc-48f3-49ce-aaa8-cddb6fa9e63a | mariia11 | maksinamariia | ⚠ display name not "Mariia Maksina"; re-verify at pre-flight |
| Jovana Tadić | @jovana4 | c7d3260d-8311-4a0b-ab1c-53928a37caec | jovana4 | Jovana Tadić | |
| Alex Blue | @dragan1 | 0adc6ff6-acb0-4dca-99d0-295211a40e3e | dragan1 | Dragan Alexander | **real human** — tech-support contact; NO AI-identity line |

All three: real members, same primary tenant `2e7528b8-472a-4356-88da-0280d4639cce`,
none in `service_bot_accounts`/`notification_test_actors`. IDs live in config and are
re-verified read-only at pilot pre-flight before any live send (VOA rule).

Owner decision 2026-10-15: **Alex Blue is a real human**, so his message is a friendly
human tech-support intro and MUST NOT claim to be an AI. (The task's "if Alex is an AI
account, make that identity clear" does not apply.)

---

## Requirement 1 — Three private team welcome messages

**User story:** As a newly registered community member, I receive three warm private
welcomes so I feel supported, encouraged to participate, and know who to ask for help.

Acceptance (EARS):
1.1 WHEN a member's registration completes THEN the system SHALL send Mariia's welcome DM
    to that member.
1.2 WHEN the configured stagger offset for Jovana elapses after registration THEN the
    system SHALL send Jovana's welcome DM, delivered through the existing onboarding
    touch ledger so it is paced and not simultaneous with Mariia's.
1.3 WHEN the configured stagger offset for Alex elapses THEN the system SHALL send Alex's
    welcome DM through the same paced path.
1.4 The three message **intents** (model-composed, never hardcoded sentences — rule 41):
    - Mariia: warm, "how lovely you've joined; the community is here to support one
      another in improving health and wellbeing."
    - Jovana: friendly community welcome; encourage them to introduce themselves, join
      conversations, and feel comfortable participating.
    - Alex: friendly introduction as their contact for the technical side of MAXINA —
      "message me here if something isn't working or you're unsure how to use a feature,
      I'll be happy to help." Approachable, reassuring. NO promise of immediate reply.
      NO AI-identity claim (Alex is a real human).
1.5 Each welcome SHALL be composed in the **recipient's preferred language**
    (`_notif_user_locale`/`getUserLocale`), du-form, warm, natural, concise.
1.6 Each welcome SHALL be sent **at most once per member per sender**, including across
    job retries and repeat sign-ins (per-sender claim row, unique + one bounded retry).
1.7 Existing members (registered before rollout) SHALL NOT receive these messages
    retroactively.
1.8 Service/test accounts (`service_bot_accounts` ∪ `notification_test_actors`) SHALL
    never receive these messages; exclusion lookup fails closed (skip on error).
1.9 A reply from the newcomer SHALL arrive in the corresponding sender account's normal
    monitored inbox (ordinary inbound `chat_messages` DM — no new routing).
1.10 Account IDs, stagger timing, and message content-guidance SHALL be configurable
     (config module / env), not hardcoded.

## Requirement 2 — "Say Hello 👋" on new-member News Feed cards

**User story:** As an existing member, I can send a newcomer a quick, genuine greeting
from their feed card; as a newcomer, I choose whether I'm introduced, and I'm not
overwhelmed.

Acceptance (EARS):
2.1 WHEN a newcomer has NOT opted in to community introduction THEN the system SHALL NOT
    show a welcome card for them. Opt-in is the newcomer's explicit choice.
2.2 WHEN a newcomer HAS opted in THEN the feed SHALL show a welcome card with a
    "Say Hello 👋" button.
2.3 WHEN a sender taps "Say Hello 👋" THEN the system SHALL open an editable, short
    greeting addressed to the newcomer by name, generated for review (not sent).
2.4 WHEN the sender presses Send THEN the greeting SHALL be delivered as a private direct
    message from that sender to the newcomer (owner decision 2026-10-15, D2 = option b —
    supersedes "public comment"). The system SHALL NEVER send without the sender's explicit Send.
2.5 WHEN the sender presses "Try another" THEN the system SHALL offer a different
    suggestion, varying naturally in wording and sentence structure, avoiding repeats
    within the session.
2.6 Suggestions SHALL NOT invent familiarity or claim shared interests not known to us.
    Tone like: "Hi Anna, lovely to have you here! 👋" / "Welcome to MAXINA, Anna! 😊" /
    "Hey Anna, just stopping by to say hello!"
2.7 The suggested language SHALL be made clear to the sender (e.g. an "in {language}"
    affordance).
2.8 The system SHALL prevent accidental duplicate submissions (disable control while a
    submit is in flight; a greeted card is hidden/collapsed for that sender afterwards).
2.9 Greeting-DM notifications to the newcomer SHALL be grouped (per-newcomer 24 h window:
    first greeting pushes, later ones are in-app only) so many greetings do not overwhelm them.
2.11 The server SHALL refuse a greeting DM when the newcomer blocked/muted the sender, is not
    opted in or is outside the 7-day card window, either party is a test/service account, the
    sender already greeted this newcomer, or the sender is over the hourly cap (fail-closed).
2.10 No community greeting SHALL ever be sent automatically.

## Requirement 3 — Language, config, conventions, verification

3.1 Team welcomes use the recipient's preferred language; community greeting suggestions
    use a language made clear to the sender.
3.2 Follow existing localisation (`tt()` catalog for fixed chrome/notification wrappers;
    model-composition for the greeting/welcome bodies) and message-generation conventions.
3.3 Account IDs, timing, and content guidance are configurable.
3.4 Verification is by CI simulation (in-memory DB) for all write paths; staging specs are
    read-only (rules 46–48). No staging/production writes by any test. Live rollout follows
    VOA's closed pilot and the two owner gates.

## Out of scope
- Changing the VTNA reward rules (done-by-Vitana earns nothing — VOA §4.3 stands).
- The inspiration-post flow (VOA slice 5), ORB rung (slice 3), day 8–90 cadence (slice 6).
- Email (dropped, VOA owner decision).
