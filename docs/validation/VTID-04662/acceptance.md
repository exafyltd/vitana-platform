# VTID-04662 — Service Health Phase 1: register the health routes that already existed

VTID: VTID-04662
VALIDATION_PROFILE: gateway_backend

## Change
18 health routes existed in the gateway but were never on the Command Hub panel. They are now
registered (55 → 73 checks), with three new groups: Self-Healing & Ops, Data & Memory, Commerce.

| Group | Checks |
|---|---|
| AI & Assistant | Nova Sonic, LLM Providers, Voice Tools Catalog |
| Self-Healing & Ops | Self-Healing, Watcher (admin), Worker Orchestrator |
| Data & Memory | Aurora Memory, Aurora RLS, ORB Session State, Memory Broker (all admin) |
| Automation & Scheduling | Reminders, Calendar |
| Domain & Context | Integrations, Pillar Agents |
| Commerce | Catalog Ingest, Shop Feed, Shopping Agent, Universal Cart |

Left out, with the reason:
- `orb/livekit/health` — LiveKit is not the voice path (Nova Sonic is); the route reports
  `active_provider: vertex` and an unconfigured LiveKit, so a tile would describe a retired path.
- `devhub/health` — the router is not mounted (HTML 404 on staging).
- `match-feedback /health` — same URL as Matchmaking (`/api/v1/match/health`), already registered.

Admin-gated routes answer through `GET /api/v1/admin/health/summary` (VTID-04661), which forwards
the caller's admin token; probed anonymously they show as `no_access` (grey), not down.

## Acceptance criteria
AC-1: All 18 entries are registered in their groups, the groups are in the display order, the
browser fallback matches the registry, and every URL is declared by its router file.
TEST: services/gateway/test/vtid-04662-service-health-registered-routes.test.ts

AC-2: On staging every public URL answers 200 JSON and every admin URL answers 401 JSON (route exists).
TEST: services/gateway/test/vtid-04661-service-health-panel.test.ts

OASIS_PROOF: none. Registry entries only.

## Evidence
- Pre-merge probe of the manifest against staging: 18/18 pass (`commands.log`).
