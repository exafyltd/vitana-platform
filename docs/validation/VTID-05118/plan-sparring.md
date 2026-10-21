# VTID-05118 — plan sparring record (FU2: welcome-discount email trigger)

Two-repo change: the vitana-v1 PR (edge function, `_shared/trigger-secret.ts`, tests) and the vitana-platform PR (the migration, its test, this pack). The same record is in both repos.

# FU2: Welcome-discount email trigger posts with NULL URL and token. Reuse the `email_trigger_secret` pattern

change class: standard (one migration, two repos)

scope:
- vitana-platform: `supabase/migrations/2026101XXXXXXX_vtid_XXXXX_welcome_discount_trigger_secret.sql` (new). This redefines `public.notify_welcome_discount()` only.
- vitana-v1: `supabase/functions/_shared/trigger-secret.ts` (new, has no imports). Exports `timingSafeEqual` and `isTriggerSecretCaller(req, getEnv?)`.
- vitana-v1: `supabase/functions/_shared/caller-auth.ts`. Its private `timingSafeEqual` is replaced by the import from `./trigger-secret.ts`, and it re-exports `isTriggerSecretCaller`.
- vitana-v1: `supabase/functions/send-welcome-discount/index.ts`. A combined auth guard; the CORS string does not change.
- vitana-v1: `src/lib/edge-functions-caller-identity.s4.test.ts`. The send-welcome-discount block is renamed and its assertions are made concrete.
- vitana-v1: `src/lib/trigger-secret.test.ts` (new). A Vitest unit test of `isTriggerSecretCaller` with a stubbed env.
- vitana-platform: `docs/validation/<VTID>/staging-tests.json` + `plan-sparring.md` (governance artefacts)

<!-- plan:begin -->
## Problem

Verified 2026-10-12 against origin/main (vitana-platform 5f0220d0c, vitana-v1 bcae4d0af) and production Supabase `inmkhvwdcuyhnxkgfvsb` (read-only SELECTs).

1. **The trigger function reads two vault names that do not exist.** See `vitana-v1/supabase/migrations/20260210141933_0d5c2768-…sql:95-123`. `notify_welcome_discount()` builds
   - `url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_url') || '/functions/v1/send-welcome-discount'` (line 104)
   - `'Authorization', 'Bearer ' || (… WHERE name = 'service_role_key')` (line 107)
   - It runs inside `EXCEPTION WHEN OTHERS THEN RAISE WARNING … RETURN NEW` (lines 118-121).
   The live `pg_get_functiondef('public.notify_welcome_discount')` is identical to that migration, and no later migration in either repo redefines it.
2. **Vault contents.** Only names were selected, never values. `vault.secrets` holds exactly two names: `email_trigger_secret` and a stray entry named `https://YOUR_SUPABASE_PROJECT_REF.supabase.co`. Neither `supabase_url` nor `service_role_key` exists. The URL therefore evaluates to NULL and `net.http_post` fails. The `WHEN OTHERS` handler turns that failure into a WARNING, so nothing is queued and nothing surfaces.
3. **Impact.** Trigger `on_discount_code_created_send_email` is enabled (`tgenabled='O'`). `public.user_discount_codes` holds 115 codes in total, created 2026-02-20 to 2026-10-06. Of these, **20 were created in the last 30 days**, and **0 have ever been used** (`used_at IS NOT NULL` = 0). The table has no column that records a sent email. No email/outbox/log table exists. `net._http_response` (30 rows, 6h retention) holds no evidence of earlier sends. It is very likely that no welcome-discount email has ever been delivered.
4. **An established pattern exists and works.** `notify_test_user_confirmation()` (`vitana-v1/supabase/migrations/20260518010000_test_user_confirmation_vault.sql:14-47`) does three things:
   - it hard-codes the project-public edge URL (line 21; the comment at lines 11-12 says the URL is public, not a secret)
   - it reads vault `email_trigger_secret` (lines 24-28)
   - it skips with a WARNING when that secret is missing (lines 30-34), then posts with an `X-Trigger-Secret` header (line 40)
   `send-test-user-confirmation/index.ts:31,56-63` checks that header against the `EMAIL_TRIGGER_SECRET` edge secret. This works in production: `test_user_applications` has 93 rows with `confirmation_sent_at` set, the latest on 2026-05-19, and vault `email_trigger_secret` exists today.
5. **Current edge-function auth.** `send-welcome-discount/index.ts:38-41` accepts only `isServiceRoleCaller(req)` (`_shared/caller-auth.ts`, VTID-05049). It reads the body as `discount_code_id` only and loads the row itself (lines 54-73), so a trigger-secret caller cannot choose the recipient, the code or the percent. `supabase/config.toml:153-154` sets `verify_jwt = false`, so the platform will not reject a request that carries no JWT.

## Fix

1. **vitana-v1, trigger-secret helper.** This is a committed decision; the inlining option is dropped (round 1, F1).
   - **New file `supabase/functions/_shared/trigger-secret.ts`, with no imports at all.** It exports:
     - `timingSafeEqual(a, b)`, moved verbatim from `caller-auth.ts:25-32`, which is currently private.
     - `isTriggerSecretCaller(req: Request, getEnv = (n) => Deno.env.get(n)): boolean`. It reads `EMAIL_TRIGGER_SECRET`. If that is unset or blank (after trim), it returns `false`. It reads the `x-trigger-secret` header; if the header is missing, it returns `false`. Otherwise it returns `timingSafeEqual(header, secret)`.
     - The `getEnv` default must not touch `Deno` at module load, so that Vitest can import the file. Reaching `Deno` only through `globalThis` follows the pattern in `data-client.ts:31-34`.
   - **`_shared/caller-auth.ts`.** Delete the private `timingSafeEqual` and import it from `./trigger-secret.ts`, so there is a single implementation. Add `export { isTriggerSecretCaller } from "./trigger-secret.ts";`. `isServiceRoleCaller` behaves exactly as before.
   - Why a separate file instead of putting the helper in `caller-auth.ts`: `caller-auth.ts:15` imports `https://esm.sh/@supabase/supabase-js@2.57.2`, which Vitest cannot import. The existing test says so at `edge-functions-caller-identity.s4.test.ts:13-14`. An import-free `_shared` module is the established way to unit-test edge logic; examples are `src/lib/erase-user-data.test.ts:8` and `src/lib/personal-memory-edge.test.ts:9`. Callers still import from `caller-auth.ts`, as F1 asked.
2. **vitana-v1, edge function** (`send-welcome-discount/index.ts`).
   - Import `isTriggerSecretCaller` from `../_shared/caller-auth.ts`.
   - Replace the guard at lines 38-41 with one combined expression: `if (!(isTriggerSecretCaller(req) || (await isServiceRoleCaller(req)))) { …401 }`. It stays before `req.json()`.
   - **The CORS allow-headers string stays exactly `"authorization, x-client-info, apikey, content-type"` (lines 8-10).** `x-trigger-secret` is not added, because pg_net calls server to server and no browser preflight happens (F4/F6).
   - Everything else is unchanged: the body yields only `discount_code_id`, values come from the DB row, and output is HTML-escaped.
   - Known inconsistency, out of scope: `send-test-user-confirmation/index.ts:62` compares the same secret with `!==`, which is not constant-time. Retrofitting it with the new helper is a follow-up (F2).
3. **vitana-platform, migration**, in `vitana-platform/supabase/migrations/`.
   - **Why this repo:** this directory plus `vitana-platform/.github/workflows/RUN-MIGRATION.yml` is the active production apply path. Track S VTID-05041/05043 and 15 runs between 2026-10-10 and 2026-10-12 were applied through it. vitana-v1 has only one-off apply workflows, one per migration.
   - The function was first defined by a vitana-v1 migration. Running `CREATE OR REPLACE` on it from the platform path is fine, because both repos target the same database.
   - `CREATE OR REPLACE FUNCTION public.notify_welcome_discount()` mirrors `notify_test_user_confirmation`:
   - constant `edge_url := 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/send-welcome-discount'`
   - `SELECT decrypted_secret INTO trigger_secret FROM vault.decrypted_secrets WHERE name = 'email_trigger_secret'`
   - if NULL, `RAISE WARNING '…vault secret "email_trigger_secret" not found — skipping'` and `RETURN NEW`
   - `net.http_post(url := edge_url, headers := {Content-Type, X-Trigger-Secret}, body := {discount_code_id: NEW.id})`. The body drops the ignored fields; the function reads only `discount_code_id`.
   - Keep `SECURITY DEFINER`, `SET search_path = public`, and the outer `EXCEPTION WHEN OTHERS → WARNING, RETURN NEW`, so signup can never be blocked.
   - The trigger definition does not change.
   - **No secret value goes in git.** The migration contains only the vault *name* `email_trigger_secret`, which already exists, and the public URL. Nothing new has to be provisioned in vault.
4. **Secret provisioning: none new.** `EMAIL_TRIGGER_SECRET` is a project-wide Supabase edge secret, already set for `send-test-user-confirmation`, so `send-welcome-discount` sees the same value. The apply step verifies this read-only (see Rollout 3) before the migration is applied.

## Tests (CI-runnable)

- **vitana-v1 Vitest, source guards** (`src/lib/edge-functions-caller-identity.s4.test.ts`).
  - Rename the describe block from `VTID-05049 send-welcome-discount is service-role only` to `send-welcome-discount accepts only a service-role or trigger-secret caller`. The PR states that this contract change is deliberate.
  - Assertions on `handler(fn('send-welcome-discount'))`:
    - `src.indexOf('isServiceRoleCaller(req)')` > -1 **and** `src.indexOf('isTriggerSecretCaller(req)')` > -1.
    - Both indexes are `< src.indexOf('req.json()')`.
    - Both calls sit in one guard expression: match `/if\s*\(\s*!\(\s*isTriggerSecretCaller\(req\)\s*\|\|\s*\(await isServiceRoleCaller\(req\)\)\s*\)\s*\)/`.
    - The `unauthorizedResponse(` call follows that guard.
  - The existing `const { discount_code_id } = await req.json();` assertion, the `user_discount_codes` row assertion and the escape assertions stay unchanged.
  - The CORS string is pinned: `fn('send-welcome-discount')` matches `/"authorization, x-client-info, apikey, content-type"/` and does not contain `x-trigger-secret`.
  - New `describe('_shared/trigger-secret.ts')` assertions on the source:
    - It has no `import` statements (`/^\s*import\s/m` does not match).
    - It exports `timingSafeEqual` and `isTriggerSecretCaller`.
    - It reads `EMAIL_TRIGGER_SECRET`.
    - The body of `isTriggerSecretCaller` calls `timingSafeEqual(`.
    - It contains no `!==`/`===` comparison against the secret variable.
  - On `caller-auth.ts`: it imports `timingSafeEqual` from `./trigger-secret.ts`, it no longer declares `function timingSafeEqual`, and it re-exports `isTriggerSecretCaller`.
  - The existing `the five functions use caller-auth` import assertion stays green.
- **vitana-v1 Vitest unit test** (`src/lib/trigger-secret.test.ts`). It imports `isTriggerSecretCaller` and `timingSafeEqual` from `../../supabase/functions/_shared/trigger-secret.ts` and passes a stub `getEnv`:
  - secret `"s3cret"` + header `x-trigger-secret: s3cret` → `true`
  - wrong header value, or one of different length → `false`
  - no header → `false`
  - env unset → `false`
  - env `""` or `"   "` with header `""` → `false` (the empty-secret bypass is closed)
  - an `Authorization: Bearer s3cret` header alone → `false`
  - `timingSafeEqual("a","a")` is `true`; `("a","b")` and `("a","ab")` are `false`
- **vitana-platform Jest/source test** on the new migration file:
  - It contains `name = 'email_trigger_secret'` and `X-Trigger-Secret`.
  - It does **not** reference the vault names `'supabase_url'` or `'service_role_key'`, and it does not contain `Bearer`.
  - It contains `/functions/v1/send-welcome-discount` and `CREATE OR REPLACE FUNCTION public.notify_welcome_discount()`.
  - It has a NULL-guard `RAISE WARNING … RETURN NEW` before `net.http_post`.
  - It keeps `EXCEPTION WHEN OTHERS`.
  - It contains no JWT-looking string (`eyJ`).
  - MIGRATION-DRIFT-CHECK stays green.
- **Staging (`docs/validation/<VTID>/staging-tests.json`), read-only only.** No signup is created, no POST is sent to the edge function, and no row is inserted. The checks are post-apply read-only SELECTs:
  - `pg_get_functiondef('public.notify_welcome_discount'::regproc)` contains `email_trigger_secret` and not `service_role_key`.
  - `SELECT count(*) FROM vault.secrets WHERE name='email_trigger_secret'` = 1 (name only).
  - End-to-end proof is observation only. After the next organic Maxina signup, read `net._http_response` for that request and expect status 200. Also read the `send-welcome-discount` edge logs (`[SEND-WELCOME-DISCOUNT] …`) for a 200 or 401.

## Rollout / apply steps

1. Merge the **exafyltd/vitana-v1** PR (the helper, caller-auth, the edge function and the tests). `vitana-v1/.github/workflows/supabase-functions-deploy.yml` deploys `send-welcome-discount`. **The edge function must be live before the migration**, otherwise the new trigger posts would get 401s.
2. Merge the **exafyltd/vitana-platform** PR (the migration in `supabase/migrations/`, the migration test and the validation docs).
3. Before applying, run a read-only check that the edge secret exists. Use the Supabase dashboard or a secrets-list API call that shows names only; no values are read. If it is missing, stop and escalate to the owner.
4. Apply via **exafyltd/vitana-platform** `.github/workflows/RUN-MIGRATION.yml` `workflow_dispatch` with `migration_file=supabase/migrations/<new file>`. This is not a vitana-v1 workflow.
5. Run the read-only post-apply SELECTs above, then watch `net._http_response` and the edge logs at the next organic Maxina signup.

## Risks

- **`EMAIL_TRIGGER_SECRET` is missing or differs from the vault `email_trigger_secret`.** Sends would get 401s, which is no worse than today because nothing is sent now. Rollout step 3 mitigates this.
- **Hard-coded project URL.** This is the same choice as the existing working trigger, and the URL is public. If the project ever changes, both triggers must change together.
- **Aurora cutover (VTID-05023).** `services/postgrest-aurora-proxy/aurora-restore-04-triggers.sql:147` re-creates this trigger on Aurora, which has no `pg_net` (`docs/validation/VTID-05023/side-effects.md:51`). This fix touches only the Supabase function. Aurora handling stays with VTID-05023. After the cutover, the edge function reads `user_discount_codes` through `createDataClient` (`DATA_API_URL`). If codes keep being inserted on Supabase while reads go to Aurora, the function returns 404. That is tracked under VTID-05023 and out of scope here.
- **Spoofing.** The trigger-secret caller can still only name a `discount_code_id`, so it can only re-send an existing code to that code's owner. A leaked secret could re-send welcome emails (spam to the code's owner), not phish arbitrary recipients. That exposure is the same class as `send-test-user-confirmation` today.
- **Duplicate sends.** No sent-marker column exists. The trigger fires once per insert (AFTER INSERT), so there are no duplicates going forward.

## Out of scope

- Backfill or retro-send for the 115 existing codes (see Owner decisions).
- Adding a `welcome_email_sent_at` idempotency column.
- The stray vault entry named `https://YOUR_SUPABASE_PROJECT_REF.supabase.co`. It is not touched and its value is not read; it is flagged only.
- Other pg_net callers with hard-coded anon JWTs (`20260317170256_…sql:13-16`, `20251009211730_…sql:10-14`).
- Aurora trigger handling (VTID-05023).
- Moving `send-test-user-confirmation/index.ts:62` (`provided !== TRIGGER_SECRET`, not constant-time) onto `isTriggerSecretCaller`. This is a follow-up.
- Localizing the English-only email body (`toLocaleDateString('en-US')`, EN copy).

## Owner decisions needed

1. **Backfill.** The recommended, conservative option is **no automatic retro-send**. The 20 members from the last 30 days, and 95 older ones, never received a code they have no way to know about. 0 codes have been used and all expire after 90 days (`expires_at` default). The options are:
   - (a) do nothing
   - (b) a one-off, owner-approved re-send for codes with `expires_at > now()`, from a script outside the trigger, possibly with extended expiry
   - (c) surface the code in-app instead of by email
   Any write or send is a production write that needs an explicit owner yes.
2. **The stray vault secret** named `https://YOUR_SUPABASE_PROJECT_REF.supabase.co`. Should it be inspected or removed later? This is a separate item, and no action is taken in this plan.
<!-- plan:end -->

## Planner responses — round 1

- **F1 [minor] `timingSafeEqual` is not exported. ACCEPTED, with one constraint stated.** The plan commits to an `isTriggerSecretCaller(req)` helper, which callers import from `_shared/caller-auth.ts`, and drops the inlining option.
  - Constraint: the round-1 response also asks for a Vitest unit test with a stubbed env (F5). Vitest cannot import `caller-auth.ts`, because it imports `https://esm.sh/...` (`caller-auth.ts:15`). The existing test states this at `edge-functions-caller-identity.s4.test.ts:13-14`.
  - So the pure logic (`timingSafeEqual`, moved and no longer private, plus `isTriggerSecretCaller`) lives in a new import-free `_shared/trigger-secret.ts`. `caller-auth.ts` imports `timingSafeEqual` from it, which leaves one implementation, and re-exports `isTriggerSecretCaller`.
  - This follows the existing tested `_shared` pattern (`src/lib/erase-user-data.test.ts:8`, `personal-memory-edge.test.ts:9`).
  - Scope gains one file. See Fix 1.
- **F2 [minor] `send-test-user-confirmation` uses `!==`. ACCEPTED.** The note is added to Fix 2 and Out of scope; retrofitting is a follow-up.
- **F3 [major] Which repo the migration belongs in. REJECTED, with evidence.**
  - `vitana-platform/supabase/migrations/` exists, and `vitana-platform/.github/workflows/RUN-MIGRATION.yml` is the active production apply path. Track S VTID-05041/05043 and 15 runs between 2026-10-10 and 2026-10-12 were applied through it.
  - vitana-v1 has only one-off apply workflows, one per migration.
  - `CREATE OR REPLACE` of a function first defined in a v1 migration is fine from the platform path, because both repos target the same database.
  - Fix 3 and Rollout 1, 2 and 4 now name each repo explicitly. This answers partner Q1 and Q3.
- **F4 [minor] `x-trigger-secret` in CORS. ACCEPTED.** It is not added: pg_net calls server to server, so no preflight happens.
- **F5 [major] Test assertions are unspecified. ACCEPTED.** The Tests section now has:
  - the renamed describe block
  - a single combined guard expression, matched by regex
  - `indexOf` checks that `isServiceRoleCaller(req)` and `isTriggerSecretCaller(req)` both come before `req.json()`
  - source guards that the helper uses `timingSafeEqual` and reads `EMAIL_TRIGGER_SECRET`
  - a migration test that the vault names `supabase_url`/`service_role_key` are gone
  - a new Vitest unit test `src/lib/trigger-secret.test.ts` with a stubbed `getEnv`, covering the match, mismatch, missing-header, unset-env and empty-secret cases
- **F6 [minor] Exact CORS string. ACCEPTED.** Fix 2 states that it stays exactly `"authorization, x-client-info, apikey, content-type"`, and a test pins it.
- **F7 [minor] Scope is missing `caller-auth.ts`. ACCEPTED.** Scope now lists `caller-auth.ts`, the new `trigger-secret.ts` and `src/lib/trigger-secret.test.ts`.

## Owner approval (Gate 1)
Approved by owner in Claude Code session https://claude.ai/code/session_01TMPMNGNEtPxKwmVqyfdx46 on 2026-10-12 ("Yes"), including the recommended option for every owner decision and the production steps named in the plan. Verdict: CONVERGED (2 rounds).

## Record
- Plan hash (sha256 of the text between the plan markers): `b9dd9fff6c2c54947f6bd53fa205b52ebf7c5d23b4d84d28c59930da7c58653a`
- Sparring record: `d39794cb-161b-490f-b8ec-690e6db5e3c1`. Partner: plan-sparring-partner, 2 rounds. Verdict: **CONVERGED**.
- Owner decisions: the recommended option for each (no automatic backfill; the stray vault entry is left untouched).

Owner approval (Gate 1): "Yes" — 2026-10-12, Claude Code session; plan hash b9dd9fff6c2c54947f6bd53fa205b52ebf7c5d23b4d84d28c59930da7c58653a; sparring record d39794cb-161b-490f-b8ec-690e6db5e3c1.

## Sparring partner findings (verbatim, round 1 then round 2)

I see a notable issue -- `send-test-user-confirmation` uses a plain `!==` comparison (line 62), not constant-time. The plan says to use `timingSafeEqual` for the new code, which is good, but it's worth noting the existing pattern does NOT use it despite the plan implying it mirrors the existing approach.

Now I have enough evidence for my analysis.

## Verified premises

- **"The trigger function reads two vault names (`supabase_url`, `service_role_key`) that do not exist"** --> TRUE -- `/home/user/vitana-v1/supabase/migrations/20260210141933_0d5c2768-22f0-40bb-9c45-a621094bb458.sql:104,107` confirms the function reads `vault.decrypted_secrets WHERE name = 'supabase_url'` and `WHERE name = 'service_role_key'`.

- **"`notify_test_user_confirmation()` hard-codes the project-public edge URL and reads vault `email_trigger_secret`"** --> TRUE -- `/home/user/vitana-v1/supabase/migrations/20260518010000_test_user_confirmation_vault.sql:21,24-28` shows `edge_url constant text := 'https://inmkhvwdcuyhnxkgfvsb.supabase.co/functions/v1/send-test-user-confirmation'` and `SELECT decrypted_secret ... WHERE name = 'email_trigger_secret'`.

- **"`send-welcome-discount/index.ts` accepts only `isServiceRoleCaller(req)` and the body is destructured only as `{ discount_code_id }`"** --> TRUE -- `/home/user/vitana-v1/supabase/functions/send-welcome-discount/index.ts:38,54` confirms both: `if (!(await isServiceRoleCaller(req)))` at line 38, and `const { discount_code_id } = await req.json()` at line 54.

- **"`supabase/config.toml` sets `verify_jwt = false` for `send-welcome-discount`"** --> TRUE -- `/home/user/vitana-v1/supabase/config.toml:153-154` shows `[functions.send-welcome-discount]` followed by `verify_jwt = false`.

- **"The plan says the trigger-secret comparison in the existing pattern uses constant-time comparison (timingSafeEqual)"** --> PARTIAL -- The plan says to use `timingSafeEqual` for the new code (correct choice), but the existing `send-test-user-confirmation` at `/home/user/vitana-v1/supabase/functions/send-test-user-confirmation/index.ts:62` uses a plain `!==` comparison, NOT constant-time. The plan references `timingSafeEqual` from `caller-auth.ts` which does exist (`/home/user/vitana-v1/supabase/functions/_shared/caller-auth.ts:25-31`) but is not exported and is used only within `isServiceRoleCaller`. The plan is correct to want constant-time, but the "same approach as caller-auth" framing is slightly misleading since `timingSafeEqual` is not exported.

## Findings

F1 [minor] `timingSafeEqual` in `caller-auth.ts` is not exported; the plan assumes it can be reused directly.

Evidence: `/home/user/vitana-v1/supabase/functions/_shared/caller-auth.ts:25` defines `function timingSafeEqual` (no `export`). The plan says "using the same `timingSafeEqual` approach as caller-auth" and proposes either a helper `isTriggerSecretCaller(req)` in `caller-auth.ts` or inlining. If the helper is added to `caller-auth.ts`, it can use the private `timingSafeEqual` internally -- fine. If inlined in `send-welcome-discount/index.ts`, the implementer must duplicate the function or export it. The plan should be explicit: either (a) the helper goes into `caller-auth.ts` (preferred, as it can reuse the private function), or (b) `timingSafeEqual` is exported. Do not leave it as "or inline it."

Suggestion: Commit to the `isTriggerSecretCaller(req)` helper in `caller-auth.ts` as the single approach. This keeps `timingSafeEqual` private and avoids duplication.

F2 [minor] The existing `send-test-user-confirmation` uses a plain `!==` comparison for the trigger secret -- inconsistency with the plan's security goal.

Evidence: `/home/user/vitana-v1/supabase/functions/send-test-user-confirmation/index.ts:62` -- `if (provided !== TRIGGER_SECRET)`. The plan correctly specifies constant-time for the new code, but the existing pattern it cites as a model is NOT constant-time. This is not a blocker for this plan, but the implementer might follow the "existing pattern" literally and use `!==`. The plan should note this divergence explicitly.

Suggestion: Add a sentence: "Note: the existing `send-test-user-confirmation` uses `!==`; the new helper intentionally upgrades to constant-time comparison. Retrofitting the old function is out of scope."

F3 [major] The plan puts the migration in `vitana-platform` but the existing trigger migration lives in `vitana-v1`.

Evidence: The plan's scope says `vitana-platform: supabase/migrations/2026101XXXXXXX_...sql (new)`. But the existing function definition is in `/home/user/vitana-v1/supabase/migrations/20260210141933_...sql:95-123`, and the companion trigger `notify_test_user_confirmation` migration is also in `vitana-v1` (`/home/user/vitana-v1/supabase/migrations/20260518010000_...sql`). There is no `supabase/migrations/` directory in vitana-platform at all (the platform repo has its migrations elsewhere or manages them differently). The `RUN-MIGRATION.yml` workflow referenced in the rollout would need to exist in whichever repo the migration is placed. Which repo's `supabase/migrations/` directory actually gets applied to the production Supabase project?

Suggestion: The planner should verify which repo's migration directory is the one that gets applied to the `inmkhvwdcuyhnxkgfvsb` Supabase project. Both existing trigger migrations are in `vitana-v1/supabase/migrations/`. If `vitana-v1` is the correct home for Supabase migrations, the plan's scope line must change. If `vitana-platform` has a separate migration path, clarify the mechanism.

F4 [minor] CORS `x-trigger-secret` addition is unnecessary for a server-to-server call from `pg_net`.

Evidence: The `pg_net` trigger runs server-side and never sends a preflight OPTIONS request. Adding `x-trigger-secret` to `Access-Control-Allow-Headers` exposes the header name to browser callers (the function has `verify_jwt = false` in config.toml:153-154). This is cosmetic -- a browser caller would still need the secret -- but it is unnecessary attack-surface disclosure. The existing `send-test-user-confirmation` does list it (line 41), so there is precedent, but that function also has `verify_jwt = false`.

Suggestion: Consider whether `x-trigger-secret` truly needs to be in the CORS allow-headers. If the function is only called by `pg_net`, it does not. If kept for consistency with the existing pattern, note why.

F5 [major] The plan does not address the test file assertion that will break: the test explicitly checks `isServiceRoleCaller` comes before `req.json()`, and the existing test name is `'send-welcome-discount is service-role only'`. Adding an alternative auth path (trigger secret) means the test's positional assertion at line 165 (`src.indexOf('await isServiceRoleCaller(req)')` < `src.indexOf('req.json()')`) still passes, but the semantic contract changes. The test at line 161 checks a contract that the plan deliberately changes, yet the plan's test section says only "extending the existing block" and "renaming" -- it does not say what the new positional assertion will be for the trigger-secret path.

Evidence: `/home/user/vitana-v1/src/lib/edge-functions-caller-identity.s4.test.ts:161-168`. The test asserts `isServiceRoleCaller` is called before `req.json()`. If the new code structure is `isServiceRoleCaller(req) || isTriggerSecretCaller(req)`, the trigger-secret check must also precede `req.json()`. The plan's test section says "The auth gate (`isServiceRoleCaller` OR the trigger-secret check) comes before `req.json()`" which is correct intent, but the plan does not describe the actual assertion change (the current test uses `src.indexOf('await isServiceRoleCaller(req)')` -- will there be a separate indexOf for the trigger-secret helper?).

Suggestion: Spell out the concrete assertion: either a single combined guard function whose name is checked positionally, or two separate indexOf checks, both before `req.json()`. The implementer needs to know the test structure, not just the intent.

F6 [minor] The plan says "Add `x-trigger-secret` to the CORS allow-headers" but the current CORS line in `send-welcome-discount/index.ts:10` is `"authorization, x-client-info, apikey, content-type"`. The plan should note that `x-client-info` and `apikey` may or may not be kept, and confirm the exact new value.

Evidence: `/home/user/vitana-v1/supabase/functions/send-welcome-discount/index.ts:9-10`.

Suggestion: Specify the full replacement string for the CORS header, do not just say "add."

F7 [minor] The plan lists `vitana-v1: src/lib/edge-functions-caller-identity.s4.test.ts` in scope but does not list `supabase/functions/_shared/caller-auth.ts` even though F1 implies it must be changed (to add `isTriggerSecretCaller`).

Evidence: Plan scope section (lines 7-8) vs. plan fix section (line 38).

Suggestion: Add `supabase/functions/_shared/caller-auth.ts` to the scope list.

## Questions for the planner

1. Which repo's `supabase/migrations/` directory is applied to the production Supabase project `inmkhvwdcuyhnxkgfvsb`? The two existing trigger migrations are both in `vitana-v1/supabase/migrations/`. If that is the canonical path, the migration in this plan belongs in `vitana-v1`, not `vitana-platform`. (F3)

2. The plan proposes `isTriggerSecretCaller` as an option in `caller-auth.ts` but also says "if the planner wants <=2 touched v1 files, it can be inlined instead." Which approach is chosen? The file count constraint should not drive a security-relevant design choice. (F1)

3. Does the `RUN-MIGRATION.yml` workflow exist in `vitana-v1`, `vitana-platform`, or both? The rollout step 4 references it without specifying the repo.

## Verdict

NOT CONVERGED -- F3 and F5 are open majors. F3 (wrong repo for the migration) is potentially a blocker if the plan as written would place the migration where it cannot be applied. F5 (incomplete test assertion specification) risks the implementation breaking CI or shipping an undertested auth change.
Good -- nothing exists yet, so the plan is purely additive. Let me check the guard ordering proposed: `isTriggerSecretCaller(req) || (await isServiceRoleCaller(req))`. The trigger-secret check is synchronous, service-role is async. That ordering is correct (cheap sync check first, expensive async check second).

One thing to verify: the plan says `isTriggerSecretCaller` is synchronous (no `await`), but the guard expression has `await` only on `isServiceRoleCaller`. Let me confirm the plan's signature says it returns `boolean` not `Promise<boolean>`.

Looking at the plan line 38: `isTriggerSecretCaller(req: Request, getEnv = ...): boolean` -- yes, synchronous return. Good. And the guard expression at line 44: `if (!(isTriggerSecretCaller(req) || (await isServiceRoleCaller(req))))` -- the `await` only wraps the async call. This is correct JavaScript short-circuit evaluation: if the trigger secret matches, the async call is never made.

Now let me check one more thing -- the plan's test regex at line 68.

The regex `/if\s*\(\s*!\(\s*isTriggerSecretCaller\(req\)\s*\|\|\s*\(await isServiceRoleCaller\(req\)\)\s*\)\s*\)/` -- this needs to match the actual code `if (!(isTriggerSecretCaller(req) || (await isServiceRoleCaller(req))))`. The regex looks correct, though it is quite rigid. Any formatting difference (e.g., a newline) would break it. But that is an implementation detail, not a plan-level concern.

I have completed my analysis.

## Verified premises

- **F3 rejection: vitana-platform has `supabase/migrations/` and `RUN-MIGRATION.yml`** --> TRUE -- `/home/user/vitana-platform/supabase/migrations/` contains 639+ SQL files; `/home/user/vitana-platform/.github/workflows/RUN-MIGRATION.yml` exists.
- **New file `trigger-secret.ts` can use the `globalThis.Deno` pattern from `data-client.ts`** --> TRUE -- `/home/user/vitana-v1/supabase/functions/_shared/data-client.ts:31-34` shows `const deno = (globalThis as any).Deno; return deno?.env?.get?.(name);`.
- **`isTriggerSecretCaller` does not yet exist anywhere in the codebase** --> TRUE -- grep returns no matches in vitana-v1.

## Findings

### Round 1 dispositions

- F1 [minor] `timingSafeEqual` not exported --> **closed**. Plan now creates `trigger-secret.ts` with the export, and `caller-auth.ts` imports from it. The Vitest-importability constraint is addressed with the import-free file design.
- F2 [minor] `send-test-user-confirmation` uses `!==` --> **closed**. Plan notes the inconsistency explicitly in Fix 2 and lists it as an out-of-scope follow-up.
- F3 [major] Wrong repo for migration --> **closed**. The planner's rejection is correct. `vitana-platform/supabase/migrations/` is the active migration directory (639+ files) and `RUN-MIGRATION.yml` exists in that repo. The plan now names both repos explicitly in scope and rollout.
- F4 [minor] CORS `x-trigger-secret` unnecessary --> **closed**. Plan states the CORS string stays unchanged; a test pins it.
- F5 [major] Test assertions unspecified --> **closed**. The test section now has concrete assertions: the renamed describe block, the regex for the combined guard, two indexOf checks before `req.json()`, source guards on the helper, and a full unit test with stubbed env covering match/mismatch/missing/empty cases.
- F6 [minor] Exact CORS string --> **closed**. Plan specifies the exact unchanged string and pins it with a test assertion.
- F7 [minor] Missing `caller-auth.ts` from scope --> **closed**. Scope now lists `caller-auth.ts`, `trigger-secret.ts`, and `trigger-secret.test.ts`.

### New findings (round 2)

No new blocker or major findings. The revision is clean: the file split (`trigger-secret.ts` import-free, `caller-auth.ts` re-exports) is sound and follows the established pattern; the guard ordering (sync first, async second) is correct for short-circuit evaluation; the test plan is concrete; the rollout order (edge function deployed before migration) prevents 401s; and both repos are named explicitly at every step.

## Questions for the planner

None.

## Verdict

CONVERGED
