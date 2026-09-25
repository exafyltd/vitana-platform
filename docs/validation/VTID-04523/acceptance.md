# VTID-04523 — Community Autopilot: at most 3 open suggestions per role, on every read

Found by the staging test of CA-0..CA-9: owner decision 3 (at most 3 open
suggestions per member per role) was enforced when suggestions are written, but
the lineup read served every open row, and rows from before the cap stayed
open. On staging all 33 members with open community suggestions had more than
3 (up to 15; `outputs/staging-finding.txt`).

## What changed
- `services/community-autopilot/lineup-cap.ts` (new, pure): `capOpenLineup` keeps the first 3 open rows of a ranked list plus every activated/completed row; `selectExcessOpenRows` picks the open rows beyond 3 to retire (typed-action rows kept first, then higher impact, then newer; expired rows ignored).
- `GET /autopilot/recommendations` (role community): capped after ranking; `has_more` is false when rows were capped, so paging cannot re-reveal them.
- `GET /autopilot/recommendations/count` (role community): the badge is at most 3.
- Voice list (`listCommunityAutopilotRecommendations`, used by `get_autopilot_recommendations`) and the `/generate` response: the same cap. Both also stop hiding rows that carry a typed action (the CA-4 fix had only reached the GET handler), which would have hidden every scan and automation suggestion from voice.
- The scan (`scan-runner.ts`): before ranking a member, `retireExcessOpenRows` sets open community rows beyond 3 to `auto_archived` (update scoped to `status=new`, so a row acted on meanwhile is never touched). A dry run reports and writes nothing; the run summary carries `rows_retired`.
- Developer findings (`role=developer`) are not capped.

## Acceptance criteria

AC-1: A community member's lineup shows at most 3 open suggestions (the top 3 after ranking) and all activated rows, with no next page of capped rows.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-2: The Autopilot badge count never exceeds 3 for a community member; developer counts are unchanged.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-3: Voice lists the same top 3, including suggestions that carry a typed action.
TEST: services/gateway/test/routes/autopilot-recommendations.test.ts

AC-4: The scan retires open rows beyond 3 (typed first, then impact, then newest kept), only rows still open, never on a dry run, and a failed write retires nothing without throwing.
TEST: services/gateway/test/vtid-04523-community-autopilot-lineup-cap.test.ts

AC-5: The existing CA-5 scan behaviour is unchanged (off unless enabled, never scans test/service accounts).
TEST: services/gateway/test/vtid-04505-community-autopilot-scan.test.ts

OASIS_PROOF: none. The cap is a read-side filter and the retirement is part of the existing scan run, whose summary gains `rows_retired`. No new state transition topic.

## Not done here
- Existing extras on staging stay open in the table until the scan runs for that member (it is off until `COMMUNITY_AUTOPILOT_SCAN_ENABLED=true`). Members already see only 3 once this deploys, because the read is capped.
