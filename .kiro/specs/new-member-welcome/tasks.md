# Tasks — New-member welcome experience

Author: kiro. Drafted 2026-10-15. VTIDs allocated by Claude Code after sparring + Gate 1.
Executor: kiro (implementer). Each lane = its own VTID + PR. Lanes are independent unless
`depends_on` says otherwise.

Conventions: migrations are files in the lane's PR (no live Supabase writes). All write
paths proven by CI simulation; staging specs read-only. Follow CLAUDE.md rules 41, 43–48,
and the collaboration protocol.

<!-- lane: team-welcome-backend -->
## Lane A — Three team welcome DMs (gateway + migration)  [vitana-platform]
depends_on: []
- [ ] A1. `welcome-team/config.ts`: three sender IDs, stagger offsets, rollout timestamp,
      mode + explicit send switch, `disabled-on-staging` on the shared DB. Unit-tested.
- [ ] A2. Migration: `welcome_team_claims` table + `claim_welcome_message` /
      `finish_welcome_message` SECURITY DEFINER RPCs (service_role only, RLS on, zero
      policies). Idempotent, re-runnable.
- [ ] A3. Welcome-team service: cohort gate (post-rollout), strict exclusion (fail-closed),
      per-sender claim, compose/select text in recipient's preferred language (du-form),
      insert the 1:1 `chat_messages` DM with `metadata.source='welcome_team'`, finish the
      claim. Mariia offset 0 (own claim, not a touch); Jovana/Alex via `claim_onboarding_touch`.
- [ ] A4. Content: per S1 decision — `tt()` catalog keys (3 senders × locales, unverified→ready
      after locale review) OR intent constants for model composition. Alex = human tech-support
      intro, no AI claim, no immediate-reply promise.
- [ ] A5. Transport: tick endpoint (extend coach-tick or sibling, per S2) behind
      `requireScheduledNotificationsAuth` + own `X-Gateway-Internal` 401/503; production only.
- [ ] A6. CI simulation scenarios (requirements 1.1–1.9): send-once across retries/re-signin,
      stagger never-same-day, existing-member none, excluded none + fail-closed, reply inbound.
- [ ] A7. `docs/validation/<VTID>/staging-tests.json`: read-only status GET only.

<!-- lane: new-member-card-optin -->
## Lane B — New-member card opt-in + feed source  [vitana-v1 + migration]
depends_on: []
(Amended after sparring, owner D2 = b: no backing post, no `post_kind`, no trigger work.)
- [ ] B1. Migration: `community_intro_opt_in` column on `global_community_profiles` (plain table) + default per owner decision
      D1 (plan default: true for members registering after rollout, false for everyone else); verify existing RLS and the
      `REPLICA IDENTITY FULL` realtime publication are unaffected.
- [ ] B2. `useAllNewsFeed.ts`: source new-member cards only for opted-in newcomers.
- [ ] B3. Off-switch for the newcomer in Settings and in the registration wizard (i18n, `t()`).
- [ ] B4. CI/unit coverage: opted-out → no card; opted-in → card; default applies only to post-rollout joiners.

<!-- lane: say-hello-composer -->
## Lane C — "Say Hello 👋" composer + suggestion endpoint + greeting guard  [vitana-platform + vitana-v1]
depends_on: [new-member-card-optin, grouped-welcome-notifications]
- [ ] C1. Gateway route `POST /api/v1/community/new-member/:userId/greeting-suggestion` (Bedrock via composer pattern,
      sender-locale system prompt, `avoid` list, validation, length cap, no-invented-interest guard). Returns `{ suggestion, language }`.
- [ ] C2. Greeting guard in `routes/chat.ts` `POST /send` for `metadata.source='new_member_greeting'`, modelled on
      `services/calendar-invite-guard.ts`, fail-closed, one generic refusal: receiver blocked/muted sender
      (`user_blocked_authors`/`user_muted_authors`), receiver not opted in or outside the 7-day window, test/service exclusion
      (`fetchExcludedTestServiceAccountIdsStrict`), one greeting per sender→receiver (bounded query), hourly cap. Untagged DMs
      unchanged.
- [ ] C3. `NewMemberGreetingComposer.tsx` + wire into `NewMemberCard.tsx`: inline editable composer, Send + "Try another",
      "in {language}" affordance; CSP-safe; `t()` labels. Send = ONE DM via `POST /api/v1/chat/send` with
      `metadata.source='new_member_greeting'`; disabled in flight; collapse on success; pressing "Say Hello" alone sends nothing.
- [ ] C4. CI simulation + RTL: guard scenarios (each refusal reason, lookup error → refuse, untagged DM unchanged), Try-another
      varies, no auto-send, double-submit prevented, suggestion language correct.
- [ ] C5. Targeted visual verification (desktop 1400×900 + mobile 390×844, LTR and `ar` RTL) of the card + composer open state.

<!-- lane: grouped-welcome-notifications -->
## Lane D — Grouped greeting-DM notifications  [vitana-platform]
depends_on: []
- [ ] D1. In the `routes/chat.ts` notification dispatch (`chat.ts:249-257`), for `metadata.source='new_member_greeting'` apply a
      recipient-keyed 24 h rule next to `chat-push-coalescer.ts`: first greeting pushes, later ones write the in-app row but do
      not push; summary "{n} people said hello 👋" localised via the recipient's locale. Off switch env var, fails open like the
      existing coalescer. Ordinary DMs untouched.
- [ ] D2. CI simulation: N greeting DMs from N senders in 24 h → N in-app rows, one push, correct language; ordinary DM
      coalescing unchanged.

## Acceptance (all lanes)
Maps 1:1 to requirements.md EARS clauses. A lane is `verified` only when its CI simulation is
green on the exact deployed commit and its read-only staging spec passes (rules 46–48). Live
pilot (closed, both-sides where applicable) and production publish are Claude Code's via the
two owner gates — never the executor's.
