# Responses — session 2, round 1 (session 344459ea)

```json
[{"finding_id":"R1-F1","disposition":"accepted","rationale":"Verified: CreateGroupPopup.tsx:51 and GroupMembersModal.tsx:161 delegate to supabase.rpc('search_global_directory') / ('search_tenant_directory'); the bot/test-actor exclusion is server-side. The plan block now requires the native member search to call exactly those two RPCs with the same parameters (never a raw table query), plus a per-lane unit test asserting those RPC calls.","deferred_to":null},{"finding_id":"R1-F2","disposition":"accepted","rationale":"Verified Messages.tsx:28-35 imports useHybridMessages (delegating to useGlobalMessages / useTenantMessages), useChatGroupsAsThreads, useChatUnreadCount, markGroupRead, useUnreadSync and useProgressiveCount. The plan block now names the 7-hook list as the load-bearing sample and lists these as part of the class-B inbox data layer the lanes re-implement natively.","deferred_to":null}]
```
