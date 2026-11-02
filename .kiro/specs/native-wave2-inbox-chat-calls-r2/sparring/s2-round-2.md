# Sparring round 2 — converged

Session: `344459ea-0539-4cb4-ab44-8493d4e91c28` · plan hash `aade652c546badfb82c9abc8ba9f17fa427702c9b3b6536c14216542fb39be19`

## Summary

Round 2 is blocked by persistent GitHub 403 errors on both `exafyltd/vitana-v1` and `exafyltd/vitana-platform` at their pinned commits — every `read_file` and `list_dir` call fails. This is the same rate-limit / access issue the plan itself documents in its "Sparring status" section. No new premises could be verified and no new findings can be raised (every finding and premise check must cite a `read_file` result from this round).

Both R1-F1 and R1-F2 were accepted by the planner. Reviewing the revised plan text, both appear substantively addressed:
- R1-F1 (RPC-based bot exclusion): The Compliance section now explicitly requires native member search to call `search_global_directory` / `search_tenant_directory` RPCs (never a raw table query) and mandates a per-lane unit test asserting those RPC calls.
- R1-F2 (hook inventory): The Measured State section now names the 7-hook list as a "load-bearing sample" and explicitly enumerates the additional hooks (`useHybridMessages`, `useGlobalMessages`, `useTenantMessages`, `useChatGroupsAsThreads`, `useUnreadSync`, `useProgressiveCount`) as class-B hooks scoped by the lanes.

A fresh session with working repo access is needed to verify the load-bearing premises (9 parity-ledger rows, CallProvider/CallManager mount points, App.tsx routes, class-B hook classifications, parity-ledger.mjs shapeOf matching logic) that were not checked in either round.

## Findings

_none_
## Acknowledgements of earlier responses

- R1-F1: acknowledged — Accepted and addressed. The revised Compliance section now explicitly requires native member search to call the same `search_global_directory` / `search_tenant_directory` RPCs (never a raw table query) and adds a per-lane unit test requirement asserting those RPC calls. This matches the suggestion.
- R1-F2: acknowledged — Accepted and addressed. The revised Measured State section now names the 7-hook list as the 'load-bearing sample' and explicitly enumerates useHybridMessages (and delegates useGlobalMessages/useTenantMessages), useChatGroupsAsThreads, useChatUnreadCount, markGroupRead, useUnreadSync, and useProgressiveCount as class-B hooks in the inbox data layer, scoped by the conversation-chat and inbox-list lanes. This matches the suggestion.
