# VTID-04790 — Dev Autopilot scope: correct glob matching, keep auth locked, allow new auth-named test files

VALIDATION_PROFILE: gateway_backend

## Problem (found live on staging, VTID-04788)

Pipeline test ticket FB-2026-10-000143 reached auto-dispatch for the first
time (VTID-04649 working): Devon drafted a real spec, VTID-04789 and a
finding were created. The safety gate then refused the plan twice with
`tests_missing` (`feedback.ticket.auto_dispatch_blocked`, 13:02 and 13:04 UTC).

Devon's spec named a new test, `services/gateway/test/get-current-screen-auth-transition.test.ts`.
`globToRegex` turned `**/` into `.*` and dropped the slash, so the deny rule
`**/auth*` matched any file NAME containing "auth". The bridge pre-flight
filed the test as denied, `proposed_files` kept only the five source files,
and the gate saw no test file.

The same over-broad match is what locks ~20 auth source files today
(oauth2.ts, tenant-role-auth.ts, operator-machine-auth.ts, ...). Owner
decision: correct the matcher, keep every one of them locked, and allow a
NEW test file to carry such a name.

## Acceptance criteria

- AC-1: `**/` means whole directories (`**/auth*` = name starts with "auth"; `a/**/b` matches `a/b`).
  TEST: services/gateway/test/vtid-04790-deny-scope-glob.test.ts
- AC-2: The rewritten live rules (`**/*auth*`, `**/*.env*`, `**/*credentials*`, and the fallback `**/*orb-live.ts`) deny exactly the repository files the old rules denied under the old matcher — checked over `git ls-files`.
  TEST: services/gateway/test/vtid-04790-deny-scope-glob.test.ts
- AC-3: A test file that does not exist on main and is caught only by name-only rules is allowed; an existing one, any source file, and anything under a directory or exact-path rule stay denied. Applied in the bridge pre-flight, the safety gate (`new_files`, confirmed against the repository, fail closed) and the agent's post-hoc diff check (`action === 'create'`).
  TEST: services/gateway/test/vtid-04790-deny-scope-glob.test.ts
- AC-4: Support pipeline: a spec naming a new auth-named test is dispatched with the test kept; an existing auth test is dropped.
  TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
- AC-5: The live `dev_autopilot_config.deny_scope` is rewritten to the explicit "contains" form before the code deploys (safe under both matchers).
  TEST: supabase/migrations/20261001140000_vtid_04790_deny_scope_name_contains.sql (applied live 2026-10-01, see commands.log)

OASIS_PROOF: no new topic. A dispatch that passes shows up as `feedback.ticket.dispatched`; a refusal stays `feedback.ticket.auto_dispatch_blocked`.

## Mutation checks

- Old matcher restored: 2 tests fail (matcher semantics).
- Exemption removed: 4 tests fail, including the support scenario reproducing FB-2026-10-000143.

## Not verified here

A live dispatch: the kill switch is armed (owner's decision after the test). Re-running FB-2026-10-000143 after this deploys to staging is the live check.
