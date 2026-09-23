# services/memory — user memory

One place to read before touching memory. The plan and the defect list (D1–D12)
are in `docs/MEMORY-SYSTEM-PLAN.md`; this file says what is true in the code now.

## Stores

| Table | Holds | Written by | Kept |
|---|---|---|---|
| `memory_facts` | One current value per (user, `fact_key`); older values stay as superseded history | `remember.ts` only | forever, until the user forgets it |
| `memory_items` | Episodes worth recalling: session summaries, diary entries, daily learnings, Garden notes, `customer` and `support_ticket` episodes | the modules below | forever |
| `memory_transcript_turns` | Raw conversation turns | `transcript.ts` | 90 days (pg_cron purge) |
| `memory_fact_forgotten` | Hashed "do not re-learn" markers for facts the user forgot | `garden.ts` (add), `remember.ts` (clear) | until the user states the fact again |
| `diary_entries` | The Diary screen's own rows | `diary.ts` | forever |
| `dev_agent_memory` | Developer / role memory (decisions, gotchas, handoffs) — not user memory | `dev-agent-memory*` services, outside this folder | — |

`mem_facts` / `mem_episodes` are the old tier-2 mirrors. The gateway no longer
writes them (VTID-04366); dropping them is pending (plan Phase 1).

## One write path per kind

| Kind | Function | Notes |
|---|---|---|
| Fact | `rememberFact()` — `remember.ts` | Identity Lock → forgotten-marker check → `write_fact` RPC → Titan embedding. Every fact writer goes through it (inline extractor, intent hooks, memory-intelligence, Garden). Never call the `write_fact` RPC directly. |
| Diary entry | `saveDiaryEntry()` — `diary.ts` | `diary_entries` row + `memory_items` episode + Vitana Index sync. Route: `POST /api/v1/memory/diary/entries`. |
| Raw turn | `transcript.ts` | `memory_transcript_turns`. Also `memory_items` while `MEMORY_RAW_TURNS_TO_ITEMS` is not `false` (transition). |
| Session summary | session-end commit (VTID-04365) | One per `session_id`, idempotent; every transport ends in the same commit. |
| Daily learning | `daily-learning.ts` | One per (user, local date); AP-0914 at the user's 22:00. |
| Customer episode | `customer.ts` | One per executed BackOffice CRM/sales command; `active_role 'backoffice'`. |
| Support ticket | `support-ticket.ts` | Two per resolved ticket: the member's (`active_role NULL`) and `role:support`. |
| Garden edits | `garden.ts` | Add / edit / forget facts, add notes, edit / delete episodes. |

Rules every writer follows:
- **Embed with Titan V2 only** (`../memory-embedding.ts`, 1024 dims). No
  fallback provider. A failed embedding leaves the row NULL; AP-0910 retries.
- **Set the role scope** with `memoryRoleForWrite()` (`scope.ts`): NULL for
  personal memory, the role name for memory written while working in a role.
- **Importance ≤ 50** for anything written automatically, so
  `trg_notify_memory_garden` (> 50) does not notify the user.

## Reading

- **`getMemoryContext()`** (`../memory-broker.ts`) is the read API. The context
  pack and the agents read through it. It reads `memory_facts`, `memory_items`
  (semantic search first, then recent) and both diary tables.
- **Role scope on read:** `memoryRoleForRead()`. A session sees personal memory
  plus its own role's memory, never another role's.
- **Garden:** `listGardenEntries()` shows exactly what recall reads, grouped
  into the 13 categories.
- **Staff-only readers** (service role, never a member-facing surface):
  `backoffice_customer_memory` (customer episodes, needs `crm.view` or
  `sales.view`) and `support_resolution_search` (the support drafters; returns
  ticket ids only).
- Still outside the broker: the ORB live prompt uses
  `fetchMemoryContextWithIdentity`. Moving it to one `recall()` needs latency
  measured on staging first (plan Phase 1).

## Forgetting

Forgetting a fact in the Garden deletes every row of its key, history included.
It first writes one `memory_fact_forgotten` marker per value (sha256 of the
normalised value; the value itself is not kept). After that:
- an inferred write of that value is refused (`blocked: 'forgotten'`);
- a different value for the key is still learned;
- an explicit user statement (`user_stated*`, `user_edited`) is written and
  clears the marker.

## Flags

| Variable | Default | Effect |
|---|---|---|
| `MEMORY_RAW_TURNS_TO_ITEMS` | on | `false` stops raw turns going to `memory_items`. Flip it once session summaries are seen on staging. |
| `SUPPORT_PRIOR_RESOLUTIONS_ENABLED` | on | `false` stops the support drafters reading past resolutions. |
| `BEDROCK_ROLE_ARN` | — | Required for Titan embeddings. Unset means no vectors, and recall falls back to recent. |

## Failure posture

Memory is best effort around the user's request, and loud about it:
- A failed write is logged and returned as `ok:false`; it never breaks the turn.
- A failed side check (marker store, prior resolutions) lets the main action
  through and logs with its VTID tag.
- `ci_memory_health()` (morning check #21) reports facts and episodes written
  per day, % embedded, session-end commits and the DLQ.
- The golden recall eval (`test/memory-golden-eval.test.ts`) runs in CI on every
  memory change. Every scenario must pass.

## Tests

`test/services/memory/`, `test/memory-golden-eval.test.ts`, and the per-VTID
suites (`test/vtid-04*-*.test.ts`). Never test against production. Use the fake
clients in these tests, or the isolated `vitana-memory-test` database.
