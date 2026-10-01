# Connected Apps sign-in: one-time setup

Members connect their own accounts in **Connected Apps**. Each member does it
for themselves, with their own account:

| App | What the member does |
|---|---|
| Gmail, Google Calendar, Google Contacts | Taps the switch. Google's sign-in page opens, they tap **Allow**, they are back in Vitanaland and connected. |
| Outlook Mail, Outlook Calendar, Outlook Contacts | Same, with Microsoft's sign-in page. |
| Apple Mail, Apple Calendar, iPhone Contacts (iCloud) | Apple offers no "Allow" screen to other apps for iCloud. The member creates an app-specific password at appleid.apple.com and pastes it once. Every iCloud app (Spark, Fantastical, Thunderbird) works this way. |
| Android Contacts | Picks contacts on the phone. Needs nothing below. |

Google and Microsoft only show their **Allow** screen to an app they know.
Vitanaland has to be registered with each of them **once**. That produces a
client ID and a client secret for Vitanaland itself — not per member. Until
those exist on the server, the switches show "Not available yet" and cannot
be turned on.

This was checked on 2026-09-24: neither staging nor production has a Google
or Microsoft client configured (`/api/v1/social-accounts/providers` reports
`google:false`, `microsoft:false` on both).

## 1. Google (Gmail, Google Calendar, Google Contacts)

In [Google Cloud Console](https://console.cloud.google.com), signed in with
the Vitanaland company account:

1. Pick or create a project for Vitanaland (not the Vertex Serbian-bridge
   project and not `lovable-vitana-vers1`).
2. **APIs & Services → Library**: enable **Gmail API**, **Google Calendar
   API** and **People API**.
3. **APIs & Services → OAuth consent screen**:
   - User type **External**, app name **Vitanaland**, support email, logo,
     links to the privacy policy and terms on vitanaland.com.
   - Authorized domain: `vitanaland.com`.
   - Scopes the gateway requests:
     `openid`, `email`, `profile`,
     `https://www.googleapis.com/auth/gmail.readonly`,
     `https://www.googleapis.com/auth/calendar.readonly`,
     `https://www.googleapis.com/auth/calendar.app.created`,
     `https://www.googleapis.com/auth/calendar.freebusy`,
     `https://www.googleapis.com/auth/contacts.readonly`.
   - While the app is in **Testing**, add the Google accounts that should be
     able to connect under **Test users** (up to 100).
4. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Type **Web application**, name `Vitanaland gateway`.
   - Authorized redirect URIs:
     - staging: `https://preview-aws-gateway.vitanaland.com/api/v1/social-accounts/callback/google`
     - production (add when production is switched on): `https://gateway.vitanaland.com/api/v1/social-accounts/callback/google`
   - Copy the **Client ID** and **Client secret**.

**Verification.** `gmail.readonly` is a restricted scope and
`contacts.readonly` a sensitive one. Before members outside the test-user list
can connect, Google must verify the app, and for Gmail an annual third-party
security assessment is required. Plan weeks for this. Test users can connect
straight away.

## 2. Microsoft (Outlook Mail, Outlook Calendar, Outlook Contacts)

In the [Azure portal](https://portal.azure.com) → **Microsoft Entra ID → App
registrations → New registration**:

1. Name `Vitanaland`. Supported account types: **Accounts in any
   organizational directory and personal Microsoft accounts**.
2. Redirect URI, platform **Web**:
   - staging: `https://preview-aws-gateway.vitanaland.com/api/v1/social-accounts/callback/microsoft`
   - production (later): `https://gateway.vitanaland.com/api/v1/social-accounts/callback/microsoft`
3. **API permissions → Microsoft Graph → Delegated**: `openid`, `email`,
   `profile`, `offline_access`, `User.Read`, `Mail.Read`, `Mail.Send`,
   `Calendars.ReadWrite`, `Contacts.Read`. None needs admin consent for
   personal accounts.
4. **Certificates & secrets → New client secret**. Copy the **Value** (shown
   once) and, from **Overview**, the **Application (client) ID**.
5. Optional but recommended for the consent screen: **Branding & properties**
   → publisher domain `vitanaland.com` and publisher verification.

## 3. Put the keys on the server

With AWS credentials for account `472838866351`:

```bash
export GOOGLE_OAUTH_CLIENT_ID=...        GOOGLE_OAUTH_CLIENT_SECRET=...
export MICROSOFT_OAUTH_CLIENT_ID=...     MICROSOFT_OAUTH_CLIENT_SECRET=...
scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging provision          # shows what it will create
scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging provision --apply  # creates them
scripts/aws/setup-connected-apps-oauth-secrets.sh --env staging status
```

The script also generates `AI_CREDENTIALS_ENC_KEY`, the key the server uses to
store Apple app-specific passwords encrypted. It never overwrites an existing
secret. Google and Microsoft can be done one at a time: unset variables are
skipped.

Then redeploy the staging gateway (a push to `main` under
`services/gateway/**`, or run `AWS-STAGE-DEPLOY-GATEWAY.yml` by hand). Its
**Resolve Connected Apps sign-in config** step logs `resolved …` for every
secret it found and wires it into the task definition; a missing one is
logged and skipped, never a failed deploy.

## 4. Check it

- `GET https://preview-aws-gateway.vitanaland.com/api/v1/social-accounts/providers`
  shows `google: true` / `microsoft: true`.
- On `https://preview-aws.vitanaland.com/connectors?tab=productivity` the
  Google and Outlook rows no longer say "Not available yet". Turning one on
  opens the provider's sign-in page; after **Allow** you land back in
  Connected Apps with the switch on.
- Apple rows open the app-specific password dialog once the encryption key is
  in place.

Production needs the same three steps with `--env prod`, the production
redirect URIs, and the matching wiring in `AWS-PROD-DEPLOY-GATEWAY.yml`
(not added yet — VTID-04507 is staging only).
