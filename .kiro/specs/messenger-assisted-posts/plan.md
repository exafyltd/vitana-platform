# Messenger assisted posts — plan

<!-- plan:begin -->

## 1. Summary

Members who rarely post get a friendly invitation in their Vitana Messenger conversation. Vitana prepares a
single-photo, single-video, or text-only post from the member's input and an optional AI wording suggestion. The
member reviews an editable preview and confirms "Publish to News Feed" before anything is published.

Owner decisions taken (approved, this conversation):
- V1 media: one photo or one video, plus text-only posts. Multi-photo albums and new voice transcription are deferred.
- Audience: Public only, shown in the preview. Friends and Groups are not offered.
- Publication: server-side, database-enforced idempotency, reusing `profile_posts` and its existing validation,
  moderation, media ownership checks and notification trigger.
- Verification: automated tests plus read-only staging checks. No test posts or notifications on the shared
  production-backed staging database. No new Supabase project for this task.
- Migrations: prepared in review, applied only after an owner approval naming the files and the target database.
- Feature flag `FEATURE_ASSISTED_POSTS_ENV` stays off in production. Pilot needs an isolated end-to-end publication test.

## 2. Today (evidence on `origin/main`)

- Vitana bot identity and messages: `vitana-v1/src/lib/vitanaBotIdentity.ts:10-21`; `chat_messages`
  (`vitana-platform/supabase/migrations/20260225200000_chat_messages.sql`).
- Card registry: `vitana-v1/src/components/vitana/card-registry.tsx:55-84`; `VitanaChatCard.tsx:15-25`.
- Post write today: client-side insert into `profile_posts` with client-generated id and reconcile-on-error
  (`vitana-v1/src/hooks/useProfilePosts.ts:35-58`). No gateway route creates posts.
- Post table: `vitana-v1/supabase/migrations/20260210135042_9aec11fb-ddef-4e88-b937-0e3c8f87c210.sql`.
- Composer and upload: `vitana-v1/src/components/CreateContentPopup.tsx:143-190` (media bucket and path);
  limits 10 MB image and 300 MB video (`:34-36`); compression `src/lib/videoCompression.ts`.
- Audience: the composer maps public, friends and groups to `is_public` (`CreateContentPopup.tsx:223`). Friends and
  Groups both save as `false`, so v1 offers Public only.
- Autopilot engine and scanners: `vitana-platform/services/gateway/src/services/community-autopilot/scan-runner.ts:23-37`
  (local-hour gate), `scanners.ts:205-218`. Post suggestions already exist as `post_to_feed`
  (`action-registry.ts:132-137`), appOnly.
- Notifications: `trg_notify_community_post` on post insert (referenced in CLAUDE.md, rule 31b). Existing
  `user_notifications` and `user_notification_preferences`.
- Feature flags: `services/gateway/src/services/feature-flags.ts:81` (`isFeatureLive`).
- Analytics: `POST /api/v1/analytics/events/batch` (`services/gateway/src/routes/product-analytics.ts:96`).
- Jobs: `scheduled-notifications.ts` `findRecentlyNotified` (fails open, not a uniqueness guarantee, so this feature
  uses a database key instead).

## 3. Interfaces between lanes

- Data → service: the table names and columns in `design.md` §2. The service reads and writes only through the
  repository module.
- Data → invitations: the pure eligibility function and the `(user_id, window_key)` unique key.
- Service → card UI: `GET /api/v1/assisted-posts/status`, `POST drafts`, `PATCH drafts/:id` (with `version`),
  `POST drafts/:id/publish` (with `expected_version`), returning `{ ok, … }` and error codes as i18n keys.
- Invitations → card UI: a `vitana_card` payload with kind `assisted_post_invite` and the action identifiers.

## 4. Lanes, owners and file scope

Lane file scope is authoritative here and in `docs/validation/<VTID>/scope.json` once allocated. Lane files are
path-free until `executing`, as the plan-PR rules require.

| Lane | Seat / area | Repo | Depends on | Paths |
|---|---|---|---|---|
| `assisted-posts-data` | exafy / platform | vitana-platform | none | `supabase/migrations/*assisted_post*.sql`, `DATABASE_SCHEMA.md`, `services/gateway/src/services/assisted-posts/{repository,eligibility}.ts`, `services/gateway/test/assisted-posts/**` |
| `assisted-posts-service` | exafy / platform | vitana-platform | `assisted-posts-data` | `services/gateway/src/routes/assisted-posts*.ts`, `services/gateway/src/services/assisted-posts/{publish,wording,flags}.ts`, `services/gateway/test/assisted-posts/**` |
| `assisted-posts-invitations` | exafy / platform | vitana-platform | `assisted-posts-data`, `assisted-posts-service` | `services/gateway/src/services/community-autopilot/assisted-post-invite*.ts`, `services/gateway/test/assisted-posts/**` |
| `assisted-posts-card-ui` | exafyltd / frontend | vitana-v1 | `assisted-posts-service` | `src/components/vitana/assisted-posts/**`, `src/components/vitana/card-registry.tsx`, `src/i18n/de/assisted-posts.json`, `src/i18n/en/assisted-posts.json`, `src/hooks/useAssistedPosts*.ts`, `src/**/*.test.tsx` |
| `assisted-posts-verification` | exafy / platform | vitana-platform | all above | `docs/validation/**`, `docs/programs/standalone/program.md` |

Shared and hot files (sequenced, never parallel, plan §8a):
- Migrations: only `assisted-posts-data` adds a migration in this plan.
- `services/gateway/src/services/community-autopilot/scanners.ts`: the invitation lane adds one scanner entry. No other
  lane touches it.
- `card-registry.tsx`: only the card UI lane.
- `DATABASE_SCHEMA.md`: only the data lane.

## 5. Tests and commands

- Gateway: `npm --prefix services/gateway test -- assisted-posts` (Jest, mocked Supabase client).
- Database integration: the local Postgres suite that already runs for migrations, with the new migration applied to
  an isolated local database. Never the shared database.
- Frontend: `npx vitest run src/components/vitana/assisted-posts` in vitana-v1.
- Staging read-only: `docs/validation/<VTID>/staging-tests.json` runs in STAGING-VERIFY. Its ref is
  `npx vitest run <paths>` or `npm run <script>`. It makes GET requests only.

Each new behaviour gets its test first, recorded red on `origin/main`, then green.

## 6. Verification matrix (summary)

| Requirement | Test type | Proven by |
|---|---|---|
| One invitation per member, no duplicates under concurrency | Mocked + local DB | invitation insert test, concurrent run test |
| Cooldowns, onboarding delay, pause, opt-out | Pure unit | eligibility tests |
| Photo and video path to publish | Mocked publish + UI tests | publish tests, card UI tests |
| Text-only path | Mocked + UI | publish and UI tests |
| No post before confirmation | Mocked | publish is the only writer, tests assert no insert before the publish call |
| Double tap, retry, reconnect create one post | Mocked + local DB | duplicate publish tests, `ON CONFLICT` test |
| Cross-user and cross-tenant rejected | Mocked + local DB | ownership tests, RLS tests |
| Manual edit survives regeneration | Mocked | wording tests with version check |
| Refresh and recovery | UI + mocked | draft reload tests |
| Localization, layout, keyboard | UI tests + read-only staging render | Vitest component tests, staging spec |
| End-to-end publication | not verified: requires an isolated environment (release requirement) | none in this plan |

## 7. Measurement

`docs/validation/<plan VTID>/timings.json` per collaboration §8b.

## 8. Risks

- Existing notification trigger fires on every post insert. Publication must keep the same trigger path, not bypass it.
- Shared database: any test that writes community content is out of scope. The local database is the only write target.
- Invitations post chat messages to real members. The delivery code path is covered by tests before the flag can be
  enabled anywhere.
- Migration applied to the shared database has no undo. The release checklist lists a rollback note per file.

## 9. Unchanged

Existing `profile_posts` schema and RLS, the composer's own publish flow, the notification preferences, the Autopilot
scanners other than the one added, the existing analytics pipeline, and every production configuration.

## 10. Premise register (re-plan after round-1 evidence floor)

Round 1 ended with `evidence_floor_not_met`: the partner recorded no read-file premise checks. This revision lists each
premise with its location so the partner can verify it directly. Repository and commit are the pinned `origin/main`
(vitana-platform `d398754f17`, vitana-v1 `6b9137ac5`).

| # | Premise | Location to read |
|---|---|---|
| P1 | Vitana bot user id is a fixed constant and `isVitanaBot` compares against it | `vitana-v1/src/lib/vitanaBotIdentity.ts:10-21` |
| P2 | Card registry maps card type strings to components through `getVitanaCardComponent` | `vitana-v1/src/components/vitana/card-registry.tsx:55-84` |
| P3 | The composer writes posts with a direct client insert into `profile_posts` using a client-generated id | `vitana-v1/src/hooks/useProfilePosts.ts:45-58` |
| P4 | `profile_posts` table definition (id, user_id, content, image_url, is_public) | `vitana-v1/supabase/migrations/20260210135042_9aec11fb-ddef-4e88-b937-0e3c8f87c210.sql:3-15` |
| P5 | Post insert fires `trg_notify_community_post` (AFTER INSERT) | `vitana-v1/supabase/migrations/20260630120000_notify_on_community_publish.sql:52-53` |
| P6 | Community-autopilot local-hour gate `SCAN_LOCAL_HOURS = {7, 17}` and `isDue(now, tz)` | `vitana-platform/services/gateway/src/services/community-autopilot/scan-runner.ts:23` and `:37` |
| P7 | Feature flags resolve through `isFeatureLive(name)` reading `FEATURE_<NAME>_ENV` | `vitana-platform/services/gateway/src/services/feature-flags.ts:81` |
| P8 | Analytics ingest endpoint `POST /events/batch` | `vitana-platform/services/gateway/src/routes/product-analytics.ts:96` |

Decision taken in this revision: the consolidated migration for the three new tables is placed in
`vitana-platform/supabase/migrations/` because the gateway services and the invitation scanner that own those tables
live in vitana-platform. It references `profile_posts` by id only, adds no foreign key into vitana-v1 tables, and
changes no vitana-v1 migration.

<!-- plan:end -->
