# VTID-04560 — the role whose screens are shown decides which Vitana assists

Program (one PR per repo, six VTIDs):

| Phase | VTID | What |
|---|---|---|
| 0 | VTID-04560 | Assistant Profile resolved once per session from the screen's declared surface + view role; role-gated greeting; community content kept off work surfaces |
| 1 | VTID-04561 | One role truth (both switchers write both role tables); role registry; a role switch restarts the conversation |
| 2 | VTID-04562 | Developer knowledge: live system snapshot, domain atlas, engineering memory; `dev_system_status`, `dev_domain_atlas` |
| 3 | VTID-04563 | Deep-dive engine (`dev_deep_dive`): read-only investigation across code, history, data and runtime |
| 4 | VTID-04564 | One brain, two channels: the Operator Console shares the knowledge and the deep dive |
| 5 | VTID-04565 | Evaluation set (69 questions) + telemetry (profiles served, deep-dive outcomes) |

Owner rule (2026-09-25): community screens → community Vitana; Command Hub →
developer Vitana; admin screens → admin Vitana — whichever app the user logged
in through.

## Acceptance criteria

AC-1: The profile is resolved from the declared surface and view role, never from the device. Command Hub → developer (unverified when the token carries no exafy_admin, never community); admin → admin; backoffice → backoffice; a work role declared on community screens is narrowed to community; anonymous → member surface, no role.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-2: A work surface opens with the `work_surface_open` rung on both greeting ladders (context resolved and the safe-fast 300 ms case) and never reaches a member rung; the directive leads with snapshot facts or offers to check when none are loaded; a transport reconnect stays silent.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-3: The system instruction of a work surface carries only its own Vitana: no RULE 0, no Guided Journey, no member navigator, no instruction-manual block, no member context; the developer surface carries the supervisor conduct block naming its tools.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: services/gateway/test/orb/latency/vtid-04542-voice-payload-identity.test.ts

AC-4: Text path: engineering context (codebase orientation, bootstrap pack, atlas) reaches only the Operator Console and developer/admin callers, on the main turn and on the tool-result turn.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: services/gateway/test/vtid-03930-operator-codebase-overview.test.ts
TEST: services/gateway/test/vtid-04018-operator-bootstrap-pack.test.ts

AC-5: One role truth: `set_role_preference()` and `me_set_active_role()` each write both `role_preferences` and `user_active_roles`; the Command Hub role switch opens the community app of its own environment (staging → preview-aws); the role registry covers every Vitana role and drives the privileged voice-tool gate.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-6: The widget declares `surface` + `view_role` on init, on every route change and in the prewarm; a role switch restarts an open conversation; the Nova prewarm resolves the same profile and member role as the session start.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-7: The developer starts with a live system snapshot (builds, Dev Autopilot, last hour of errors, profiles served, deep dives) that is bounded per source, fails open, is cached 90 s and coalesced, and whose highlights feed the opener; the domain atlas claims every gateway route file (drift guard); engineering memory comes from `dev_agent_memory`, never member memory.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-8: `dev_deep_dive` runs on the `planner` stage within 10 turns / 12 tool calls / 150 s, only for developer callers on the Command Hub; every tool is read-only (the endpoint probe is GET-only on `/alive` and `/api/v1/*` of the two known hosts, without credentials); findings name their sources; `orb.deep_dive.completed` / `.failed` carry duration, tools, provider and tokens.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-9: The Operator Console declares and executes the same `dev_system_status`, `dev_domain_atlas` and `dev_deep_dive`; a console turn makes no unplanned database reads (the snapshot is fetched on demand); the console deep dive requires the verified caller on the thread.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

AC-10: The evaluation set has 60+ questions covering every atlas domain; the atlas routes at least 90% correctly (69/69 today); the live eval script runs against staging only with the machine credential.
TEST: services/gateway/test/vtid-04560-role-separation-regression.test.ts

AC-11: The customer-support and operator pipeline suites stay green (standing rules 42c/42e).
TEST: services/gateway/test/vtid-04456-customer-support-pipeline-regression.test.ts
TEST: services/gateway/test/vtid-04465-operator-pipeline-regression.test.ts

## Mutation checks (run before this PR)

- Removing the `work_surface_open` rung from `computeGreetingDecision` fails 6 tests.
- Reverting the engineering-context gate in `gemini-operator.ts` fails 2 tests.

## OASIS

OASIS_PROOF: every ORB session start emits `orb.session.profile.resolved`
(surface, role, resolution, declared surface/view role); every deep dive emits
`orb.deep_dive.completed` or `orb.deep_dive.failed`. Staging observations are
recorded in `outputs/staging-verification.txt` after the deploy.

## Not verified here

- Real spoken audio. No session can place an ORB call; the audible check is the
  owner's first Command Hub session on staging.
- A deep dive against real data on staging, until the staging verification
  (recorded in `outputs/`).
- Cognito tokens carry no exafy_admin claim (known gap, VTID-03851). A Command
  Hub session under such a token resolves as `unverified`: it is still the
  developer persona, and every developer tool re-checks the role.
