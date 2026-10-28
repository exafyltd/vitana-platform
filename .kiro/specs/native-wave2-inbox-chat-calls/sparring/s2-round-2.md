# Sparring round 2 — converged

Session: `680bcc7d-1c3e-439b-bf36-61b9c494b048` · plan hash `8a7c445a04469431f396309b3cfcfcd8ec1af9658cef1f8bf586c6e85e66cc58`

## Summary

Round 2 review of the inbox-chat-calls Wave 2 plan. Both R1-F1 and R1-F2 were accepted by the planner but R1-F1 (useHybridMessages) was not actually incorporated into the revised plan text — the class-B hook enumeration is unchanged. Additionally, two more class-B hooks imported by Messages.tsx are missing from the enumeration. All major premises verified: the 9 ledger rows, routes, CallProvider/CallManager mounting, lane rules, and class-B classification of listed hooks all hold.

## Findings

### R2-F1 [minor]

R1-F1 was accepted ('useHybridMessages added to the explicit class-B hook list in the design') but the revised plan text still does not include `useHybridMessages` in either the Measured-state class-B enumeration or the Decision 2 re-implementation list. Both lists remain: `useMessages.ts, useChatApi.ts, useTypingIndicators.ts, useChatUnreadCount.ts, useRealtimeRelayStream.ts, useCallState.ts, useWebRTC.ts`. The hook is class B (transitively imports supabase via useGlobalMessages/useTenantMessages) and needs native re-implementation.

- `exafyltd/vitana-v1:src/hooks/useHybridMessages.ts:1` — import { useGlobalMessages } from './useGlobalMessages';
import { useTenantMessages } from './useTenantMessages';
import { useTypingIndicators } from './useTypingIndicators';
- `exafyltd/vitana-v1:src/hooks/useGlobalMessages.ts:5` — import { supabase } from '@/integrations/supabase/client';
import { realtimeChannel, removeRealtimeChannel } from '@/integrations/supabase/realtime';
- `exafyltd/vitana-v1:src/pages/Messages.tsx:28` — import { useHybridMessages } from '@/hooks/useHybridMessages';

Suggestion: Actually add `useHybridMessages` to both the Measured-state class-B enumeration and the Decision 2 native-re-implementation list so the accepted R1-F1 fix is reflected in the plan text.

### R2-F2 [minor]

Messages.tsx imports two additional class-B hooks — `useChatGroupsAsThreads` (line 31, imports `realtimeChannel` from `@/integrations/supabase/realtime`) and `useUnreadSync` (line 34, also imports `realtimeChannel` from `@/integrations/supabase/realtime`). Both are class B and need native re-implementation, but neither appears in the plan's class-B enumeration. The claim of an exhaustive list is still incomplete even after R1-F1's acceptance.

- `exafyltd/vitana-v1:src/pages/Messages.tsx:31` — import { useChatGroupsAsThreads, isChatGroupThreadId, chatGroupIdFromThreadId } from '@/hooks/useChatGroupsAsThreads';
import { useChatUnreadCount } from '@/hooks/useChatUnreadCount';
import { markGroupRead } from '@/hooks/useChatApi';
import { useUnreadSync } from '@/hooks/useUnreadSync';
- `exafyltd/vitana-v1:src/hooks/useChatGroupsAsThreads.ts:16` — import { useCallback, useEffect, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { realtimeChannel, removeRealtimeChannel } from '@/integrations/supabase/realtime';
import { useAuth } from '@/context/AuthProvider';
import { fetchGroups, type ChatGroup } from './useChatApi';
- `exafyltd/vitana-v1:src/hooks/useUnreadSync.ts:1` — import { useEffect, useCallback } from 'react';
import { useAuth } from '@/context/AuthProvider';
import { realtimeChannel, removeRealtimeChannel } from '@/integrations/supabase/realtime';

Suggestion: Add `useChatGroupsAsThreads` and `useUnreadSync` to the class-B hook enumeration. Both require native re-implementation (they subscribe to Supabase realtime channels). The full list should now be: useMessages, useChatApi, useTypingIndicators, useChatUnreadCount, useRealtimeRelayStream, useCallState, useWebRTC, useHybridMessages, useChatGroupsAsThreads, useUnreadSync.
