# Track S / S2 — SECURITY DEFINER functions exposed to clients (sub-plan)

- **Change class: expedited.** P1 data exposure live today: any signed-in member can read and overwrite
  any other member's memory facts (S-B), can drain another member's credits (S-C), and anyone without
  signing in can read any visible member's email (S-D). Expedited = ≥2 sparring passes, 10-min time box,
  immediate owner approval. Never break-glass (gateway and Bedrock are up).
- **Scope (vitana-platform; plus vitana-v1: mirror migration guard (Vitest), RPC return type in `src/integrations/supabase/types.ts` and the `PublicProfilePage.tsx` interface (see round-1 amendments)):**
  `supabase/migrations/2026101XHHMMSS_vtid_XXXXX_definer_functions_lockdown.sql` (new),
  `scripts/ci/test-vtid-XXXXX-definer-lockdown.sh` + `supabase/tests/vtid_XXXXX_{fixture,definer_lockdown.test}.sql`,
  `services/gateway/test/vtid-XXXXX-definer-lockdown.test.ts`, `DATABASE_SCHEMA.md`,
  `docs/validation/VTID-XXXXX/{plan-sparring.md,acceptance.md,commands.log,rollback.sql,staging-tests.json}`.
- Source: `docs/MULTI-TENANT-PLAN.md` §3 S-B/S-C/S-D (branch `claude/zealous-pasteur-i0czi8`). Read from origin/main, 2026-10-10.

<!-- plan:begin -->
## 1. Problem (evidence)
- Live 2026-10-10 (planner): `write_fact(uuid,uuid,text,text,text,text,text,uuid,numeric,uuid)`,
  `get_current_facts(uuid,uuid,text,text[])`, `recall_at_time_range(uuid,timestamptz,timestamptz,text)`,
  `memory_facts_semantic_search(vector,integer,uuid,uuid,text,numeric)` are SECURITY DEFINER, take
  `p_user_id` as a parameter, never check `auth.uid()`, and `authenticated` can EXECUTE them.
  The migrations only `GRANT … TO service_role` (`20260119000000_vtid_01192_infinite_memory_v2.sql:492-493`,
  `20260427200000_vtid_01990_…:253`, `20260221000000_…:94`); PUBLIC's default EXECUTE was never revoked.
  Likely amplifier: `20260608130000_phase_c_rpc_anon_lockdown.sql` revoked anon from every anon-callable
  DEFINER function and then explicitly `GRANT … TO authenticated, service_role` on each of them.
- `fn_consume_credits`: **already fixed in code, not yet live.** `20261008170000_vtid_04981_consume_credits_lockdown.sql`
  (VTID-04981, #3958) revokes PUBLIC/anon/authenticated with a self-check, but the live grant still exists,
  so RUN-MIGRATION was never run for it (its AC-4 has no production evidence in `commands.log`).
- `get_user_profile_by_identifier(text)`: latest body `vitana-v1:supabase/migrations/20260721124500_…sql`
  returns `p.email` and is granted to `anon, authenticated, service_role`; anon can resolve by handle,
  vitana_id or user UUID (enumeration) for every `gcp.is_visible` member.

## 2. Caller inventory (origin/main of both repos, migrations/docs excluded)
| Function | Caller | Credential | Client path? |
|---|---|---|---|
| write_fact | gateway `services/memory/remember.ts:105` (REST), `:126` (`client.rpc`, client = service client from `memory-facts-service.ts:101-110` / `automation-executor.ts:92-93`); `scripts/backfill-memory-facts.mjs:127` | service role | none |
| get_current_facts | gateway `memory-facts-service-repository.ts:34` via `createServiceClient()` (`memory-facts-service.ts:231`) | service role | none |
| recall_at_time_range | gateway `tool-recall-conversation.ts:266` | `SUPABASE_SERVICE_ROLE` | none |
| memory_facts_semantic_search | gateway `memory-facts-service.ts:492` (key `:463-464`) | service role | none |
| fn_consume_credits | gateway `entitlement-service-repository.ts:67` | service role | none |
| get_user_profile_by_identifier | v1 `PublicProfilePage.tsx:141`, `ProfilePreviewDialog.tsx:51`, `useRealMatches.ts:84` | anon / member JWT | **yes, keep**; nobody reads `email` (only declared at `PublicProfilePage.tsx:31`) |
- vitana-v1 references the memory functions only in generated `src/integrations/supabase/types.ts`; no
  edge function in either repo calls any of the six; no Python service does. ⇒ No rewrite to `auth.uid()`
  is needed anywhere: every memory/credit caller is server-side on the service role.

## 3. Fix per function
- **Four memory functions → REVOKE.** `REVOKE ALL … FROM PUBLIC, anon, authenticated; GRANT EXECUTE … TO service_role`,
  applied in a `DO` loop over `pg_proc` by `proname` so every overload is covered (older
  `memory_facts_semantic_search`/`write_fact` signatures, if any survive). Bodies untouched.
- **fn_consume_credits → apply the existing VTID-04981 migration first** (RUN-MIGRATION, no new SQL for it).
  The S2 migration's self-check also asserts it, so S2 refuses to apply while it is still open. Not
  re-revoked inside S2: one migration owns it, no duplicate.
- **get_user_profile_by_identifier → drop `email` from the return shape**, everything else byte-identical
  to the 20260721124500 body (same 3 branches, same `is_visible` gate, same account_type/verification CASEs).
  Return type changes ⇒ `DROP FUNCTION` + `CREATE FUNCTION` in one transaction, then re-issue
  `GRANT EXECUTE … TO anon, authenticated, service_role` (DROP discards grants) and `REVOKE … FROM PUBLIC`.
  Other public fields (full_name, location, social fields) unchanged — that is WS3/D23, not this hotfix.

## 4. Migration + rollback
- One file, `BEGIN … COMMIT`, header citing S-B/S-D and the caller inventory. Ends with a `DO $check$`
  that RAISEs (rolling everything back) unless: authenticated/anon have no EXECUTE on any overload of the
  4 memory functions nor on `fn_consume_credits(uuid,uuid,integer,text,text,text)`; service_role has
  EXECUTE on all of them; `anon` can EXECUTE `get_user_profile_by_identifier(text)`; its
  `pg_get_function_result` does not contain `email`. Idempotent (re-apply is a no-op).
- Order on production (covered by Gate 1 for this plan): RUN-MIGRATION `20261008170000_vtid_04981_…sql`,
  then RUN-MIGRATION the S2 file; PostgREST schema reload is part of the workflow. Then one read-only
  catalog query (has_function_privilege × roles, `pg_get_function_result`) recorded in `commands.log`.
- `docs/validation/VTID-XXXXX/rollback.sql` (not under migrations, per VTID-04868/04888/05012): re-grants
  `authenticated` on the four memory functions (only if a legitimate member path turns out to be broken;
  fix-forward preferred) and recreates the profile function with the old shape but `NULL::text AS email`
  — the rollback never re-exposes email.
- **ALTER DEFAULT PRIVILEGES — recommend DEFER to WS0.** Supabase's own defaults grant ALL on new
  public functions to anon/authenticated/service_role per creator role (postgres, supabase_admin);
  PUBLIC's built-in EXECUTE can only be revoked globally (`FOR ROLE <creator>` without `IN SCHEMA`), and
  migrations here reach the DB by several routes/roles (RUN-MIGRATION via Management API, v1 apply-*
  workflows, MCP), so a partial ADP gives false confidence. It silently breaks every future migration that
  adds an RLS helper or a frontend RPC without explicit grants (policy evaluation → 42501, client RPC → 401).
  Instead S2 ships a **CI guard**: any migration newer than S2 that creates a SECURITY DEFINER function
  must, in the same file, `REVOKE … FROM PUBLIC` (and anon unless allowlisted) or carry
  `-- definer-public: <reason>`. ADP lands in WS0 together with the DB lint and a creator-role inventory.
  This diverges from MULTI-TENANT-PLAN §3's "Default privileges" line → listed under Decisions for Gate 1.

## 5. Tests
- **Jest `services/gateway/test/vtid-XXXXX-definer-lockdown.test.ts`** (migration-text pattern of
  `vtid-04981-consume-credits-lockdown.test.ts`): pins the REVOKE/GRANT lines and the self-check; pins the
  profile function's exact RETURNS TABLE column list (no `email`) and its anon grant; no LATER migration
  grants any of the 4 memory functions or `fn_consume_credits` to anon/authenticated/PUBLIC, or re-adds
  `email` to `get_user_profile_by_identifier`; caller contract: the four gateway call sites still use the
  service-role key (string asserts); the new-DEFINER guard from §4. Runs the SQL harness when a local
  Postgres exists (skip otherwise, as 04981).
- **SQL harness `scripts/ci/test-vtid-XXXXX-definer-lockdown.sh`** (04981 pattern: initdb, fixture roles
  as `vtid_04809_fixture.sql`): creates DEFINER stubs with the exact live identity signatures granted to
  `authenticated` (reproducing live), minimal `profiles`/`global_community_profiles`, the real 20260721124500
  profile function; applies VTID-04981 + S2 migration twice; asserts privileges; `SET ROLE authenticated`
  call → `insufficient_privilege`; `SET ROLE anon` profile lookup returns the row without an `email` column.
  Mutation checks in `commands.log`: REVOKE commented out → migration refuses to apply; `p.email` re-added
  → refuses. PGlite (`docs/validation/VTID-04762/pglite-migration-check.mjs`) only as a fallback if the
  runner lacks postgres.
- **Staging (STAGING-VERIFY, read-only):** `staging-tests.json` = `/alive` + `existing` ref to the jest
  suite (the change is a DB permission; staging shares the prod DB). Plus one unauthenticated read probe:
  anon-key `POST /rest/v1/rpc/get_user_profile_by_identifier` for a known public handle → 200, row has
  `display_name`, has no `email` key. No sign-in probe and no write attempt (a member `write_fact` probe
  would write if the revoke were absent — rules 31/48).
- Suites unaffected but run: gateway Jest CI (incl. `memory-facts-service`, `entitlement-service`,
  `test:support`, `test:operator`).

## 6. Risks
- An unknown member-JWT caller of a memory function (none found in either repo) would get 42501 → the
  gateway paths log and degrade, nothing writes. Mitigation: post-apply PostgREST log check for 42501 on
  these RPCs for 24h (read-only); rollback.sql per function.
- DROP/CREATE of the profile function: atomic in one transaction; plpgsql callers (e.g.
  `resolve_profile_by_vitana_id`) bind at run time; generated v1 `types.ts` still lists `email` (harmless,
  no reader; refreshed at next regen).
- Applying VTID-04981 also unblocks nothing else by itself; VTID-04982/04988 migrations stay separate.

## 7. Out of scope
- Other DEFINER functions (whole-catalog sweep = WS0 lint/inventory); anon enumeration of public profiles
  by UUID and the remaining public fields (WS3/D23); `switch_to_tenant_by_slug` (S-E); ADP (WS0);
  rewriting any memory function to `auth.uid()` (no client needs it).

## Decisions for Gate 1
1. fn_consume_credits is closed by applying VTID-04981 as merged, not by new SQL.
2. ADP deferred to WS0; a CI guard on new DEFINER functions ships now instead.
3. Profile: only `email` removed; rollback keeps it NULL.

### Round-1 amendments (binding, supersede earlier text where they differ)
- **Effect-based checks only.** `supabase_migrations.schema_migrations` is not authoritative on production: its newest row is `20261004075058` (vtid_04872), yet later migrations' effects are live (plan_sparring tables exist, `nav_catalog` archived by VTID-04880). Every pre-apply self-check and post-apply verification therefore tests effects (`has_function_privilege('authenticated'|'anon', <fn>, 'EXECUTE')`, `pg_get_function_result`), never migration rows. VTID-04981's lockdown is not live by effect (authenticated can still execute `fn_consume_credits`, verified 2026-10-10), so S2 applies 04981 first; `20261008190000_vtid_04988` only grants `service_role` (verified in the file), is harmless in either order, and is listed in the Jest guard as a known later migration touching `fn_consume_credits`.
- **Cross-repo guard for the profile function.** The DROP/CREATE stays in this repo's migration (applied by RUN-MIGRATION), and a mirror guard ships in `exafyltd/vitana-v1` (Vitest scanning `supabase/migrations/*.sql`): any migration that creates/replaces `get_user_profile_by_identifier` with `email` in its `RETURNS TABLE` fails the build. The same vitana-v1 PR removes `email` from the RPC return type in `src/integrations/supabase/types.ts` (~:13612) and from the `PublicProfilePage.tsx:31` interface.
- **Late-binding risk, corrected.** No live plpgsql function references `get_user_profile_by_identifier` (verified 2026-10-10); the risk note now reads "any plpgsql function that calls it", with no specific name. `generate-daily-matches/index.ts:106` mentions it in a comment only (not a call) — recorded in the caller inventory.
- **Staging probe wording.** The anon PostgREST probe reads the production Supabase project (staging has no separate database); it is read-only and compliant with rule 48, and it verifies the production migration state, not an isolated staging copy.
<!-- plan:end -->

## Planner responses — round 1
Live read-only checks (2026-10-10): schema_migrations newest = 20261004075058 though later migrations' effects are live → effect-based checks; 04981 not live by effect; no live function references get_user_profile_by_identifier; resolve_profile_by_vitana_id does not exist.
- F1 ACCEPTED, option (a) — migration stays here (RUN-MIGRATION path), mirror guard + types/interface cleanup in a vitana-v1 PR. Q1 answered.
- F2 ACCEPTED — fabricated name removed; generic late-binding note. Q3: does not exist live either.
- F3 ACCEPTED — comment-only reference recorded.
- F4 ACCEPTED — 04988 listed as known later migration (grants service_role only); all checks effect-based because schema_migrations is not authoritative. Q2: 04988 not recorded, effects irrelevant to authenticated; ordering safe.
- F5 ACCEPTED — types.ts and interface updated in the vitana-v1 PR.
- F6 ACCEPTED — probe wording states it reads the production project.

## Sparring verdict
Round 1: 3 major (F1, F4, F6) + 3 minor → all accepted. Round 2: all closed, no new findings. **Verdict: CONVERGED** (2 rounds). Header scope line updated after convergence to name the vitana-v1 work (outside the plan markers; hash unaffected).
Final plan-body hash: `4e5a3a8c914f929ea58a216dbbc8ad9aabf4027c19e9404232865e35c05022c7`

## Record
- Plan hash (sha256 of the text between the plan markers, stripped, plus one trailing newline): `4e5a3a8c914f929ea58a216dbbc8ad9aabf4027c19e9404232865e35c05022c7`
- Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- VTID-05041 allocated after approval (placeholders `XXXXX` in the plan text = 05041; migration `20261010164100_vtid_05041_definer_functions_lockdown.sql`).

Owner approval (Gate 1): "Yes approved" — 2026-10-10, Claude Code session; plan hash 4e5a3a8c914f929ea58a216dbbc8ad9aabf4027c19e9404232865e35c05022c7; sparring record 4a2f8391-283a-498c-b4ba-a8c79e84b03a.
