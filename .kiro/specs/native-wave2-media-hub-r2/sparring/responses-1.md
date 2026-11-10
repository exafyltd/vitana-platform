# Responses to sparring round 1

Checked at vitana-v1 `origin/main` `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f` (the pin in `plan.md` Measured state).

```json
[
  {"finding_id": "R1-F1", "disposition": "rejected", "rationale": "The lane file id (`media-hub`, `lanes/media-hub.md`) and the ledger `lane` value (`media`) are two different namespaces and nothing cross-references them. `scripts/native/parity-ledger.mjs --check` validates a row's `lane` only against `parity-scope.json` `lanes` (`parity-ledger.mjs:244-245`: `rules.lanes?.[r.lane]`; `laneOf` `:107-114` derives it from `lane_rules`/`lane_by_category`), and `parity-scope.json:9` defines `\"media\": \"Media hub / shorts\"`, `:98` maps the prefix to it. Collab lane ids come from `.kiro/specs/<slug>/lanes/*.md` and the `tasks.md` `<!-- lane: -->` marker. So no rename of ledger rows or scope file is needed or wanted: the lane flips the 4 rows' `status` only (plan Decision 1, tasks.md task 8)."},
  {"finding_id": "R1-F2", "disposition": "rejected", "rationale": "Navigating to `/comm/events-meetups?tab=hot` is the web behaviour (`MediaHub.tsx:1458`) and Decision 2 fixes this lane to 1:1 parity. At the pin the path is not native yet, but it does not open a WebView: `resolveWebPath` returns `unported` (`resolve.ts:195-222`) and the shell shows the `Unported` screen (`apps/mobile/src/screens/Unported.tsx`). `/comm/events-meetups` belongs to the `events-calendar` lane (`parity-scope.json:93`, plan `native-wave2-events-calendar-r3`), so the same destination string becomes a native screen when that lane lands, with no change here; sending the member to `/home` would add a divergence the program forbids (no redesign, program §4). Documented as accepted temporary degradation in plan Decision 6."}
]
```
