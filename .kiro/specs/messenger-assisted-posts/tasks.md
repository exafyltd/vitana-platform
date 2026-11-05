# Messenger assisted posts — tasks

<!-- lane: assisted-posts-data -->
## Lane: assisted-posts-data (Database, Backend)

- [ ] 1. Write one migration `supabase/migrations/<timestamp>_assisted_post_foundation.sql` creating
      `assisted_post_drafts`, `assisted_post_invitations` and `assisted_post_preferences` (design §2), with RLS, CHECK
      constraints, the partial unique indexes and the `(user_id, window_key)` unique key. Idempotent DDL
      (`IF NOT EXISTS`, `ON CONFLICT DO NOTHING`).
- [ ] 2. Update `DATABASE_SCHEMA.md` in the same PR (ALWAYS 24) and add a rollback note to the migration header.
- [ ] 3. Repository module `services/gateway/src/services/assisted-posts/repository.ts` with typed queries, every query
      tenant-scoped.
- [ ] 4. Pure eligibility module `eligibility.ts`: cooldowns, 48-hour onboarding delay, pause, opt-out, timezone window,
      conservative UTC fallback. No I/O.
- [ ] 5. Unit tests for eligibility, covering every rule in requirements §Invitation requirements.
- [ ] 6. Local Postgres integration test (existing local test infrastructure): RLS owner-only reads, unique active draft,
      concurrent invitation insert produces exactly one row, `published` CHECK.

**Acceptance:**
- Change types: Database, Backend
- Outcome: no member-visible change in this lane; the data needed for drafts and invitations exists and is protected.
- States: n/a: schema lane
- Surfaces: backend callers only (assisted-posts service)
- Locales: n/a: no visible strings
- Accessibility: n/a: no UI
- Contract: n/a: no route in this lane
- Staging proof: not verified on staging: migration not applied (owner approval required, collaboration §7d). Covered by
  the local Postgres integration test in task 6.

<!-- lane: assisted-posts-service -->
## Lane: assisted-posts-service (Backend)

- [ ] 7. Routes under `/api/v1/assisted-posts/*`: `GET status` (flag), `POST drafts`, `GET drafts/:id`,
      `PATCH drafts/:id` (version-checked), `POST drafts/:id/media`, `POST drafts/:id/wording`,
      `POST drafts/:id/discard`, `POST drafts/:id/publish`, `PATCH preferences`, `POST invitations/:id/respond`.
- [ ] 8. Publish service implementing design §3 exactly: row lock, `already_published` short-circuit, version check,
      media ownership check, reuse of the existing post validation and moderation, insert into `profile_posts` with
      the pre-allocated id and `ON CONFLICT DO NOTHING`, draft update in the same transaction.
- [ ] 9. Wording service: Bedrock stage through the LLM router, locale injected with the repo helper, AI-29 logging,
      prompt delimiters for user and media text. Failure returns a retryable error and leaves the caption unchanged.
- [ ] 10. Feature flag: `isFeatureLive('ASSISTED_POSTS')` on every route except `GET status`, which reports
      `enabled: false` when off.
- [ ] 11. Unit tests with a mocked Supabase client: publish success, duplicate publish returns the same post id,
      concurrent publish attempts, stale version returns 409, foreign draft returns 404, media outside the caller
      folder is rejected, moderation rejection keeps the draft, flag off returns the disabled response.

**Acceptance:**
- Change types: Backend
- Outcome: a member publishes exactly one post after confirming; a retry or double tap shows the same post.
- States: publish in flight, duplicate request, network failure after commit, moderation rejection, flag off
- Surfaces: the assisted-posts endpoints, called only by the Messenger card lane
- Locales: wording output follows the member's language; error codes are keys, never raw sentences
- Accessibility: n/a: no UI
- Contract: each route has auth required, JSON responses, error shape `{ ok: false, error: '<CODE>' }`, and 409 for
  version conflicts. `file:line` on both sides is recorded in the PR body.
- Staging proof: not verified on staging: publish writes community content and the shared database forbids test
  writes. Covered by the mocked publish tests in task 11 and the local integration test in lane 1.

<!-- lane: assisted-posts-invitations -->
## Lane: assisted-posts-invitations (Backend, Integration)

- [ ] 12. Add the `assisted_post_invite` scanner to the existing community-autopilot scanner list. It reads eligibility
      from lane 1's pure module and writes the invitation through the idempotent insert.
- [ ] 13. Invitation delivery: insert a `vitana_card` bot message into `chat_messages` only when the invitation insert
      succeeded. Copy keys follow the approved text ("Choose a photo / video").
- [ ] 14. Pause rule: two consecutive `expired` invitations set `paused_until` to 30 days; any engagement resets the
      counter. Dismissal of "Maybe later" applies the normal cooldown.
- [ ] 15. Expiry sweep: move delivered invitations past `expires_at` to `expired`, idempotently.
- [ ] 16. Tests: two concurrent scanner runs produce one invitation; cooldown and onboarding delay; pause after two
      unanswered; opt-out stops new invitations but keeps drafts; unknown timezone uses the fallback window.

**Acceptance:**
- Change types: Backend, Integration
- Outcome: an eligible member sees one invitation in Messenger; no duplicate cards appear, even when jobs overlap.
- States: no eligible member, duplicate scanner run, invitation already open, expired, paused, opted out
- Surfaces: the Vitana conversation (via the existing message stream)
- Locales: copy keys in de and en
- Accessibility: n/a: rendered by lane 4
- Contract: scanner output matches the existing scanner contract; the card payload matches `VitanaChatCard`
- Staging proof: not verified on staging: delivery writes a chat message to real members. Covered by the concurrency and
  eligibility tests in task 16.

<!-- lane: assisted-posts-card-ui -->
## Lane: assisted-posts-card-ui (Frontend, Integration, UI)

- [ ] 17. Card registry entry `assisted_post_invite` with the four actions and the card menu, using design tokens and
      `VCard`. Compact layout, no oversized banner.
- [ ] 18. Composer flow: "Choose a photo / video" opens the file picker from the click handler; one photo or one video;
      thumbnail, progress, remove, retry; optional caption; "Write a post" starts a text draft; "Give me an idea"
      offers the six ideas as a single prompt.
- [ ] 19. Preview component: avatar and name, thumbnail or user-controlled video player, text, "Public" label,
      "Draft — not published" label, Publish, Edit text, Help with wording, Add or remove media, Discard.
- [ ] 20. Success state: "Your post is live 🎉" with View post and Create another post; Publish disabled after success.
- [ ] 21. Continue your draft prompt when a draft exists. Never create a second invitation while one is open.
- [ ] 22. i18n: keys in `src/i18n/de/` first, mirrored to `en/`. ESLint i18n rules at error level must pass.
- [ ] 23. Analytics calls through the existing batch endpoint without text or URLs.
- [ ] 24. Vitest component tests for every state in the Outcome list, plus RTL and keyboard tests.

**Acceptance:**
- Change types: UI, Integration
- Outcome: a member can choose a photo or video, get a caption suggestion or write one, review the preview, and
  publish after confirming; the success card shows the post.
- States: empty, uploading, processing, failed upload (text kept), wording failure, publishing, published, offline,
  slow response, long text, flag off
- Surfaces: the Vitana conversation on phone and desktop (`useIsMobile`, the mobile composer sheet)
- Locales: de first (du-form) and en; ar RTL checked for the preview layout
- Accessibility: accessible names on every icon button, keyboard reach and order, visible focus, announced states,
  44px touch targets, user-controlled video playback
- Contract: calls to `/api/v1/assisted-posts/*` with the auth header; error codes mapped to i18n keys
- Staging proof: read-only Playwright check that the feature status endpoint answers and the card renders with the flag
  on for a test session. No post is created. Publication itself is not verified on staging.

<!-- lane: assisted-posts-verification -->
## Lane: assisted-posts-verification (Tooling/docs, Integration)

- [ ] 25. Read-only staging spec under `docs/validation/<VTID>/staging-tests.json` that asserts the status endpoint and
      the card presence with the flag on, with a network guard that aborts every non-GET request except sign-in.
- [ ] 26. Write the release runbook `docs/validation/<VTID>/release-checklist.md`: isolated end-to-end publication test
      steps, migration approval list, flag enablement steps, rollback (flag off).
- [ ] 27. Acceptance matrix in `docs/validation/<VTID>/acceptance.md` mapping every AC to a test or a check, marking
      each one mocked, local-database, read-only staging, or not verified.

**Acceptance:**
- Change types: Tooling/docs, Integration
- Outcome: the release owner can see exactly what was proven and what still needs an isolated environment.
- States: n/a: documentation and test suite
- Surfaces: n/a
- Locales: n/a
- Accessibility: n/a
- Contract: staging spec makes GET requests only; `staging-tests.json` `ref` is `npx vitest run <paths>` or
  `npm run <script>`
- Staging proof: the staging spec itself runs in STAGING-VERIFY. It proves the read-only checks only.
