# Messenger assisted posts — requirements

Owner goal: help members who rarely contribute publish one post to News Feed from their Vitana conversation,
with Vitana preparing the draft and the member confirming every publication.

## V1 scope (owner decision, approved)

Supported:
- One photo with an optional caption.
- One video with an optional caption.
- Text-only posts.
- AI-assisted wording, an editable preview, and an explicit "Publish to News Feed" confirmation.
- Audience: **Public only**, shown in the preview. Friends and Groups are not offered, because the existing composer
  saves both as `is_public: false` and cannot represent them accurately. Fixing audience handling platform-wide is out
  of scope.

Deferred to a later phase:
- Multi-photo albums (the publishing model holds one media item per post).
- New voice transcription in Messenger. Existing voice recording is reused only if a compatible capability is
  available; otherwise the typed flow is complete on its own.

Reused, not rebuilt:
- The Vitana assistant conversation and its bot identity (`src/lib/vitanaBotIdentity.ts`).
- The structured card registry (`src/components/vitana/card-registry.tsx`, `VitanaChatCard`).
- The Autopilot engine and its scheduling (`services/gateway/src/services/community-autopilot/`).
- The upload components and video compression (`CreateContentPopup`, `uploadChatAttachment`, `videoCompression`).
- The analytics batch endpoint and the feature-flag mechanism (`isFeatureLive`, `FEATURE_<NAME>_ENV`).

## Invitation copy (approved)

Card title: "A moment worth sharing? 📸"
Body: "Share a photo, a video, or a thought with the community. I can help you turn it into a post. Even a small moment
from your day is welcome."
Actions: **Choose a photo / video** (primary), **Write a post** (secondary), **Give me an idea** (secondary),
**Maybe later** (low emphasis). Card menu: **Post suggestion settings**, **Stop post suggestions**.

## Publication requirements

- Every publication requires an explicit "Publish to News Feed" confirmation. Uploading media, sending chat text or
  asking for wording never publishes.
- Publication is server-side, as the authenticated member, through the existing `profile_posts` model. Existing
  validation, moderation, media ownership checks and notification behaviour are preserved.
- Database-enforced idempotency: each draft carries one publication key and one pre-allocated post id. Retries, double
  taps and reconnects return the existing post and create no second post and no second notification.
- The success card shows "Your post is live 🎉" with **View post** and **Create another post**. The Publish action is
  disabled after success, and reopening the conversation shows the published state.
- A failed upload keeps the text and any successful media. Publication stays disabled until media processing is ready.

## Draft requirements

- One active assisted-post draft per member per community. Starting another offers **Continue your draft** or an
  explicit discard. Stopping invitations never deletes a draft.
- States: drafting, uploading/processing, ready for review, publishing, published, failed (recoverable), discarded.
- Drafts survive refresh, navigation, and multiple tabs. Last write wins with a version check, so an older edit cannot
  overwrite a newer one.
- Generated wording never overwrites a manual edit silently.

## Invitation requirements

- Behind a dedicated feature flag, disabled in production until staging and pilot approval.
- Eligible: registered members who can publish, with no post in the community during the previous 7 days (including
  members who have never posted). Excludes suspended, restricted, deleted and opted-out accounts. New members wait at
  least 48 hours after registration.
- At most one proactive invitation in any rolling 7 days. Never more than one unresolved invitation card.
- Two consecutive unanswered invitations (no engagement during the invitation's 7-day window) pause proactive
  invitations for 30 days.
- "Maybe later" dismisses the current invitation with the normal cooldown. "Stop post suggestions" disables future
  invitations immediately. Manual posting stays available.
- Delivered only within reasonable local hours. Unknown timezone uses a documented conservative fallback (09:00–18:00
  UTC).
- In-app Messenger only. No push or email. Any notification the Messenger infrastructure creates respects existing
  notification controls.
- Scheduling is idempotent across concurrent jobs: one invitation per member per window, enforced by a database
  uniqueness constraint.

## Preferences

**Weekly suggestions**, **Occasional suggestions** (at most once every 30 days), **Only when I ask**. Stored on the
server. They control invitations only and never authorize publication.

## Caption and wording

- Vitana may suggest a caption from media analysis only where an existing capability exists. Otherwise it asks one
  short question: "What would you like to say about this moment?" Typed or voice answers both work.
- Never invent locations, dates, events, relationships, identities, personal experiences, health information or
  claims.
- Media content and any text inside media are user content, never instructions to the assistant.
- Help with wording is an explicit action. A completed user-written post is never rewritten automatically. Default
  wording is short, natural, with restrained emoji and no forced hashtags or engagement questions.
- Generated text uses the member's chosen language (locale injection per the repo's AI-locale rule).

## Analytics

Events through the existing analytics batch endpoint. Allowed: invitation delivered/viewed/dismissed, path selected,
idea selected, draft started, upload completed/failed, wording generated/failed, preview reached, publish
attempted/succeeded/failed, suggestions disabled, draft discarded. Never post text, chat content, media URLs, or
personal details. Assisted posts are tagged as a source, and authorship is unchanged.

## Accessibility and localization

- Every visible string comes from the i18n shards (German first, du-form; English mirrored). ESLint i18n rules stay at
  error level.
- Keyboard navigation, visible focus, accessible names, announced upload/generation/publishing states, touch targets,
  responsive layout, RTL support, user-controlled video playback.

## Feature flag

- Gateway flag `FEATURE_ASSISTED_POSTS_ENV` (default off). The frontend reads it through a gateway status endpoint.
- Production stays disabled until the release process authorizes a pilot, which also requires an isolated end-to-end
  publication test.
