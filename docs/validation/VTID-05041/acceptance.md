# VTID-05041 — Track S / S2: SECURITY DEFINER functions exposed to clients

Security hotfix (P1 data exposure). `write_fact`, `get_current_facts`, `recall_at_time_range` and
`memory_facts_semantic_search` are SECURITY DEFINER, take `p_user_id`, never check `auth.uid()`, and were
executable by `authenticated`: any signed-in member could read and overwrite any other member's memory facts
(MULTI-TENANT-PLAN S-B). `get_user_profile_by_identifier(text)` returned every visible member's `email` to
`anon` (S-D). `fn_consume_credits` (S-C) is closed by VTID-04981, applied first. Every caller of the memory
functions is the gateway on the service role; no client, edge function or Python service calls them.

This slice deploys no service code. Verification after the owner-approved apply (RUN-MIGRATION of
`20261008170000_vtid_04981_consume_credits_lockdown.sql`, then `20261010164100_vtid_05041_definer_functions_lockdown.sql`)
is the read-only catalog query in `post-apply-checks.sql` (has_function_privilege × roles,
`pg_get_function_result`), which the orchestrator runs and records in `commands.log`. The migration is NOT
applied by this PR.

AC-1 After apply, `authenticated` and `anon` cannot execute any overload of the four memory functions; a member
call is refused by Postgres (`insufficient_privilege`); `service_role` keeps EXECUTE and its calls work. The
memory function bodies are not redefined.
TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts
TEST: supabase/tests/vtid_05041_definer_lockdown.test.sql (via scripts/ci/test-vtid-05041-definer-lockdown.sh)

AC-2 `get_user_profile_by_identifier(text)` returns no `email` column; everything else is unchanged (40 columns
pinned, same three lookup branches by handle / vitana_id / UUID, same `is_visible` gate, same account_type /
verification CASE defaults); `anon`, `authenticated`, `service_role` keep EXECUTE, `PUBLIC` does not.
TEST: supabase/tests/vtid_05041_definer_lockdown.test.sql (anon resolves by handle, @handle, vitana_id, UUID; no email key; hidden member stays hidden)
TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts

AC-3 The migration is atomic and checks itself by effect: it refuses to apply (rolling everything back) unless
AC-1/AC-2 hold and `fn_consume_credits` is closed to members. Applied before VTID-04981 it refuses and changes
nothing; applied twice it is a no-op. Mutation-checked: REVOKE commented out → refuses; `p.email` re-added →
refuses (outputs/mutations.txt).
TEST: scripts/ci/test-vtid-05041-definer-lockdown.sh

AC-4 Any later migration that grants one of the four memory functions or `fn_consume_credits` to
authenticated/anon/PUBLIC, or recreates `get_user_profile_by_identifier` with `email`, fails CI. A mirror Vitest
guard ships in vitana-v1 for the profile function.
TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts (outputs/ci-guard-mutation.txt)

AC-5 New-DEFINER guard: a migration newer than S2 that contains SECURITY DEFINER must, in the same file, revoke
PUBLIC and anon or carry `-- definer-public: <reason>` (replaces ALTER DEFAULT PRIVILEGES, deferred to WS0).
TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts (outputs/ci-guard-mutation.txt)

AC-6 The gateway callers of the memory functions still use the service-role key (remember.ts REST + client,
memory-facts-service createServiceClient + semantic search REST, memory-facts-service-repository,
tool-recall-conversation, memory-garden route on getSupabase()).
TEST: services/gateway/test/vtid-05041-definer-lockdown.test.ts

AC-7 After RUN-MIGRATION on production (orchestrator, read-only): `post-apply-checks.sql` Q4 returns
`vtid_05041_ok = true`; Q1 shows auth_x/anon_x/public_x = false and service_x = true for all five functions; Q2
shows anon_x/auth_x/service_x = true, public_x = false, returns_email = false. Baseline before apply:
outputs/live-baseline-2026-10-10.txt.
TEST: docs/validation/VTID-05041/post-apply-checks.sql

Rollback: `rollback.sql` (not a migration). Block A re-grants `authenticated` per memory function only if a
legitimate member path breaks; Block B restores the old profile shape with `email` always NULL.
