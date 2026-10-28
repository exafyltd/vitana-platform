# VTID-05005 — plan sparring record

Partner: plan-sparring-partner agent (independent, read-only). Rounds: 3 (cap). Verdict: **CONVERGED**.

## Plan (final)
Kiro sessions get the Operator's read tools via MCP. Gateway route `POST /api/v1/operator/kiro/mcp`
(stateless JSON-RPC, commerce-mcp pattern) serving the Operator's own executors through an identity
adapter. The kiro-runner injects one stdio MCP server (`vitana`, mcp-proxy.js) into session/new and
session/load itself; the relay POSTs to the environment's public gateway with a per-session pass:
HMAC-SHA256, key HKDF-derived from GATEWAY_INTERNAL_TOKEN (info `kiro-mcp-token-v1`), claims user,
thread, env, exp ≤ 1 h; exafy_admin re-checked per call; OASIS `operator.kiro.tool_called`.
Off unless KIRO_MCP_ENABLED=true. Read tools only; write tools and repo cloning are a later plan.

## Findings and answers
- R1 F1 [blocker] executeTool reads threadIdentityMap — accepted: adapter registers a synthetic thread identity per call, removed in finally.
- R1 F2 [blocker] HTTP MCP support in kiro-cli unproven — accepted: stdio relay (mandatory in ACP), injected by the runner; staging proof before relying on it.
- R1 F3 [major] reuse an existing token — rejected: the relay runs as Kiro's child (same uid), so a runner/service token there could leak; a per-session pass bounds a leak to read tools, one user, ≤ 1 h.
- R1 F4 [major] SQL/logs PII via Kiro — closed by owner decision 2026-10-09: "Include SQL and logs. I want full access."
- R1 F5 [major] runner→gateway path unspecified — accepted: the environment's public gateway URL over HTTPS (KIRO_MCP_GATEWAY_URL per runner workflow).
- R1 F7 [minor] event payload — accepted: commerce.mcp.tool_called shape, no args/results.
- R2 F8 [major] dev_deep_dive also needs threadAuthMap — accepted: setThreadAuth/clearThreadAuth in the adapter, tested.
- R2 F9 [major] HMAC vs in-memory opaque token — rejected with reason, accepted by partner in R3: the ALB round-robins across tasks (stickiness off), an in-memory token fails on the other task (the VTID-05002 problem); HKDF from the existing secret means nothing new to provision.

## Owner approval
2026-10-09, in session: "yes, build it" (after "Include SQL and logs. I want full access.").

## Post-review change (Codex review on PR #3974, before merge)
- Batches: capped at 10 messages, charged per message, run sequentially.
- `session/prompt` no longer uses the 30 s request default (15 min; the user has Stop); each tool call has a 100 s budget; the relay waits 115 s — all inside the ALB's measured 120 s idle timeout.
- `dev_deep_dive` removed from the read set (runs up to 150 s, past that limit). The R2 F8 adapter fix (setThreadAuth) stays: other Operator checks use the same map.
