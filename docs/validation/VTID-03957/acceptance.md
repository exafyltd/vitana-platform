# VTID-03957 — Commerce Partner Onboarding Phase A: apply migration + merge PR #3331 + PR #1088

## Summary

Phase A of the Commerce Partner Onboarding plan (see the platform owner's
approved plan in this session): unblock Phases 1-4 of the feature — built
in two open PRs but neither merged, and the underlying migration unapplied
to the live Supabase project, so none of the built code was reachable.
This VTID is governance/ops only — no new application code, no new tests.

## Acceptance criteria

AC-1 Migration applied to live Supabase, confirmed via pre/post schema check.

TEST: direct Supabase read (`to_regclass` + `information_schema.columns`)
against project `inmkhvwdcuyhnxkgfvsb`.

Pre-migration:

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

Post-migration:

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

Full output in `outputs/pre-migration-check.json` and
`outputs/post-migration-check.json`.

AC-2 `vitana-platform` PR #3331 merged to `main`.

TEST: `mcp__github__pull_request_read` (method `get`) on
`exafyltd/vitana-platform#3331` reports `merged: true`,
`merge_commit_sha: 4a61b039b4268a1208af9bbd2a5c852f943dec7b`. CI was green
on every check except `drift` (fails by design pre-migration); re-ran
`drift` after the migration landed and it passed.

AC-3 `vitana-v1` PR #1088 merged to `main`.

TEST: `mcp__github__pull_request_read` (method `get`) on
`exafyltd/vitana-v1#1088` reports `merged: true`,
`merge_commit_sha: f545bf5b37ec656d69ecf35db355cd49e58ba2c5`. Four workflow
runs initially came back `action_required` instead of executing (a known
i18n-propagate-bot auto-commit quirk on this branch); re-ran all four,
all passed, `mergeable_state: clean` before merge.

AC-4 Staging gateway route exists and enforces auth post-merge.

CURL:
```
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
    https://preview-aws-gateway.vitanaland.com/api/v1/partner-orgs/mine
```
Result: `401 application/json; charset=utf-8` — route exists (not a
`text/html` 404), requires auth, per `vitana-platform` CLAUDE.md §15's
diagnostic. Full output in `outputs/staging-curl-verification.txt`.

AC-5 Staging frontend SPA shell serves the new build post-merge.

CURL:
```
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" \
    https://preview-aws.vitanaland.com/commerce
```
Result: `200 text/html`. Full output in
`outputs/staging-curl-verification.txt`.

## Non-goals

No application code changes. Phases B (the `partner_registry` bridge) and
C (mobile wiring) are separate, later VTIDs — not part of this one.

## OASIS

VTID-03957 allocated via `POST /api/v1/vtid/allocate` (gateway API,
reachable this session), `status='in_progress'`/`spec_status='approved'`
set directly per the owner's in-conversation go-ahead (CLAUDE.md §4.1).
No new OASIS event types — no application code changed.

## Production

Not touched. Both merges land on `main`, which auto-deploys to staging
only per the staging-first protocol (`vitana-platform` CLAUDE.md §15/§16);
no PUBLISH or manual `workflow_dispatch` to an `AWS-PROD-DEPLOY-*.yml`
workflow was performed or implied by this VTID.
