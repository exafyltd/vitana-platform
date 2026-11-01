---
slug: native-wave2-health-biology-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T17:20Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Health / Vitana Index / Biology screen ports (+ in-screen Health Sync UI)
Wave 2 screen-port batch of the native Maxina app program (vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Picks up the "health/Vitana Index/biology + Health Sync UI" item in
`vitana-platform:.kiro/specs/health-native/handoff.md` "What Kiro does next" → Wave 2 screen ports. Plan block:
`plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail, disjoint
`paths`, no `vtid` yet). Ports the 24 web destinations the parity ledger assigns to `"lane": "health"` to native at
1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3 shell; fixture / fake-gateway tests only, device-runtime
parity deferred to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native
route files and parity-row status flips.

**Collab session (planning):** `kiro-202610151913-51bd`.

**This is plan-authoring only.** No VTID is allocated here, no product/native code is written, nothing is merged,
pushed to prod or written to any live system. A later step handles the branch, commit, push and PR. Sparring follows
the standing process: the `plan(native-wave2-health-biology-r2)` PR is sparred by CI (`PLAN-SPAR.yml`); on convergence it
is approved by policy (`converged-auto-v1`) and CI writes the VTIDs into the lanes. No `docs/validation/<VTID>/`
directory is created here — the lanes' `paths` reference `docs/validation/**` for the future executor only.

## Health Hub coordination (boundary with the `health-native` spec)
Health data is governed by the Health Hub program (`docs/programs/health-hub/HEALTH-HUB-PLAN.md`, VTID-05020). The
in-flight `health-native` spec's lane **`n5a-health-sync` (VTID-05184)** owns the native **Health Sync module**
(HealthKit + Health Connect integration, OS permission strings, ingest contract), switched off until its
C1/D10/DPIA/0T preconditions. **This cluster owns only the health SCREENS** and the **in-screen** "connect Apple
Health / Health Connect / device" affordance, which delegates to that module's public read-only-until-enabled entry
(or a typed stub behind the ingest-off flag if the module is not yet on main, logged as a dependency). The standalone
Connected Apps settings screen (`/settings/connected-apps`) and `/connectors?tab=health` are **not** here — the ledger
assigns them to `"lane": "profile-settings-support"`. Every health-data read uses the same RLS-scoped
(`user_id = auth.uid()`) path as web, respects the member's existing consent, inherits the §2 wellness boundary, and
**writes nothing to production** (reads only; no production profile; fixture tests only). See `plan.md` "Health Hub
coordination" for the full boundary.
Re-plan of `native-wave2-health-biology` (PR #4272) under a new slug; the old branch has commits without Collab trailers (and lane files with an empty `vtid:` key, which made CI PLAN-SPAR allocate 0 VTIDs). Sparring history: https://github.com/exafyltd/vitana-platform/pull/4272.
## Log
### 2026-11-01T17:20Z · kiro-exafyltd-202611011658-9f52 · created → drafted
Holder of the `native-wave2-health-biology-r2/_plan` claim. Re-plan of `native-wave2-health-biology` (PR #4272), whose branch cannot pass Collab handoff without a history rewrite. Copied the plan, tasks, requirements, design and lane files from the old PR head; lane `vtid` keys removed (CI allocates on convergence), lane `paths` widened to the shared native-infra files a screen port produces, lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-health-biology-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
