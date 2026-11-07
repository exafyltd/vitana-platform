# Acceptance — VTID-05529 (mt-track-s-authz / work-surface-permission)

Each permitted-role rule is the owner's per-screen rule (handover, 2026-11-03). Commerce is unchanged.
Test names below are the titles in services/gateway/test/mt-track-s-authz-work-surface.test.ts (outputs/green.txt).

AC-1: A declared command-hub, admin or backoffice surface is kept only for a signed-in caller who holds a permitted role for that screen. Command Hub: developer, admin, infra or staff. Admin: admin, developer or infra. BackOffice: backoffice, admin, developer or infra.
TEST: mt-track-s-authz-work-surface › verifyWorkSurfaceProfile — command-hub | admin | backoffice › kept for a caller with the permitted role <role>, resolution "permitted"

AC-2: Every other switcher role is narrowed to the member surface on each of the three screens: surface vitanaland, role null, resolution "narrowed", the declared values kept for telemetry.
TEST: mt-track-s-authz-work-surface › verifyWorkSurfaceProfile — command-hub | admin | backoffice › narrowed to the member surface for <role> alone

AC-3: Each screen's permitted set mirrors its own gate: the Command Hub set equals COMMAND_HUB_ROLES in services/gateway/src/routes/command-hub.ts.
TEST: mt-track-s-authz-work-surface › each screen mirrors its own gate › the Command Hub role set is the one routes/command-hub.ts admits

AC-4: An unreadable permitted set fails closed: null, an empty set, the exafy_admin claim offered as a role, and a rejected read all serve the member surface.
TEST: mt-track-s-authz-work-surface › verifyWorkSurfaceProfile — command-hub | admin | backoffice › fails closed when the permitted set is unreadable (null)
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › a permitted-roles read that rejects is served the member surface and the session still starts
TEST: mt-track-s-authz-work-surface › LiveKit mint — resolveLiveKitServedProfile › a rejected read fails closed to the member surface

AC-5: The exafy_admin claim keeps the resolver's value and reads no permitted set. An anonymous session is unchanged and reads nothing.
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › exafy_admin keeps the declared surface and never reads the permitted set
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › an anonymous session is unchanged and reads nothing

AC-6: Commerce is unchanged: the same surface, role and resolution, and no permitted-roles read at the session start, in the LiveKit mint or in the verifier.
TEST: mt-track-s-authz-work-surface › verifyWorkSurfaceProfile — commerce, member and anonymous are unchanged › commerce keeps its surface and role for every permitted input, including unreadable
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › commerce is unchanged: served without a permitted-roles read
TEST: mt-track-s-authz-work-surface › LiveKit mint — POST /orb/livekit/token › commerce is minted as before

AC-7: A session start for a caller without a permitted role is served the member surface. Its instruction holds no admin briefing, the session holds none, and orb.session.profile.resolved is emitted with status warning.
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › command-hub declared by a caller without a permitted role: member surface, no admin briefing, warning event
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › admin declared by a caller without a permitted role: member surface, no admin briefing

AC-8: A permitted caller keeps the work surface with resolution "permitted", with the work-surface context and the admin briefing.
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › a permitted caller keeps the work surface, resolution "permitted", with the admin context

AC-9: At the session start, an unreadable permitted set (roles null) is served the member surface.
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › an unreadable permitted set (roles null) is served the member surface

AC-10: A refused caller's Command Hub route does not lift the member brain to the developer role, and a refused caller binds no operator thread. A stored developer role does not serve the work role. A verified Command Hub session still binds its thread.
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › a refused caller on a Command Hub route is not lifted to the developer brain by the route
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › a refused caller cannot bind an operator thread; a permitted developer still can
TEST: mt-track-s-authz-work-surface › session start — a declared work surface is served only to a permitted caller › a refused caller whose stored role is developer is served the member role, not the work role

AC-11: The LiveKit mint serves the verified profile: a refused caller gets the member surface and role, a permitted caller the admin surface and role, an unreadable permitted set the member surface, and exafy_admin the declared surface.
TEST: mt-track-s-authz-work-surface › LiveKit mint — resolveLiveKitServedProfile › a declared admin surface without a permitted role is served the member surface
TEST: mt-track-s-authz-work-surface › LiveKit mint — POST /orb/livekit/token › a non-exafy caller without a permitted admin role is minted a member session

AC-12: The LiveKit context bootstrap builds both system instructions for the verified surface.
TEST: mt-track-s-authz-work-surface › source contracts — the three routes call the verifier › the LiveKit context bootstrap builds both instructions for the verified surface

AC-13: A text turn's body role other than user or community is served only to exafy_admin or to the caller's effective role. Anything else is served as user. The tool set served for a denied developer role is the user tool set.
TEST: mt-track-s-authz-work-surface › text path — servedTurnRole › a denied developer role yields the user tool set, not the developer one
TEST: mt-track-s-authz-work-surface › source contracts — the three routes call the verifier › the text turn and stream serve the clamped role and resolve the effective role

AC-14: ProfileResolution includes "permitted"; resolveAssistantProfile is unchanged; the role separation suite stays green without editing it.
TEST: npm run test:roles (test/vtid-04560-role-separation-regression.test.ts): 105 passed, outputs/test-roles.txt

AC-15: The other required suites and the type check stay green.
TEST: npm run test:support: 87 passed, outputs/test-support.txt
TEST: npm run test:operator: 71 passed, outputs/test-operator.txt
TEST: npm run test:voice-identity: 28 passed, 56 snapshots passed, outputs/test-voice-identity.txt
TEST: npx tsc --noEmit (services/gateway): exit 0, outputs/tsc.txt

Open, not accepted by this PR as it stands:
- OPEN-1: services/gateway/test/routes/orb-livekit.test.ts is outside this lane's paths. Three of its assertions pin the previous contract: two VTID-04776 mint cases (a non-permitted caller declaring admin or backoffice is served that role) and the GET /orb/context-bootstrap instruction call, which now receives the served surface as a fourteenth argument. They fail on this branch (outputs/livekit-route-suite.txt, outputs/full-suite-summary.txt). The file needs to join the lane paths, with those assertions stating the new contract.
- OPEN-2: test/providers/storage-provider.test.ts and test/vtid-04226-eventbridge-test-contract-schedules.test.ts fail in this sandbox for environment reasons (AWS region variable, openssl not installed). They also fail on origin/main (outputs/baseline-origin-main.txt).
