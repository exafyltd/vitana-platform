# Messenger assisted posts — design

## 1. Principles

- Reuse before building. The post model is `profile_posts`. Media stays in the existing `media-uploads` bucket and
  `media_uploads` table. The Vitana conversation stays the existing bot thread in `chat_messages`.
- One consolidated migration for this feature, not one table per concept.
- The server decides what gets published. The client only prepares a draft and asks to publish.
- Publication is idempotent in the database, not in client code.

## 2. Data model (one migration, `messenger-assisted-posts` lane `assisted-posts-data`)

### 2.1 `assisted_post_drafts`
One row per draft. One active draft per (user, tenant, community) is enforced by a partial unique index on rows whose
state is not terminal.

| Column | Purpose |
|---|---|
| `id uuid pk` | Draft id |
| `user_id uuid` | Author; RLS owner-only |
| `tenant_id uuid` | Tenant boundary; every query filters by it |
| `community_id` | Community scope (per-community draft rule) |
| `state text` | `drafting`, `uploading`, `ready`, `publishing`, `published`, `failed`, `discarded` (CHECK) |
| `kind text` | `photo`, `video`, `text` |
| `caption text` | Editable text, max length matches `profile_posts.content` rules |
| `wording_source text` | `user`, `ai`, `idea`; never overwrites a manual edit silently |
| `media_path text` | Storage path under `{userId}/posts/...`, verified server-side against the caller's folder |
| `media_status text` | `none`, `uploading`, `processing`, `ready`, `failed` |
| `version int` | Optimistic concurrency: updates require the version they read |
| `publish_key uuid` | Idempotency key, created once per publication attempt and reused on retry |
| `post_id uuid` | Pre-allocated `profile_posts.id`; equals the published post id |
| `published_at timestamptz` | Set in the same transaction as the post insert |
| `created_at`, `updated_at` | Standard |

Constraints: `post_id` unique; `(user_id, publish_key)` unique; CHECK that `published` implies `post_id is not null`.

### 2.2 `assisted_post_invitations`
One row per proactive invitation. It holds the scheduling and cooldown state that the job reads.

| Column | Purpose |
|---|---|
| `id uuid pk` | |
| `user_id`, `tenant_id` | Member and tenant |
| `window_key text` | Rolling-window key (`YYYY-Www` in UTC plus member slot) |
| `state text` | `delivered`, `viewed`, `answered`, `dismissed`, `expired` |
| `delivered_at`, `expires_at` (`delivered_at + 7 days`), `responded_at` | Timing |
| `message_id uuid` | Reference to the `chat_messages` row carrying the card |

Uniqueness: `(user_id, window_key)` gives at most one invitation per member per window. A partial unique index on
`(user_id)` where `state = 'delivered'` means only one unresolved invitation can exist.

### 2.3 `assisted_post_preferences`
Per member: `user_id pk`, `frequency text` (`weekly`, `occasional`, `on_request`), `paused_until timestamptz`,
`consecutive_unanswered int`, `opted_out_at timestamptz`, `updated_at`. Stored on the server so every device agrees.

All three tables have RLS: members read and write their own rows. Writes from the job use the service role. The job
never writes `profile_posts` directly.

## 3. Publication path (lane `assisted-posts-service`)

`POST /api/v1/assisted-posts/drafts/:id/publish` with body `{ "expected_version": n }`.

Server steps, in one transaction:
1. Authenticate the caller. Load the draft `FOR UPDATE`. Reject if the caller is not the owner or the tenant does not
   match.
2. If `state = 'published'`, return `{ post_id, status: 'already_published' }`. Do not insert again.
3. Reject if `state` is not `ready`, if `expected_version` differs, if `media_status` is not `ready`, or if the caption is
   empty for `text` drafts.
4. Verify the media object exists and lives under the caller's folder (`{userId}/posts/`). Reject otherwise.
5. Run the existing post validation and moderation check used by the composer path (reused, not re-implemented).
6. Insert into `profile_posts` with `id = post_id`, `is_public = true`, `user_id = caller`. The existing
   `trg_notify_community_post` trigger handles notifications, so notification behaviour is unchanged. Use
   `ON CONFLICT (id) DO NOTHING` so a concurrent duplicate cannot insert a second row.
7. Update the draft to `published`, set `published_at`, and commit.

Retries reuse `publish_key`. A second request after success hits step 2 and gets the same `post_id`. A request that
arrives during an in-flight publish waits on the row lock and then takes step 2.

Audience: `is_public = true` is the only value the endpoint writes. The preview always shows "Public".

## 4. Wording and media (lane `assisted-posts-service`)

- `POST /api/v1/assisted-posts/drafts/:id/wording` with `{ mode: 'start' | 'help' | 'regenerate', input }`. It calls the
  existing LLM router through a Bedrock stage (CLAUDE.md §2b, no Google). The system prompt includes the member locale
  via the repo's locale helper, and every call logs provider, model, and latency (AI-29).
- Output is stored as a new `ai` suggestion. The draft caption changes only when the client sends an explicit "apply"
  with the version it read, so a manual edit is never overwritten silently.
- Media input is the existing upload path. The draft stores only the storage path. Captioning from media analysis is
  used only where an existing capability exists. Otherwise the endpoint returns `needs_caption_question`.
- Prompt-injection rule: media text and user text are passed as data inside delimiters, and the instructions state they
  are content, not commands.

## 5. Invitations (lane `assisted-posts-invitations`)

- Runs inside the existing Autopilot / companion scheduler (`community-autopilot` tick). It adds one scanner,
  `assisted_post_invite`, to the existing scanner list. It does not create a second scheduler.
- Eligibility is computed in one function (pure, unit-tested):
  - Member can publish, not suspended/restricted/deleted, not opted out.
  - No `profile_posts` row in the community in the previous 7 days.
  - Registered at least 48 hours ago.
  - No unresolved invitation (`delivered` state).
  - Frequency allowance: weekly = 1 per rolling 7 days; occasional = 1 per 30 days.
  - Not paused (`paused_until` in the past).
  - Local time is inside 09:00–18:00 in the member's timezone. Unknown timezone uses UTC 09:00–18:00.
- Pause rule: when two consecutive invitations expire with state `expired` (never engaged within 7 days), set
  `paused_until = now() + 30 days`. Engagement of any kind resets the counter.
- Concurrency: insert into `assisted_post_invitations` with the `(user_id, window_key)` unique key and
  `ON CONFLICT DO NOTHING`. Only the insert that succeeds posts the chat card, so concurrent jobs produce one invitation.
- Delivery: a Vitana bot message in `chat_messages` carrying a structured `vitana_card` payload. Existing notification
  preferences apply to any notification the infrastructure creates. No push, no email.

## 6. Draft lifecycle and failures

| Event | Result |
|---|---|
| Upload fails | `media_status = failed`; text and prior successful media are kept; publish disabled |
| Wording fails | Error card with retry; caption unchanged |
| Publish network drop | Client re-sends with the same `publish_key`; server returns the existing post |
| Refresh or reopen | Draft loaded by id; card state derived from the draft row |
| Two tabs | Version check on every write; stale writes return 409 and the client reloads |
| Stop suggestions | Sets `opted_out_at`; drafts untouched |
| Discard | `state = discarded`; media kept until the existing cleanup policy runs |

## 7. Client (lane `assisted-posts-card-ui`, repo vitana-v1)

- Card: a new entry in `card-registry.tsx` with kind `assisted_post_invite`. The card component uses the existing
  design tokens and `VCard`. Compact on mobile, with no oversized banner.
- Composer flow: a bottom sheet on mobile and a dialog on desktop, reusing `MobileCreatePostSheet` and
  `CreateContentPopup` pieces where possible. The media picker opens from the user gesture. A single file is accepted.
- Preview: avatar and name, thumbnail or video player (user-controlled playback), text, "Public" audience label,
  "Draft — not published" label.
- States: uploading with progress, processing, failed with retry, publishing, published.
- Feature flag: read from `GET /api/v1/assisted-posts/status`, which returns `enabled` from `isFeatureLive`. Off means
  no card and no entry point.
- Analytics: events go through the existing batch endpoint with no text, media URLs, or chat content.
- Localization: keys added under `src/i18n/de/` first and mirrored to `en/`. Dates use `fmtDate`/`fmtTime` helpers.

## 8. Verification design

- Unit tests (Vitest, gateway Jest, vitana-v1 Vitest): eligibility, cooldowns, pause, timezone, publish validation,
  idempotency key handling, card rendering states.
- Mocked integration: publish flow against a mocked Supabase client, including duplicate taps and retries.
- Database integration: migration applied to an isolated local Postgres with RLS, concurrent publish, and unique
  invitation insert. This uses existing local test infrastructure, not the shared database.
- Read-only staging checks: the feature status endpoint, the card registry presence on a signed-in page, and
  localization rendering. These do not create posts or notifications.
- Not covered by staging: end-to-end publication and the invitation delivery. An isolated end-to-end test is a release
  requirement before the pilot.

## 9. Rollout

- Flag `FEATURE_ASSISTED_POSTS_ENV` off by default in every environment.
- Migrations are reviewed in the PR and applied only after the owner approves the file list and target database.
- Pilot enablement is a separate decision after the isolated end-to-end test passes.
