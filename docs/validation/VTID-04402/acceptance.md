# VTID-04402 — Connected Apps hub: one switch per Mail / Calendar / Contacts app

Ships together with **VTID-04403** (Microsoft: Outlook Mail + Outlook Calendar),
**VTID-04404** (Apple iCloud: Apple Mail, Apple Calendar, iPhone Contacts) and
**VTID-04405** (contacts import). They share one hub, one migration and one test
suite, so they are one PR. The app screen is VTID-04406 in `exafyltd/vitana-v1`.

The owner asked for all nine apps on the Connected Apps screen to actually
work, with one switch each, the way assistants connect external apps. Before
this change, only Google connected, and only read-only. The six Apple,
Microsoft and Android apps logged to the console or showed a "coming soon" toast.

## What was built

- **Catalogue**: `services/connected-apps/catalogue.ts` defines the nine apps.
  For each one it records the provider, the connect method (OAuth, app-specific
  password or device), the exact scopes, the assistant capabilities it enables
  and what its sync does.
- **Hub**: `services/connected-apps/hub.ts` provides `listApps`, `connectApp`,
  `onGrantReturned`, `disconnectApp`, `syncApp`, `importDeviceContacts` and a
  background loop.
  - A switch is on only when the provider access covers that app's scopes.
  - Scopes are the ones the provider actually granted, now stored in
    `social_connections.scopes`.
  - A new consent asks for the new app's scopes plus those of the provider's
    other apps that are on, so no app is dropped.
  - Turning the last app of a provider off releases the provider access.
- **Microsoft**: `social-connect-service` gains a `microsoft` provider.
  - Tenant is `common` by default, overridable with `MICROSOFT_OAUTH_TENANT`.
  - The token response's scopes are stored. The Graph `/me` profile is used.
  - Microsoft rotates refresh tokens, so the refresher and the dispatcher now
    store the rotated one.
  - `connectors/productivity/microsoft.ts` handles `email.read`, `email.send`,
    `calendar.list` and `calendar.create`, plus Outlook busy times.
- **Apple**: `services/connected-apps/apple-dav.ts` talks CalDAV, CardDAV and a
  read-only IMAP reader over TLS, with no new dependency.
  - Credentials are stored AES-256-GCM encrypted (`apple-store.ts`).
  - `connectors/productivity/apple.ts` uses a new auth type, `app_password`.
  - It is read-only: sending mail and writing events are not offered.
- **Contacts**: `contacts-import.ts` imports into `contacts`.
  - Contacts are de-duplicated per source.
  - Contacts who are already members are matched by e-mail, excluding test and
    service accounts (rule 45).
  - Android contacts come from the phone's Contact Picker.
- **Google**: the Gmail app now asks for `gmail.send` too, and `email.send` is
  implemented.
  - A missing scope returns the Connected App to switch on.
  - `contacts.import` points at the hub.
- **Assistant**: the capability resolver respects the switches. With Gmail off,
  Vitana does not read Gmail even while the Google token exists.
- **Calendar**: busy blocks come from Google, Outlook and iCloud (`source`
  column), gated by `include_busy` only.

## Acceptance criteria

AC-1: The catalogue lists exactly the nine app ids of the screen, each asking only for its own scopes.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › catalogue

AC-2: On/off follows the rules.
- A pre-hub Google token that covers an app counts as on.
- An explicit switch wins over the token.
- An app switched on whose grant is gone or missing a scope is `needs_reconnect`.
- Apple is on only with credentials that last worked.
- A provider this stack cannot serve is never on.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › computeAppState

AC-3: Switching an OAuth app on without a covering grant returns a consent URL.
- The URL requests that app's scopes plus the ones already on.
- It carries a signed state naming the app.
- Microsoft uses the Graph authorize endpoint and the microsoft callback.
- With a covering grant, one tap turns the app on.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › toggle flows

AC-4: Apple needs an Apple ID and an app-specific password.
- A password Apple rejects is reported and nothing is stored.
- A good one is stored encrypted, never in plaintext.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › toggle flows › Apple

AC-5: Turning off works as follows.
- It clears the app's busy times.
- It keeps imported contacts unless asked.
- It releases the provider access only when the provider's last app goes off.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › toggle flows › turning off

AC-6: The grant callback turns the app on only when every scope was granted.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › the grant callback

AC-7: Outlook calendar sync writes busy times only, never titles, and skips free and cancelled events.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › Outlook calendar sync

AC-8: The assistant does not use an app that is switched off.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › assistant gate

AC-9: Android contacts picked on the phone are imported, de-duplicated and the app turned on.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › Android

AC-10: Microsoft behaves as follows.
- Local times are read as UTC.
- The rotated refresh token is kept.
- Mail maps correctly, and a missing scope names the app.
- The token exchange keeps the granted scopes.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › microsoft

AC-11: The iCloud parsers read DAV, VEVENT, vCard, RFC 2047 headers and IMAP FETCH literals correctly.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › iCloud parsing

AC-12: The routes need a verified member, act only for the caller and refuse to sync an app that is off.
The API is mounted, the loop starts at boot, and the refresher covers microsoft.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › routes

AC-13: The migration is correct.
- The new tables are service-role only.
- The contacts upsert key is a plain unique index, as PostgREST needs.
- The busy sources are widened.
TEST: services/gateway/test/vtid-04402-connected-apps.test.ts › migration

## Route mount evidence

ROUTE_MOUNT: services/gateway/src/index.ts → mountRouterSync(app, '/api/v1/connected-apps', connectedAppsRouter, { owner: 'connected-apps' })
FINAL_URL: /api/v1/connected-apps (GET), /api/v1/connected-apps/:id/connect|disconnect|sync (POST), /api/v1/connected-apps/android-contacts/import (POST)
CURL_PROOF: See outputs/local-curl.txt. The gateway was booted locally from this branch, with the Supabase URL pointed at an unreachable local port so nothing live is touched. `GET /api/v1/connected-apps` returns `401 application/json` `{"error":"UNAUTHENTICATED"}`. `POST …/outlook-mail/connect` with a forged bearer returns `401 application/json` "Invalid or expired token". Both are JSON rather than an HTML 404, so the route is mounted and gated. The same check against staging follows the deploy.

## Switched on where?

Nothing needs a flag to be safe. Every switch acts only when the member taps
it, and an app is offered only when its stack can serve it.

- **Google**: needs `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
  Checked read-only on 2026-09-23, staging's `/social-accounts/providers`
  reports `configured:false` for every provider, including Google.
- **Microsoft**: needs `MICROSOFT_OAUTH_CLIENT_ID` and
  `MICROSOFT_OAUTH_CLIENT_SECRET`, from an app registration the owner creates
  in Entra.
- **Apple**: needs `AI_CREDENTIALS_ENC_KEY`.
- **Android contacts**: always available.

Restricted Google scopes (`gmail.readonly`, `gmail.send`) need Google's app
verification before members outside the test-user list can grant them.

## Not done here, reported

- **Outlook and Apple calendars are pull-only.** They provide busy times and
  the assistant can read them; Outlook events can also be created by the
  assistant. Two-way push exists for Google only (VTID-04372).
- **Microsoft contacts** have no app on the screen, so none are imported.
- **Apple Mail and Apple Calendar are read-only**, by design.

## OASIS

The hub emits these events, with the member as `actor_id`:

- `connected_app.enabled`
- `connected_app.disabled`
- `connected_app.consent_incomplete`
- `connected_app.sync_failed`
- `connected_app.contacts_imported`

OASIS_PROOF: `services/gateway/test/vtid-04402-connected-apps.test.ts` asserts that
`emitOasisEvent` is called with `connected_app.enabled` (one-tap switch-on of
Outlook Mail with a covering grant) and `connected_app.contacts_imported`
(Android import), each carrying `vtid: VTID-04402`, `actor_id` = the member and
`payload.app_id`. The remaining three types go through the same `emit()` helper
in `services/connected-apps/hub.ts`.
