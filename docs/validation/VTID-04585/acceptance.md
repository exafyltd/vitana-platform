# VTID-04585 — follower / following answers carry both directions

## Problem (measured on staging, build 8fa030b, 2026-09-25)
Two authenticated `de` Nova sessions were asked "Wem folge ich eigentlich in
der Community?" Both times the model called `list_followers` (execution events
at 20:08:57Z and 20:09:21Z). That tool is not in the Nova session's declared
catalog; only `list_following` is. It returned "Nobody follows the user", and
Vitana told a user who follows Mariia Maksina that they have no followers.

## Change
`runListFollows()` (behind both `list_followers` and `list_following`) already
fetched both directions in one query. The result text now also names the other
direction, labelled, and states which question maps to which direction. The
result object carries `other: { direction, count, names }`. No new query, no
schema change, no tool-catalog change.

## Acceptance criteria
AC-1: `list_followers` for a user with 0 followers who follows Mariia Maksina
names Mariia Maksina under the following direction.
TEST: services/gateway/test/services/social-read-tools.test.ts — "list_followers still names who the user follows"

AC-2: `list_following` names the followers under the other direction.
TEST: services/gateway/test/services/social-read-tools.test.ts — "list_following also names the followers"

AC-3: Existing behaviour is unchanged: the primary line, mutual counts, the
12-name cap and fail-closed privacy handling.
TEST: services/gateway/test/services/social-memory/social-read-tools.test.ts

AC-4: On staging, the spoken "Wem folge ich?" names Mariia Maksina.
UI: scripts/orb/verify-vertex-serbian-bridge.mjs --mode=authenticated --utterance-pcm=q_follows_de.raw against preview-aws-gateway after deploy (result in outputs/)
