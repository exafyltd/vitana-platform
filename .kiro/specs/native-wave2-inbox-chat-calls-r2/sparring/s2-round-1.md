# Sparring round 1 — in_progress

Session: `344459ea-0539-4cb4-ab44-8493d4e91c28` · plan hash `ec6506f61a4140139861f97b6eba03f4232fea234f6c995b67fce866c9d28454`

## Summary

Verified 6 distinct premises against the pinned code. The plan is substantively sound: the 9 parity-ledger rows, their lane assignment, the class-B classification of every chat/call hook, the CallProvider/CallManager mounting in Messages.tsx, the App.tsx routes, and the shapeOf matching logic all check out. Two minor findings: (1) the NEVER-45 bot-exclusion mechanism lives in server-side RPCs, not client code, so the plan's language about "reusing the web search query" needs clarification for a natively re-implemented data layer; (2) the plan's explicit class-B hook list omits several hooks also used in Messages.tsx that the native implementation will need to re-implement.

## Findings

### R1-F1 [minor]

The plan's NEVER-45 compliance section says member-listing exclusion (service_bot_accounts + notification_test_actors) is 'inherited by reusing the web search query, not re-implemented' (citing CreateGroupPopup.tsx:51 and GroupMembersModal.tsx:161). However, neither component contains client-side bot filtering — both delegate to `supabase.rpc('search_global_directory')` / `supabase.rpc('search_tenant_directory')`, meaning the exclusion lives entirely in the database RPC functions. Since Decision 2 mandates a full native re-implementation of the data layer, the native code must explicitly call these same RPCs to inherit the server-side exclusion. The plan should specify this as a concrete implementation requirement and add a test that the native member-search results exclude service/test accounts.

- `exafyltd/vitana-v1:src/components/messages/CreateGroupPopup.tsx:51` — const searchUsers = async (term: string) => { ... const searchFunction = context === 'global' ? supabase.rpc('search_global_directory', { search_term: term }) : supabase.rpc('search_tenant_directory', { search_term: term, tenant_id_param: user?.user_metadata?.active_tenant_id }); ...
- `exafyltd/vitana-v1:src/components/messages/GroupMembersModal.tsx:161` — const searchUsers = async (term: string) => { ... const searchFunction = context === 'global' ? supabase.rpc('search_global_directory', { search_term: term }) : supabase.rpc('search_tenant_directory', { search_term: term, tenant_id_param: user?.user_metadata?.active_tenant_id }); ...

Suggestion: In the compliance section and in the lane requirements, explicitly state that the native member-search must call the same `search_global_directory` / `search_tenant_directory` RPCs (where the bot exclusion is enforced server-side). Add a unit test per lane that asserts the native search calls these RPCs, so a future refactor to a raw table query cannot silently drop the exclusion.

### R1-F2 [minor]

The plan's class-B hook enumeration lists 7 hooks (useMessages, useChatApi, useTypingIndicators, useChatUnreadCount, useRealtimeRelayStream, useCallState, useWebRTC) but Messages.tsx also imports useHybridMessages (line 28), which delegates to useGlobalMessages and useTenantMessages (also class B), plus useChatGroupsAsThreads (line 31), useChatUnreadCount (line 32), markGroupRead from useChatApi (line 33), useUnreadSync (line 34), and useProgressiveCount (line 35). These are all part of the inbox data layer that must be re-implemented natively per Decision 2. Omitting them from the scoping list risks underestimating the conversation-chat lane.

- `exafyltd/vitana-v1:src/pages/Messages.tsx:28` — import { useHybridMessages } from '@/hooks/useHybridMessages';
import { useChatGroupsAsThreads, isChatGroupThreadId, chatGroupIdFromThreadId } from '@/hooks/useChatGroupsAsThreads';
import { useChatUnreadCount } from '@/hooks/useChatUnreadCount';
import { markGroupRead } from '@/hooks/useChatApi';
import { useUnreadSync } from '@/hooks/useUnreadSync';
import { useProgressiveCount } from '@/hooks/useProgressiveCount';
- `exafyltd/vitana-v1:src/hooks/useHybridMessages.ts:1` — import { useRole } from './useRole';
import { useGlobalMessages } from './useGlobalMessages';
import { useTenantMessages } from './useTenantMessages';
import { useTypingIndicators } from './useTypingIndicators';
import { prefetchMessages } from './messageCache';

Suggestion: Add useHybridMessages (and its delegates useGlobalMessages/useTenantMessages), useChatGroupsAsThreads, useUnreadSync, and useProgressiveCount to the plan's class-B hook inventory, or note that the 7-hook list is illustrative rather than exhaustive. This helps the executor correctly scope the native re-implementation.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
