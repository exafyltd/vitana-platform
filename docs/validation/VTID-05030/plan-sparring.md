# Plan sparring record — VTID-05030 (Health Hub WP2 / D1)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D1, §5 Phase 0, incl. "OAuth callback returns error codes, not raw messages").
- **Sparring session:** `plan_sparring_sessions.id = 5e911168-1cb3-4848-886d-b67caaf49d94`; VTID allocated with `p_sparring_id`.
- **Partner:** `plan-sparring-partner` agent (read-only, independent).
- **Change class:** standard. **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `a442bbbdf5d7f5946528c88d4b39aa4c4fe70ba4cf2e88f0a657c959f190dadf`, **final `481c0509d7ab45913466cd8790f3184fd78b3d679d21cdda672d2438eb589a99`**.
- **Approval basis:** the owner's Gate 1 approval of the program plan ("Yes to both plans", 2026-10-10, `docs/validation/VTID-05020/plan-sparring.md`). This WP implements program item D1 as approved.
- **Production write in this WP:** the grants migration. It is applied only after the owner's Gate 2 "yes" and is listed in the Gate 2 message.

## Round 1 — NOT CONVERGED

Premises verified TRUE: Facts 1, 4, 5, 6, 7, 8, 9. Fact 2 was PARTIAL from the repo; the extra privileges come from
Supabase default grants, and the planner's live `information_schema` read confirms them. Fact 3 cannot be verified
from code.

| # | Sev | Finding (partner) | Planner answer |
|---|-----|-------------------|----------------|
| F1 | major | `encryptApiKey`/`decryptApiKey` return and take three Buffers; packing into one TEXT value is a new adapter, understated. | **Accepted.** Described as a new serialization adapter (fixed offsets 12/28); tests for tamper of each part and truncation. |
| F2 | major | The staging `/connections` check passes before and after; it does not test grants. | **Accepted.** Relabelled as a regression check. Grants are proven by the CI migration test and a read-only `information_schema` check after the post-Gate-2 apply. |
| F3 | minor | Terra/Vital widget rows stay token-null after reconnect. | **Accepted.** Documented in code. |
| F4 | minor | Terra revoke with a null `provider_user_id`. | **Accepted.** `no_token` without a network call. |
| F5 | minor | `isCredentialCryptoConfigured` name is AI-specific. | **Accepted.** `isTokenCryptoConfigured()` alias with an interim shared-key comment. |
| F6 | major | A column-level GRANT is a maintenance trap; no client needs SELECT. | **Accepted.** REVOKE ALL from anon and authenticated, no re-grant. |
| F7 | minor | Meta understates the behaviour changes. | **Accepted.** Reworded. |
| Q1–Q3 | — | Why keep a column SELECT; shared-key rotation; revoke timeout. | Answered: no re-grant; dedicated key and rotation deferred (zero stored tokens, so no added blast radius now); a single 5 s bound, with the DB wiped before the vendor call. |

Planner-side vendor documentation check (2026-10-10), folded in:
- Terra and Vital (Junction) document their disconnect endpoints.
- The Strava URL is confirmed by client libraries.
- Fitbit's revoke is documented, but the legacy Web API was deprecated in September 2026, so it is best-effort.
- Oura documents no revoke endpoint, so it reports `unsupported`.

## Round 2 — CONVERGED

All findings closed. F8 (minor): the Vital URL notation could double `/v2`. Accepted: the URL is now
`{vitalBaseUrl()}/user/{id}/{provider}`, pinned by a unit test.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. Gateway code, one grants-only migration (no table or column change, no data rewrite),
  tests. No new route. The OAuth callback gains encryption and fail-closed storage; disconnect gains a token wipe
  and a vendor revoke.
- **Scope:**
  - Gateway: `routes/wearables.ts`, `routes/wearables-repository.ts`, `routes/connector-webhooks.ts`,
    `routes/connector-webhooks-repository.ts`, `connectors/types.ts`, `connectors/wearable/{fitbit,oura,strava,terra,vital}.ts`.
  - New: `lib/connection-token-crypto.ts`, migration `supabase/migrations/<ts>_vtid_<wp>_user_connections_token_grants.sql`.
  - Tests under `services/gateway/test/`, the evidence pack, `docs/programs/health-hub/STATUS.md`.

## Facts (origin/main 421f9d3; live DB read-only 2026-10-10)
1. `user_connections.access_token`/`refresh_token` are plain TEXT
   (`supabase/migrations/20260417000000_vtid_02100_connector_framework.sql` L61-62).
   `routes/wearables.ts` L212-213 writes the OAuth tokens raw via `repo.upsertOAuthConnection`.
2. **Live grants:**
   - `authenticated` holds SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on the table, including
     column SELECT/INSERT/UPDATE on both token columns.
   - `anon` holds SELECT, REFERENCES, TRIGGER and TRUNCATE, including column SELECT on both token columns.
   - Policies are `select_own`, `insert_own` and `update_own` for `authenticated`, plus ALL for `service_role`
     (migration L264-273, L301). There is no anon policy, so RLS currently yields anon zero rows.
3. **Live data:** 1 row in total (connector `claude`, category `ai_assistant`). 0 rows hold an access_token,
   0 hold a refresh_token. So there is no stored token to migrate.
4. **No client reads or writes the table.**
   - vitana-v1: grep of `src/` and `supabase/` finds no reference to `user_connections`.
   - Gateway: every caller of the 9 repository modules that touch the table uses the service-role client.
     None of them uses `createUserSupabaseClient` (`lib/supabase-user.ts`).
   - The only DB function is `user_connections_bump_updated` (trigger `trg_user_connections_updated`,
     not SECURITY DEFINER).
5. **Disconnect never clears or revokes tokens.**
   - `POST /api/v1/wearables/disconnect/:connector` (`wearables.ts` L234-246 → `wearables-repository.ts` L38-40)
     sets only `is_active=false` and `disconnected_at`.
   - The vendor `auth.revoked` webhook path (`connector-webhooks.ts` L133-136) flips `is_active=false` the same way.
   - No connector has a revoke method (`connectors/types.ts` L129-165).
6. Nothing in the gateway reads the `user_connections` token columns today. The only token reader,
   `connectors/runtime/dispatcher.ts`, loads from `social_connections`, a different table (out of scope).
7. An AES-256-GCM helper already exists: `lib/ai-credential-crypto.ts`, keyed by `AI_CREDENTIALS_ENC_KEY`
   (32-byte hex).
   - It is used by `ai_assistant_credentials` and `connected-apps/apple-store.ts`.
   - Staging wires the key from Secrets Manager `vitana/gateway/staging/credentials-enc-key`
     (`AWS-STAGE-DEPLOY-GATEWAY.yml` L248). From the repo it cannot be confirmed that production carries the key.
8. The callback's error redirect puts the raw exception message in the URL: `reason=${encodeURIComponent(message)}`
   at `wearables.ts` L227-229.
9. Migrations reach the single shared database only through manual `RUN-MIGRATION.yml` dispatch.
   `MIGRATION-DRIFT-CHECK.yml` runs on PRs.

## Changes
1. **Grants migration** (grants and policies only; idempotent):
   - `REVOKE ALL ON public.user_connections FROM anon;`
   - `REVOKE ALL ON public.user_connections FROM authenticated;`
   - No re-grant. No client uses either role on this table (Fact 4), so all access is `service_role` only. This avoids
     the column-grant maintenance trap, where every future column would need its own GRANT (round-1 F6/Q1).
   - `DROP POLICY IF EXISTS user_connections_insert_own` and `user_connections_update_own`. `select_own` stays: it is
     inert without a grant, and nothing is deleted that is not needed.
   - `service_role` is unchanged.
   - The file header records the live grant state found (Fact 2) and the rollback statement.
2. **Encryption at rest, reusing the existing helper (Fact 7)** — no new key, no new KMS integration.
   - `lib/connection-token-crypto.ts` is a **new serialization adapter** over the existing primitives (round-1 F1).
     - `sealToken(plain)` calls `encryptApiKey` and packs `iv (12 B) ‖ tag (16 B) ‖ ciphertext` into
       `enc:v1:<base64>`.
     - `openToken(stored)` checks the prefix, base64-decodes, rejects any payload shorter than 28 B, splits at the
       fixed offsets 12/28 and calls `decryptApiKey`.
     - It exports `isTokenCryptoConfigured()`, an alias of `isCredentialCryptoConfigured()`, with a comment that the
       shared `AI_CREDENTIALS_ENC_KEY` is a deliberate interim choice (round-1 F5). A dedicated key and a rotation
       runbook are deferred.
   - `openToken` returns `null` for anything that is not `enc:v1:` or that fails authentication. It never returns
     plaintext it did not decrypt.
   - Values go into the existing TEXT columns, so there is no schema change.
   - Because there are no stored tokens (Fact 3), no backfill is needed.
   - The program plan's wording "KMS migration" is satisfied as follows: the key lives in Secrets Manager (KMS-backed),
     and the one-time migration has zero rows to convert.
3. **Fail closed at connect.**
   - In `/callback/:connector`, if `isCredentialCryptoConfigured()` is false, nothing is stored. The member is
     redirected with `reason=storage_unavailable` and an OASIS event `connector.wearable.token_storage_unavailable`
     is emitted.
   - Otherwise both tokens are sealed before `upsertOAuthConnection`.
4. **Error codes, not messages (Fact 8).** The callback error redirect carries a fixed code
   (`exchange_failed` | `storage_unavailable` | the provider's own `error` param, already a code). The message is
   only logged.
5. **Disconnect clears and revokes.**
   - `disconnectUserConnection` sets `access_token=null`, `refresh_token=null`, `token_expires_at=null`,
     `is_active=false` and `disconnected_at`. The `auth.revoked` webhook path clears the same three columns.
   - Order: load the row's sealed tokens and `provider_user_id` into memory (service role), **clear the DB first**,
     then await the new optional `Connector.revokeAccess(ctx)` with a single 5 s total bound before responding.
     Local state is safe even if the vendor hangs (round-1 Q3).
   - `revokeAccess` reports `no_token` without any network call when its required identifier (an opened token, or
     `provider_user_id` for Terra/Vital) is missing (round-1 F4).
   - Terra/Vital widget connections never store OAuth tokens in this table. Their rows legitimately stay token-null,
     including after an `auth.completed` reconnect; this is documented in code (round-1 F3).
   - The vendor result is recorded as OASIS `connector.wearable.vendor_revoke` with status
     ok | failed | unsupported | no_token.
   - A vendor failure never blocks the disconnect; local tokens are always cleared.
6. **Vendor revoke implementations** (vendor docs checked 2026-10-10), each with its request shape pinned by a unit
   test using mocked `fetch`:
   - **Terra:** `DELETE https://api.tryterra.co/v2/auth/deauthenticateUser?user_id=<provider_user_id>`, headers
     `dev-id` and `x-api-key`. This is documented; a 404 for an unknown user is reported as `ok`, since the user is
     already gone.
   - **Vital (Junction):** `DELETE {vitalBaseUrl()}/user/{user_id}/{provider}` (`vitalBaseUrl()` already ends in `/v2`), header `x-vital-api-key`. This is
     documented. If the provider slug is not stored, the result is `unsupported`.
   - **Strava:** `POST https://www.strava.com/oauth/deauthorize` with `access_token`. The URL is confirmed by
     client libraries; the request shape is re-checked against developers.strava.com at implementation.
   - **Fitbit:** `POST https://api.fitbit.com/oauth2/revoke` (RFC 7009, Basic client auth). This is documented, but
     the legacy Web API was deprecated in September 2026, so the call is best-effort and a failure is reported as
     `failed`.
   - **Oura:** Oura documents no revoke endpoint, so it reports `unsupported` rather than calling an undocumented URL.
   - A connector that cannot revoke reports `unsupported`. It never throws.
7. **Tests** (`test/vtid-<wp>-connection-tokens.test.ts`):
   - seal/open round trip; tamper (ciphertext, iv or tag byte) → null; truncated (< 28 B) → null; wrong prefix or
     plaintext → null; no key → seal returns null.
   - Callback with no key → no upsert, redirect code `storage_unavailable`.
   - Callback with key → the upserted tokens start with `enc:v1:` and never equal the raw values.
   - Callback exception → the redirect contains no exception text.
   - Disconnect → the update clears all three token columns; `revokeAccess` is called with the opened token.
     A vendor rejection or timeout still returns `ok` and still clears the tokens.
   - Webhook `auth.revoked` → the patch clears the token columns.
   - One request-shape test per vendor revoke.
   - A static migration test: the file revokes ALL from anon and authenticated, never grants a token column, and
     drops the insert/update policies.
   - A source scan: no `access_token:`/`refresh_token:` write into `user_connections` outside `sealToken` output.

## Rollout and the production database
- **Code** follows merge → staging → STAGING-VERIFY → Gate 2 → publish.
- **The migration is a production write** (shared DB, Fact 9). It is not applied at merge. It is listed in the
  Gate 2 message under "migrations in the release" and applied with `RUN-MIGRATION.yml` only after the owner's
  "yes", before or alongside the gateway publish.
  - Applying it is safe in either order relative to the code: no client uses the revoked grants (Fact 4).
- **Post-apply check, read-only** (a database read, not a test suite against production): the same
  `information_schema` grant query as Fact 2 must show no privilege for `anon` or `authenticated` on the table.
  This is the check that actually proves the grant change. Staging cannot prove it before the owner's "yes",
  because applying the migration is the production write (round-1 F2).
- **Production key check before publish:** the Gate 2 message states whether the production task definition carries
  `AI_CREDENTIALS_ENC_KEY`. If it does not, connects fail closed with `storage_unavailable`, which is the intended
  safe state. It is reported, not silently accepted.

## Staging verification (read-only)
- HTTP: unauthenticated `GET /api/v1/wearables/connections` → 401 JSON.
- Playwright, signed in as the test user: `GET /api/v1/wearables/connections` → 200 and
  `GET /api/v1/wearables/connectors` → 200. No connect, no disconnect, no writes.
  - This is a regression check that the touched router still serves. It is **not** a grant test: the endpoint
    already selects non-token columns (round-1 F2).
- The grant change is proven by the static migration test in CI and by the post-apply `information_schema` check
  above.
- Existing: `npx jest` on the new suite and the connector suites.

## Not in scope
- `social_connections` tokens (Fact 6): own finding. It is recorded in STATUS.md as a follow-up for a separate plan.
- D2 webhook verification, D5 erasure (bucket, inbox, webhook log): own WPs.
- Rotating `AI_CREDENTIALS_ENC_KEY`, or a dedicated key for health tokens: deferred. It is recorded in STATUS.md.

<!-- plan:end -->
