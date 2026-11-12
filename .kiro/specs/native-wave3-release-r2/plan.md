# Plan — native-wave3-release-r2
Author: Kiro, seat `exafyltd`. Repos: `exafyltd/vitana-v1` (native app `apps/mobile/`, web bridge `src/`) and
`exafyltd/vitana-platform` (gateway metric, this spec). Program: `docs/programs/native-app/NATIVE-APP-PLAN.md`
(VTID-05021), Wave 3 row at `vitana-v1:docs/programs/native-app/NATIVE-APP-PLAN.md:199`. Spec: `handoff.md`,
`tasks.md`, `lanes/*.md` in this folder.

<!-- plan:begin -->
Re-plan note (2026-11-08T12:30Z): this is the plan of `native-wave3-release` (PR #4770) under a new slug, because the old branch carries `_plan` commits from two Kiro sessions (the original author and the session that answered its sparring), which Collab handoff refuses for a `_plan` lane. Content is the version that converged there (session 1d3959ab-0249-4d15-81ec-1f39154fce6f, 2026-11-08), incl. its sparring answers; unchanged except the slug and the lane-file fixes: the migration is `supabase/migrations/<ts>_client_identity_daily_seen.sql` (not `database/migrations/`), `client_identity_daily_seen` carries `tenant_id` in its primary key `(day, tenant_id, user_id, client_class)` (old round 2, R2-F1 and R2-F2), and the lane `client-identity-gateway` lane file carries the classifier-only goal text of tasks G1-G2.
## Goal
Take the native Maxina app from the Wave 2 screen ports to a released app: an internal and closed-track beta with
staff and volunteer members, store review, a phased rollout (1 → 10 → 50 → 100 %) and the retirement of the Appilix
wrapper once native use reaches the adoption threshold. Exit criteria, quoted from the program row: **≥95 % of active
mobile members on native; crash-free sessions ≥99.5 %.**

This plan builds only what can be built and verified in the repositories today. Everything that needs an owner-held
account, key or decision is written as an owner-gated lane (`next_actor: owner`) and is not built here: App Store
Connect (team `62Q26QSEJW`), Play Console, the Android upload and signing key, EAS cloud builds (gate G3,
`NATIVE-APP-PLAN.md:118`), the payment classification (§8 decision 4), and the crash-reporting SDK and Firebase
ownership (§8 decision 5). The store submissions themselves are performed by the owner in the consoles.

## Today (measured on `exafyltd/vitana-v1` origin/main `663d09a34`)
- **Wave 2 has not exited.** `apps/mobile/parity/ledger.json` holds 435 rows: 312 `not_started`, 121 `native`, 2
  `exception`. The Wave 2 exit (`NATIVE-APP-PLAN.md:198` row: "every in-scope ledger row native and parity-checked")
  is not met, so Wave 3 cannot exit. The sentinel lane `prereq-exit` records this gate.
- **Wave 1 is not complete on main.** Only the `build-profiles` lane of `native-g1-wiring` is merged (vitana-v1 PR
  #1615, merge `663d09a34`). `tools/fixture-gateway/` does not exist on main. The G1 test backend is an owner gate
  (`NATIVE-APP-PLAN.md:95`, §2a). The Health Sync module (contract v1, Wave 1 row `:196`) has no code in
  `apps/mobile/src`.
- **No store declarations exist.** `apps/mobile/app.config.ts` has no HealthKit or Health Connect entries and no iOS
  privacy manifest (`ios.privacyManifests`). `apps/mobile/app.config.ts:34` and `:37` throw on a missing or production
  `APP_PROFILE`; these guards stay unchanged. The app has no StoreKit or Play Billing dependency.
- **No crash-reporting SDK is wired.** A search of `apps/mobile/src`, `package.json` and `app.config.ts` for
  Sentry, Crashlytics and Bugsnag finds no import.
- **The web app still carries the Appilix bridge.** 106 files under `vitana-v1:src/` reference Appilix (for example
  `src/App.tsx`, `src/components/AppLayout.tsx`, `src/components/PushDiagnostics.tsx`). Their removal is the
  `appilix-retire` lane and waits for the adoption threshold.
- **Remote config exists.** `apps/mobile/src/config/remote-config.ts` reads `GET /api/v1/app-config` (per-platform
  flags and a minimum supported version, fail-safe to defaults). It is the in-app kill switch and the forced-update
  path, and the rollout runbook uses it.
- **Nothing measures native share today.** The app does not send a client-identity header that the gateway can
  count, so the adoption threshold (≥95 %) cannot be measured. Lanes `client-identity-app`,
  `client-identity-gateway` and `client-identity-store` add that.

## Decisions (each decided by Kiro, grounded in the cited code)
1. **Wave 3 is gated, not started in parallel with its prerequisites.** Every lane that changes store-facing or
   release-facing code depends on `prereq-exit`. `prereq-exit` passes only on machine evidence (the ledger check
   and the Wave 1 exit smoke). Reason: store review and phased rollout on a half-ported app would ship a product the
   program row does not allow.
2. **Adoption is measured by a client-identity header plus gateway counting, not by Appilix or user agents.** The app
   adds `X-Vitana-Client` (`native/<platform>/<version>`) to gateway calls from `src/config/http.ts`. The gateway
   middleware (lane `client-identity-store`, `services/gateway/src/middleware/client-identity.ts`, using the pure
   classifier of lane `client-identity-gateway`; mounted once in `src/index.ts` after
   `delegatedTokenGuard()`, line 640) classifies every request: a well-formed `X-Vitana-Client: native/...` is
   `native`, anything else (missing, malformed) is `web`. **Mechanism (sparring R1-F1, R1-F2):** authentication is per route (`req.identity` is set by the route-level middleware of `auth-supabase-jwt.ts`, for example lines 422, 453, 775, 859), so at the global mount point `req.identity` is not yet set. The middleware therefore (a) sets `X-Vitana-Client-Class` synchronously with `res.setHeader` before `next()`, so it is present on every response including errors, and (b) registers `res.on('finish')` and reads `req.identity` there, after the route chain has run; it records one row only when `req.identity` is then set (`user_id`, `tenant_id`), otherwise nothing. No JWT is decoded or verified in the middleware. For an authenticated request it records one row per
   (day, member, class) in a new table `client_identity_daily_seen`. The `appilix` class is **derived per member**,
   not per request: a member is `appilix` when they hold an un-revoked `user_device_tokens` row whose `device_label`
   starts `Appilix ` (the label the wrapper registers, `vitana-v1:src/lib/pushNotifications.ts:284`; the existing
   gateway query is `scheduled-notifications-repository.ts:365-372`) and have no `native` row in the window. Reason:
   the wrapper sends no distinguishing request header and the user agent is not a reliable signal (the only Appilix UA
   use is the push label, and `routes/orb-livekit.ts:764` uses a loose regex), so the only grounded Appilix signal is the
   push registration. Adoption = members with a `native` row in the last 7 days divided by members with a `native`
   row or (an Appilix token and any row) in the last 7 days. Plain-web members without an Appilix token are not
   "mobile" and are outside the denominator. Rejected: a separate analytics SDK (a new third-party dependency that
   needs owner approval); a new header from the web app (gateway calls are spread over many hooks, for example
   `src/hooks/useChatApi.ts`, so it would touch dozens of files).
   **Storage and privacy.** `client_identity_daily_seen(day date, tenant_id uuid, user_id uuid, client_class text,
   primary key (day, tenant_id, user_id, client_class))`, RLS on with no policy (service role only), rows older than 35 days
   deleted by the gateway. It holds `tenant_id` (from the authenticated identity, so the adoption count is per tenant like `user_device_tokens`, `scheduled-notifications-repository.ts:365-372`) and `user_id` because the join to device tokens and the distinct count need them; only
   aggregates leave the table (the owner-run query). Writes are best effort and de-duplicated in memory (one upsert
   per member, class and day per instance); a failed write never fails or delays the request. Applying the migration is
   an owner-approved step (`collaboration.md` §7d); until it is applied the middleware's write fails soft and the
   classification still works.
3. **Crash-free sessions use a provider-agnostic port first.** `crash-port` (`apps/mobile/src/telemetry/`) defines
   session start and end and a crashed-session flag, with a no-op default, the same pattern as
   `apps/mobile/src/push/provider.ts:53` (`setPushProvider`). The SDK behind it is an owner decision (`crash-sdk-owner`). Reason:
   the metric and its tests can ship before the vendor choice, and no SDK is added without the owner.
4. **Health store declarations declare only the data the Health Sync module reads.** `store-declarations` writes the
   iOS HealthKit usage strings and the Android Health Connect permission entries from the Health Sync contract
   (Wave 1), nothing more. Reason: least privilege; the store reviewer checks the declared types against the
   runtime use. The strings are catalog entries in 11 locales (de first, du-form), never hardcoded.
5. **Rollout uses the stores' own staged rollout plus the remote-config kill switch.** The 1 → 10 → 50 → 100 %
   ramp is run by the owner in App Store Connect (phased release) and Play Console (staged rollout). The in-app
   control is `remote-config.ts`. Halt rule: crash-free sessions below 99.5 % on the current ramp step stop the ramp.
   Reason: no in-repo rollout mechanism is needed, and the consoles already provide one.
6. **Appilix retirement waits for measured adoption.** `appilix-retire` opens only when the gateway count shows ≥95 %
   of active mobile members on `native` for the rollout's last step and the crash-free gate holds. Reason: the
   program row ties the removal to an adoption threshold, and removing the bridge early would strand members who
   have not updated.
7. **No Wave 3 lane edits `.github/**`.** EAS cloud builds and store-submission workflows need a governance-path
   lane (`executor: claude`) and G3, so they are owner-gated and not in this spec. Reason: keeps every buildable lane
   `executor: kiro` with a reviewer agent (`collaboration.md` §3a).
8. **Cross-repo work is one lane per repo.** The adoption metric is split into `client-identity-app`
   (vitana-v1) and, on vitana-platform, `client-identity-gateway` (pure classifier) and `client-identity-store`
   (middleware, mount, table, adoption query; depends on the classifier), because a lane has one branch and PR (the rule in
   `native-g1-wiring` `plan.md`, R1-F4).

## Lanes
| Lane | Repo | Executor / seat → reviewer | Scope | depends_on | next_actor |
|---|---|---|---|---|---|
| `prereq-exit` | vitana-v1 | kiro / exafyltd → hotmail | `docs/validation/native-wave3/prereq-exit.md` | — | kiro |
| `client-identity-app` | vitana-v1 | kiro / exafyltd → hotmail | `apps/mobile/src/config/client-identity.ts`, `apps/mobile/src/config/http.ts`, `apps/mobile/tests/client-identity*` | — | kiro |
| `client-identity-gateway` | vitana-platform | kiro / exafyltd → hotmail | `services/gateway/src/services/client-identity/**`, `services/gateway/test/client-identity*` (the pure classifier only) | — | kiro |
| `client-identity-store` | vitana-platform | kiro / exafyltd → hotmail | `services/gateway/src/middleware/client-identity.ts`, `services/gateway/src/index.ts`, `services/gateway/src/services/client-adoption/**`, `supabase/migrations/*_client_identity_daily_seen.sql`, `DATABASE_SCHEMA.md`, `services/gateway/test/client-adoption*` | client-identity-gateway | kiro |
| `crash-port` | vitana-v1 | kiro / exafyltd → hotmail | `apps/mobile/src/telemetry/**`, `apps/mobile/tests/telemetry/**` | — | kiro |
| `store-declarations` | vitana-v1 | kiro / exafyltd → hotmail | `apps/mobile/app.config.ts`, `apps/mobile/src/i18n/*/healthStore.json`, `apps/mobile/tests/store/**`, `docs/validation/native-wave3/store-declarations.md` | prereq-exit | kiro |
| `beta-rollout-runbook` | vitana-v1 | kiro / exafyltd → hotmail | `docs/validation/native-wave3/beta-rollout-runbook.md` | prereq-exit | kiro |
| `store-submission-owner` | vitana-v1 | owner (G3) | `docs/validation/native-wave3/store-submission.md` | prereq-exit, store-declarations | **owner** |
| `iap-decision-owner` | vitana-v1 | owner (§8 decision 4) | `docs/validation/native-wave3/iap-decision.md` | prereq-exit | **owner** |
| `crash-sdk-owner` | vitana-v1 | owner (§8 decision 5) | `docs/validation/native-wave3/crash-sdk.md` | crash-port | **owner** |
| `appilix-retire` | vitana-v1 | kiro / exafyltd → hotmail (after owner gate) | set when the owner opens the gate (see below) | client-identity-gateway, store-submission-owner, beta-rollout-runbook | **owner** |

`appilix-retire` keeps `client-identity-gateway` in its `depends_on` (its lane file keeps it); the owner's gate (task A1)
additionally requires `client-identity-store` to be `done`, because the count comes from there.
`appilix-retire` has no `paths` yet on purpose. Its file list is the 106-file bridge inventory above, and it is fixed
when the owner opens the gate, against the measured adoption. A `ready` lane with no `paths` is not claimable while
`next_actor` is `owner`.

**Owner gates (not built here).** `store-submission-owner` covers G3: the owner confirms App Store Connect and Play
Console access and the Android signing key (`NATIVE-APP-PLAN.md:118` and §8 decision 2 at `:219`). `iap-decision-owner`
covers the payment classification per purchase type, which decides whether StoreKit or Play Billing is introduced
(§8 decision 4 at `:221`; §2 item 5 at `:86`). `crash-sdk-owner` covers the crash SDK and Firebase ownership (§8
decision 5 at `:222`). None of these
lanes builds, provisions or submits anything in this plan.

**Parallelism.** Lanes with no `depends_on` (`client-identity-app`, `client-identity-gateway`, `crash-port`,
`prereq-exit`) run at once. `store-declarations` and `beta-rollout-runbook` start when `prereq-exit` is done. Hot
files: `apps/mobile/app.config.ts` is edited only by `store-declarations`; `apps/mobile/src/config/http.ts` only by
`client-identity-app`. No two lanes share a path.

## Tests and verification
- Each app lane runs `cd apps/mobile && npm ci && npm test && npm run typecheck` and the offline bundle for the
  `development` and `test-g1` profiles. No lane runs a store build.
- `client-identity-gateway` runs the classifier unit tests (Jest). `client-identity-store` runs the middleware and the
  count query tests over an in-memory store, and proves the classification with a read-only probe on staging (an unauthenticated request to a public route; the
  middleware echoes `X-Vitana-Client-Class` on the response and records nothing without an identity) (`docs/validation/<VTID>/staging-tests.json`). It writes nothing to the production database.
- `store-declarations`: a test checks that every HealthKit and Health Connect type declared in `app.config.ts` appears
  in the Health Sync contract, and that every user-visible string exists in all 11 locales (de first).
- `crash-port`: unit tests for session start and end, crashed-session flagging, and the no-op default.
- Every lane that changes a member-visible surface adds a read-only staging spec, or records
  `not verified on staging: <reason>` with the test that covers it (`.kiro/pipeline/quality-checks.md`).
- Test accounts follow the rule in `vitana-v1/CLAUDE.md` (the absolute rule against testing on production). Staging
  specs are read-only; no lane writes to production.

## Measurement
- Adoption: `native` share of active mobile members over the last 7 days, from the `client-identity-store` counts.
  Threshold: ≥95 % (program row). Reported in `docs/validation/native-wave3/adoption.md` by the owner-run query, never
  from a session tool against production.
- Crash-free sessions: from `crash-port` once `crash-sdk-owner` picks an SDK. Threshold: ≥99.5 %.
- Ramp: each step's crash-free rate and adoption share are recorded in the rollout log before the next step opens.

## Risks
- **Wave 2 and Wave 1 slip.** The sentinel holds Wave 3 back. Cost: the store dates move with Wave 2.
- **Health declarations drift from runtime use.** Store rejection or a privacy incident. Mitigation: the contract
  test in `store-declarations`.
- **Adoption counting is wrong.** An Appilix member could be counted as `native`, or a member with no push token
  could be missed from the denominator. Mitigation: the tests cover a native-only, an Appilix-only, a both and a
  plain-web member, and `appilix-retire` waits for the owner's review of the counts. Known limit: an Appilix member
  without a push token is not in the denominator; the owner reads the counts with that in mind.
- **`src/index.ts` is a hot file.** Only `client-identity-store` edits it in this plan; any other plan touching it is
  sequenced by the merge rule (§8a).
- **Crash SDK choice delays the crash-free gate.** Mitigation: the port ships first with a no-op default, so the
  metric is built before the vendor is chosen.

## Unchanged
The parity method (`NATIVE-APP-PLAN.md` §4), the production guards in `app.config.ts` and `env.ts`, the
`assertNotProduction` gate, the ledger scope rules, the sidebar and What's New rules, the i18n rules, and
the rule that no native build or test touches production. This plan changes no existing behaviour of the web app
except the Appilix removal, which is gated and not opened by this plan.
<!-- plan:end -->
