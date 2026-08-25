# B6 — Storage Inventory (VTID-03737)

Part of `docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md`'s B6 workstream ("23
call sites → S3, smallest workstream"). Same live-verification discipline
as B2/B3/B5: check the plan's own numbers against current `main` and the
live project before treating them as settled.

## Call-site count: plan is accurate here (unlike B5)

Plan states (line 25): *"19 frontend + 4 gateway call sites."* Live-checked
via `.storage.from(` (the Supabase Storage client entry point, distinct
from the `.from()` query-builder call B1/B2/B3 covered):

- **`services/gateway`**: 4 call sites, 4 files — `video-thumbnail-service.ts`,
  `intent-cover-service.ts`, `intent-cover-service-repository.ts` (this
  session's own B1 extraction of `intent-cover-service.ts`'s query calls;
  its Storage calls were left in the original file, correctly — B1 only
  moved `.from()`/`.rpc()` query-builder calls, not Storage), `cover-image-
  outpaint.ts`. **Matches the plan exactly.**
- **`exafyltd/vitana-v1`**: 19 call sites, 15 files. **Matches the plan
  exactly.**

Total: 23, confirmed. No correction needed for this half of B6, in contrast
to B5 where the gateway figure had gone stale.

## Bucket names referenced in code (9 distinct)

| Bucket | Referenced from |
|---|---|
| `covers` | frontend (5 call sites) |
| `feedback-attachments` | frontend (5 call sites, mixed quote styles) |
| `intent-covers` | frontend (2) + gateway (`INTENT_COVERS_BUCKET` env var, default `'intent-covers'`, in `cover-image-outpaint.ts` + `intent-cover-service.ts`) |
| `stream-recordings` | frontend (1) |
| `media-uploads` | frontend (2) |
| `diary-photos` | frontend (1) |
| `avatars` | frontend (2) |
| `media` | gateway only (`video-thumbnail-service.ts`) |

## Plan's "8 objects in storage schema" claim: stale — live has 19 buckets, 1099 objects, ~5GB

Plan line 25 also states *"8 objects in `storage` schema"* — checked live
against `storage.buckets`/`storage.objects` on project `inmkhvwdcuyhnxkgfvsb`:
**19 buckets exist, holding 1,099 objects totaling ~5,020 MB (~5 GB).**
Whatever the "8" referred to (possibly a bucket count from an earlier point
in the project's life, or a different metric entirely), it does not match
current reality by an order of magnitude. Per-bucket breakdown, sized for
S3 migration planning:

| Bucket | Public | Objects | Approx. size | Referenced in code? |
|---|---|---|---|---|
| `media-uploads` | yes | 380 | 3,455 MB | yes (both repos) |
| `media` | yes | 92 | 301 MB | yes (gateway) |
| `covers` | yes | 238 | 181 MB | yes (frontend) |
| `avatars` | yes | 82 | 165 MB | yes (frontend) |
| `intent-covers` | yes | 108 | 143 MB | yes (both repos) |
| `media-podcasts` | yes | 12 | 426 MB | **not found in either repo's grep** |
| `chat-attachments` | no | 67 | 73 MB | **not found in either repo's grep** |
| `event-images` | yes | 50 | 73 MB | **not found in either repo's grep** |
| `media-music` | yes | 13 | 101 MB | **not found in either repo's grep** |
| `health-reports` | no | 20 | 36 MB | **not found in either repo's grep** |
| `media-videos` | yes | 2 | 57 MB | **not found in either repo's grep** |
| `diary-photos` | yes | 5 | 8 MB | yes (frontend) |
| `voucher-pdfs` | no | 28 | 226 kB | **not found in either repo's grep** |
| `feedback-attachments` | no | 1 | 980 kB | yes (frontend) |
| `campaign-images` | yes | 1 | ~0 | **not found in either repo's grep** |
| `stream-recordings` | yes | 0 | — | yes (frontend), but bucket is empty |
| `community-marketplace-listings` | yes | 0 | — | not found |
| `default-images` | yes | 0 | — | not found |
| `media-thumbnails` | yes | 0 | — | not found |

**9 of 19 live buckets (holding ~766 MB / 172 objects — `media-podcasts`,
`chat-attachments`, `event-images`, `media-music`, `health-reports`,
`media-videos`, `voucher-pdfs`, `campaign-images`, plus the empty
`community-marketplace-listings`/`default-images`/`media-thumbnails`) were
not found by grepping `.storage.from(` in either `vitana-platform` or
`vitana-v1`.** This is a real gap in this pass's coverage, not a claim those
buckets are unused — plausible explanations, none checked here:
Supabase **edge functions** (`supabase/functions/*`, a third code surface
this pass did not grep), the **mobile app** (`exafyltd/vitana-mobile`, also
not checked — same gap B5 flagged), or direct dashboard/admin uploads with
no application code touching them at all. `chat-attachments`,
`health-reports`, and `voucher-pdfs` being non-public buckets with real
object counts makes them the most important of these nine to positively
locate before S3 migration — a bucket nobody's code visibly reads is either
dead weight or a coverage gap, and those are very different next steps.

Also relevant to the migration's RLS-parity requirement (ALWAYS rule 22,
"Always enforce tenant isolation (RLS)"): **58 RLS policies exist on
`storage.objects`/`storage.buckets`** (`pg_policies` where
`schemaname='storage'`) — each one is an access-control rule that needs an
S3-side equivalent (bucket policy, presigned-URL scoping, or an
application-layer check in front of S3) before cutover, not just the data
itself.

## Not done in this pass

- Did not grep `supabase/functions/*` (edge functions) or
  `exafyltd/vitana-mobile` for Storage call sites — both are plausible
  homes for the 9 buckets with no hit in the two repos checked. B5 flagged
  the identical mobile-app gap for Realtime; the same repo is unchecked
  here for the same reason (out of this session's active branches).
- Did not read the 58 storage RLS policies individually to map each to an
  S3-equivalent access rule — sizing only, not a policy-by-policy port plan.
- Did not check whether any bucket needs versioning, lifecycle rules, or
  CDN/CloudFront fronting in its S3 form — pure inventory, no target-
  architecture design.
