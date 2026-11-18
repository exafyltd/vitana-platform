---
slug: preview-gateway-recovery
author: kiro
author_seat: jtadic
executor: kiro
next_actor: owner
state: drafted
updated: 2026-11-18T12:00Z
---
# Handoff: preview-gateway-recovery

Drafted by Kiro (kiro-jtadic-202611180939-a2df). Sparring is paused on the owner's instruction (2026-11-18), and the sparring gateway is the
thing this plan repairs, so no `plan(` PR is opened yet. The branch is pushed for review only.

### 2026-11-18T10:30Z · kiro-jtadic-202611180939-a2df · drafted
Waiting for the owner: D1 (proxy revision 21), D2 (canonical-ledger option), D3 (restore files + target),
D4 (one-time changes and who runs them). See plan.md §2–§5.

### 2026-11-18T11:15Z · kiro-jtadic-202611180939-a2df · drafted (owner decisions D1–D4 applied)
D1 proxy rev 21 + separate preview token; D2 allocation deferred, preview sparring is evidence only; D3 schema-only
restore rehearsed (40/40, rehearsal-output.txt), waiting for Dragan's dry run; D4 listener rule narrowed to the sparring
paths after the blast-radius check. Waiting for the owner: break-glass VTIDs, PLAN-SPAR.yml instruction, D3 apply.

### 2026-11-18T12:00Z · kiro-jtadic-202611180939-a2df · drafted
Strict precheck + exact rollback scope (rehearsal 44/44, catalog identical after rollback); sparring-only rule accepted
by the owner, routing evaluated; branch pushed from a single-repo checkout; plan-spar-token prepared (local c799b28328).
Next: Dragan's read-only dry run; owner decision on rule 55 and the 2 break-glass VTIDs.
