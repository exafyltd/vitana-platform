---
slug: health-native
author: claude
executor: kiro
next_actor: kiro
state: executing
vtids: [VTID-05020, VTID-05021, VTID-05090, VTID-05091, VTID-05092, VTID-05093, VTID-05094, VTID-05159, VTID-05160, VTID-05162, VTID-05163, VTID-05164, VTID-05165, VTID-05166, VTID-05175, VTID-05180, VTID-05184]
sparring_record: docs/validation/VTID-05020/plan-sparring.md
updated: 2026-10-15T18:59Z
---
# Handoff — Health Hub (health data integration) + native iOS/Android app

Handover (2026-10-15T18:59Z) from Claude Code session `session_01VuZPi9pvHaUverAXRC1WvU` to Kiro (owner request 2026-10-15: "write
handover for kiro to pick up from here and continue developing the full plan for native apps and health data
integration and everything else in the original plan").

## The two programs (approved plans — read these first)

| Program | Umbrella VTID | Plan | Sparring record | Live status table |
|---|---|---|---|---|
| Health Hub (health data integration: Apple Health, Health Connect, cloud wearables, AI, labs) | VTID-05020 | `docs/programs/health-hub/HEALTH-HUB-PLAN.md` | `docs/validation/VTID-05020/plan-sparring.md` | `docs/programs/health-hub/STATUS.md` |
| Native Maxina app (Expo / React Native, `apps/mobile/` in vitana-v1, replaces the Appilix wrapper) | VTID-05021 | vitana-v1 `docs/programs/native-app/NATIVE-APP-PLAN.md` | vitana-v1 `docs/validation/VTID-05021/plan-sparring.md` | same STATUS.md |

Owner Gate 1 for both: 2026-10-10. Every work package is its own sparred plan + VTID before code (still true — for
new packages use a `plan(<slug>): …` PR so PLAN-SPAR spars it, §7 of `.claude/rules/collaboration.md`).

## Where things stand (2026-10-15)

### Done and merged to main
- **Health Hub Phase 0** (live-defect fixes): D12 (VTID-05025), D1 (05030), D2 (05031), D3–D5/D7/D8
  (05032, 05053–05056), D6a dark bridge (05089), fix-ups 05155/05156, D4–D5 remainder 05173 (app) + 05174 (gateway).
- **Health Hub Phase 1**: A1 health store schema, Aurora only (VTID-05158, #4102); B1 `health_sources` (VTID-05161, #4104).
- **Native Wave 1 + 1b** — the whole stack is on vitana-v1 main:
  N1 `@vitana/core` + `@vitana/tokens` (05183, #1396), N2 UI kit (05176, #1395), N3 shell + i18n keys
  (05186, #1397 + #1400), N4-APP push/links/remote config (05178, #1390), N4-GW `/app-config` + native push routing,
  switched off (05177, platform #4113 + #4117), N5b Health Sync i18n (05185, #1391), N6a ORB protocol client
  (05179, #1393), N6c Android voice module (05181, #1394), N6d ORB overlay/FAB/bench + the N6b iOS sources (05182, #1401).

### In flight — open draft PRs (all mine, all up to date with their base on 2026-10-14)
See the lanes below. Every gateway PR is green except `drift`, which is red **only** because its migration is not
applied yet. Every vitana-v1 PR is green and conflict-free.

| Lane | PRs | Blocked on |
|---|---|---|
| `d9-partner-dpa` | platform #4057 (VTID-05090), v1 #1342 (05091) | owner applies `20261012200000_vtid_05090_partner_dpa.sql` |
| `d10-consents` | platform #4100 (05092), v1 #1377 (05093), v1 #1383 C3 (05166, stacked on #1377) | owner applies `20261012180000_vtid_05092_health_consent_categories.sql`; C3 also needs counsel wording |
| `phase1-data-core` | platform #4105 A2 (05159), #4109 B2 (05162), #4111 B3 (05163, stacked on #4109), #4107 C1 (05164), #4110 C2 (05165, stacked on #4107) | `d10-consents` migration (they carry it / depend on it), then merge order A2 → C1 → B2 → B3 → C2 |
| `a3-erase-raw` | v1 #1380 (05160) | A2 merged |
| `v1-d5r` | v1 #1388 (05175) | VTID-05174 live in production + `CONNECTOR_WEBHOOK_LOG_PURGE_ENABLED=true` in prod |
| `n5a-health-sync` | v1 #1398 (05184) | C1 merged; then re-vendor the contract from C1's merge commit and switch the N3/N4 stubs to the real modules |
| `n6b-ios-voice` | v1 #1392 (05180) | a macOS build (Xcode) — the code itself is already on main via #1401 |

### Waiting on the owner (Kiro cannot do these — §7a)
1. Gateway production deploy of `0b875e982` — STAGING-VERIFY passed 116/116 (run 38501720649); Gate 2 sent 2026-10-14 ~03:05.
2. Apply the two migrations above (RUN-MIGRATION.yml).
3. Yes/no on authenticated Docker pulls in CI (public.ecr.aws 429 "Data limit exceeded" keeps killing pr-gate's
   `Initialize containers`; one re-run per commit fixes it).
4. Program gates: G1/0T isolated test environment (Aurora test cluster + test Supabase project), G2 push/Firebase
   project, G3 App Store Connect / Play Console / signing key access, 0L legal (DPIA, DPO, counsel, DPAs).
5. Community-app (frontend) Gate 2 waits on another session's Spotlight fix (vitana-v1 #1399): STAGING-VERIFY for
   community-app fails only on VTID-05111/05114/05116/05117 suites; all native suites pass.

## What Kiro does next (in this order)

1. **Pick up lanes from this spec** (`lanes/*.md`, `next_actor: kiro`). Rules: §4–§7a of the collaboration file.
   Never allocate VTIDs, merge, deploy, run migrations or write to Supabase/AWS. Blocked → lane log + `next_actor: claude`.
2. **Write the next plans** (each = `plan(<slug>)` PR with `plan.md`, `handoff.md`, lanes; PLAN-SPAR spars it; VTIDs
   come from CI). The backlog, in priority order:

   **Native app (Wave 1 exit → Wave 2 → Wave 3)**
   - `native-g1-wiring` — point dev/QA builds at the G1 test backend once it exists (env profiles, EAS profiles);
     until then, fake-gateway / fixture tests only. Wave 1 exit: signed-in G1 member navigates the full shell, gets a
     push and opens its deep link on both platforms.
   - `native-eas-builds` — EAS (or macOS runner) build + TestFlight / Play internal track pipeline (needs G3).
   - Wave 2 screen ports, one plan each (plan §5 "Waves", lane list): home/feed/news · inbox/chat/calls ·
     journey/guided/autopilot · health/Vitana Index/biology + Health Sync UI · events/calendar/reminders/live rooms ·
     media hub/shorts · discover/commerce/cart/orders · wallet (iOS payment gates, owner decision 4) ·
     profile/settings/support/connectors · memory/diary · AI pages · sharing/business hub ·
     patient/professional/staff/business modes · public/auth/onboarding/legal.
     Each port updates `apps/mobile/parity/ledger.json` (`node scripts/native/parity-ledger.mjs --sync`), uses
     `@vitana/core` only for web code, 11 locales + RTL, and adds read-only `docs/validation/<VTID>/staging-tests.json`.
   - Wave 3: beta + store review (HealthKit, Health Connect declaration, privacy labels, IAP), phased rollout,
     Appilix removal.

   **Health Hub (rest of Phase 1, then 2–5)**
   - After the in-flight lanes merge: B3 cutover switch on staging (dual-compute report review), D10 WP3
     enforcement (lane `d10-wp3-enforcement`), C3 counsel wording, Health Sync ingest flag preconditions
     (`HEALTH_SYNC_INGEST_ENABLED`: A/B tables live, D10 WP3 in prod, DPIA, 0T, a native build).
   - Phase 2: one EU cloud aggregator + scheduler/webhooks + real Connected Apps screen; D6b poll scheduler
     (outline in STATUS.md "Deferred follow-ups").
   - Phase 4: AI recommendations on the C2 wellness-context module (engine, guard + per-locale golden tests,
     feedback loop, explanations; Bedrock only; user locale via `llm-locale.ts`).
   - Phase 5: labs & providers (FHIR lab adapter, upload parser with member confirm, grants, provider view, access history).
   - Deferred follow-ups table in STATUS.md (lab-report RPC consent check, `social_connections` token sealing,
     dedicated key + rotation, buckets on erasure, data export job, inert privacy switches, fake non-health cards).

3. **Keep STATUS.md current** in the same PR as each change.

## Hard rules that bit this program (do not relearn them)
- Never test against production; staging specs are read-only; the staging frontend uses the production Supabase.
- Native code reaches web code only through `@vitana/core` (`packages/core/manifest.json` + `core-closure.mjs --write`).
- React 19 types: no global `JSX` namespace — use `ReactElement`.
- vitana-v1 i18n stamp conflicts after every main move: resolve stamps by key (main's stamps + the PR's new keys),
  take main's `docs/SCREEN_INVENTORY.md` and regenerate with `npm run i18n:inventory`; JSON shards merge by key.
- Stacked PRs (#4110→C1, #4111→B2, #1383→D10 WP2) merge their **base branch**, not main, to clear conflicts.
- Jest suites that log heavily overflow the STAGING-VERIFY runner (spawnSync 1 MB): silence console in `beforeEach`
  (the global setup restores mocks after every test).
- Partial `jest.mock` of `wearable-features-bridge` needs `...jest.requireActual(...)` (module constants are read at import).
- Duplicate migration timestamp prefixes exist on main (78); accepted by the tooling.

## Log
### 2026-10-15T18:59Z · session_01VuZPi9pvHaUverAXRC1WvU · (backfill) → executing
Spec created as the handover to Kiro. In-flight PRs mapped to lanes; new work listed above as plans to write.
Claude keeps: Gate 2 messages, merges (until the Project Manager runs), governance paths, owner-blocked items.
