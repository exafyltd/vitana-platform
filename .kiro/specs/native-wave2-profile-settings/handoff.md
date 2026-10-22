---
slug: native-wave2-profile-settings
author: kiro
executor: kiro
next_actor: claude
state: drafted
author_seat: exafyltd
updated: 2026-10-21T17:59Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Profile / Settings / Support / Connectors screen ports
Wave 2 screen-port batch of the Maxina native app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the 37 web destinations the parity ledger assigns to
`"lane": "profile-settings-support"` to native at 1:1 mobile-web parity on `@vitana/core` + `@vitana/ui` + the N3
shell; fixture / fake-gateway tests only, device-runtime parity deferred to G1 (`next_actor: owner`). No web screen,
`App.tsx` route or registry/manifest change — and no `@vitana/core` extraction (the cluster's hooks are class-B data
hooks, re-implemented natively) — only native route files and parity-row status flips.
Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat exafyltd → reviewer_seat hotmail,
disjoint `paths`, no `vtid` yet).
## Log
### 2026-10-21T17:59Z · kiro-202610211759-c58e · drafted
Holder of the `native-wave2-profile-settings/_plan` claim (planner). Measured on the worktree (= origin/main):
`apps/mobile/parity/ledger.json` version 2 has **37 rows with `"lane": "profile-settings-support"`, every one
`not_started`** (35 registry `screen`, 2 `exclusion` `route`; 435 rows total), counted with `node -e` over the
committed ledger (the `--report` CLI needs `typescript`, not installed here). Verified the web source pages
(`EditProfilePage` 739, `PublicProfilePage` 413, `PrivacySettings` 301, `MobileSettings` 603 with `VALID_SECTIONS`
`:39-44`, `Limitations` 491, `TenantRole` 388, `DeleteAccount`, `MobileSupport` 819 with `normalizeTab` `:43-98`,
`ConnectedApps` 2111 with `activeTab` `:105`) and the `src/App.tsx` route lines exist, and confirmed the one
load-bearing fact that `MobileSettings`/`MobileSupport`/`ConnectedApps` are single `?param=` screens so their many
`?mode=`/`?tab=`/`?section=` rows share one route file each (`shapeOf` drops the query, `parity-ledger.mjs:60`).
Wrote requirements, design, tasks, plan and 3 lane files; partitioned the 37 rows into **`profile` (5), `settings`
(18), `support-connectors` (14)** with disjoint native file subtrees and ledger-rows-by-row — 0 overlap, 0 orphan,
37 rows → 12 native route files. The one shared directory `apps/mobile/app/(app)/settings/` is split by explicit
file names between `settings` and `support-connectors` (design §1a) so no file is in two lanes. All three lanes are
independent (no `depends_on`) and run in parallel.
Decided, as planner: (1) three disjoint lanes by cluster; (2) **no `@vitana/core` extraction** — the cluster's data
hooks are class-B (they runtime-import the web Supabase client) and would fail `core-closure --check`, so they are
re-implemented natively per the Wave-1 pattern, and a class-B module is never moved into core; (3) member-facing
support only — admin partner-connections (`requiredRole="admin"`, no ledger row) and Commerce connector docs are out
of scope; (4) no new routes/registry/manifest, only status flips; (5) **this is an all-WRITE cluster** (profile
edits, settings toggles, support submissions, connector connect/disconnect, account deletion), so standing rule
31/31b makes verification **fixture / fake-gateway unit tests only** (a save asserts the built request against a
mocked gateway and fires nothing) and device-runtime parity is deferred to G1 as `next_actor: owner`, to run only on
the isolated test environment, never a live backend as the test account. No VTID allocated, no product code changed,
no live system touched.
Next: **PLAN-SPAR** spars the `plan(native-wave2-profile-settings)` PR; on convergence the policy `converged-auto-v1`
approves it and CI writes the VTIDs into the lanes. Then seat `exafyltd` claims the three lanes (all parallel, no
deps) — reviewer seat `hotmail` reviews each. Device-runtime parity (the last G1 task in each lane) waits on the
owner's G1 isolated test environment.
