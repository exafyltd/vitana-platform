---
slug: native-wave2-public-auth-onboarding
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-10-21T18:06Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Public / Auth / Onboarding / Legal screen ports
Wave 2 public/auth/onboarding/legal screen-port batch of the native Maxina app program
(`docs/programs/native-app/NATIVE-APP-PLAN.md`, program VTID-05021; Wave 2 lane list in §5). Sibling of the first
Wave 2 batch `native-wave2-home-feed-news`; reuses the link + auth plumbing the `native-g1-wiring` lane (VTID-05178)
and N3 (VTID-05186) already built. Plan block: `plan.md`. Lanes: `lanes/*.md` (3, all `ready`, executor kiro, seat
exafyltd → reviewer_seat hotmail, disjoint `paths`, no `vtid` yet). Ports the 20 web destinations the parity ledger
assigns to `"lane": "public-auth"` to native at 1:1 mobile-web parity (the `PublicAppShell` branch) on
`@vitana/core` + `@vitana/tokens` + `@vitana/ui` + the N3 shell; sign-in is the one allowed auth write, everything
else read/fixture only; fixture / fake-gateway tests only, device-runtime and the real OAuth browser round-trip
deferred to G1 (`next_actor: owner`). No web screen, `App.tsx` route or registry/manifest change — only native route
files and parity-row status flips.
## Log
### 2026-10-21T18:06Z · kiro-planner · created → drafted
Holder of the `native-wave2-public-auth-onboarding/_plan` claim (planner). Measured on the worktree (= origin/main):
`apps/mobile/parity/ledger.json` version 2 has **20 rows with `"lane": "public-auth"`** (5 `registry` screen rows +
15 `exclusion` route rows; 435 rows total) — **2 `exception`** (`/download`, `/maxina/app`, kept as web pages), **5
`in_progress`** (`AUTH.MAXINA_PORTAL`, `AUTH.ALKALMA_PORTAL`, `/oauth/complete`, `/reset-password`, `/logout` — N3
landed their functional core), **13 `not_started`** — counted with `node -e` over the committed ledger (the `--report`
CLI needs `typescript`, not installed here). Verified the web source pages exist with the line counts cited in
`plan.md` and the `App.tsx` route lines, and that the g1-wiring/N3 link + auth plumbing
(`apps/mobile/src/linking/{resolve-link,link-router,auth-port}.ts`, `apps/mobile/src/auth/{AuthProvider,sign-in}.ts`)
already tags the four deep-link routes the brief names. Wrote requirements, design, tasks, plan and 3 lane files;
partitioned the 20 rows into `auth-portals` (10), `public-legal` (9, incl. the 2 kept-exception rows it owns) and
`onboarding` (1) with disjoint native file subtrees and ledger-rows-by-row — 0 overlap, 0 orphan. No VTID allocated,
no product code changed, no live system touched.
Next: PLAN-SPAR spars the `plan(native-wave2-public-auth-onboarding)` PR; this session answers each round in
`sparring/responses-<n>.md`. On convergence CI writes the VTIDs into the lanes and the `sparring_record` + `vtids`
into this front matter (`state: drafted → approved`); then seat `exafyltd` claims lanes in dependency order —
`auth-portals` and `public-legal` in parallel, `onboarding` after `auth-portals` is `done` (it is the sign-in →
onboarding redirect target and shares the auth session seam). Reviewer seat `hotmail` reviews each lane. Device-runtime
parity and the live OAuth browser round-trip (the last device task in each lane) wait on the owner's G1 isolated test
environment.
