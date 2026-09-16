# VTID-03957 — Commerce Partner Onboarding Phase A: apply migration + merge PR #3331 + PR #1088

## Summary

Phase A of the Commerce Partner Onboarding plan (see the platform owner's
approved plan in this session): unblock Phases 1-4 of the feature — built
in two open PRs but neither merged, and the underlying migration unapplied
to the live Supabase project, so none of the built code was reachable.
This VTID is governance/ops only — no new application code, no new tests.

## AC-1 — Migration applied to live Supabase

`supabase/migrations/20260915120000_vtid_03932_partner_organizations.sql`
applied via the Supabase MCP `apply_migration` against project
`inmkhvwdcuyhnxkgfvsb`. Additive-only (`CREATE TABLE IF NOT EXISTS`/
`ADD COLUMN IF NOT EXISTS`), safe against the confirmed-absent prior state.

**Pre-migration check** (`to_regclass` + `information_schema.columns`):

```json
{
  "partner_organizations": null,
  "partner_organization_members": null,
  "partner_organization_invites": null,
  "patient_profiles": null,
  "partner_registry_link_col": null,
  "assigned_professional_col": null
}
```

**Post-migration check** (same query):

```json
{
  "partner_organizations": "partner_organizations",
  "partner_organization_members": "partner_organization_members",
  "partner_organization_invites": "partner_organization_invites",
  "patient_profiles": "patient_profiles",
  "partner_registry_link_col": "partner_organization_id",
  "assigned_professional_col": "assigned_professional_user_id",
  "trigger_installed": "trg_partner_health_test_orders_activate_patient"
}
```

All 4 new tables, both new columns, and the `AFTER INSERT` patient-activation
trigger are confirmed live.

## AC-2 — `vitana-platform` PR #3331 merged

PR: `exafyltd/vitana-platform#3331` — "Commerce Partner Onboarding (Phase 1):
self-service partner_organizations + org-scoped roster + patient activation
(VTID-03932)".

- CI: every check green except `drift` (fails by design pre-migration,
  confirmed on the original run); re-ran `drift` after the migration
  landed — passed.
- Marked ready for review (was draft), merged via squash.
- **Merge commit: `4a61b039b4268a1208af9bbd2a5c852f943dec7b`.**

## AC-3 — `vitana-v1` PR #1088 merged

PR: `exafyltd/vitana-v1#1088` — "Commerce Partner Onboarding, Phases
2+3+4: org registration/roster + patient results + professional orders
view (VTID-03936/VTID-03941/VTID-03951)".

- Marked ready for review (was draft). Initial CI check runs on the head
  commit came back `action_required` rather than executing (i18n check,
  UNIT-TESTS, I18N-PROPAGATE, Preview Deploy Frontend) — a known quirk on
  this branch with the i18n-propagate bot's auto-commits. Re-ran all 4;
  all passed on re-run (Vitest jsdom, i18n, plan, preview-deploy all
  green; fanout/collect/pivot correctly skipped as no-ops).
- `mergeable_state: clean`, merged via squash.
- **Merge commit: `f545bf5b37ec656d69ecf35db355cd49e58ba2c5`.**

## AC-4 — Staging verified live

Both checks run directly against the live staging hosts, post-merge:

```
$ curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
    https://preview-aws-gateway.vitanaland.com/api/v1/partner-orgs/mine
401 application/json; charset=utf-8

$ curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
    https://preview-aws.vitanaland.com/commerce
200 text/html
```

`401 application/json` on the gateway route confirms the route exists and
enforces auth (not a `text/html` 404 — see `vitana-platform` CLAUDE.md §15's
diagnostic). `200 text/html` on `/commerce` confirms the frontend SPA shell
is serving from the newly merged build.

**Production was not touched.** Both merges land on `main`, which
auto-deploys to staging only per the staging-first protocol
(`vitana-platform` CLAUDE.md §15/§16); no PUBLISH or manual
`workflow_dispatch` to a `AWS-PROD-DEPLOY-*.yml` workflow was performed or
implied by this VTID.

## Non-goals

No application code changes. Phases B (the `partner_registry` bridge) and
C (mobile wiring) are separate, later VTIDs — not part of this one.

## OASIS

VTID-03957 allocated via `POST /api/v1/vtid/allocate` (gateway API,
reachable this session), `status='in_progress'`/`spec_status='approved'`
set directly per the owner's in-conversation go-ahead (CLAUDE.md §4.1).
