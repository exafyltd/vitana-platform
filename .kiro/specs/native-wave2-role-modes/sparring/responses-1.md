# Planner responses — session 1, round 1

Session: `1bb1ca40-7a66-4f8d-9364-09f0323c637d` · answering `round-1.md`.

Both findings accepted and fixed in `plan.md`, each verified against vitana-v1 `main`.

## What changed in `plan.md`

- **R1-F1 (blocker, class-A classification wrong).** Confirmed on origin/main: `role-switch-destination.ts:2`
  **value**-imports `getCommandHubUrl` from `src/config/devHub.config.ts`, which reads `import.meta.env.*`
  (`devHub.config.ts:8-12`) → `vite` signal → own-class **B** (`extraction-deps.mjs:207-211`, `:231-233`); the
  `core-closure.mjs` BFS (`:145-156`) would traverse that non-type-only edge, reach the class-B config, and **fail
  `--check`**. Removed the planned core extraction of `role-switch-destination.ts` (option c): it is re-implemented
  natively in the `business` lane (a small helper that takes the command-hub URL as an injected value, not an import
  of `devHub.config.ts`), alongside the data hooks. **This plan now adds NO new `@vitana/core` entry** — fixed the
  measured-state class split, decision 3, decision 7, the lanes table and the test-plan deliverable accordingly; the
  generated core files are unchanged and `--check` passes as-is. `business-mode`/`drawer-nav`/`permissions` remain
  already-present class-A helpers consumed unchanged.
- **R1-F2 (minor, 11th commerce row).** Verified with `node -e` over the committed ledger: there ARE 11 commerce
  `role-modes` rows — 10 `source: role-route` (the block at `:4337-4455` the partner read) plus the 1
  `source: exclusion` row for `/commerce/connect/authorize`, which lives in the **exclusion section** around
  `ledger.json:2477` (lane `role-modes`, status `not_started`). That is why the partner's budget-limited read of the
  role-route block found only 10. The 8+8+8+11 = 35 partition is correct; added the explicit citation to the
  measured state.

## Dispositions

```json
[
  {
    "finding_id": "R1-F1",
    "disposition": "accepted",
    "rationale": "Confirmed on vitana-v1 main: role-switch-destination.ts:2 value-imports getCommandHubUrl from src/config/devHub.config.ts (not type-only), and devHub.config.ts reads import.meta.env.VITE_DEV_HUB_ENABLED/VITE_DEV_HUB_READONLY/VITE_GATEWAY_BASE at lines 8-12, which extraction-deps.mjs:207-211 marks as a vite signal, making devHub.config.ts own-class B (ownClass at :231-233). The core-closure BFS (:145-156) traverses the non-type-only import, reaches devHub.config.ts, finds m.own !== 'A' and errors, so core-closure.mjs --check WOULD fail if role-switch-destination.ts were added as a core re-export. Took the most conservative option (c): role-switch-destination is NOT extracted; the business lane re-implements the destination mapping natively (injecting the command-hub URL rather than importing devHub.config.ts), same pattern as the data hooks. Consequently this plan adds no new core entry at all; updated the measured-state class split, decision 3, decision 7, the lanes table and the test plan. business-mode/drawer-nav (already extracted) and permissions (already re-exported) are consumed unchanged, so --check passes with the generated files untouched.",
    "deferred_to": ""
  },
  {
    "finding_id": "R1-F2",
    "disposition": "accepted",
    "rationale": "Verified with node -e over apps/mobile/parity/ledger.json: there are exactly 11 commerce rows with lane role-modes — 10 source: role-route (the /commerce* block at lines 4337-4455 the partner read) and 1 source: exclusion for /commerce/connect/authorize. The exclusion row exists; it is in the ledger's exclusion section (around line 2477), NOT in the role-route block, which is why the partner's budget-limited read found only 10. The row is lane role-modes, source exclusion, status not_started. So the count is 11 (not 10), the total role-modes rows are 35, and the 8+8+8+11 = 35 partition is correct. Added the explicit ledger-location citation to the measured state so the premise is independently checkable; no arithmetic correction was needed because the row does exist.",
    "deferred_to": ""
  }
]
```

## Next

Committing `plan.md` + this file and pushing to start round 2.
