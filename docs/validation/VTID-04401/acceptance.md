# VTID-04401 — Connected Apps security: verified tokens, signed OAuth state

Found while mapping Connected Apps for the owner's request to make all nine
mail, calendar and contacts apps connect for real. Nothing can safely be
built on these endpoints until this is fixed.

## What was wrong (verified in the source)

- **`routes/social-connect.ts` and `routes/capabilities.ts`** took the user id
  by base64-decoding the bearer token's payload, **without checking the
  signature**, then read and wrote with the service role.
  - Anyone could send a hand-made token naming another member.
  - That token gave access to the member's connections and could run
    capabilities (`email.read`, `calendar.list`, `contacts.read`) against
    their connected Google account.
  - It could also start a connect flow in their name.
- **OAuth `state`** (social-connect and wearables) was plain base64 JSON: `userId`, `tenantId` and `provider`.
  - The callback has no bearer token, so `state` is the only proof of whose account is being connected.
  - A crafted callback could therefore attach a provider account to any user.

## Fix

- `lib/oauth-state.ts`: the state is now `<base64url(json)>.<HMAC-SHA256>`.
  - It carries `iat`, `exp` (15 min) and a random nonce.
  - Comparison is constant-time.
  - Key: `OAUTH_STATE_SECRET` (≥32 chars), or a key derived from the service-role secret. With neither, signing throws and verifying fails, so it fails closed.
- Both routers now `router.use(optionalAuth)`, the gateway's verifying
  middleware. `extractUserFromJwt` only reads `req.identity`.
- The social callback rejects unsigned, tampered or expired state. It also
  rejects a state whose provider is not the callback's provider.
- Wearables: `/connect` signs the state and `/callback` verifies it.

## Acceptance criteria

- **AC-1:** A signed state round-trips. The following are all rejected: an
  unsigned state (the old format), a tampered body or signature, an expired
  state, another key's state, and garbage. With no key, it fails closed.
  TEST: `vtid-04401-connected-apps-auth.test.ts` › signed OAuth state.
- **AC-2:** A forged token naming another user gets 401 on
  `/social-accounts/connections`, `/connect/google` and
  `/capabilities/:capability`, and the victim's id never reaches a query.
  TEST: › routers trust only the verified identity.
- **AC-3:** An unsigned state never reaches the token exchange. A state
  signed for another provider is refused.
  TEST: › callbacks reject forged state.
- **AC-4:** Neither router decodes a token by hand any more. The wearables
  route signs and verifies its state.
  TEST: › source guards.

## Not changed, reported

Other routes also decode the token payload without verifying it:
`diary.ts`, `live.ts` (×7), `community.ts` (×6), `matchmaking.ts` (×2),
`feedback*.ts` (×3), `specialists-connections.ts`, `backoffice-commands.ts`.

Many of them only use the id for attribution next to a user-scoped client.
Each one needs checking on its own, which is a separate VTID. This change
fixes the two routers that hand a decoded id straight to service-role reads
of third-party accounts.

## OASIS

No new state transition. The OAuth callbacks' existing events are
unchanged.

## Operational note

A connect flow that was already in progress at deploy time carries an old
unsigned state, so it fails once with `invalid_state`, and the member taps
Connect again. `OAUTH_STATE_SECRET` is optional; if it is ever set, it must
be the same on every gateway task.
