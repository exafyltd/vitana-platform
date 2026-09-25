# VTID-04582: the Operator Console's recommendations tool showed community member nudges

On 2026-09-25 an operator asked the Operator Console for "the Dev Autopilot recommendations". The tool `autopilot_get_recommendations` returned ten items: "Complete your profile", "Add your photo", "Start a streak on your weakest pillar".

Those are community recommendations that belong to real members. The tool called the `get_autopilot_recommendations` RPC with `p_user_id: null`. That RPC is the community recommender. With no user it returns every member's rows, and it never returns `source_type`.

Live counts in `autopilot_recommendations` (read-only, 2026-09-25):

- `source_type='community'`, `status='new'`: 268 rows, every one with a `user_id` (a real member).
- The developer backlog sits in the same table: `dev_autopilot` (20 new, 11 snoozed) and `dev_autopilot_impact` (5 new), all with `user_id` null.

In the same conversation the model then claimed it had pulled the developer autopilot, which was false.

A second fabrication came from a staging console turn at 19:17 UTC. That turn called only `autopilot_review_execution`. Its reply nonetheless presented an `autopilot_approve_execution` result:

- `"status":"pr_opened"` and `"pr_number":3709`;
- a `github_auth` field that the endpoint does not return;
- the sentence "the 401 is gone and the PR is open".

None of it happened: `dev_autopilot_executions` still read `awaiting_approval` with no PR, and #3709 did not exist yet. That text was then taken as proof by the session operating the console. The real approve, called at 19:55 through `POST /api/v1/dev-autopilot/executions/:id/approve`, opened #3711.

## What changed

- `autopilot_get_recommendations` reads the Dev Autopilot supervisor snapshot (`buildSupervisorSnapshot`, VTID-04281). This is the payload the Command Hub Autopilot screens render. It returns:
  - the open `dev_autopilot` / `dev_autopilot_impact` findings, each with the gate that holds it;
  - executions in flight and awaiting approval;
  - the 7-day success rate and the supervisor alerts.
- Findings a person can unblock come first. `vtid` narrows the list to the finding activated under that VTID.
- `operator-dev-recommendations.ts` is the pure mapping. The supervisor findings now carry `activated_vtid`.
- The wire description, the tool registry and both prompt sources say the tool never returns community recommendations. The prompts route backlog questions to it.
- `operator-fabricated-tool-guard.ts`: when the reply presents a tool call that did not run in this turn, a visible notice is appended and an `operator.reply.fabricated_tool_call` OASIS event is emitted. This applies on both reply paths, with and without tools. "Presents" means a line opening `Tool:` / `Tool call:` or the phrase `Ran <tool>`, where `<tool>` is a declared tool. Prose that only names a tool is left alone.
- Two rules added to both prompts:
  - Current execution state comes from `autopilot_review_execution`, not from OASIS history.
  - When told an earlier answer was wrong, the model checks what the tools returned and corrects itself. It never claims a tool returned something it did not.

## Acceptance criteria

AC-1 The tool returns the Dev Autopilot backlog and never calls the community recommender RPC.
TEST: services/gateway/test/vtid-04582-operator-dev-recommendations.test.ts

AC-2 Findings a person can unblock are listed first. Each finding carries its source, detector, VTID, risk and blocker. `vtid` narrows the list and reports whether it matched.
TEST: services/gateway/test/vtid-04582-operator-dev-recommendations.test.ts

AC-3 An unavailable supervisor snapshot fails loudly and names the fallback tools.
TEST: services/gateway/test/vtid-04582-operator-dev-recommendations.test.ts

AC-4 Both prompt sources list the tool, route backlog questions to it, and carry the two honesty rules. The VTID-03838 drift guard stays green.
TEST: services/gateway/test/vtid-04582-operator-dev-recommendations.test.ts
TEST: services/gateway/test/vtid-03838-operator-prompt-lists-execute-tool.test.ts

AC-5 The operator pipeline regression suite stays green (Part 1 rule 42e).
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-6 A reply that presents a declared tool call which did not run in the turn gets a visible "Not verified" notice, on the tool path and on the direct path. Honest replies and prose mentions are left untouched.
TEST: services/gateway/test/vtid-04582-operator-fabricated-tool-guard.test.ts

## Not covered here

- No live Operator Console turn has used the new tool yet. The first "what should we work on" question on staging after this deploys is the exercise.
- The community ORB voice tool `get_autopilot_recommendations` (VTID-04493) is correct for members and is untouched.

OASIS_IMPACT: no
