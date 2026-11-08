# Sparring round 1 — in_progress

Session: `efadbe18-afbe-452c-8138-e3a248f109e7` · plan hash `83f3b4c277037c1d4583317d420ea0053cf5640f272b5fddb9b6d664632eeffd`

## Summary

Verified 10+ premises against the pinned code. Most hold accurately. The ORB protocol, HomeScreen/DailyDiaryScreen deferrals, OverlayHost scope, link-router invite dispatch, auth-port pending channel, ledger rows, ConnectorsScreen fallthrough, test-timeout pattern/gaps, and gateway analytics schema all check out. One major design gap in the invite link navigation mechanism and one minor concern about the ORB directive handler modification.

## Findings

### R1-F1 [major]

Decision 6 says the link router will navigate invite links to `/i/<code>` 'with no sign-in hold,' but the plan does not specify how the existing `flush()` gate is bypassed. Currently `flush()` (link-router.ts:44-50) requires `deps.isSignedIn()` to be true before navigating any held route. For the exact cold-start signed-out scenario the plan aims to fix (item 4: 'A link that opens the app therefore lands on / and the code is never read'), `isSignedIn()` is false because no session has been set (auth-port.ts:55, `session` starts as `null`). If the implementation simply adds the invite href to `held` and relies on the existing `flush()`, the link will never navigate for signed-out users — silently reproducing the bug the plan describes. The plan must specify the flush bypass mechanism (e.g., a separate `heldPublic` slot that flushes on navigator-attach without the sign-in check, or a direct `navigate()` call for invites).

- `exafyltd/vitana-v1:apps/mobile/src/linking/link-router.ts:44` — const flush = () => {\n      if (held !== null && navigate && deps.isSignedIn()) {\n        const href = held;\n        held = null;\n        navigate(href);\n      }\n    };
- `exafyltd/vitana-v1:apps/mobile/src/linking/link-router.ts:58` — switch (link.kind) {\n        case 'auth':\n        case 'oauth_return':\n          deliverAuthLink(link);\n          break;\n        case 'invite':\n          deliverInviteLink(link);\n          break;\n        default:\n          held = hrefOf(link);\n          flush();\n      }
- `exafyltd/vitana-v1:apps/mobile/src/linking/auth-port.ts:55` — let session: SessionLike | null = null;

Suggestion: Add an explicit design note: invite dispatch must both `deliverInviteLink(link)` AND navigate to `/i/<code>` via a path that does not require `isSignedIn()`. For example, a `heldPublic` slot that `attachNavigator` and `flush` drain unconditionally, or an immediate `navigate?.('/i/<code>')` with a `held` fallback that flushes on `attachNavigator` alone. Specify which approach and add a test that asserts a cold-start invite link for a signed-out user results in navigation to `/i/:code`.

### R1-F2 [minor]

Decision 5 says `end_guided_topic_teaching` should emit `vitana:guided-topic-teaching-complete` on the overlay bus. Currently, session.ts:355-358 handles ALL `SESSION_END_DIRECTIVES` (including `end_conversation` and `end_teaching_session`) uniformly with `end('end_directive')`. The plan should note that the directive handler must branch on the specific directive string to emit the bus event only for `end_guided_topic_teaching`, so the other two end directives are not affected. Additionally, the plan references web widget backstop timers (45 s idle, 5 min ceiling) that fire the teaching-end locally — these are new native behavior that must be implemented in the session or controller but are described only by widget line references, not as explicit implementation tasks.

- `exafyltd/vitana-v1:apps/mobile/src/orb/session.ts:355` — if ((SESSION_END_DIRECTIVES as readonly string[]).includes(d)) {\n        const gen = generation;\n        waitForDrain(gen, navCancel, () => end('end_directive'));\n        return;\n      }
- `exafyltd/vitana-v1:apps/mobile/src/orb/protocol.ts:190` — export const SESSION_END_DIRECTIVES = ['end_conversation', 'end_teaching_session', 'end_guided_topic_teaching'] as const;

Suggestion: In the ORB lane description, explicitly state that: (a) the session directive handler will branch on `end_guided_topic_teaching` to emit the bus event before ending, leaving the other two directives unchanged; (b) the guided-topic idle/ceiling backstop timers are new native-side logic in the controller or session, not just a repeat of widget references.

### R1-F3 [minor]

The plan says test timeouts go into each folder's helpers.tsx using the settings pattern, and notes that 'Every test file in the four folders imports its helpers.tsx except two synchronous suites (diary/app-config-plugins.test.ts, ui/tokens-contract.test.ts).' The community/helpers.tsx and ui/helpers.tsx have fundamentally different structures from the settings/helpers.tsx pattern — community/helpers.tsx builds its own Supabase double and provider wrapper inline rather than using a shared `configure`+`jest.setTimeout` preamble; ui/helpers.tsx provides render utilities and RTL helpers with no configure call. Adding `configure({ asyncUtilTimeout })` and `jest.setTimeout` at the top of these files will work but the plan should confirm it won't conflict with any per-test overrides or import order issues (e.g., community tests that import both helpers.tsx and their own configure calls).

- `exafyltd/vitana-v1:apps/mobile/tests/community/helpers.tsx:1` — /* eslint-disable @typescript-eslint/no-explicit-any */\nimport type { ReactNode } from 'react';\nimport { QueryClient, QueryClientProvider } from '@tanstack/react-query';\nimport { AuthProvider } from '../../src/auth/AuthProvider';
- `exafyltd/vitana-v1:apps/mobile/tests/ui/helpers.tsx:1` — /** VTID-05176 — shared helpers for the Vitana Native UI tests. */\nimport type { ReactElement } from 'react';\nimport { I18nManager } from 'react-native';\nimport { render, type RenderResult } from '@testing-library/react-native';

Suggestion: Verify that no test file in the four folders calls `configure()` or `jest.setTimeout()` on its own (which would conflict or be overridden by the helpers import). A quick grep of each folder's test files for these calls before implementation would confirm.

## Next

Planner: answer every finding above in `sparring/responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
