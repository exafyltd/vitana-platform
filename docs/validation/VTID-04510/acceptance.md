# VTID-04510 — Community Autopilot CA-8: automations propose instead of acting silently

Step CA-8 of `docs/COMMUNITY-AUTOPILOT-V2-PLAN.md`.

## What changed

- `services/community-autopilot/automation-proposals.ts` — `proposeToMember()`
  turns what an automation used to do on a member's behalf into a typed
  Autopilot suggestion in that member's queue (language, expiry 72 h,
  provenance `{source:'automation', automation_id, run_id}`). Guards: never
  to or about a test/service account, at most 3 open per member (owner
  decision 3), same fingerprint not repeated within 14 days. Writes go
  through `ctx.supabase`, so shadow mode records and skips them. Nothing
  here notifies anyone.
- Converted from acting to proposing:
  - **AP-0201** — no longer creates a public group and adds up to 20 members.
    Suggests joining the existing group for the interest, or starting one.
  - **AP-0209** — no longer creates a private group for three mutual connections. Suggests a circle to each of the three.
  - **AP-0410** — no longer connects the new member to the inviter or signs them up for the shared event. Suggests both instead.
    The inviter's thank-you note is unchanged.
  - **AP-1306** — no longer posts milestones to members' social accounts, and sends no notification.
    Suggests a feed post draft instead; the post only starts from the app preview (owner decision 1).
- `GET /api/v1/automations/supervisor` (X-Gateway-Internal or exafy admin). It is read-only and reports:
  - the delivery mode;
  - runs, users and actions per automation in the window (default 7 days, maximum 30);
  - suggestions by status per proposing automation;
  - which automations still act silently.
- `GET /api/v1/automations/runs` and `/runs/active` now require the scheduler
  token or an exafy admin (they were public). The Command Hub already sends its
  admin bearer.
- Catalog: `autopilot.auto.*` titles and summaries in 10 gateway locales (`ar` stays untranslated, per the catalog-coverage rule).

## Acceptance criteria

AC-1: A proposal is refused for a test/service account (member or target), an unknown action, a full queue (3 open, expired rows not counted) and a fingerprint seen within 14 days.
TEST: services/gateway/test/vtid-04510-community-autopilot-automation-proposals.test.ts

AC-2: A proposal is one row with a typed action, the member's language, provenance and a 72 h expiry; in shadow mode the write is recorded and skipped.
TEST: services/gateway/test/vtid-04510-community-autopilot-automation-proposals.test.ts

AC-3: AP-0201 and AP-0209 create no group, add no member and notify nobody; they propose join/start suggestions.
TEST: services/gateway/test/services/automation-handlers-community-groups.test.ts

AC-4: AP-0410 writes no relationship edge and no event participant; it proposes connect + RSVP to the new member and still thanks the inviter.
TEST: services/gateway/test/vtid-04510-community-autopilot-automation-proposals.test.ts

AC-5: AP-1306 never calls the social share service and sends no notification; it proposes a post draft.
TEST: services/gateway/test/vtid-04510-community-autopilot-automation-proposals.test.ts

AC-6: The supervisor folds runs and proposals per automation, marks proposing vs silently-acting automations, and answers only the scheduler token or an exafy admin; run history is no longer public.
TEST: services/gateway/test/vtid-04510-community-autopilot-automation-proposals.test.ts

OASIS_PROOF: the converted handlers emit `autopilot.community.group_suggestions_proposed`, `autopilot.community.match_cluster_groups_proposed` (renamed from the `…_created` topics, which described actions that no longer happen) and `autopilot.sharing.viral_signup` with a `proposals` tally, through `ctx.emitEvent` as before; the executor's `autopilot.automation.completed` is unchanged.

## Evidence

- `outputs/jest-ca8.txt`
- `outputs/mutation-queue-cap-removed.txt` — removing the 3-open cap fails its test.

## Not done here

- The automations still acting silently are listed by the supervisor
  (`REMAINING_SILENT_ACTORS`): AP-0103, AP-0212, AP-0404, AP-0405, AP-0708,
  AP-1101, AP-1104, AP-1301, AP-1305. Each needs its own conversion.
- The group "start one" suggestion opens `/community/groups`; a prefilled
  create form is a frontend follow-up.

## Route mount

ROUTE_MOUNT: `router.get('/supervisor')` in services/gateway/src/routes/automations.ts, a router mounted at `/api/v1/automations` (the same router that serves `/health`).
FINAL_URL: GET https://preview-aws-gateway.vitanaland.com/api/v1/automations/supervisor
CURL_PROOF: before merge, `curl https://preview-aws-gateway.vitanaland.com/api/v1/automations/health` → `200 application/json` (router mounted); `…/supervisor` → `404 text/html` (the route is new in this PR). After deploy the same URL must answer `401 application/json` without credentials.
