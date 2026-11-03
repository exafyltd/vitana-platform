# Project Manager GitHub App (VTID-05352, plan `pm-ci-load`)

The Project Manager (PM) makes its GitHub REST calls with an installation token from a dedicated GitHub App when
three variables are set. Otherwise it keeps using today's tokens (`GITHUB_SAFE_MERGE_TOKEN` for vitana-platform,
`FRONTEND_DEPLOY_TOKEN` for vitana-v1). Code: `services/gateway/src/services/project-manager/github-app-token.ts`,
used by `github-rest.ts` `resolvePmToken`. The PM's merges go through the gateway safe-merge path and do not change.

## Why
Today the PM, every Kiro Web session and `PLATFORM_DISPATCH_TOKEN` act as one GitHub user (`exafyltd`, id 171726573)
and share its 5,000 requests/hour. 55 vitana-v1 Lane-scope / staging-guard failures in 14 days were
`API rate limit exceeded for user ID 171726573`. An App installation has its own rate limit, its token expires after
an hour, and its commits show as `vitana-pm[bot]`, so PM activity is separable from human and Kiro activity.

## Permissions (repository permissions only)
| Permission | Access | Used for |
|---|---|---|
| Contents | Read and write | lane files on `pm-agent/<slug>` branches, refs, trees, blobs, commits, compare |
| Pull requests | Read and write | list, create, read files/commits, `update-branch` |
| Checks | Read | `commits/:sha/check-runs` |
| Variables | Read | `actions/variables/CLAUDE_AVAILABLE` |
| Metadata | Read | mandatory |
No Actions, Administration, Workflows, Secrets, Commit statuses or organization permissions; no webhook. The App is
not in any branch-protection bypass list.

## Setup (an `exafyltd` organization owner)
1. GitHub → `exafyltd` → Settings → Developer settings → GitHub Apps → New GitHub App. Name `vitana-pm`, homepage
   any Vitana URL, **Webhook: off**, the permissions above, "Only on this account". Create.
2. Install the App on `exafyltd/vitana-platform` and `exafyltd/vitana-v1` only ("Only select repositories"). Note
   the **installation id** (the number in the installation's settings URL) and the **App ID** (App settings page).
3. Generate a private key (App settings → Private keys). Store the PEM in AWS Secrets Manager (`472838866351`,
   `eu-central-1`) as `vitana/gateway/staging/pm-github-app-key`; delete the downloaded file.
4. Tell Kiro the App ID and installation id (they are not secret). A follow-up lane then wires
   `PM_GITHUB_APP_ID`, `PM_GITHUB_APP_INSTALLATION_ID` (values) and `PM_GITHUB_APP_PRIVATE_KEY` (from the secret) into
   the **staging** task definition in `AWS-STAGE-DEPLOY-GATEWAY.yml`, after the secret is confirmed to exist (the
   workflow fails the deploy on a listed secret that is missing). Production follows at PUBLISH.

**If an App is not allowed:** a dedicated machine user (`vitana-pm-bot`) with a fine-grained PAT limited to the two
repositories and the same permissions, stored the same way. This needs one more code path and is not built now.

## Verify
After the staging wiring: PM bookkeeping commits on `pm-agent/*` show author `vitana-pm[bot]`; gateway logs show
no `pm.github_app.token_failed`; the `exafyltd` rate limit (`GET /rate_limit` as that user) no longer drops with PM
activity.

## Roll back
Unset the three variables (or remove them from the task definition). The PM returns to today's tokens with no
restart of anything else. A failed token exchange already falls back automatically (one log line, status only).
