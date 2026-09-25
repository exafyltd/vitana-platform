# VTID-04504 — Community Autopilot CA-4: create-with-me and connect drafts

Step CA-4 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`. Gateway half; the app half is
`exafyltd/vitana-v1` PR #1146 (preview sheet + composer prefill).

## What changed

- New action kinds: `post_to_feed` (public, app only), `media_upload` (caption,
  app only), `send_chat_message` (medium: voice only after the draft is read back).
- `services/community-autopilot/drafts.ts`: the draft is written by the `memory`
  routing stage (Bedrock primary) from an English intent, in the member's
  language (`buildLocalizedSystemPrompt`), sanitized and length-bounded, and
  stored on the suggestion's `action` so the preview, the read-back and the
  execution use the same text.
- Activation: an edit from the app preview (`draft_text`) wins; a missing draft
  is generated first. A voice "yes" to an app-only kind returns `needs_app` and
  changes nothing. `POST /api/v1/autopilot/recommendations/:id/draft` returns,
  regenerates or saves the draft (owner, community, drafted kinds only).
- `send_chat_message` never targets the member themselves or a
  `service_bot_accounts` / `notification_test_actors` account (rules 43-45).
- The list includes `action`; a row with a typed action is no longer hidden by
  the retired-template filter.
- Voice tools report "finish in the app" for app-only kinds.

## Acceptance criteria

AC-1: A public post is never published by voice: any voice activation returns needs_app and writes no status change; from the app it opens the composer pre-filled with the reviewed draft.
TEST: services/gateway/test/vtid-04504-community-autopilot-drafts.test.ts

AC-2: A message by voice needs a read-back that contains the draft text; a confirmed voice send goes through the shared chat tool.
TEST: services/gateway/test/vtid-04504-community-autopilot-drafts.test.ts

AC-3: A message is never sent to the member themselves or to a test/service account.
TEST: services/gateway/test/vtid-04504-community-autopilot-drafts.test.ts

AC-4: Drafts come from the memory stage with a localized system prompt, from an English intent (no finished sentence), are sanitized and bounded, and a failed generation is reported, not thrown.
TEST: services/gateway/test/vtid-04504-community-autopilot-drafts.test.ts

AC-5: The app preview edit is stored on the row and carried into the composer route; POST /:id/draft saves an edit for the owner and refuses other members' rows and non-drafted kinds.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

## Evidence

- App side (vitana-v1 #1146): `src/components/autopilot/AutopilotDraftSheet.test.tsx` — the sheet shows the draft, returns exactly the approved text, and cannot confirm an empty post.

- `outputs/jest-ca4.txt` — 240 suites / 4,114 tests across the autopilot and ORB suites.
- `outputs/mutation-apponly-removed.txt` — removing the app-only guard fails 2 tests.
- `outputs/draft-desktop.png`, `outputs/draft-mobile.png` — the preview sheet
  (vitana-v1 #1146) at 1400×900 and 390×844 on a local harness, no network.

Not verified live: no draft was generated and nothing was posted or sent on any
host. Staging is the first place this runs.

## Route mount

ROUTE_MOUNT: `router.post('/:id/draft')` in services/gateway/src/routes/autopilot-recommendations.ts, a router mounted at `/api/v1/autopilot/recommendations` (services/gateway/src/index.ts:829, `mountRouterSync`).
FINAL_URL: POST https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/recommendations/<id>/draft
CURL_PROOF: `curl -X POST https://preview-aws-gateway.vitanaland.com/api/v1/autopilot/recommendations/rec-x/draft` (no credentials, writes nothing) → `401 application/json` `{"ok":false,"error":"missing bearer token"}`, taken before merge. This shows the router is mounted and answers JSON. The handler itself runs only after this merges and deploys; its auth and behaviour are covered by the route tests above.
