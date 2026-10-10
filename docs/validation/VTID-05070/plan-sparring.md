# Plan sparring record — VTID-05070 (Kiro runs addendum, Phase 5: Kiro takes read-only screenshots on staging)

- Sparring session: `29df2236-1a78-4c7c-a864-977456670aff`
- Plan hash: `83cac70ef4783d161cf2b95366e349f2262a39520206a6f6f502826cb4e6b884`
- Verdict: **converged** after 2 rounds (round 1: 0 blocker / 2 major / 3 minor, all accepted; round 2: all closed, 2 new minors accepted)
- Owner approval: 2026-10-10, Claude Code session https://claude.ai/code/session_019XRHThojRVzYPDzoLtuby6 — approved
- This VTID implements **Phase 5** of the addendum only ("Phase 5 (new)" + planner responses F11–F17). Phase 2 (paste/drop images, console module, `/api/v1/operator/media`) is a separate VTID.

---

# Addendum to the option-2 plan (VTID-05065 family): paste images, Kiro screenshots

<!-- plan:begin -->
## Owner request (2026-10-10)
"copy paste images into chat" (never possible so far) and "operator [Kiro] should use playwright and make screenshots of screens and new designs, same like you do here".

## Verified starting point
- `POST /api/v1/operator/upload` (routes/operator.ts ~1312) is a stub: it validates metadata, mints an `OASIS-FILE-…` ref and emits an event, but stores no bytes and has no auth. Chat messages accept `attachments: [{ oasis_ref, kind }]` (types/operator-chat.ts:27) that nothing can resolve to an image.
- `AcpClient.initialize()` sends `clientCapabilities: {}` and ignores the agent's capabilities (acp-client.ts:190); `prompt()` sends text blocks only.
- The runner image (services/kiro-runner/Dockerfile) has no browser.

## Phase 2 gains: paste / drop images (with the new Kiro console module)
1. Storage: private Supabase Storage bucket `operator-media`, created once through the Storage API (`POST /storage/v1/bucket`, `public=false`) by a one-time setup script `scripts/supabase/setup-operator-media-bucket.mjs` run from a workflow_dispatch job (no direct INSERT into `storage.buckets`); no client policies — gateway service role only; the script is idempotent and documented in DATABASE_SCHEMA.md. Objects at `<user_id>/<thread_id>/<uuid>.<ext>`; png/jpeg/webp/gif only, ≤ 5 MB each, ≤ 4 per message (checked by magic bytes, not the name).
2. `POST /api/v1/operator/media` (requireAdminAuth; raw body up to 5 MB; content-type checked) stores the image and returns `{ media_id, oasis_ref, url }` where `url` is a 1 h signed URL; `GET /api/v1/operator/media/:id` re-signs for the owner only. The old stub `/upload` is left unchanged (no caller depends on it beyond the old console; removing it is out of scope).
3. Composer (kiro-console.js, and the LLM composer in app.js through the same small helper): Ctrl/Cmd+V of an image, drag-and-drop and a paperclip pick → thumbnail chips with remove ✕ → uploaded on Send; text paste keeps working as today.
4. Delivery: a run stores `attachments` (media ids). For Kiro, `initialize` reads `agentCapabilities.promptCapabilities.image`; when true the prompt carries ACP `{ type: 'image', mimeType, data }` blocks (base64, from storage); when false or absent the prompt gets one line "The user attached N image(s) that this agent cannot view" and the console shows "Kiro can't see images in this version" under the message — never silently dropped. For the Operator (LLM) engine the images go to Bedrock Claude as image blocks (the router already supports `images`, VTID-03496).
5. Thread history shows the images (signed URLs fetched per view, never stored in localStorage).

## Phase 5 (new): Kiro takes screenshots on staging
1. Browser in a SIDECAR container of the kiro-runner task (official pinned Playwright image), not in the runner image: kiro-cli's container has no browser binary and cannot start one; the runner image stays lean. The sidecar runs as non-root with a read-only root filesystem and `/dev/shm` handled by `--disable-dev-shm-usage`. First step of Phase 5: prove on staging Fargate whether Chromium's sandbox works there; if Fargate blocks it, `--no-sandbox` is used ONLY inside this dedicated sidecar, which holds no secret other than the test user's password and reaches only the allowlisted hosts. The measured image size and the sandbox result are recorded in the PR.
2. Tool path without credentials near Kiro: kiro-cli gets one more stdio MCP server, `vitana-browser` (the same tiny relay pattern as `mcp-proxy.ts`, decided by the runner in `mcpServersFor`), whose env holds only a localhost URL and a per-session token; it forwards calls to the sidecar's HTTP endpoint on localhost. The sidecar alone holds the test user's password (read by the runner from Secrets Manager and given to the sidecar at start, never to kiro-cli's env, never to the relay). ONE tool: `browser_screenshot { url, viewport: desktop|mobile|both, full_page?, wait_for_selector?, click_selector? }`.
3. Guards, enforced in the sidecar at the network level (`browserContext.route('**/*')`, the same rules as `scripts/ci/staging-verify/staging-guard.ts`, reused), so a redirect, meta refresh or click to another host is blocked too, not only the first URL: host allowlist = staging hosts only (`preview-aws.vitanaland.com`, `preview-aws-gateway.vitanaland.com`, per-PR preview hosts matching the preview pattern in the frontend deploy workflow); any production host refused; every non-GET request from the page aborted except the Supabase password sign-in of the E2E test user (same network guard as the staging Playwright suite, CLAUDE.md rules 31/48); optional sign-in as that test user with its password from the runner's Secrets Manager (read by the runner, never sent to Kiro); 30 s per page, 10 screenshots per run — the 11th call returns the error "screenshot limit reached for this run" so Kiro can adapt.
4. Each PNG is posted by the runner to `POST /api/v1/operator/kiro/media` with the session's MCP pass (same token as the read tools), stored in `operator-media`, and appended to the run as a `kiro.image` event (media id, url, viewport, page url); the Kiro console shows it inline in the step list; Kiro gets back the media id and dimensions (and, when image input is supported, the image itself so it can judge it).
5. Read-tool trust: `Running: @vitana-browser/browser_screenshot` is auto-allowed like the read tools (read-only by construction of the guards); a CI pin covers the title.
6. Session rules (VTID-05064) gain one line: after a UI change is on staging, screenshot it at desktop and mobile before asking to publish.

## Out of scope
Screenshots of production; image editing; video; images in voice (ORB); deleting old media (retention job is a follow-up, logged).

## Tests
- Media route: auth 401, owner-only 403, type/size/magic-byte refusals, signed URL TTL; storage mocked.
- Composer (command-hub jest): paste image → chip; drop; remove; text paste unchanged; Send uploads then starts the run with attachments.
- ACP: image blocks only when the agent advertises image input; the text fallback line otherwise (fake kiro-cli both ways).
- Runner (vitest): allowlist refuses prod and arbitrary hosts; non-GET aborted except the sign-in; per-run cap; PNG upload with the pass; tool hidden when Chromium is missing.
- Pipeline suite: a run with a pasted image reaches Kiro as image blocks; a screenshot step appears as a `kiro.image` event and replays after reload.
- Staging (read-only): `GET /api/v1/operator/media/<non-existent>` → 401/404 JSON; console module served with the composer paste handler.
<!-- plan:end -->

## Planner responses — addendum round 1
- F11 major — ACCEPTED: the password lives only in a separate sidecar container; kiro-cli's MCP entry gets a localhost URL + per-session token, nothing else.
- F12 major — ACCEPTED: browser moved to a sidecar (runner image stays lean, kiro-cli cannot spawn a browser); Fargate sandbox proven first; `--no-sandbox` only inside the dedicated sidecar if Fargate blocks the sandbox; size + result recorded.
- F13 minor — ACCEPTED: network-level guard via browserContext.route, reusing staging-guard.ts rules.
- F14 minor — ACCEPTED: explicit error at the cap.
- F15 minor — ACCEPTED: bucket created via the Storage API by an idempotent setup script, no INSERT into storage.buckets.

## Planner responses — addendum round 2
- F16 minor — ACCEPTED: the CI pin asserts the exact title from the vitana-browser relay ("Running: @vitana-browser/browser_screenshot") end to end through acp-client kind defaulting and the permission broker; a format change falls back to a card.
- F17 minor — ACCEPTED: the sidecar is a second container in the SAME kiro-runner Fargate task definition (shared localhost), port pinned at 8090 via env `KIRO_BROWSER_URL=http://127.0.0.1:8090`; the task-definition change (read live first, CLAUDE.md ALWAYS 16) and the runner deploy workflows are in scope.
- Q1 — yes: Phase 2 stores `agentCapabilities` from the initialize response on the session. Q2 — yes: the media upload uses the same X-Kiro-Mcp-Token pass the read tools use.

## Verdict
CONVERGED after 2 rounds (round 1: 0 blocker / 2 major / 3 minor, all accepted; round 2: all closed, 2 new minors accepted).
