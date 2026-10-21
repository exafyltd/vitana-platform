# VTID-04767 — memory plan revision: the whole memory, not just chat facts

The owner rejected the first research round: it covered conversation logic and treated memory as one fact store. It ignored roles and multi-role users, personal vs role memory, cross-session memory, the Memory Garden, the Daily Diary, medical records and combining memories before answering. `docs/MEMORY-SYSTEM-PLAN.md` §8 now covers all of it, based on a code inventory of both repos and a second research round.

## Acceptance

AC-1: the plan has the revision, linked from the top.
TEST: services/gateway/test/docs/vtid-04767-memory-plan.test.ts

AC-2: every one of the 22 hard requirements has a stated answer.
TEST: services/gateway/test/docs/vtid-04767-memory-plan.test.ts

AC-3: roles (flow rule), Garden, Diary, health records, continuity, combining, people and erasure are each addressed.
TEST: services/gateway/test/docs/vtid-04767-memory-plan.test.ts
