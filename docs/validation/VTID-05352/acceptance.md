# VTID-05352 acceptance (pm-ci-load/pm-app-token, tasks.md A1-A5)

Every AC maps to a TEST: within 12 lines. Raw output: `outputs/red-on-base.txt`. Commands: `commands.log`.
Change types: Backend, Integration. Deploys the gateway to staging; merged only after
`pm-reassign-idempotent/reassign-noop` (plan §3 lane 2 item 6).

AC-1 With PM_GITHUB_APP_ID / PM_GITHUB_APP_PRIVATE_KEY / PM_GITHUB_APP_INSTALLATION_ID not all set, every PM GitHub
call uses exactly today's token (repo token for vitana-v1, GITHUB_SAFE_MERGE_TOKEN for vitana-platform); with no token
at all the existing error is thrown.
TEST: npx jest test/project-manager/github-app-token.test.ts ("resolvePmToken …", "appConfigFromEnv …")

AC-2 When set: RS256 App JWT (iss = App ID, iat −60 s, exp +9 min), exchanged at
`/app/installations/<id>/access_tokens` for exactly the two repositories and the plan §4 permissions (contents
write, pull_requests write, checks read, Variables read, metadata read); cached until 5 min before expiry;
concurrent callers share one exchange.
TEST: npx jest test/project-manager/github-app-token.test.ts ("mints an RS256 App JWT …", "reuses the cached token …", "shares one exchange …")

AC-3 A failed exchange (401/5xx) returns null, logs exactly one `pm.github_app.token_failed` line with the status only
(no key, JWT or token), and the call falls back to today's token.
TEST: npx jest test/project-manager/github-app-token.test.ts ("an exchange answered …", "prefers the App token …")

AC-4 No PM behaviour changes: every existing PM suite and the operator pipeline regression stay green; gateway
type-checks.
TEST: npx jest test/project-manager; npx jest test/vtid-04465-operator-pipeline-regression.test.ts; npx tsc --noEmit

AC-5 Staging proof is read-only (gateway alive, PM mode serves, PM jest suite) and the setup steps an organization
owner must do are documented with least-privilege permissions and rollback.
TEST: docs/validation/VTID-05352/staging-tests.json (validateManifest ok); docs/project-manager/github-app.md
