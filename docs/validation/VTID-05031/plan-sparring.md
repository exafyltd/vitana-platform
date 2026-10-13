# Plan sparring record — VTID-05031 (Health Hub WP3 / D2)

- **Parent program:** VTID-05020 (Health Hub plan r7, §1 D2, §5 Phase 0).
- **Sparring session:** `plan_sparring_sessions.id = f2d03052-6b0b-4774-9cb8-b1355dffa639`; VTID allocated with `p_sparring_id`.
- **Partner:** `plan-sparring-partner` agent (read-only, independent). **Rounds:** 2. **Verdict:** CONVERGED.
- **Plan hashes:** round 1 `0711573ff4483d484dd2f60bec7d7152396e3ba332dd027bbfa0e7655752e859`, **final `42b07613b43dac083696651698d067154b81fd2a0b618ea3dae903609b5b3dc1`**.
- **Approval basis:** the owner's Gate 1 approval of the program plan ("Yes to both plans", 2026-10-10). D2 is in the approved plan.
- **Process note (recorded on purpose):** to keep throughput, the planner drafted the code locally while round 1 ran.
  It was uncommitted, unpushed and had no VTID. Nothing was committed or allocated before the partner converged. The
  partner saw the draft and verified it against the plan.

## Round 1 — CONVERGED (minors only)

Facts 1–7 were verified (Fact 2 and Fact 7 as of the baseline commit; Fact 6 is plausible from the code).

| # | Sev | Finding | Answer |
|---|-----|---------|--------|
| F1 | minor | The code already exists on disk before sparring. | Accepted as a process record (above). |
| F2 | minor | `express.raw` `type: '*/*'` is broader than the Stripe precedent. | Accepted: a comment explains the choice. |
| F3 | minor | `some()` short-circuits in `verifySvix`. | Accepted: a comment documents that this matches Svix's libraries. |
| F4 | minor | The Svix test vector carries no URL. | Accepted: the URL is cited in the test. |
| Q2 | — | Terra Vantage header. | No evidence it is ever sent. A Monitoring section was added: it would surface as `signature_missing`. |

## Round 2 — CONVERGED

All findings closed; no new findings.

## Final plan

<!-- plan:begin -->

## Meta
- **Change class:** standard. Gateway code and tests. No migration, no new route.
- **Behaviour changes:**
  - Webhooks with no configured secret are rejected (401) instead of accepted.
  - The connector webhook route receives the raw body bytes.
- **Scope:**
  - `src/index.ts`: one raw-body mount line, before `express.json()`.
  - `routes/connector-webhooks.ts`.
  - `connectors/wearable/terra.ts`, `connectors/wearable/vital.ts`, `connectors/health/doctorbox.ts`.
  - New `connectors/runtime/webhook-signature.ts`.
  - Tests, evidence pack, STATUS.md.

## Facts (origin/main 6c275e7; live DB read-only 2026-10-10)
1. **The verifiers fail open when their secret is unset.** Each returns `true` and logs a warning:
   - Terra: `terra.ts` L53-57, `TERRA_WEBHOOK_SECRET`.
   - Vital: `vital.ts` L48-51, `VITAL_WEBHOOK_SECRET`.
   - DoctorBox: `doctorbox.ts` L52-55, `DOCTORBOX_WEBHOOK_SECRET`.
2. **The route never sees the raw bytes.**
   - `index.ts` L589 mounts `express.json()` globally.
   - Raw parsers exist only for the Stripe and SNS paths (L580-586).
   - `connector-webhooks.ts` builds `rawBody` as `JSON.stringify(req.body)` when the body is an object (L27-31), and
     verifies the HMAC over that re-serialized string.
   - Terra's docs say verification needs the unmodified raw body, and Svix's say the same. So with a secret set, a
     genuine vendor signature fails whenever the re-serialization differs from the sent bytes.
3. **Terra.**
   - Signature header `terra-signature: t=<unix seconds>,v1=<hex>`; signed payload `${t}.${raw_body}`; HMAC-SHA256
     (`terra.ts` L59-72, matching the vendor docs).
   - The parser keeps only the last `v1` (reduce into an object). The vendor says to compare against each received
     signature.
   - There is no timestamp tolerance; the vendor says to check the age.
4. **Vital (Junction).** Vital delivers webhooks via Svix (`vital.ts` comment L56). Our verifier instead:
   - signs only `raw_body`, not `${svix-id}.${svix-timestamp}.${body}`;
   - uses the secret string as the key, not the base64-decoded part after `whsec_`;
   - has no timestamp tolerance (`vital.ts` L58-69).
   So it can never validate a real Svix delivery.
5. **DoctorBox.** `x-doctorbox-signature` is a hex HMAC-SHA256 of the raw body (`doctorbox.ts` L32-60). The file
   documents that no real vendor spec exists (sandbox only).
6. **Live traffic (read-only):** `connector_webhooks_log` holds 3 rows in total, the last on 2026-04-16 (one Terra and
   one Vital with `signature_valid=true`, one unknown connector). Failing closed therefore affects no current traffic.
7. **Route results.** On `result.valid=false` the route logs the row with `event_type='invalid'` and answers.
   On a handler throw it logs `handler_error` and answers 500 **with the exception message in the body**
   (`connector-webhooks.ts` L69-80).

## Changes
1. **Raw body.** `app.use('/api/v1/connectors/webhook', express.raw({ type: '*/*', limit: '2mb' }))`, mounted next to
   the Stripe/SNS raw mounts and before `express.json()`.
   - The route already handles a Buffer body (L28-30) and parses JSON from it (L33-38).
   - It now always verifies over those exact bytes. A JSON parse failure still logs `{ raw }` as today.
2. **Shared verifier, `connectors/runtime/webhook-signature.ts`** (pure functions, injectable `now`):
   - `verifyTerra(raw, header, secret, now)`:
     - parse every `v1` entry;
     - require a numeric `t` within ±300 s of `now`;
     - HMAC-SHA256 hex over `${t}.${raw}`;
     - constant-time compare against each `v1`.
   - `verifySvix(raw, { id, timestamp, signature }, secret, now)`:
     - the key is base64-decode of the part after `whsec_` (a secret without the prefix is decoded as base64 too,
       per Svix);
     - require a timestamp within ±300 s;
     - HMAC-SHA256 base64 over `${id}.${timestamp}.${raw}`;
     - accept if any space-separated `v1,<sig>` matches (constant time).
   - `verifyHexHmac(raw, header, secret)` for DoctorBox: unchanged semantics, constant time, with a length guard.
   - **Every function returns `false` when the secret is empty or unset. Fail closed, with no dev-mode bypass.**
3. **Connectors.** Terra, Vital and DoctorBox call the shared functions.
   - Vital reads `svix-id`, `svix-timestamp` and `svix-signature`. The non-Svix `vital-signature` fallback is
     removed: it cannot carry a valid Svix signature.
   - A missing secret returns `{ valid: false, error: 'secret_not_configured' }`. A bad signature returns
     `signature_invalid`, and a stale timestamp returns `timestamp_out_of_tolerance`.
4. **Route.**
   - An invalid result answers **401** `{ ok: false, error: <code> }` and is logged as today.
   - A handler throw answers 500 `{ ok: false, error: 'handler_error' }`. The message is kept only in the log row.
5. **Tests** (`test/vtid-<wp>-webhook-verification.test.ts`):
   - Terra: valid; a tampered body; a wrong secret; a second `v1` that matches; a timestamp older or newer than
     300 s; a missing `t`; an unset secret → false.
   - Svix: valid with a `whsec_` secret (vector built with the documented algorithm); multiple signatures; a wrong
     id; a stale timestamp; an unset secret → false.
   - DoctorBox: valid; invalid; unset → false.
   - A source scan: no `return true` in any verifier when the secret is missing.
   - Route (supertest, mounted with the same raw parser): a JSON body whose whitespace differs from
     `JSON.stringify` still verifies with Terra, which proves the raw bytes are used. An invalid signature → 401 and
     a log row. A handler throw → 500 without the message.

## Staging verification (read-only)
- Any POST to the webhook route writes an audit row to `connector_webhooks_log` in the shared database, even a
  rejected one (Fact 7). So the staging suite makes **no POST probe**.
- **HTTP:** `GET /alive` (smoke) only.
- **Existing:** the new Jest suite runs as the change suite's `existing` entry. It proves verification over raw bytes,
  fail-closed and the 401/500 behaviour, with no write to any shared system.

## Rollout notes
- If the production or staging task definitions do not carry the three webhook secrets, deliveries are rejected
  (401) after deploy. Vendors retry, and today's traffic is zero (Fact 6). The Gate 2 message states this.
- No migration.

## Monitoring
- A rejected delivery is logged in `connector_webhooks_log` (`event_type='invalid'`, `process_error=<code>`).
- If Terra ever sends its Vantage-API header (`X-Terra-Signature`, milliseconds), it surfaces there as
  `signature_missing`. That is the signal to extend the verifier, not to loosen it.

## Not in scope
- Webhook log retention and erasure (D5): own WP.
- Terra's "Vantage API" variant (`X-Terra-Signature`, milliseconds): not used by this connector (see Monitoring).

<!-- plan:end -->
