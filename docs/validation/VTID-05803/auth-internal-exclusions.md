# VTID-05803 — documented exclusions: auth-internal foreign keys (10)

Source: read-only pg_constraint inventory of the production Supabase project (inmkhvwdcuyhnxkgfvsb), 2026-11-17,
as recorded in the canonical baseline commit 589d0923 (schema-restore-package/source-auth-fk-inventory.tsv).

These are foreign keys whose referencing table is in the `auth` schema and whose target is `auth.users`. They belong to
Supabase Auth and are NOT restored to Aurora. They are excluded by construction: the executor dumps only `--schema=public`
(stage-exec.sh step 7), so the `auth` schema never enters the restore. Aurora receives only the empty `auth.users` stub
(0001_auth_shim.sql), so these constraints have no target schema.

Expected in the executor's dump: zero. Any of these appearing in the restore SQL is a defect.

| # | constraint | referencing table | column | on_update | on_delete | definition |
|---|---|---|---|---|---|---|
| 1 | identities_user_id_fkey | auth.identities | {user_id}]/} | a | c |  |
| 2 | mfa_factors_user_id_fkey | auth.mfa_factors | {user_id}]/} | a | c |  |
| 3 | mfa_recovery_code_sets_user_id_fkey | auth.mfa_recovery_code_sets | {user_id}]/} | a | c |  |
| 4 | oauth_authorizations_user_id_fkey | auth.oauth_authorizations | {user_id}]/} | a | c |  |
| 5 | oauth_consents_user_id_fkey | auth.oauth_consents | {user_id}]/} | a | c |  |
| 6 | one_time_tokens_user_id_fkey | auth.one_time_tokens | {user_id}]/} | a | c |  |
| 7 | scim_users_user_id_fkey | auth.scim_users | {user_id}]/} | a | n |  |
| 8 | sessions_user_id_fkey | auth.sessions | {user_id}]/} | a | c |  |
| 9 | webauthn_challenges_user_id_fkey | auth.webauthn_challenges | {user_id}]/} | a | c |  |
| 10 | webauthn_credentials_user_id_fkey | auth.webauthn_credentials | {user_id}]/} | a | c |  |

Storage-internal foreign keys (6): NOT in the baseline inventory, which covers only foreign keys referencing auth.users.
They are excluded by the source-exclusions.sql rule (public -> storage). Their live list must be reported from the
executor's exclusions.txt; this document does not assert their names.
