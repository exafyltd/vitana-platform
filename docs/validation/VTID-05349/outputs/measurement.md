# Measurement — VTID-05349 (Kiro Web, Linux, node 20+, vitana-platform 51a8e57113, vitana-v1 57aece53f)

Source tables: `benchmark.md` (from `bench-context-map.sh`) and `codeintel.txt`.

## One `context.mjs` call against today's way, seven representative questions

The baseline is generous. Its grep/git commands already know where to look (the mount table, `screens.json`, the
parity-ledger key, the App.tsx line), which is exactly the knowledge a fresh session lacks and had to rediscover in
past plans (plan §2.2).

| task | today: commands / bytes | `context.mjs`: commands / bytes |
|---|---|---|
| T1 gateway route → handler + tests | 4 / 2 542 | 1 / 842 |
| T2 v1 path → page + registrations | 6 / 389 | 1 / 1 034 |
| T3 area map (routes, tables, flags) | 3 / 41 984 | 1 / 2 115 |
| T4 importers (code vs tests) | 1 / 1 183 | 1 / 607 |
| T5 why (rule + history) | 1 / 35 256 | 1 / 3 653 |
| T6 prior work for a VTID | 5 / 865 (resume-vtid.sh fails: no token) | 1 / 1 191 |
| **T1–T6** | **20 / 82 219** | **6 / 9 442 (−70 % calls, −89 % bytes)** |
| T7 stale pointers | no command; found by two ad-hoc scripts in this investigation | 1 / 2 299 |

Every answer was found by both. Wall time is not the difference: every call takes ≤ 1.3 s either way. The savings are
in agent turns (14 fewer tool calls on six questions) and in the context read (≈ 18 k fewer tokens at 4 bytes/token),
plus the correctness of knowing where to look.

## RepoWise / Graphify on the same questions (`codeintel.txt`)
- Ready only after the 436 s install and index build (foreground; the detached start died in this session).
- T4: `graphify explain` gives the same importers, with `file:line`, in 6.1 s. Good.
- T1: `repowise search` (full text only) did not return `routes/vtid.ts` for either phrasing, 3.4–3.9 s.
- T5: `repowise search` returns the enforcing code (`routes/worker-orchestrator.ts`), not the rule that explains it.
- T6: `repowise search VTID-05300` returns nothing.
- `graphify query … --budget 1500` returned unrelated nodes for T4.

## This investigation as a sample session
Before the tool existed, collecting these facts took about 25 exploratory tool calls (grep, ls, reads, index runs).
With it, the same facts come from 7 calls, one per question.
