# VTID-05067 - Kiro console as its own module + paste / drop images (Phase 2 of 5)

Owner approval 2026-10-10 (Gate 1: "approved" plan, "yes" addendum, "build it"). Sparring: `plan-sparring.md` (main plan converged in 2 rounds, VTID-05065 record; addendum converged in 2 rounds). This VTID implements "Phase 2 — Kiro console as its own module" of the main plan and "Phase 2 gains: paste / drop images" of the addendum (not Phase 5).

VALIDATION_PROFILE: gateway_backend

ROUTE_MOUNT: `/api/v1/operator/media` (new file `services/gateway/src/routes/operator-media.ts`, mounted in `index.ts` after `/api/v1/operator/kiro/runs` and before the operator router; `requireAdminAuth` on every route; an image is readable by the admin who uploaded it only). Routes: `POST /?thread_id=<uuid>` (raw image body, png/jpeg/webp/gif by magic bytes, ≤ 5 MB) → `201 { ok, media_id, oasis_ref, url, mime_type, size_bytes }`; `GET /:id` → the owner's image re-signed (1 h). Atlas: `/^operator-media$/` in the `agents` domain (`orb/developer/domain-atlas.ts`). `POST /api/v1/operator/kiro/runs` and `POST /api/v1/operator/chat` (+ `/chat/stream`) accept image media ids (`attachments`), at most 4, the caller's own.

FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/operator/media (staging); the module at https://preview-aws-gateway.vitanaland.com/command-hub/kiro-console.js.

CURL_PROOF: unauthenticated `GET /api/v1/operator/media/<uuid>` answers 401 application/json; unauthenticated `POST /api/v1/operator/media?thread_id=<uuid>` is rejected 401 application/json by the auth gate before any handler; `GET /command-hub/kiro-console.js` serves the module with the paste handler and the after_seq reattach; `GET /command-hub/` references `kiro-console.js`/`.css` and `app.js` at `?v=20261111-vtid-05067` (`staging-tests.json`, read-only).

OASIS_PROOF: `operator.media.uploaded` — vtid VTID-05067, source `gateway-operator`, declared in the `CicdEventType` union; payload `{ media_id, thread_id, mime_type, size_bytes }` only, never the bytes. How a Kiro run took its images is a run event `kiro.images` `{ count, delivery: sent | unsupported | unreadable, sent }` in `kiro_run_events` (not an OASIS topic).

MIGRATION: `supabase/migrations/20261011090000_vtid_05067_operator_media.sql` — `operator_media` (RLS on, no policies, `anon`/`authenticated` revoked) and the nullable `kiro_runs.attachments` jsonb. Documented in `DATABASE_SCHEMA.md`. Applied after merge via `RUN-MIGRATION.yml`. Until it is applied, run listing keeps working (the gateway falls back to the column list without `attachments`); image uploads answer 503 until `operator_media` exists.

BUCKET: private Storage bucket `operator-media`, created once through the Storage API (`POST /storage/v1/bucket`, never an INSERT into `storage.buckets`) by `scripts/supabase/setup-operator-media-bucket.mjs` — run the workflow_dispatch job `.github/workflows/SETUP-OPERATOR-MEDIA-BUCKET.yml` with `dry_run=true`, then `false` (idempotent; an existing PUBLIC bucket is refused, exit 2). No generic "run a setup script" workflow existed, so this one-off job was added.

## Acceptance criteria

AC-1: A Kiro thread's chat pane belongs to `kiro-console.js` (window.KiroConsole); app.js keeps the thread list, the engine switch, the model picker and the Operator (LLM) path and hands the pane over (`renderPane`). The VTID-04975…05064 live-transcript / approval-card / Stop / confirmation-poll code is gone from app.js (one owner of the Kiro view); its CSS moved to `kiro-console.css`.
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  TEST: services/gateway/test/command-hub/vtid-04975-kiro-operator-ui.test.ts
  UI: docs/validation/VTID-05067/outputs/a-runs-live-permission-desktop.png
AC-2: A Kiro thread is rendered as its runs (`GET /runs?thread_id=`): past runs with the message, its images, Kiro's reply, a collapsible step list (tool calls with status, approval cards with their answer, loaded once from the store on open), and how the run ended (stopped early, failed with "Continue in Operator" for no_credits/not_connected, stopped, interrupted); turns from before the oldest run are drawn through the host; an empty thread shows the Kiro workspace card.
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  UI: docs/validation/VTID-05067/outputs/a-past-runs-top-desktop.png
AC-3: The current run streams from `GET /runs/:id/stream?after_seq=<last seen seq>`; a reload, a thread switch or a second tab lists the runs again and reattaches; a dropped stream reconnects with backoff (1 s, 2 s … 15 s) from the last seq — nothing lost, nothing twice; the end reloads the run and re-reads Kiro's model list. The sidebar spinner and the model picker / End session follow the run status.
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  TEST: services/gateway/test/command-hub/vtid-05064-operator-turn-thread.test.ts
  UI: docs/validation/VTID-05067/outputs/a-runs-live-permission-mobile.png
AC-4: The composer is always enabled: Send while a run runs → `POST /runs` queues it, shown as a queued item with Cancel (`POST /runs/:id/cancel`); 409 `queue_full` is shown inline and the draft is kept. Stop cancels the current run by its id. Continue on the newest interrupted run starts a new run with a short continue message.
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  UI: docs/validation/VTID-05067/outputs/b-queued-and-image-chips-desktop.png
  UI: docs/validation/VTID-05067/outputs/c-interrupted-continue-refused-desktop.png
AC-5: Open approval cards of the live run (and VTID-05006 write confirmations, polled only while a run of the thread runs) answer through `/kiro/permissions/:id` and `/kiro/confirmations/:id`.
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  TEST: services/gateway/test/vtid-05006-kiro-write-tools.test.ts
AC-6: Images, one shared helper for the Kiro and the Operator composer: Ctrl/Cmd+V of an image, drag-and-drop and the paperclip add thumbnail chips with a remove ✕; a text paste is unchanged; type (png/jpeg/webp/gif), size (≤ 5 MB) and count (≤ 4) are checked before upload; Send uploads each to `POST /api/v1/operator/media` and then starts the run (or the Operator turn) with the media ids; a refused upload keeps the draft and the chips. History shows images through signed URLs fetched per view, kept in memory only.
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  UI: docs/validation/VTID-05067/outputs/b-queued-and-image-chips-mobile.png
AC-7: `POST /api/v1/operator/media` is admin-only (401 JSON), owner-only (another admin's thread 403; GET re-signs for the owner only, 403 otherwise), recognises the type by magic bytes (svg, a GIF labelled PNG and text refused 415), refuses > 5 MB (413) and an empty body (400), stores at `<user_id>/<thread_id>/<uuid>.<ext>` in the private bucket and answers a 1-hour signed URL on the PUBLIC Supabase origin; the bucket script uses the Storage API and is idempotent.
  TEST: services/gateway/test/operator-media.test.ts
  CURL: staging GET /api/v1/operator/media/<uuid> without a token -> 401 application/json
AC-8: Kiro gets the images as ACP image blocks `{ type: 'image', mimeType, data }` only when `initialize` advertised `agentCapabilities.promptCapabilities.image` (kept on the client); otherwise the prompt carries one line "The user attached N image(s) that this agent cannot view", nothing is read from storage, and a `kiro.images` run event + reply meta make the console show "Kiro can't see images in this version"; an unreadable image is said in the prompt. Never silently dropped.
  TEST: services/gateway/test/vtid-05067-kiro-acp-images.test.ts
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
  UI: docs/validation/VTID-05067/outputs/c-interrupted-continue-refused-mobile.png
AC-9: A run with a pasted image reaches Kiro as an image block end to end (media route → run → executor → ACP), another admin's image is refused (400 invalid_attachment), more than 4 is refused (400 too_many_attachments) before a run exists; an Operator (LLM) turn's image reaches the model through the router's `images`.
  TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts
AC-10: CSP and accessibility: external files only (no inline script/style, no innerHTML, no CDN), `?v=20261111-vtid-05067` on app.js, styles.css, kiro-console.js/.css; every class the module uses is styled; buttons carry labels (Attach images, Remove image N, Cancel this queued message), alerts use role=alert, the runs region is aria-live polite, focus-visible outlines; no horizontal overflow at 390 px; the sidebar is untouched; no new screen (the existing Operator Console chat pane).
  TEST: services/gateway/test/command-hub/vtid-05067-kiro-console.test.ts
  TEST: services/gateway/test/scripts/command-hub-ownership-guard.test.ts
  UI: docs/validation/VTID-05067/outputs/a-runs-live-permission-mobile.png

## Changed existing tests (code they pinned moved to kiro-console.js)

- `test/command-hub/vtid-04975-kiro-operator-ui.test.ts` — slices the Kiro block from `function operatorThreadEngine(thread) {` (the removed `var KIRO_TOOL_STATUS` was the old start marker); the live-transcript / approval / Stop tests became a check that this code is gone from app.js and lives in the module (behaviour pinned in the new suite); Stop → End session only; frame routing → pane hand-off; CSS check reads styles.css + kiro-console.css.
- `test/command-hub/vtid-04984-kiro-model-select.test.ts` — `applyKiroTurnFrame(kiro.turn_end)` → `onKiroRunFinished(threadId)` (and only that thread's list is dropped); start marker as above.
- `test/command-hub/vtid-05064-operator-turn-thread.test.ts` — Stop-follows-the-turn-thread tests replaced by "a finished run resets its own thread's model list only" (Stop now cancels the run by id); cache-bust and guard checks accept a later VTID; start marker as above.
- `test/command-hub/vtid-04999-kiro-key-field.test.ts`, `test/command-hub/vtid-05003-kiro-default-engine-ui.test.ts` — start marker only.
- `test/vtid-05006-kiro-write-tools.test.ts` — the confirmation-poll source pin reads kiro-console.js.
- `test/vtid-03822-operator-chat-threads.test.ts` — the fixed 6500-char window into `renderOperatorChat` grew to 8000 (the Kiro hand-off and image thumbnails sit above the pinned loop).
- `test/operator-pipeline/fake-operator-platform.ts` — in-memory Supabase Storage (upload, sign, read) for the new scenarios.

## Decisions taken (inside the approved plan)

- Turns of a Kiro thread from before its oldest listed run (pre-run history, or beyond the 20 listed) are drawn above the runs through a small host renderer (markdown bubble, Kiro notices, model badge, Continue in Operator) — not the full Operator bubble (no copy button there).
- Past runs' steps load once when their step list is opened; runs with images load their events at once so "Kiro can't see images" shows without a click.
- The continue message is "Continue where you left off." (a developer message to Kiro, not spoken text).
- The Operator composer's paperclip "Image" option uses the new image tray; "Video" and "File" keep the old `/upload` stub (left unchanged per the addendum).
- The media upload also checks that the thread, when it exists, belongs to the caller (403 otherwise).
- Images are sent with the Operator's first model call and with its tool-continuation calls (so a reply after tools still sees them).
- Approval cards read ACP kinds as verbs: `other` → "use a tool", `execute` → "run a command" (Kiro's MCP tools arrive as `other`).
- `kiro_runs` reads fall back to the column list without `attachments` while the migration is not applied (re-checked every 5 min).
- No existing generic workflow could run the bucket script, so `SETUP-OPERATOR-MEDIA-BUCKET.yml` (workflow_dispatch, dry run first) was added.
- `services/gateway/specs/command-hub-symbol-index.json` regenerated (generator script) for the moved/added functions.

## Visual evidence (local harness, not served in production)

`services/gateway/test/command-hub/fixtures/kiro-console-harness.html` loads the real `styles.css`, `kiro-console.css` and `kiro-console.js` with mocked gateway answers; Playwright (chromium) at 1400×900 and 390×844, no horizontal overflow at 390 (scrollWidth 390), no console errors:

- `outputs/a-runs-live-permission-desktop.png`, `outputs/a-runs-live-permission-mobile.png` — a thread with 2 past runs and the live run (steps, live text, open approval card, Stop); `outputs/a-past-runs-top-desktop.png`, `outputs/a-past-runs-top-mobile.png` — the same thread scrolled to the past runs (image thumbnail, opened step list, model badge).
- `outputs/b-queued-and-image-chips-desktop.png`, `outputs/b-queued-and-image-chips-mobile.png` — a running run, a queued message with Cancel, two pasted-image chips with ✕ in the composer.
- `outputs/c-interrupted-continue-refused-desktop.png`, `outputs/c-interrupted-continue-refused-mobile.png` — a refused run ("Kiro stopped early: refusal"), a run whose image Kiro could not see, an interrupted run with Continue.

Staging visual check (CLAUDE.md IF-THEN 26) follows the deploy, read-only (render existing runs; no new run on staging, rule 48).
