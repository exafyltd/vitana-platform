---
slug: preview-gateway-recovery
author: kiro
author_seat: jtadic
executor: kiro
next_actor: owner
state: drafted
updated: 2026-11-24T16:45Z
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

### 2026-11-19T11:25Z · kiro-jtadic-202611191115-a88f · drafted (KIRO 12, seat jtadic, resumed)
Re-verified read-only (artifacts/observed-2026-11-19T1120Z.md). New since 2026-11-18 16:30Z: d.stevanovic@vitanaland.com
deployed `vitana-gateway-preview:2` (22:23Z, 1/1, image b48f95b2df52 without the runtime-profile code, shared ECS task
and execution roles, no preview sparring token) and added listener rule 9 (`/api/v1/*` on the preview host, 23:55Z).
This is a variant of plan step 8 run before step 7 and outside D4's narrow rule; it is recorded, not changed by Kiro.
Go/no-go A: reviewer availability now confirmed. Still open for the owner: rule 55 confirmation, the ledger insert
procedure, the #5110 deploy consequence (C1), the overnight deployment (C3), and the written go for the inserts.
PLAN-SPAR: no run since 44292773682 (failure); not re-run (the re-run allowance on #5117's head is used).
Next: owner decisions above; on a go, Kiro opens the runtime-profile and plan-spar-token lane PRs with their VTIDs.

### 2026-11-19T16:20Z · kiro-jtadic-202611191115-a88f · drafted (owner decisions 2026-11-19, tracker)
Proposal PR #5122 (draft, untrusted, non-executable; title not `plan(`, PLAN-SPAR skipped) until the Rule 55 owner's
written trusted-plan promotion sequence. `.github/workflows/PLAN-SPAR.yml` is not modified until the 2026-11-18
authorization is retrieved or reissued by its authorized owner. #5110 stays unmerged.
| Item | Owner | State |
|---|---|---|
| Written trusted-plan promotion sequence | Rule 55 owner | open |
| Issuance evidence requirements; two separate VTIDs (runtime-profile, plan-spar-token) | registry operator | open; issued-at and 24 h deadlines: none yet |
| Protected-workflow authorization (2026-11-18), retrieved or reissued | its authorized owner | open |
| Second eligible reviewer model; both token accepts on the same final published head | owner | open (this session: claude-opus-5.5 only) |
| Ordinary staging restoration: community staging app + `vitana-gateway`; staging JWT and gateway service-token secrets through the authorized process; evidence ready for STAGING-VERIFY | **Kiro 5** | open; 16:14Z both services 0/0, both secrets missing |
| #5110 merge authorization | Dragan | open |
Prepared heads (non-binding pre-review accept): runtime-profile 27a878bd63, plan-spar-token 3c4d6662af. One
allocation-disabled preview run may cover both if it exercises both; evidence links to each VTID record.

### 2026-11-24T16:45Z · kiro-jtadic-202611241634-913f · drafted (Rule 55 ruling for plan-spar-token, owner 2026-11-24)
Owner instruction (Kiro Web, 2026-11-24): PLAN_SPAR_GATEWAY_TOKEN is provisioned in GitHub Actions from the dedicated
AWS preview secret; take plan-spar-token through Rule 55 and the two required independent reviews, then land it on
main. Break-glass: VTID-05833 for plan-spar-token from the GitLab `vtid-allocate` operation (pipeline 1452). This spec
lands on main so the lane file is trusted from the merge-base; PLAN-SPAR cannot spar it until plan-spar-token is on main
(the preview rejects the shared token, runs 45378800297 and 45416113680 on #5135). The covering sparring follows on the
first full PLAN-SPAR run through the preview with allocation off. runtime-profile, preview-ops and incident-record are
held for the owner (next_actor owner, no VTID). #5122 is superseded by this plan PR for the spec.
