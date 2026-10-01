# VTID-04417 — Conversation rebuild WS-1.5: the one-path rule covers decisions and context

This is Plan v1 (Conversation Intelligence Rebuild), Phase 1, workstream WS-1.5.
It ships in PR #3614 as a companion to VTID-04339.

## What was actually true (checked, not assumed)

**The plan's premise was out of date.** It said the `transport-flow-parity` check "stops running with `continue-on-error`" once enforced. It is already enforced:

- the rule is `severity: 'blocker'` (since VTID-03366);
- in `DEV-AUTOPILOT-IMPACT.yml` only the scan *step* has `continue-on-error: true`, so the PR comment is still posted;
- a later step, `Fail if blocker findings`, fails the job on pull requests.

**What it did not cover:** the rule counted inline `wake_opener` literals and per-language directive maps only. It could not see either of these in a transport:

- a direct `computeGreetingDecision` call that bypasses the brain entry point;
- the voice context being assembled outside the shared builder.

The second case is exactly the reconnect/LiveKit defect VTID-04414 fixed.

## Fix

**`scripts/ci/impact-rules/transport-flow-parity.mjs`:**

- **`TRANSPORT_FILES`** adds `orb/live/session/live-session-controller.ts`, which is where session start assembles the context for WS and SSE.
- **New pure `scanTransportSource(src)`**, exported for tests, reports:
  - direct `computeGreetingDecision(` calls;
  - direct `buildBootstrapContextPack(` / `buildBrainSystemInstruction(` / `buildBrainSystemInstructionCached(` calls.

  It skips comment lines and the builders' own definitions. Passing the legacy builder as a dependency (`{ legacy: buildBootstrapContextPack }`) is not a call. A deliberate exception carries `// brain-parity-allow: <reason>` on the line or just above it.
- **Each hit is a blocker finding** naming its lines and the replacement to use.

**`orb-live.ts`:**

- **Diagnostic endpoints:** `GET /debug/awareness` and the context-bootstrap test endpoint both claimed to run "the SAME bootstrap path the voice ORB uses", but called the legacy pack while sessions use the brain. They now call the shared builder, so they show what a real session gets.
- **Exceptions carrying the allow marker:**
  - the explicit brain-instruction debug route;
  - the prewarm of the legacy fallback cache, which builds nothing for a session.

**The registry description** is updated.

## Acceptance criteria

AC-1: On the current tree the rule reports no findings for any of the three transport files.
TEST: services/gateway/test/scripts/vtid-04417-transport-flow-parity.test.ts

AC-2: A direct `computeGreetingDecision(` call and a direct legacy/brain/cached-brain context build are each reported with their line numbers; dependency passing, definitions, comments and allow-marked lines are not.
TEST: services/gateway/test/scripts/vtid-04417-transport-flow-parity.test.ts

AC-3: `check()` turns a direct context build in a touched transport into one blocker finding naming the line and the shared builder.
TEST: services/gateway/test/scripts/vtid-04417-transport-flow-parity.test.ts

AC-4: The diagnostic endpoints build through the shared builder; tsc clean; ORB and route suites green.
TEST: services/gateway/test/orb, services/gateway/test/routes

## Not verified live

- **The rule runs on this PR's own impact scan**, which touches all three transport files. That run is the first real exercise.
