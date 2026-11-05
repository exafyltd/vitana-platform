---
change_class: standard
---
# plan(memory-legacy-read-retire): the ORB reads memory only through recall(); the legacy six-table read and its shadow go
<!-- plan:begin -->
## Problem
Memory plan §8.4 phase 2 (VTID-04784, VTID-05007) moved the ORB memory read to `recall()`. Production serves recall since
2026-10-09 20:15 UTC (env-only run 37985283918; pinned in `AWS-PROD-DEPLOY-GATEWAY.yml` since `4bc87f36`). The
2026-10-10 read-only shadow report showed 44/44 sessions with identical facts and 0 shadow failures
(`docs/validation/VTID-05007/outputs/production.md`). That record set a two-week watch until about 2026-10-23 and named
the next step: delete the legacy six-table read in `orb-memory-bridge.ts` (plan §8.4 phase 7, first bullet) under its own
VTID. The watch has ended. No PR since then touches it (GitHub search, 2026-11-04).

Today every ORB memory read still pays for the legacy path twice:
- the shadow (`MEMORY_ORB_RECALL_SHADOW=true`, pinned on both gateways) runs the six queries in the background after
  every read;
- when `recall()` returns `ok:false`, the bridge silently falls back to the six queries, so a recall failure is hidden.

## Premises (read-only, `exafyltd/vitana-platform` @ `29b639da4bfcacce3200e2d1d08881c260c4e990`; line numbers re-checked there, unchanged from `bf5e0c12`)
1. `services/gateway/src/services/orb-memory-bridge.ts:887-908`: with recall enabled and an identity, the bridge returns
   the recall result when `ok`; a forced recall returns `ok:false`; otherwise it falls through to the legacy read.
2. `orb-memory-bridge.ts:910-1157`: the legacy read (six parallel queries: persistent and time-sensitive `memory_items`,
   `memory_facts` over REST, `memory_diary_entries`, `diary_entries`, `ai_memory`), 2 s timeout, `read_path: 'legacy'`.
3. `orb-memory-bridge.ts:831-847`: `fetchMemoryContextWithIdentity` starts `runRecallShadow` against the other path when
   `MEMORY_ORB_RECALL_SHADOW=true`.
4. The five `orb-memory-bridge-repository.ts` fetchers used by the legacy read (`fetchPersistentMemoryItemsParallel`,
   `fetchTimeSensitiveMemoryItemsParallel`, `fetchMemoryDiaryEntriesParallel`, `fetchLovableDiaryEntriesParallel`,
   `fetchLovableAiMemoryParallel`) have no other caller in `services/gateway/src` or `test`. The rest of that file
   (`fetchOrbConversationItems`, `fetchRecentOrbUserTurnsRaw`, `insertMemoryItem`, the `*ByImportance`/`*ByOccurredAt`
   fetchers, the `rpc*` helpers) stays: it is used by other bridge code.
5. `runRecallShadow` and `isRecallShadowEnabled` (`services/memory/recall-shadow.ts`) are called only from the bridge and
   `test/services/memory/vtid-04784-recall-shadow.test.ts`.
6. `isOrbRecallEnabled()` (`services/memory/recall.ts:94`) reads `MEMORY_ORB_RECALL_ENABLED`; the flag is pinned `true` on
   staging (`AWS-STAGE-DEPLOY-GATEWAY.yml:1261`) and production (`AWS-PROD-DEPLOY-GATEWAY.yml:1538-1540`), and in
   `conversation/conversation-flag-pins.generated.ts:115-116`.
7. To measure before the lane merges (read-only, CloudWatch `/vitana/gateway-awsdr`, last 14 days): the number of
   `[VTID-04452] orb recall unavailable` lines and the number of sessions served by `legacy`
   (`scripts/memory/recall-shadow-report.sh /vitana/gateway-awsdr 336`). This is the fallback that the change removes.
   A Kiro Web session has no AWS credentials (`aws sts get-caller-identity`: NoCredentials, 2026-11-05), and the only
   in-repo CloudWatch reader (`aws-cloudwatch-logs-readonly.ts`) runs inside the production Operator Console. So the
   count is taken by the owner or a session with read-only AWS access, and recorded in
   `docs/validation/<VTID>/outputs/recall-failures.md` before merge. The lane is built and reviewed meanwhile; only
   its merge waits on the count.

## Change — one lane `bridge-recall-only` (vitana-platform, gateway only)
- `readMemoryContext` returns the recall result for an identified caller. When recall is not ok, it returns
  `ok:false`, `items: []`, `error` from recall, the same shape a forced recall returns today (premise 1). The
  no-identity dev-sandbox path keeps its current "Memory bridge disabled" answer. Every caller in `routes/orb-live.ts`
  already handles a context with `ok:false` or no items (`:3239` falls back to `emptyMemoryContext`; `:13156`, `:13177`,
  `:13248` check `ok`/`items.length`; `:15186` and `:17260` read `items` only), so a session starts with no memory block
  instead of the legacy read.
- Delete the legacy read (premise 2), the `forcePath`/`ReadPath` plumbing, the `read_path` field and the shadow call
  (premise 3), only the five legacy-read fetchers from `orb-memory-bridge-repository.ts` (premise 4; the rest of the
  file stays), and `recall-shadow.ts` with its test (premise 5).
- The dev-sandbox path with no identity (`isMemoryBridgeEnabled()`, dev-sandbox only, never staging or production) read
  `DEV_IDENTITY`'s memory through the legacy read; it now reads it through `recall()`. With the bridge disabled it keeps
  its "Memory bridge disabled" answer.
- `isOrbRecallEnabled()` is no longer read by the bridge. The flag pins stay in both deploy workflows and the generated
  pin file for now: `AWS-PROD-*.yml` is a protected gate file (`scripts/collab/protected-gate-files.json`), and an unused
  env var is harmless. `scripts/memory/recall-shadow-report.sh` stays, because it still reads old log windows.
- One log line per not-ok recall stays (`recall.ts`, existing `[VTID-04452] orb recall unavailable`), so failures are now
  visible instead of hidden by the fallback.

## Test plan
- New, red on `origin/main` (prototyped 2026-11-05: 4 failed / 1 passed on `29b639da`): in
  `test/services/memory/recall-bridge-wiring.test.ts`, with recall returning `ok:false`, `fetchMemoryContextWithIdentity`
  returns `ok:false`, no items, recall's `error`, and makes no network call (no legacy query, no shadow); a successful
  read starts no shadow; recall is used whatever `MEMORY_ORB_RECALL_ENABLED` says.
- Updated (R1-F1), `test/services/orb-memory-bridge.test.ts`: the two `fetchMemoryContextWithIdentity` tests that asserted
  the legacy `memory_items` queries are converted, not dropped. Tenant scoping is asserted on the identity handed to
  `recall()` (exactly the given `tenant_id`/`user_id`, never `DEV_IDENTITY`'s) plus "no direct `memory_items` query"; the
  all-empty case is asserted on an empty recall. The two dev-identity tests are unchanged.
  `test/vtid-05147-effective-role-permitted.test.ts` mocks `fetchMemoryContextWithIdentity` entirely, so it needs no
  change (prototype: 73/73 across the three files). `test/routes/orb-live.test.ts` mocks it too and is unchanged.
- Removed with the code: `test/services/memory/vtid-04784-recall-shadow.test.ts`. No other test is skipped or loosened.
- Gateway `npx tsc --noEmit` clean and full `npx jest` green apart from failures that also fail on `origin/main` (prototype:
  `test/providers/storage-provider.test.ts` and `test/vtid-04226-eventbridge-test-contract-schedules.test.ts` read the
  sandbox's `AWS_REGION`/AWS env and fail identically on `29b639da`; CI is the reference).
- Staging: `docs/validation/<VTID>/staging-tests.json`: `/alive` 200 (the new bridge loads on the deployed commit) and
  `kind: existing` for the three changed test files plus `test/services/memory/recall.test.ts`. Read-only; nothing writes.
  STAGING-VERIFY on the merge commit is the end point.

## Rollback
Revert the lane's merge commit. There is no env-only rollback after this change, which is why premise 7 is measured
first; if it shows recall failures above about 0.5% of sessions, the lane is parked and the owner is told before merge.

## Lanes
- `bridge-recall-only` (vitana-platform, seat `exafyltd`, area `platform`, executor `kiro`, `depends_on: []`). Paths:
  `services/gateway/src/services/orb-memory-bridge.ts`, `services/gateway/src/services/orb-memory-bridge-repository.ts`,
  `services/gateway/src/services/memory/recall-shadow.ts`, `services/gateway/test/services/memory/**`,
  `services/gateway/test/services/orb-memory-bridge.test.ts`, `services/gateway/test/routes/orb-live.test.ts`,
  `services/gateway/test/vtid-05147-effective-role-permitted.test.ts`, `docs/MEMORY-SYSTEM-PLAN.md`,
  `docs/validation/VTID-*/**`.

## Out of scope
- The other phase 7 deletions (tier-2 `mem_*` mirrors, `ai_memory` table, D-engine prompt paths): each its own plan.
- Removing the `MEMORY_ORB_RECALL_*` pins from `AWS-PROD-DEPLOY-GATEWAY.yml` (protected gate file, owner instruction needed).
- W2 (EventBridge memory jobs, VTID-05011) and W4 (dev-memory pack token, VTID-05009): owner AWS steps, unchanged.
<!-- plan:end -->
