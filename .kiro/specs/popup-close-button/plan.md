---
change_class: standard
slug: popup-close-button
---

# Plan — Edit Video Details popup shows its close (X) button

<!-- plan:begin -->

## Goal

Owner request (Kiro Web, 2026-11-03): *"Every popup on a mobile app must have a close button (X) in the upper right
corner … investigate and fix it/add it. This one particularly is Media Hub (Shorts screen), edit details."* The owner
then asked for this fix to go to staging.

This plan covers that one popup only. Auditing the other popups is a separate plan (see Risks).

## Today (file:line, origin/main 6b9137ac5)

- `vitana-v1/src/components/ui/dialog.tsx:66` — the shared `DialogContent` already renders a real close button
  (`DialogPrimitive.Close`, lines 68–72, with the X icon and a screen-reader label).
- The same class list (line 63) contains `[&>button]:sr-only`. That hides every direct `<button>` child of the
  dialog, so the built-in X is visible to screen readers only. Sighted users have no X.
- `vitana-v1/src/components/community/EditShortVideoModal.tsx:124` — the Edit Video Details dialog uses
  `DialogContent` with no override, so it inherits the hidden X. It is opened from
  `vitana-v1/src/pages/community/MediaHub.tsx:1561`.
- Precedent: `vitana-v1/src/components/sharing/SocialShareButton.tsx:215` already un-hides the same button with
  `[&>button]:not-sr-only [&>button]:absolute [&>button]:end-4 [&>button]:top-4`.

## Change

In `EditShortVideoModal.tsx`, add the same override to its `DialogContent` className. Nothing else changes:

- the shared `dialog.tsx` is not touched, so the roughly 140 other dialogs keep their current behaviour;
- no new strings (the close label already comes from `screens.ui.close`);
- no change to save, cancel or any other behaviour.

## Interfaces between lanes

None. There is one lane.

## Lanes

- `close-button` — the one-line class change in `EditShortVideoModal.tsx`, plus one read-only staging spec that opens
  the Shorts edit dialog and checks that its close button is visible and inside the viewport.

## Parallel, shared and hot files

None shared. `EditShortVideoModal.tsx` is not a hot file.

## Tests and commands

- Local: `npx eslint src/components/community/EditShortVideoModal.tsx` (clean today); `npx tsc --noEmit -p
  tsconfig.app.json` (176 pre-existing errors on main, none in this file).
- Staging (read-only, `tests/e2e/staging/popup-close-button.staging.spec.ts`): sign in, open Media Hub Shorts, open
  Edit Video Details on an existing short, assert the close button is visible and inside the viewport at 390×844,
  then close it. The spec never clicks Save and never writes.
- Lane acceptance covers the class-merge check and the staging check.

## Measurement

Standard `timings.json` per §8b.

## Risks

- The shared dialog still hides the X everywhere else. Other popups may need the same fix. That is a separate
  audit plan, not this lane.
- The staging spec needs an existing short on the test account. If none exists, the spec must report that as a
  blocker, not create content (absolute no-write rule).

## Unchanged

The sidebar, the ORB, the save and cancel behaviour, the shared `dialog.tsx`, the Spotlight design contract and the
i18n keys.

<!-- plan:end -->
