# VTID-04508 — Community Autopilot CA-7: attributed invite links + wallet credit on join

Step CA-7 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md` (owner decision 5). App half:
exafyltd/vitana-v1#1147.

## Before

The pieces existed but were never joined up:
- Share links were minted on every click to a `/s/<code>` URL that nothing resolved.
- No signup was ever attributed to an inviter (0 rows in `referrals`).
- The reward automation (AP-0405) listened for a payload shape that nothing sends.

## What changed

- `services/community-autopilot/invites.ts`:
  - `getOrCreateInviteLink`: one reusable personal link per member, `https://vitanaland.com/i/<code>`. The base URL is `PUBLIC_APP_URL`.
  - `lookupInvite`: public; returns the inviter's first name only.
  - `claimInvite`: the new member's app claims the code after sign-in.
- Anti-abuse rules, checked before anything is written:
  - no self invite;
  - no test or service account on either side (rules 43-45);
  - the new member must be in the inviter's community;
  - the account must be at most 14 days old, with a confirmed email;
  - one referral per member (unique index);
  - at most 10 rewarded invites per inviter per 30 days.
- The credit is paid exactly once:
  - The referral must move `signed_up` → `rewarded` first. A repeat claim stops earlier, at `already_attributed`.
  - Only then is `increment_wallet_balance(CREDITS)` called. The amount is `COMMUNITY_INVITE_REWARD_CREDITS`, default 200 (`REWARD_TABLE.referral_completed`).
  - If the credit fails, the referral is rolled back to `signed_up`.
- **The credit is off unless `COMMUNITY_INVITE_REWARD_ENABLED=true`** (not set anywhere in this PR). Attribution is recorded either way.
- Vitanaland never contacts the invited person; the member shares the link through their own channel.
- New router `routes/community-invites.ts` mounted at `/api/v1/invites`:
  - `GET /me` (member)
  - `GET /:code` (public)
  - `POST /claim` (member)
- OASIS events `community_autopilot.invite.attributed` and `community_autopilot.invite.rewarded`.
- Migration `20260924200000_vtid_04508_invite_attribution.sql`, applied live: two unique partial indexes. `DATABASE_SCHEMA.md` updated.

## Acceptance criteria

AC-1: One reusable, unambiguous invite link per member, at /i/<code>.
TEST: services/gateway/test/vtid-04508-community-invites.test.ts

AC-2: A claim is refused for self invites, test/service accounts on either side, another community, an account older than 14 days, or an unconfirmed email; refused and unknown claims write nothing.
TEST: services/gateway/test/vtid-04508-community-invites.test.ts

AC-3: A member is attributed at most once; the reward stays off unless COMMUNITY_INVITE_REWARD_ENABLED is exactly true.
TEST: services/gateway/test/vtid-04508-community-invites.test.ts

AC-4: With the flag on, the inviter is credited exactly once; after 10 rewards in 30 days there is no reward but attribution is still recorded; a failed credit rolls the referral back.
TEST: services/gateway/test/vtid-04508-community-invites.test.ts

AC-5: My link and the claim need a signed-in member; a claim without a code is a 400.
TEST: services/gateway/test/vtid-04508-community-invites.test.ts

OASIS_PROOF: `POST /api/v1/invites/claim` emits `community_autopilot.invite.attributed`, or `.rewarded` when a credit was paid. The payload carries referral_id, referred_id, rewarded and reward_reason (routes/community-invites.ts). No event fires when the claim is not attributed.

## Route mount

ROUTE_MOUNT: `mountRouterSync(app, '/api/v1/invites', communityInvitesRouter)` in services/gateway/src/index.ts; routes `GET /me`, `POST /claim`, `GET /:code` in services/gateway/src/routes/community-invites.ts.
FINAL_URL: https://preview-aws-gateway.vitanaland.com/api/v1/invites/me (and /claim, /:code)
CURL_PROOF: Taken before merge: `curl https://preview-aws-gateway.vitanaland.com/api/v1/invites/me` → `404 text/html` ("Cannot GET"). The router is new and does not exist on staging yet. After this merges and deploys, the same curl must return `401 application/json` (member route, no token). That is the post-deploy check. Behaviour is covered by the route tests above.

## Evidence

- `outputs/jest-ca7.txt`: 14 tests.
- `outputs/mutation-monthly-cap-removed.txt`: removing the monthly cap fails its test.
- The exactly-once guard (`status=eq.signed_up` on the transition) protects against two concurrent claims, which the unique index also blocks. A sequential repeat already stops at `already_attributed`, so no unit test can isolate the guard.

## Owner steps

- Set `COMMUNITY_INVITE_REWARD_ENABLED=true` (and optionally `COMMUNITY_INVITE_REWARD_CREDITS`) when credits should be paid.
