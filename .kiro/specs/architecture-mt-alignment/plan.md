---
change_class: standard
---
# plan(architecture-mt-alignment): verify the 41-module Vitanaland architecture map against the code, and record how every workstream must consume the ongoing Multi-Tenant contracts (docs only, no Multi-Tenant change)
Author: Kiro, seat `exafy`, session `kiro-exafy-202611110920-270b` (Kiro Web). Repos `exafyltd/vitana-platform`, `exafyltd/vitana-v1`.
Premises pinned to `origin/main` vitana-platform `6dc6e1ba0c`, vitana-v1 `e31bf4627f`.
<!-- plan:begin -->
Pins: vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`, vitana-v1 `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`, strategy
repository GitLab `vitana/vitanaland-strategy` branch `kiro/phase-three-strategy` at `e5dd629d77a8e1032148e3c28688613924b6bd9c`. A
lane that starts on newer heads re-verifies its citations there and records all three SHAs in `commands.log`.

## 1. Goal
Owner, 2026-11-11 ("Execution Directive Update", §5): *"Start architecture and Multi-Tenant alignment in parallel. Do
not restart Multi-Tenant. Do not modify existing Multi-Tenant migrations, provisioning, identity, RLS, membership, flags
or acceptance criteria without the required approval. The existing 41-module architecture map is the baseline.
Validate it against the actual source code and update it where evidence requires."* Earlier (Consolidated Directive,
Track B): *"No duplicate tenant resolver, identity model, membership model or authorisation system."*

Not authorised: any code, schema, migration, flag, RLS, tenant, membership, provisioning or acceptance-criteria change;
any new store, resolver or ledger.

## 2. Today (evidence)
- The baseline is the strategy repository's `02-PLATFORM/module-ownership.json` (41 modules, `MOD-CORE` first; fields
  `id`, `name`, `workstream`, `layer`, `status`, `status_run_ids`, `repositories`, `paths`, `tenant_awareness`,
  `deployment_boundary`, …) and `02-PLATFORM/integrated-architecture-map.md` (1059 lines), both at `e5dd629`. They were
  written from the pins above; no check has yet compared every module's `paths` and claims with the code.
- Multi-Tenant is in flight: programme `docs/programs/multi-tenant/program.md` (16 specs, e.g. `mt-identity-r2`,
  `mt-track-s-authz`, `mt-guardrails-r2`, `mt-packs-r2`, `mt-frontend-brand-r3`), plan `docs/MULTI-TENANT-PLAN.md`,
  migration queue `docs/multitenancy/MIGRATION-QUEUE.md`. The strategy records open MT lanes VTID-05221 (v1 PR #1438),
  VTID-05267..05270 and VTID-05323..05327 and M0 published 2026-10-14 (`19-EXECUTION-PROGRAMME/SESSION-HANDOVER.md` §6).
- Wave 1 (plan `strategy-execution-wave1`, open plan PR #4943 at `366850e45102ce7c7c7f5f12609e74bc2e19cdfc`, VTIDs allocated by
  PLAN-SPAR on that PR, not on `main`) covers destination identity (VTID-05689, PR #4944, branch
  `kiro/strategy-execution-wave1/destination-identity` at `b8f4cb7f5f`) and Healthy Million readiness (VTID-05690, PR #4950,
  branch `kiro/strategy-execution-wave1/hm-readiness` at `4502288c18`), owned by session `kiro-exafy-202611110004-e38b`.
  This plan does not repeat them; `mt-alignment` cites those branch SHAs and marks the wave-1 findings "draft, not merged".
- The 18 workstreams are the strategy registry's (`19-EXECUTION-PROGRAMME/master-task-registry.json` `workstreams`, at
  `e5dd629`): WS01 Strategy Repository and Governance, WS02 Integrated Architecture and Modularisation, WS03 Multi-Tenant,
  WS04 Vitana AI and Conversation Intelligence, WS05 Memory and Personal Context, WS06 Vitanaland Knowledge Graph, WS07
  Five Foundational Health Pillars, WS08 Native Mobile Applications, WS09 Website Factory and Skeleton, WS10 Online
  Presence and Destination Websites, WS11 B2B Commerce Portal, WS12 Exafy Back Office, WS13 Marketing Studio and
  Marketing Automation, WS14 Command Hub Modernisation, WS15 Healthy Million Complete Tenant Replication, WS16 AI-Powered
  Tenant/Destination Builder, WS17 Autonomous Operations and Continuous Improvement, WS18 System Integration, Validation
  and Launch. They are not the Multi-Tenant plan's own work streams (`docs/MULTI-TENANT-PLAN.md`: WS-S and WS0–WS11),
  which `mt-alignment` maps onto WS03 as a separate column.

## 3. Interfaces between lanes
Both lanes write Markdown under `docs/programs/strategy-execution/` plus `docs/validation/<VTID>/`, read code only, and
cite with `file:line` at the pins. `arch-map-verify` produces the per-module verdicts; `mt-alignment` produces the
per-workstream tenant contract table and cites module ids from the strategy map (not from the other lane's draft), so the
lanes do not wait on each other. Changes to the strategy repository itself (map corrections) are made afterwards by the
strategy owner session on GitLab from the lane's "corrections" list; the lanes do not write to GitLab.

## 4. Lanes
### Lane `arch-map-verify` (seat `exafyltd`, Kiro 3, pilot of a second account)
`docs/programs/strategy-execution/architecture-map-verification.md`: for each of the 41 modules, every `paths` entry
exists at the pin (or not), the entry points and interfaces the map names (routes, tables, events, services) with
`file:line`, the stated `status` class checked against evidence (a "Verified operational" keeps its run id or is
downgraded), `tenant_awareness` checked against the code, and a verdict: confirmed, corrected (with the exact correction
for the map), or Unknown. Also: modules present in the code but missing from the map (gateway route families, services,
v1 top-level areas) and dependency edges the map misses. A generated check script under `docs/validation/<VTID>/` lists
every `paths` entry and whether it exists, run in `commands.log`.

### Lane `mt-alignment` (seat `exafy`, Kiro 2)
`docs/programs/strategy-execution/multi-tenant-alignment.md`: the Multi-Tenant contracts as they exist at the pin, each
with `file:line` and status class (tenant resolution, `TenantContext`, membership and roles, authorisation, RLS
policies, provisioning, tenant-aware memory, jobs/events/registries, branding/destination identity, rollout flags); the
open MT specs and lanes with their protected paths and hot files; for each of the 18 workstreams, which contracts it must
consume, which it must not duplicate, and its conflicts with open MT lanes (file overlap, migration order, flags). Every
needed change is a "proposed follow-up" naming the MT spec that owns it; nothing is changed.

Paths, both lanes: their one Markdown file and `docs/validation/VTID-*/**`.

## 5. Parallel / hot files
Parallel; no shared file; no hot file. `arch-map-verify` runs on seat `exafyltd` to pilot a second account; if that seat
has no session within 24 h of approval, the plan driver records it and the lane may be re-seated through the lane-admin
process (collaboration.md §7a), not taken silently.

## 6. Tests and commands
Per lane: the citation check script (every `file:line` resolves at the pins) and, for `arch-map-verify`, the paths check
over all 41 modules; preflight; `node --test scripts/collab/*.test.mjs`.

## 7. Measurement
41 of 41 modules with a verdict and counts per verdict; 18 of 18 workstreams in the alignment table; number of proposed
follow-ups per owning MT spec.

## 8. Risks
- The strategy map lives in another repository: the lane reads it at `e5dd629` (`git show`), records the SHA, and does
  not copy the JSON into this repository.
- Alignment text could be read as an instruction to MT lanes: each follow-up names its owning MT spec and is only a
  proposal.

## 9. Unchanged
All code, schema, migrations, flags, RLS, tenants, MT specs and acceptance criteria, CLAUDE.md, the strategy repository.
<!-- plan:end -->
