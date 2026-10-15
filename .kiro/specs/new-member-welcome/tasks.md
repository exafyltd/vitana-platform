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
## Lane B — New-member card opt-in + backing welcome post + feed source  [vitana-v1 + migration]
depends_on: []
- [ ] B1. Migration: `community_intro_opt_in` column (table per S3) + default per owner;
      `profile_posts.post_kind` incl. `'welcome'` with service_role-only set trigger and
      `trg_notify_community_post` skip (reuse VOA's planned `post_kind` work; coordinate so it
      is defined once).
- [ ] B2. Service-role creation of one `post_kind='welcome'` backing post per opted-in
      newcomer (so the card has a comment target); no tenant push.
- [ ] B3. `useAllNewsFeed.ts`: source welcome cards only for opted-in newcomers; map to the
      backing post id.
- [ ] B4. Extend `fetchGreetedMemberIds` to also count a comment the viewer authored on the
      newcomer's welcome post.
- [ ] B5. CI/unit coverage: opted-out → no card/post; opt-in → card maps to post; greeted hides.

<!-- lane: say-hello-composer -->
## Lane C — "Say Hello 👋" composer + suggestion endpoint  [vitana-platform + vitana-v1]
depends_on: [new-member-card-optin]
- [ ] C1. Gateway route `POST /api/v1/community/new-member/:userId/greeting-suggestion`
      (Bedrock via composer pattern, sender-locale system prompt, `avoid` list, validation,
      length cap, no-invented-interest guard). Returns `{ suggestion, language }`.
- [ ] C2. `NewMemberGreetingComposer.tsx` + wire into `NewMemberCard.tsx`: inline editable
      composer, Send + "Try another"; CSP-safe (Tailwind + ui/*, no inline/CDN); `t()` labels;
      "in {language}" affordance.
- [ ] C3. Send posts exactly one comment via `useFeedPostInteractions('post', welcomePostId)
      .addComment`; disable while in flight (no duplicate); collapse + mark greeted on success;
      never auto-send.
- [ ] C4. CI simulation + RTL: Try-another varies & no session repeat; no auto-post; double-submit
      prevented; suggestion language correct.
- [ ] C5. Targeted visual verification (desktop 1400×900 + mobile 390×844) of the card +
      composer open state — screenshots in the PR (CLAUDE.md rule 26–28).

<!-- lane: grouped-welcome-notifications -->
## Lane D — Grouped welcome-comment notifications  [vitana-v1 migration]
depends_on: [new-member-card-optin]
- [ ] D1. Migration: welcome-comment notification groups per newcomer per window (reuse the
      vtid_04916 / cumulative-like precedent), localized via `_notif_user_locale`, window per S4.
- [ ] D2. CI simulation: N greetings in the window → one grouped notification row, correct
      language, no per-greeter push storm.

## Acceptance (all lanes)
Maps 1:1 to requirements.md EARS clauses. A lane is `verified` only when its CI simulation is
green on the exact deployed commit and its read-only staging spec passes (rules 46–48). Live
pilot (closed, both-sides where applicable) and production publish are Claude Code's via the
two owner gates — never the executor's.
