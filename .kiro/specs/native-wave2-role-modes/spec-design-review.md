# Spec design review — native-wave2-role-modes

Reviewer: independent design-review subagent (fresh context, no author history).
Date: 2026-10-28.
Scope reviewed: `plan.md`, `handoff.md`, `tasks.md`, `requirements.md`, `design.md`, `lanes/{patient,professional,staff,business}.md`.
Model spec cross-checked for structural parity: `.kiro/specs/native-wave2-home-feed-news/`.
All factual premises were re-verified read-only against `exafyltd/vitana-v1` `origin/main` (fetched this session) and the `vitana-v1` program plan.

Verdict: **APPROVED** — 0 HIGH, 0 MEDIUM findings. NITs below are non-blocking.

---

## Summary

This is a planning/design spec for a native screen-port batch (Wave 2 role-modes). It decomposes the 35 `role-modes`
parity-ledger rows into four disjoint lanes (patient/professional/staff/business) and specifies the core-extraction
class split, the per-mode bottom-tab rule, the admin exclusion, the i18n/RTL rules and a fixture-only test plan with
device-runtime deferred to G1. Every load-bearing numeric and structural premise in the spec was checked against the
live `origin/main` ledger and source and matched exactly. The structure mirrors the already-converged model spec
`native-wave2-home-feed-news`. No code is written, no VTID is allocated, no live system is touched — correct for a
plan at the `drafted` stage awaiting PLAN-SPAR.

---

## Findings

### NIT-1 — Program plan says "Admin (96 consoles)", spec/ledger say 93 rows
`design.md` §2, `requirements.md` "Out of scope" and `plan.md` all cite **93** `/admin/*` rows, each `scope:
out:system-browser`. I verified the ledger has exactly 93 such rows, all `out:system-browser` — the spec is correct
against its cited source (the ledger). The *program plan* (`docs/programs/native-app/NATIVE-APP-PLAN.md` §2 decision 3)
says "Admin (96 consoles)". The discrepancy is in the program plan, not this spec, and the spec correctly sources the
count from the ledger. No change required; flagging only so a reader who opens the program plan is not confused.
Fix (optional): add a half-sentence in `design.md` §2 — "(the program plan's '96 consoles' predates the current
ledger; the ledger has 93 `/admin/*` rows)".

### NIT-2 — "Web sources under `src/pages/` commerce screens" is less precise than the other lanes
`requirements.md` R0.5 and `lanes/business.md` describe the business web sources as "under `src/pages/` commerce
screens", whereas patient/professional/staff name an exact folder (`src/pages/patient/*` etc.). Commerce screens are
not all under a single `src/pages/commerce/` folder (commerce pages are spread across `src/pages/Commerce*.tsx` and
related files per the repo's Commerce UX contract), so the vaguer phrasing is arguably accurate — but it is less
checkable than the other three lanes. This does not block the port: the authoritative scope is the 11 enumerated
ledger rows + the enumerated native route-file plan in `design.md` §1, both of which are exact. Fix (optional):
replace "under `src/pages/` commerce screens" with "the commerce screens behind the 11 enumerated `/commerce*` routes
in `App.tsx`" to match the precision of the other lanes.

### NIT-3 — Device-runtime task is numbered 6 (patient/professional/staff) vs 7 (business) — intentional, worth a one-line note
Each lane's device-runtime G1 task is the second-to-last task, so it is task 6 in the three 7-task lanes and task 7 in
the 8-task business lane (which has the extra core-extraction task 1). `requirements.md` R5.3 refers generically to
"the deferred tasks", and the lane acceptance blocks correctly reference "task 6"/"task 7" per lane, so this is
consistent — but a reader skimming might expect a single task number. No change required.

---

## Verified Assumptions (checked read-only against `origin/main` and the program plan)

1. **Ledger totals and partition.** `apps/mobile/parity/ledger.json` version 2 has **435 rows total**; exactly **35**
   carry `"lane": "role-modes"`, **all `status: "not_started"`**; sources are **34 `role-route` + 1 `exclusion`**.
   Partition by prefix: **patient 8 + professional 8 + staff 8 + commerce 11 = 35, 0 overlap, 0 orphan** (recomputed
   with a Node script over the exported `origin/main` ledger). Matches `plan.md`, `requirements.md` R0, `handoff.md`,
   `design.md` §5 and every lane file exactly.
2. **The 8+8+8 role paths** enumerated in R0.2/R0.3/R0.4 and the lane files match the ledger exactly
   (`/patient/appointments…results`, `/professional/billing…tools`, `/staff/communications…tools`).
3. **The 11 commerce paths** enumerated in R0.5, `design.md` §1 and `lanes/business.md` match the ledger exactly,
   including the single `source: exclusion` row **`/commerce/connect/authorize`**.
4. **The exclusion row** `/commerce/connect/authorize` carries `scope: "in"`, `lane: "role-modes"` in
   `scripts/native/parity-scope.json` — confirming the spec's claim that the business lane flips only its `status`
   while `scope` stays `in`.
5. **ADMIN exclusion.** Exactly **93** `/admin/*` rows exist, **every one `scope: out:system-browser`**. The program
   plan `docs/programs/native-app/NATIVE-APP-PLAN.md` §2 decisions 3 and 7 confirm admin opens in an in-app system
   browser (SFSafariViewController / Custom Tabs), not a native port. Matches `requirements.md` "Out of scope" and
   `design.md` §2.
6. **Class-A premise — `role-switch-destination.ts`.** On `origin/main` the file imports exactly
   `import type { UserRole } from "@/hooks/useRole"` (type-only) and `import { getCommandHubUrl } from
   "@/config/devHub.config"` (pure config). `scripts/native/extraction-deps.mjs` has `isTypeOnlyImport()` that
   excludes type-only imports from the runtime graph — so the module is class A, as the spec claims, and is the one
   new core extraction (no `role-switch` entry exists yet in `packages/core/manifest.json` or `src/extracted/`).
7. **Already-extracted class-A modules.** `packages/core/src/extracted/business-mode.generated.ts` and
   `drawer-nav.generated.ts` exist; `src/lib/permissions.ts` is already re-exported in `packages/core/manifest.json`
   ("Role/tenant switch permissions from the session; pure"). Matches `requirements.md` R1.5 and `design.md` §3a.
8. **Class-B premise — data hooks.** `src/hooks/useResellerSales.ts`, `useActivateReseller.ts` and
   `usePatientAccess.ts` each `import { supabase } from "@/integrations/supabase/client"` on `origin/main` — class B,
   correctly kept out of core and re-implemented natively (R1.6, `design.md` §3b).
9. **Native twin exists.** `apps/mobile/src/identity/usePatientAccess.ts` exists on `origin/main`, confirming the
   patient lane "reuses/extends the existing twin" claim.
10. **Wave-1 substrate exists.** The resolver route `apps/mobile/app/(app)/[...path].tsx`, `src/hooks/use-mobile.tsx`
    (the `useIsMobile()` source cited in R1.1), `scripts/native/core-closure.mjs`, and the `shapeOf()` /
    `fileToRoute()` functions in `scripts/native/parity-ledger.mjs` all exist as cited.
11. **Lane assignment source.** `role-modes` is a defined lane in `scripts/native/parity-scope.json`
    ("Patient / Professional / Staff / Business modes") with a `{ "prefix": "/patient", "lane": "role-modes" }`-style
    mapping — so the ledger's `role-modes` grouping is authoritative, as the spec relies on.
12. **Structural parity with the model spec.** `plan.md` has `<!-- plan:begin -->`/`<!-- plan:end -->` wrappers
    (lines 8/133). `tasks.md` has all four `<!-- lane: {patient,professional,staff,business} -->` markers. The model
    spec `native-wave2-home-feed-news` places lane markers in `tasks.md` (not `plan.md`) identically — the role-modes
    spec matches the model's convention exactly. All six file kinds present; `lanes/<id>.md` present per lane.
13. **Disjoint native subtrees.** Each lane's `paths` owns `apps/mobile/app/(app)/<role>/**` + `src/screens/<role>/**`
    (business = `commerce`/`business`); subtrees do not overlap. The shared-by-row files (`parity/ledger.json`,
    `packages/core/**`, the i18n shard) are documented as shared-by-row/line with conflict resolution stated.
14. **Bottom-tab rule.** Patient/professional/business carry own bottom tabs; **staff has none** — stated
    consistently in `design.md` §2a, `requirements.md` R1.4, `plan.md` decision 4, `tasks.md` (staff task 1 + task 4
    "assert no bottom tab bar") and each lane acceptance block.
15. **Class split ownership.** Only the business lane adds the one new class-A core entry
    (`role-switch-destination.ts`) and runs `core-closure.mjs --write` + commits the regenerated
    `closure.generated.json` and `mobile-ci-paths.generated.json` in the same PR (tasks.md business task 1, plan
    decision 3, design §3a/§4.3). The other three lanes add no core entry — their lane files state "this lane adds no
    new core entry".
16. **handoff.md front matter.** `author: kiro`, `executor: kiro`, `next_actor: kiro`, `author_seat: exafyltd`,
    `state: drafted`, `spar_refs: - exafyltd/vitana-v1: main`, `sparring_record` present, **no `vtids:` key**.
    Matches every requirement in the review brief. The only `VTID-` strings anywhere in the spec are citations of
    already-allocated program/Wave-1 VTIDs (05021, 05186, 05176, 05183), not new allocations — correct.
17. **Constraints.** class-A-only extraction, fixture/fake-gateway tests only, device-runtime deferred to G1
    (`next_actor: owner`), DE-first i18n across all 11 locales (de en es sr fr pl pt ru tr zh ar) with **pt = você
    (not teu/tua), fr = tu (not vous), ru = ты (not вы), ar = RTL**, no new routes, no web change beyond a DE-first
    i18n key and the one class-A re-export line — all present and correct in `requirements.md` R2/R5, `plan.md` test
    plan, `design.md` §6 and the lane acceptance blocks.
18. **File integrity.** All nine spec files are real, readable, non-empty, non-reparse-point regular files (the
    re-authoring note explains the earlier reparse-point stub loss; the current files are clean).

## Unverified / Wrong Assumptions

None. Every load-bearing premise the spec asserts about the ledger, the parity-scope config, the class-A/class-B
import graph, the already-extracted core modules, the native twin, the Wave-1 substrate and the program-plan admin
decision was verified true against `origin/main`. The only discrepancy found (NIT-1) is an inconsistency inside the
*program plan* (96 vs 93 consoles), not an error in this spec, which correctly cites the ledger's 93.
