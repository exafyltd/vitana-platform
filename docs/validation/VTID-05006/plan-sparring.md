# VTID-05006 — plan sparring record

Partner: plan-sparring-partner agent (independent, read-only). Rounds: 3 (cap). Verdict: **CONVERGED**.

## Plan (final)
Kiro write tools via the phase A MCP route with four gates (KIRO_MCP_WRITE_ENABLED; autopilot kill switch for
autopilot_*; open VTID; the user's Allow in the thread, DB-backed in `kiro_mcp_confirmations`), the Kiro-only
`dev_push_kiro_branch` (gateway token, kiro/<user8>/<slug>, limits, denied paths, fast-forward only), and both
repos in every session (shared mirrors + per-session worktrees). No deploy tool.

## Findings and answers
- R1 F1 [blocker] the dev_* write tools lack the governance the plan claimed — accepted: gates at the MCP layer, listed per tool.
- R1 F2 [blocker] dev_deploy_service defaults to production — accepted: excluded (dead GCP route; production stays behind Gate 2).
- R1 F3/F5 [major] in-memory confirmation fails across tasks; conflated with the ACP broker — accepted: DB-backed confirmation, its own routes.
- R1 F4 [major] operator regression suite — accepted: scenarios added to vtid-04465.
- R1 F6 [major] push tool limits — accepted.
- R1 F7 [minor] clone cost — accepted: shared mirrors + worktrees.
- R1 F8 [minor] repo visibility — verified public (GitHub API).
- R1 F9 [minor] push event — accepted (`operator.kiro.branch_pushed`).
- R2 F10 [major] ALB idle timeout vs a held call — measured 120 s on vitana-alb-prod; window capped, abort on close, proxy forwards MCP cancellation, atomic decision.
- R2 F11 [minor] more denied paths (docs/validation, CODEOWNERS, lockfiles) — accepted.
- R2 F12 [minor] kill switch semantics — accepted: KIRO_MCP_WRITE_ENABLED for all writes, autopilot switch only for autopilot_*.
- R2 F13 [minor] autopilot_get_status already in phase A — accepted.

## Changes taken while building (listed as decisions at Gate 2)
- Confirmation window 60 s (not 90): the tool still needs time inside the 110 s call budget under the ALB's 120 s.
- autopilot_create_task, autopilot_run_task and autopilot_activate_recommendation are NOT exposed: each mints a VTID, and a VTID comes only after a sparred, owner-approved plan (rules 51-55).
- Production keeps KIRO_MCP_WRITE_ENABLED=false until its own approval.

## Owner approval
2026-10-09, in session: "Yes, ship both to production and build phase B."
