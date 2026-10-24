---
slug: mt-m3
author: kiro
author_seat: hotmail
executor: kiro
next_actor: claude
state: drafted
updated: 2026-10-19T20:31Z
---
# Handoff — mt-m3 (M3 generally provisionable; program `docs/MULTI-TENANT-PLAN.md` v5.1 §6/§7)

Planner: Kiro seat `hotmail` (session `kiro-hotmail-202610151618-b437`). Plan: `plan.md` (sparred by PLAN-SPAR on the
`plan(mt-m3)` PR; policy-approved on convergence). Requirements/design/tasks: `requirements.md`, `design.md`,
`tasks.md`. This spec covers the deferred M3 items: custom-domain plumbing, member tenant switching UI, per-tenant
monitoring, ERP auto-bootstrap, wizard polish, D2/D9-bounded price-display de-hardcoding, and the offboarding runbook
(reference only). Deactivate/archive is mt-tenant-admin (O2); Network groups are mt-network — neither re-planned here.

Lanes:
- `tenant-domains-db` — DB, seat `hotmail`, reviewer `jtadic`. `tenant_domains` + `resolve_tenant` host arm.
- `host-resolution-gw` — gateway, seat `jtadic`, reviewer `hotmail`, depends on `tenant-domains-db`.
- `tenant-switcher-ui` — vitana-v1 frontend, seat `exafyltd`, reviewer `hotmail`. Member community switcher (D8).
- `native-domains-aasa` — vitana-v1 native, seat `exafy`, reviewer `exafyltd`. AASA/assetlinks custom-domain readiness.
- `provision-erp-monitoring-db` — DB, seat `hotmail`, reviewer `jtadic`. ERP bootstrap request + per-tenant health.
- `monitoring-erp-gw` — gateway, seat `jtadic`, reviewer `hotmail`, depends on `provision-erp-monitoring-db`.
- `morning-health-pertenant` — governance (`.github/**`), executor `claude`, reviewer `jtadic`, depends on
  `provision-erp-monitoring-db`.
- `wizard-price-polish` — vitana-v1 frontend, seat `exafyltd`, reviewer `hotmail`, depends on `tenant-domains-db`.

Migration range 20261101140000–145959 (free today). All lanes held (`next_actor: owner`) until PLAN-SPAR allocates the
VTIDs and flips them to `kiro`; `morning-health-pertenant` is `next_actor: claude` (governance).

## Log
### 2026-10-15T16:40Z · kiro-hotmail-202610151618-b437 · created → drafted
Planned mt-m3 from `docs/MULTI-TENANT-PLAN.md` v5.1 §6/§7 against platform/v1 `origin/main`. Verified premises:
no `tenant_domains` table and no host arm in the gateway (JWT-claim resolution only); no member switching UI (only the
exafy-admin `TenantManagement` switch); single AASA appID `62Q26QSEJW.com.exafy.maxina` `paths:["*"]`;
`provision_tenant` records no ERP request; `ci_tenant_isolation_health()` is global + report-only in MORNING. Cross-spec
rulings applied: O2 (deactivate/archive referenced only, owned by mt-tenant-admin); Network groups excluded (mt-network).
Next: PLAN-SPAR spars the plan; on convergence the VTIDs are allocated and the lanes flip to `kiro` (except the
governance lane → `claude`).

### 2026-10-15T16:52Z · kiro-hotmail-202610151618-b437 · internal-review fixes (still drafted)
Internal adversarial review verdict REJECTED on one MEDIUM + two LOW. All three fixed and re-verified against
`origin/main`:
- **F1 (MEDIUM) — host-arm security/correctness gating.** `_tenant_public_registry()` filters
  `t.is_active AND is_platform = false` (`20261014000600_vtid_05151_public_tenant_registry.sql:74-77`) and
  `resolve_tenant(p_slug)` selects through it. The host arm now states, in `requirements.md` R1.2/R1.3, `design.md`
  (tenant-domains-db D2 + Rule 4), `plan.md` Fix #1/Tests, and `tasks.md` D2/D3, that the host arm resolves a host ONLY
  when its `tenant_domains` row has `verified_at IS NOT NULL` AND resolves it THROUGH `_tenant_public_registry()`, so an
  unverified/inactive/platform host resolves empty and falls through to slug (the membership check gates data, not which
  tenant the context is set to). pgTAP now pins: unverified host and host on an inactive/platform tenant both resolve
  empty.
- **F2 (LOW) — switcher membership source.** `design.md` tenant-switcher-ui, `plan.md` Fix #3 and `tasks.md` S1 now say
  the switcher lists the member's own memberships from `useMemberships()` (`list_my_memberships`,
  `vitana-v1/src/hooks/useMemberships.ts`) and uses the public registry only to resolve slug/brand for display.
- **F3 (LOW) — pin no `tenant_domains` column leaks.** `design.md` Rule 4 + D2, `requirements.md` R1.2 and `tasks.md` D2
  now state the host arm MUST NOT add any `tenant_domains` column (host/verified_at/is_primary) to the returned set; the
  Lane C 8-column whitelist stays pinned by the existing harness case.
Lane set, paths and front matter unchanged; validators re-run clean. INTERNAL-REVIEW.json deleted. Re-pushed
`kiro/mt-m3/plan`.

### 2026-10-17T11:45Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (code_access_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T15:33Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:44Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T18:47Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T19:36Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-17T20:10Z · kiro-hotmail-202610151618-b437 · answered round-1 (still drafted)
Sparring round-1 came back `in_progress` with 4 findings (2 major, 2 minor); all ACCEPTED and fixed after re-verifying
each premise against `origin/main` and the concurrent plan branches (`responses-1.md`):
- **R1-F1 (major)** mt-tenant-admin is a concurrent, unmerged sibling plan branch (`kiro/mt-tenant-admin/plan`), not a
  merged artifact. Problem #7 + Depends-on reframed: runbook references the O2 RPCs by signature only, degrades to a TODO.
- **R1-F2 (major)** live MIGRATION-QUEUE ends at row 8 with no mt-tenant-admin/0701xx rows. ## Migrations + tasks.md D4
  now append after the live last row with an mt-m3 range note; mt-m3's `1101140000+` range sorts after any `070xxx`.
- **R1-F3 (minor)** `host-resolution-gw` now extends the `TenantSource` union with `'host'` and audits the consumers at
  `auth-supabase-jwt.ts:35,579,607,617` (plan Fix #2, tasks H1, lane body).
- **R1-F4 (minor)** `provision_tenant`'s `ON CONFLICT DO NOTHING` would drop a feature_flags ERP flag on re-run; a
  guarded `jsonb_set` UPDATE after the INSERT + a both-paths pgTAP assertion added (plan Fix #5, tasks E1/E3, lane body).
Plan body trimmed back under ~15k chars; markers + change_class intact. Re-pushed `kiro/mt-m3/plan`; next round starts.

### 2026-10-18T20:20Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:25Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:33Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-18T20:46Z · ci-plan-spar · escalated (partner unavailable)
The sparring partner could not review (model_unavailable). Not a plan problem: Claude Code looks at the partner, then re-runs.

### 2026-10-19T20:31Z · kiro-hotmail-202610151618-b437 · answered round-1 of session 8a83bc72 (still drafted)
New sparring session after the throttle resume; round-1 returned 5 findings (3 major, 2 minor), all ACCEPTED
(`sparring/responses-1.md`):
- **R1-F1** `monitoring-erp-gw` descoped to display-only (erp-bridge is execute-only); `backoffice/**` path removed.
- **R1-F2** host arm hot-path budget: platform-host skip, flag gate, 60s bounded cache, `abortAfter` (task H1b).
- **R1-F3** `resolve_tenant(p_host, p_slug)` is a separate no-DEFAULT overload; 1-arg slug function untouched + pinned.
- **R1-F4** `erp` made a governed key in `tenant_settings_merge_feature_flags()` (tasks E1/E3).
- **R1-F5** v1 citations re-verified at `32a82e6b`; line numbers corrected (`useTenant.tsx:170/190/208` etc.).
