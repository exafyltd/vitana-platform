# Sparring round 1 — in_progress

Session: `5246259d-c51b-4fd0-986b-9d1ea14c2cd2` · plan hash `b7118b3d88ac7bb4428de2c0f8ce19a1470735406e640c514e2b9b9f822ade3f`

## Summary

The plan is thorough and well-evidenced. All key premises I verified against the pinned code hold: ledger rows, NATIVE_ROUTES absence, package.json dependencies, app.config.ts plugin registrations, web route and redirect, resolve.ts structure, spotlight/mobile logic, shortsTags.ts classification, gateway client shape, shell bus event handling, and the MediaHub.tsx mobile branch rendering logic. Two findings below — one potentially actionable mismatch and one UX note.

## Findings

### R1-F1 [major]

The plan declares the lane as `media-hub` (lane file `lanes/media-hub.md`) but the ledger rows at the pin all carry `"lane": "media"` (ledger.json:742, 754, 766, 778), and parity-scope.json:98 maps the prefix to lane `media`. If parity-ledger.mjs cross-references the lane file name against the ledger `lane` field, the `--check` gate will fail. The plan does not mention renaming the ledger `lane` value from `media` to `media-hub` or naming the lane file `lanes/media.md`.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:736` — "lane": "media" (all 4 rows at lines 742, 754, 766, 778)
- `exafyltd/vitana-v1:scripts/native/parity-scope.json:98` — { "prefix": "/comm/media-hub", "lane": "media" }

Suggestion: Either rename the lane file to `lanes/media.md` (matching the ledger/scope value `media`) or, if the plan intentionally renames the lane, explicitly state that the 4 ledger rows and parity-scope.json:98 will be updated to `media-hub`. Verify which name `parity-ledger.mjs --check` expects.

### R1-F2 [minor]

Decision 6 replicates the web deep-link close behaviour: closing a `?short=<id>` feed navigates to `/comm/events-meetups?tab=hot`. On the native app at the pin, `/comm/events-meetups` is not in NATIVE_ROUTES (resolve.ts:42-147), so `resolveWebPath` returns `unported` and the user lands in a WebView fallback rather than a native screen. This is technically 1:1 web-path parity but produces a jarring native-to-WebView transition.

- `exafyltd/vitana-v1:apps/mobile/src/navigation/resolve.ts:42` — NATIVE_ROUTES list — no `/comm/events-meetups` entry
- `exafyltd/vitana-v1:src/pages/community/MediaHub.tsx:1458` — navigate('/comm/events-meetups?tab=hot', { replace: true });

Suggestion: Consider navigating to `/home` (which IS in NATIVE_ROUTES) as the close-on-deep-link target for the native port, or document the WebView fallback as an accepted temporary degradation until the events-calendar lane ships.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
