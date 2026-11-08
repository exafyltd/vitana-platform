# Tasks — native-wave3-release-r2

One PR per lane. Each lane lives in one repo (`vitana-v1` or `vitana-platform`), so its branch is
`kiro/native-wave3-release-r2/<lane-id>` and its title is `VTID-xxxxx (native-wave3-release-r2/<lane-id>): …`, with the
trailers `Collab-Session` and `Collab-Lane`. A lane changes only its `paths`. VTIDs are assigned by CI after PLAN-SPAR
converges. Do not start a lane before its `vtid:` is set. Owner-gated lanes (`next_actor: owner`) are not built by any
session. Every app lane runs `cd apps/mobile && npm ci && npm test && npm run typecheck`, then the offline bundle for
`APP_PROFILE=development` and `APP_PROFILE=test-g1`. Every user-visible string goes in all 11 locales, de first in
du-form. No store build, no signing, no credential, no production host.

## Prerequisite gate — sentinel
<!-- lane: prereq-exit -->
- [ ] P1 Record the Wave 2 exit: run `node scripts/native/parity-ledger.mjs --check` on `origin/main`, and write the
  in-scope row count per status to `docs/validation/native-wave3/prereq-exit.md`. Done only when zero in-scope rows
  are `not_started`.
- [ ] P2 Record the Wave 1 exit: link the merged `deep-link-push-smoke` lane and the Health Sync module (contract v1)
  on `origin/main`, with its test, in the same file. A missing item stays a blocker; the lane is not marked done.

Acceptance:
- Change types: Tooling/docs
- Outcome: the lanes that depend on `prereq-exit` can be claimed only after the two exits are recorded from machine
  output, not from a claim.
- States: n/a: the lane writes evidence only.
- Surfaces: n/a: no UI or backend change.
- Locales: n/a: no user-visible text.
- Accessibility: n/a: no UI.
- Contract: n/a: no boundary crossed.
- Staging proof: not verified on staging: this lane reads the ledger and the code; the check itself is the proof.

## Client identity — app side
<!-- lane: client-identity-app -->
- [ ] C1 Add `apps/mobile/src/config/client-identity.ts`: build `X-Vitana-Client: native/<platform>/<version>` from
  `Platform.OS` and the app version (`apps/mobile/app.config.ts`), with a test for iOS, Android and the test profile.
- [ ] C2 In `apps/mobile/src/config/http.ts`, send the header on every gateway call. Do not change timeouts, retry or
  the URL guard.
- [ ] C3 Tests under `apps/mobile/tests/client-identity*`: the header is present on gateway calls and absent on
  third-party calls.

Acceptance:
- Change types: Backend (request header), Tooling/docs
- Outcome: no member sees a difference; the gateway can tell native traffic from the Appilix web view.
- States: no version available → header sends `unknown` and the request still goes out.
- Surfaces: n/a: no screen changes.
- Locales: n/a: the header value is not localized.
- Accessibility: n/a: no UI.
- Contract: request header `X-Vitana-Client` on every call from `src/config/http.ts`; response unchanged; the gateway
  lane reads it. `file:line` on both sides.
- Staging proof: the gateway lane's read-only probe proves the classification; not verified on staging for this
  lane alone: the header carries no member data and is covered by the unit tests in C3.

## Client identity — gateway side (classifier)
<!-- lane: client-identity-gateway -->
- [ ] G1 Add `services/gateway/src/services/client-identity/classify.ts`: a pure function from the `X-Vitana-Client`
  header value to `native` (well-formed `native/<ios|android|test>/<version>`) or `web` (missing, malformed or unknown
  platform), exported with its class type. No I/O, no Express import.
- [ ] G2 Tests under `services/gateway/test/client-identity*`: native iOS and Android, a missing header, a malformed
  header, an unknown platform and an unknown version.

Acceptance:
- Change types: Backend, Tooling/docs
- Outcome: one tested definition of the request class that the middleware lane uses; members see nothing.
- States: missing header → `web`; malformed header → `web`.
- Surfaces: backend only; the caller is the middleware of lane `client-identity-store`.
- Locales: n/a: no user-visible text.
- Accessibility: n/a.
- Contract: `classifyClient(headerValue): 'native' | 'web'` with `file:line`. AI calls: none.
- Staging proof: not verified on staging for this lane alone: it is a pure function covered by Jest; the staging probe
  is in `client-identity-store`.

## Client identity — gateway side (middleware, storage, adoption query)
<!-- lane: client-identity-store -->
- [ ] S1 Add `services/gateway/src/middleware/client-identity.ts` using `classifyClient`; mount it once in
  `services/gateway/src/index.ts` after `delegatedTokenGuard()`. It sets `X-Vitana-Client-Class` with `res.setHeader` before `next()` and,
  when `req.identity` is set by the route-level auth by the time `res` emits `finish` (read there, never at mount time; no JWT decode in
  the middleware), records one (day, tenant, member, class) row, best effort, de-duplicated in
  memory per instance, never failing or delaying the request.
- [ ] S2 Add migration `supabase/migrations/<ts>_client_identity_daily_seen.sql` (table
  `client_identity_daily_seen(day, tenant_id, user_id, client_class)`, primary key on all four, RLS on with no policy, 35-day
  purge) and its `DATABASE_SCHEMA.md` entry. Add `services/gateway/src/services/client-adoption/adoption.sql` and
  `adoption.ts`: the read-only adoption counts, where the `appilix` class is a member with an un-revoked
  `user_device_tokens` row labelled `Appilix %` and no `native` row in the window. The migration is applied only after
  the owner approves the file and the target database (`collaboration.md` §7d).
- [ ] S3 Tests under `services/gateway/test/client-adoption*`: header echo, no write without identity, a write
  failure never fails the request, one upsert per member/class/day, and the count query for native-only, Appilix-only,
  both and plain-web members.

Acceptance:
- Change types: Backend, Database (new table, migration file only), Tooling/docs
- Outcome: the owner can read the native share of active mobile members; members see nothing.
- States: table missing (migration not applied) → the write fails soft and the request is unaffected.
- Surfaces: backend only; the middleware runs on every gateway request.
- Locales: n/a: no user-visible text.
- Accessibility: n/a.
- Contract: the middleware, the table and the aggregate output, with `file:line`. AI calls: none.
- Staging proof: a read-only probe on `preview-aws-gateway.vitanaland.com` sends an unauthenticated request with a
  native and with no `X-Vitana-Client` header and checks the echoed `X-Vitana-Client-Class`. It writes nothing; the
  count query is tested in Jest, never against production.

## Crash-free sessions — port
<!-- lane: crash-port -->
- [ ] X1 Add `apps/mobile/src/telemetry/crash-port.ts`: `startSession`, `endSession(crashed)`, and a `setCrashProvider`
  seam with a no-op default, the same pattern as `apps/mobile/src/push/provider.ts:53`.
- [ ] X2 Tests under `apps/mobile/tests/telemetry/`: session start and end, the crashed flag, and that the default
  provider sends nothing.
- [ ] X3 No SDK package is added. The vendor is chosen by `crash-sdk-owner`.

Acceptance:
- Change types: Tooling/docs (app code without UI or network)
- Outcome: none for members; the crash-free metric has a seam to report into once an SDK is chosen.
- States: a provider error is swallowed and logged without throwing into the UI.
- Surfaces: n/a: no screen.
- Locales: n/a.
- Accessibility: n/a.
- Contract: n/a: the port makes no network call.
- Staging proof: not verified on staging: no network path exists before the SDK choice; the covering test is X2.

## Store declarations — HealthKit, Health Connect, privacy manifest
<!-- lane: store-declarations -->
- [ ] S1 In `apps/mobile/app.config.ts`, add the iOS HealthKit usage strings and the Android Health Connect permission
  entries for exactly the data types the Health Sync module (contract v1) reads. Add `ios.privacyManifests` for the
  data the app collects, per the declared Expo config. Keep the production guards at `:34` and `:37` unchanged.
- [ ] S2 Add the usage and rationale strings to `apps/mobile/src/i18n/<locale>/healthStore.json` in all 11 locales,
  de first (du-form). No hardcoded string in `app.config.ts`.
- [ ] S3 Tests under `apps/mobile/tests/store/`: every declared health type is in the Health Sync contract; every
  string key exists in 11 locales; the iOS manifest lists only collected data.
- [ ] S4 Write `docs/validation/native-wave3/store-declarations.md`: the declared types, why each is read, and the data
  map for the Play Data safety form and the App Store privacy labels. Store submission itself is owner-gated.

Acceptance:
- Change types: Tooling/docs, Integration (declarations for the OS health stores)
- Outcome: the app asks for health data only for the types it uses, with a clear reason in the member's language.
- States: permission denied → the app keeps working and the Health Sync module reports no data; no error screen.
- Surfaces: the OS permission sheet only; no new in-app screen.
- Locales: de first (du-form), 11 locales; RTL checked for the permission text if it is shown in-app.
- Accessibility: n/a: OS sheets are system-rendered.
- Contract: `app.config.ts` plugin output for iOS and Android, with `file:line`.
- Staging proof: not verified on staging: store declarations are not observable on a staging build; the covering test
  is S3 plus the owner's store review.

## Beta and rollout runbook
<!-- lane: beta-rollout-runbook -->
- [ ] R1 Write `docs/validation/native-wave3/beta-rollout-runbook.md`: the internal, TestFlight and closed-track cohort
  (staff and volunteer members, named by the owner), the feedback channel, the ramp 1 → 10 → 50 → 100 %, and the halt
  rule (crash-free sessions below 99.5 % or adoption regression stops the ramp).
- [ ] R2 Describe the in-app kill switch: `apps/mobile/src/config/remote-config.ts` minimum version and flags, and who
  sets them. Do not change the code.
- [ ] R3 Name the owner actions (App Store phased release, Play staged rollout) without performing them.

Acceptance:
- Change types: Tooling/docs
- Outcome: the owner and the on-call session can run the ramp and halt it from the runbook alone.
- States: n/a: a document.
- Surfaces: n/a.
- Locales: n/a: an internal document in English.
- Accessibility: n/a.
- Contract: n/a.
- Staging proof: not verified on staging: a document. The runbook steps are checked by the owner at Gate 2.

## Owner-gated lanes (recorded, not built)
<!-- lane: store-submission-owner -->
- [ ] O1 G3: owner confirms App Store Connect (team `62Q26QSEJW`), Play Console and the Android signing/upload key;
  owner decides on EAS cloud builds. Recorded in `docs/validation/native-wave3/store-submission.md`. No session
  creates a credential or submits a build.

<!-- lane: iap-decision-owner -->
- [ ] O2 §8 decision 4: owner decides the payment classification per purchase type and whether StoreKit or Play
  Billing is introduced. Recorded in `docs/validation/native-wave3/iap-decision.md`. No payment code is written here.

<!-- lane: crash-sdk-owner -->
- [ ] O3 §8 decision 5: owner picks the crash-reporting SDK and the Firebase ownership. Recorded in
  `docs/validation/native-wave3/crash-sdk.md`. No SDK is added here.

Acceptance (all three owner lanes):
- Change types: Tooling/docs
- Outcome: the owner's decision is recorded where the next lane can read it.
- States: n/a: a decision record.
- Surfaces: n/a.
- Locales: n/a.
- Accessibility: n/a.
- Contract: n/a.
- Staging proof: not verified on staging: a decision record; no runtime change.

## Appilix retirement — gated on adoption
<!-- lane: appilix-retire -->
- [ ] A1 Owner opens the gate only when the gateway count (`client-identity-store`, which must be `done`) shows ≥95 % of active mobile
  members on `native` and the crash-free gate holds on the last ramp step.
- [ ] A2 After the gate opens, a kiro lane with a fixed `paths` list removes the Appilix push and bridge code from the
  web app (the 106 files under `src/` that reference Appilix). The paths are fixed then, against the inventory on
  `origin/main` at that time.

Acceptance (set when the gate opens):
- Change types: UI, Integration, Tooling/docs
- Outcome: members on the Appilix wrapper are told to update before the removal; members on native are unaffected.
- States: an Appilix-only member sees the migration notice (`NATIVE-APP-PLAN.md:120`), not a broken screen.
- Surfaces: every web screen that reads Appilix push or bridge code, phone and desktop.
- Locales: de first and 11 locales for the migration notice.
- Accessibility: WCAG 2.2 AA for the notice.
- Contract: the removed bridge endpoints and their callers, with `file:line`.
- Staging proof: the staging spec asserts the notice and the web app's normal screens; no production check.
