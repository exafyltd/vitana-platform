---
slug: native-wave2-memory-diary-r2
author: kiro
executor: kiro
next_actor: kiro
state: drafted
author_seat: exafyltd
updated: 2026-11-01T00:05Z
spar_refs:
  - exafyltd/vitana-v1: main
---
# Handoff — Native Wave 2: Memory / Diary screen ports
Wave 2 screen-port batch of the native Maxina app program (`docs/programs/native-app/NATIVE-APP-PLAN.md`,
program VTID-05021; Wave 2 lane list in §5). Ports the 7 web destinations the parity ledger assigns to
`"lane": "memory-diary"` (vitana-v1 origin/main, ledger version 2, 435 rows) to native at 1:1 mobile-web parity on
`@vitana/core` + `@vitana/ui` + the N3 shell; fixture / fake-gateway tests only, device-runtime parity deferred to G1
(`next_actor: owner`). Plan block: `plan.md`. Lanes: `lanes/*.md` (2 — `memory`, `diary` — all `ready`, executor
kiro, seat exafyltd → reviewer_seat hotmail, disjoint `paths`, no `vtid` yet). No web screen, `App.tsx` route or
registry/manifest change — only native route files, a DE-first i18n key (+ its mirrors), at most a `@vitana/core`
re-export line, and parity-row status flips. Ledger investigation: `sparring/ledger-findings.md` (read-only,
verified against vitana-v1 origin/main).
Re-plan of `native-wave2-memory-diary` (PR #4322, converged) under a new slug; the old branch has commits without Collab trailers. Sparring history: https://github.com/exafyltd/vitana-platform/pull/4322.
## Log
### 2026-11-01T00:05Z · kiro-exafyltd-202611010001-e9e0 · created → drafted
Holder of the `native-wave2-memory-diary-r2/_plan` claim. Re-plan of `native-wave2-memory-diary` (PR #4322, converged and policy-approved), whose branch cannot pass Collab handoff without a history rewrite (commits without a Collab-Session trailer). Copied the converged plan, tasks, requirements, design and lane files from the old PR head; lane VTIDs removed (CI allocates on convergence), lane logs restarted, sparring rounds left on the old PR. One commit, one session. No VTID allocated, no product code changed, no live system touched. Next: PLAN-SPAR spars the `plan(native-wave2-memory-diary-r2)` PR; this session answers each round in `sparring/responses-<n>.md`.
