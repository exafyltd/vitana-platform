# ORB Reconciliation — Pending Human / Out-of-Sandbox Actions

Items the autonomous session cannot do, or that are in-flight. Each is logged here.

## VTID-03210 — turn-1 wake-decision observability (PR-1, PR #2427)

**VTID collision note:** PR-1 was originally marked VTID-03204. Between allocation-check and merge, a parallel session shipped VTID-03204 for an unrelated gateway endpoint (PR #2423, `data_export_ok`). Per the collision-at-merge rule, PR-1 was re-marked to a freshly **allocated** VTID. The branch slug `VTID-03204-wake-decision-observability` is retained (cosmetic; renaming a PR head ref is disruptive) — the authoritative marker is VTID-03210 in the commit, PR title, and ledger.

**Done by the autonomous session:**
- [x] **VTID ledger row** — allocated `VTID-03210` via `POST gateway.vitanaland.com/api/v1/vtid/allocate` (num=3210, id=dad4d62f…). `GET /api/v1/vtid/VTID-03210` confirms `status: allocated` — passes the EXEC-DEPLOY hard gate.
- [x] Re-marked all code/doc/test references VTID-03204 → VTID-03210.

**In flight / remaining:**
- [ ] **PR merge** — merge PR #2427 once CI is green (authorized).
- [ ] **Deploy** — AUTO-DEPLOY fires on merge to main; EXEC-DEPLOY may be triggered with `vtid=VTID-03210` if a manual deploy is needed.
- [ ] **Production smokes** — a real authenticated vitanaland.com ORB session (Vertex) + a Command Hub LiveKit Test Bench session, then `grep '[wake-decision]'` in gateway logs to read: transport, winner, per-provider suppress reasons, turn1_collision, first_name source, and whether the spoken first line matched the selected decision.
  - Note: server-side `[wake-decision]` lines are emitted on session start via API regardless of audio; true spoken-line confirmation needs a browser/device check (API success ≠ spoken success).
- [ ] **gcloud reauth** — `gcloud auth login` (interactive) needed for direct Cloud Run log pulls; otherwise logs come via the `DEBUG-GATEWAY-LOGS.yml` workflow.

This PR changes NO spoken behavior, so code tests suffice for code-complete; the production smoke is the *purpose* of the PR (it produces the R0-diagnostic log), not a merge gate.
