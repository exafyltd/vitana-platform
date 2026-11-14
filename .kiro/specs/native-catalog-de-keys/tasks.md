# Tasks — native-catalog-de-keys

One lane, one PR, in `exafyltd/vitana-v1`. Branch `kiro/native-catalog-de-keys/de-keys`, title
`VTID-xxxxx (native-catalog-de-keys/de-keys): …`, trailers `Collab-Session` and `Collab-Lane`. VTIDs are assigned by CI
after PLAN-SPAR converges. Do not start the lane before its `vtid:` is set.

## Catalog keys
<!-- lane: de-keys -->
- [ ] K1 Measure: flatten `src/i18n/de/<ns>.json` and each `src/i18n/<locale>/<ns>.json` for the three namespaces and
  record the raw key diff in `docs/validation/VTID-xxxxx/key-diff.txt` (before). Expect 113 leaves under `_pending_review`
  and no key missing in `de`.
- [ ] K2 Confirm for every marker leaf that the same path without `_pending_review` exists in `de` with a non-empty value.
  Any gap is listed and the lane stops (no value is invented).
- [ ] K3 In each of the 10 non-German shards of `settingsNative`, `aiAssistantsNative`, `aiCoachNative`, delete every
  `_pending_review` object. Keep all other keys and values. Use a JSON round-trip (2-space indent, trailing newline);
  a round-trip of the untouched files is byte-identical.
- [ ] K4 `de` shards: no change (the keys already exist). If K1 finds a German key missing, stop and list it.
- [ ] K5 Run the three catalog tests in `apps/mobile` and `npm run typecheck`; record the output in `commands.log`.

Acceptance:
- Change types: Tooling/docs (catalog data only; no UI code, no user-visible text changes)
- Outcome: the three namespaces have the same raw key set in all 11 locales; the exact-key tests pass as written.
- States: n/a: no screen or state change.
- Surfaces: n/a: no screen code is touched; the strings are the same values as before.
- Locales: all 11 locales in the three namespaces; `de` unchanged; no value changed in any locale; every value non-empty.
- Accessibility: n/a: no UI change.
- Contract: n/a: no API or boundary crossed.
- Staging proof: not verified on staging: the change is catalog data; the proof is the three exact-key test files on the PR head.
- Tests: the 25 failing tests on base pass; no test file is edited; no key is renamed.
- Decisions: the removed flags are listed in `docs/validation/VTID-xxxxx/key-diff.txt`, with the owner-visible note that the
  machine-translated values are now accepted without a new review.
