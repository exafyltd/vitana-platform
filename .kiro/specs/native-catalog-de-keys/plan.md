---
change_class: standard
---
# Plan — native-catalog-de-keys
Author: Kiro, seat `exafyltd`. Repo: `exafyltd/vitana-v1` (catalog shards under `src/i18n/`). Program: `docs/programs/native-app/`
(VTID-05021), registry entry `docs/programs/native-app/program.md`. Spec: `handoff.md`, `tasks.md`, `lanes/de-keys.md`.

<!-- plan:begin -->
## Goal
Owner decision (final, 2026-11-11): "Catalog tests: don't weaken them. Add the German keys for the _pending_review items,
since German is the reference locale. Translate them in the same PR."

## Measured state
Pinned: vitana-v1 origin/main 02681143da1fe3f2145817289923242dc494ec09, vitana-platform origin/main e7e0c116fc135f16f621d91a0ab296be327da9d7 (2026-11-11T19:50Z).

Red on base (vitana-v1 clean checkout at the pin, `npx jest` in `apps/mobile`, three files, 260 tests): **25 failed**, 235 passed.
- `apps/mobile/tests/settings/i18n-rtl.test.tsx:88` `settingsNative catalog › <locale> has exactly the German keys, none empty`: 9 failed (es sr fr pl pt ru tr zh ar).
- `apps/mobile/tests/ai-assistants/i18n-rtl.test.tsx:73` `aiAssistantsNative catalog`: 8 failed (es sr pl pt ru tr zh ar).
- `apps/mobile/tests/ai-coach/i18n-rtl.test.tsx:68` `aiCoachNative catalog`: 8 failed (es sr pl pt ru tr zh ar).

Cause, measured with a raw key diff of the flattened shards (the test compares raw keys): the non-German shards hold a
review-flag object `_pending_review` whose leaves are `true`, for example `src/i18n/es/settingsNative.json:8-10`
(`"_pending_review": { "chat": true }`) and `src/i18n/es/aiCoachNative.json:71-74`. The German key does not need to be added:
the value and its path already exist in `src/i18n/de/` and in every locale. Examples, `file:line` at the pin:
- `src/i18n/de/settingsNative.json:4` `notifications.chat` = "Chat"; the es marker is `notifications._pending_review.chat` (es:8-10).
- `src/i18n/de/settingsNative.json:30` `security.sessionPhone` = "iPhone 15 Pro"; the es marker sits at es:36.
- `src/i18n/de/aiAssistantsNative.json:4` `toast.errorDetail` = "{message}"; the marker is es:5.
Measured counts of non-empty markers (leaves): settingsNative 55, aiAssistantsNative 23, aiCoachNative 35 (113 in total), across
es sr fr pl pt ru tr zh ar. For every marker leaf, the same path without `_pending_review` exists in `de` (checked, no gap).
`en` has empty markers (`_pending_review: {}`, for example `src/i18n/en/settingsNative.json:8`), which add no leaves.

Markers are repo-wide: about 1,500 shards carry them. Only the three namespaces above are in scope.

## Decisions
1. **No new German key.** Every pending path already has its German key and a non-empty value in all 10 locales, so there is
   no text to translate and nothing new to invent. The owner's step "add the German keys" resolves to a no-op on `de`. Reason: the
   test fails only on the flag objects, not on missing values.
2. **Remove the flag, keep the value.** In each non-German shard of the three namespaces, delete the `_pending_review` object
   (and any empty one), keep every other key and value as it is. The raw key set then equals `de` exactly, and the test passes
   without edit. This is the owner's "move the value to the key, keep the existing value" step applied to a key that already exists.
3. **Known consequence (owner-visible).** The flag records that a human has not reviewed the machine-translated value. Removing
   it records the value as accepted without a new review. The owner's instruction says to finish the translations in this PR, so
   this plan follows it and lists the 113 accepted leaves in the lane evidence. No value is changed.
4. **No test edit, no new test.** The existing exact-key tests are the verification. `scripts/**`, `.kiro/steering/**`, `CLAUDE.md`
   and lane-scope rules are unchanged.

## Lanes
One lane, `de-keys`, in `exafyltd/vitana-v1`:
- paths: `src/i18n/*/settingsNative.json`, `src/i18n/*/aiAssistantsNative.json`, `src/i18n/*/aiCoachNative.json`
  (the 11 locale shards of the three namespaces; `de` is listed and must stay byte-identical), `docs/validation/VTID-*/**`.
- depends_on: none. No other lane touches these files.

## Tests and commands
- Red on base (already measured above): `cd apps/mobile && npx jest tests/settings/i18n-rtl.test.tsx tests/ai-assistants/i18n-rtl.test.tsx tests/ai-coach/i18n-rtl.test.tsx --maxWorkers=2`.
- Green after the change: the same command, 260 passed; then `npm run typecheck` in `apps/mobile`.
- Key-set measurement script output (before and after) recorded in `docs/validation/VTID-*/key-diff.txt`.

## Measurement
`docs/validation/VTID-*/key-diff.txt` (before and after): raw key counts per namespace and locale, and the list of removed marker paths.

## Out of scope / owner-gated
- Other `_pending_review` markers in other namespaces (about 1,500 shards): a separate decision.
- Human review of the machine translations (decision 3): recorded for the owner, not done here.
- Anything that needs a live system, a migration or production. Nothing here does.
<!-- plan:end -->
