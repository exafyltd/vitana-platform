# Sparring round 1 — in_progress

Session: `680bcc7d-1c3e-439b-bf36-61b9c494b048` · plan hash `8a7c445a04469431f396309b3cfcfcd8ec1af9658cef1f8bf586c6e85e66cc58`

## Summary

The plan is well-structured and the major factual premises hold against the codebase. I verified the 9 parity-ledger rows (5 screen + 4 exclusion, all `inbox-chat-calls`, all `not_started`), CallProvider/CallManager mounting in Messages.tsx, the class B classification of key hooks, App.tsx routes, and the shapeOf matching logic. Line number references are approximate (as the plan declares) but directionally correct. Two minor findings are noted below; no blockers or major issues found.

## Findings

### R1-F1 [minor]

The plan lists `useMessages.ts`, `useChatApi.ts`, `useTypingIndicators.ts`, `useChatUnreadCount.ts`, `useRealtimeRelayStream.ts`, `useCallState.ts`, `useWebRTC.ts` as the exhaustive set of class-B chat/call hooks, but Messages.tsx also imports `useHybridMessages` (line 28). If this hook is class B (likely, given the pattern), the enumeration is incomplete. If it were somehow class A / pure, it would be a core-extraction candidate the plan doesn't account for.

- `exafyltd/vitana-v1:src/pages/Messages.tsx:28` — import { useHybridMessages } from '@/hooks/useHybridMessages';

Suggestion: Add `useHybridMessages` to the explicit class-B hook list (or verify and document its classification). It's almost certainly class B, but the plan's claim of an exhaustive enumeration should include it.

### R1-F2 [minor]

CallManager.tsx imports `callSounds` from `@/utils/callSounds` (line 7) which uses browser Audio API for ringtone/beep playback. The native re-implementation of CallManager will need a platform-appropriate audio solution (e.g. expo-av or react-native-sound). The plan doesn't mention this web-only dependency.

- `exafyltd/vitana-v1:src/components/CallManager.tsx:7` — import { callSounds } from '@/utils/callSounds';

Suggestion: Acknowledge `callSounds` as a web-only utility that needs a native equivalent (expo-av or similar), and note it in the conversation-chat lane scope so the implementer doesn't overlook it.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
