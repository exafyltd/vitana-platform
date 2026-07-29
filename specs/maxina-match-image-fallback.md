# MAXINA Match Card — Premium Image Fallback Pipeline

## Goal
MAXINA "My Matches" cards must always look premium and realistic, even when the
matched user has not uploaded their own photo. We achieve this with a backend-
driven, generate-once-and-reuse pipeline backed by Google Cloud Vertex AI
Imagen.

## Image priority (canonical, server-side)
1. **uploaded** — user's own uploaded photo
2. **imported** — provider/social avatar imported during onboarding
3. **generated** — Vertex AI Imagen image, generated once and cached
4. **initials** — premium gradient initials/monogram avatar (last resort,
   rendered client-side from a stable seed)

Frontend never decides between these — it asks `resolve-match-images` and
renders the URLs that come back.

## Database (vitana-v1 supabase migration)
Adds to `public.profiles`:

| Column | Type | Notes |
|---|---|---|
| `profile_image_url` | text | Final URL displayed for the avatar |
| `profile_image_source` | text | `uploaded \| imported \| generated \| initials` |
| `match_cover_image_url` | text | Final URL for the match-card cover |
| `match_cover_source` | text | `uploaded \| generated \| curated_library` |
| `fallback_seed` | text | Stable seed used for prompt + initials gradient |
| `image_last_generated_at` | timestamptz | When the most recent generation ran |
| `has_uploaded_photo` | boolean | Hard signal — never overwrite uploads |

Plus a public storage bucket `match-covers` (service-role write only) and a
helper view `profile_match_image_resolution` that the resolver reads from.

## Edge functions (vitana-v1)
- `resolve-match-images` — POST `{ matchedUserIds, category, awaitGeneration }`,
  returns the resolved URLs. If any user is missing a generated cover, fans
  out to `generate-fallback-image` (in parallel) and either waits for the URLs
  (`awaitGeneration=true`) or returns immediately and lets the next call pick
  up the freshly-stored URLs.
- `generate-fallback-image` — POST `{ userId, category, imageType, force? }`,
  the ONLY place that calls Imagen for the match-card pipeline. Short-circuits
  if a higher-priority image already exists. Stores the PNG in
  `match-covers/{userId}/{cover|avatar}-{category}.png` and writes the source
  metadata back to `profiles`.
- Both reuse `_shared/vertex-imagen.ts` for JWT, token caching, prompt
  construction, and category-aware prompt selection.

## Category-aware cover prompts
`vertex-imagen.ts` ships with hand-tuned prompts for each category:
- `dance` — boutique social-dance studio, cinematic motion, premium magazine
- `fitness` — boutique gym, golden hour, focused training, premium magazine
- `wellness` — Mediterranean wellness, terracotta + sage, mindful movement

Avatars for the rare "no photo at all" case use a stylised, non-portrait
prompt (gradient + silhouette only) to avoid presenting a stranger as the
real user.

## Frontend (vitana-v1)
- `useMaxinaMatchImages(matchedUserIds, category)` — calls the resolver,
  re-fetches once (after 8s) if any match was missing a cover so background
  generations show up without polling.
- `<MaxinaMatchImage variant="avatar" | "cover" />` — renders the URL or
  falls back to a deterministic gradient initials monogram (data: URL, no
  network round-trip).
- `utils/initialsAvatar.ts` — premium SVG gradient + initials, deterministic
  per `fallback_seed`.

## Sequence (cold-start match card render)
```
Frontend: useMaxinaMatchImages([id1,id2,...], 'dance')
  -> POST /functions/v1/resolve-match-images
       -> reads profile_match_image_resolution view
       -> for each user lacking a cover:
            POST /functions/v1/generate-fallback-image (service-role)
              -> short-circuits if uploaded/imported/generated already exists
              -> Imagen via _shared/vertex-imagen.ts (seeded, deterministic)
              -> upload to storage `match-covers/{user}/cover-{category}.png`
              -> UPDATE profiles SET match_cover_image_url, match_cover_source='generated'
       -> returns ResolvedMatchImage[]
Frontend renders <MaxinaMatchImage> with the URL, OR initials avatar.
```

## Guarantees
- **Generate once, reuse forever.** The storage key is stable per
  (user, imageType, category); the resolver short-circuits when
  `match_cover_source IN (uploaded, generated, curated_library)`.
- **No repeated cartoon placeholder.** The last-resort fallback is a
  deterministic, per-user gradient + initials monogram — different for every
  user, never a cartoon.
- **Never claim a stranger's face is the user.** Avatars use a stylised
  silhouette prompt (no facial features); covers depict the activity, not a
  specific person, so an unidentified card never misrepresents identity.
- **Source is always tracked.** Every image returned to the frontend carries
  its `profile_image_source` / `match_cover_source` so analytics, moderation
  and debugging can distinguish real uploads from generated content.
