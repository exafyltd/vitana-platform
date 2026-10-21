# Summary: VTID Governance Docs

> Summary of the VTID system documentation: numbering, branching, deployment integration, and the Claude Operational Protocol.

## Content

### Source Documents

This summary covers four governance documents:

1. **VTID_SYSTEM.md** -- the complete VTID numbering specification including format, database schema, API endpoints, OASIS integration, RLS policies, and deployment instructions.
2. **VTID_BRANCHING.md** -- branching guidelines for VTIDs, the fresh-branch rule, branch naming conventions, and the Command Hub protection zone.
3. **CLAUDE_START_PROMPT.md** -- the Claude Operational Protocol (COP v1.0) defining behavioral rules, command hierarchy, execution discipline, and the Exact-Match Edit Protocol.
4. **CEO-HANDOVER-REVISED.md** -- governance rule for canonical frontend source enforcement.

### VTID Numbering System

- **Format:** `VTID-YYYY-NNNN` (year + sequential number) or `VTID-XXXXX` (5-digit extended).
- **Database:** `vtid_ledger` table in Supabase with UUID primary key, VTID unique identifier, family, type, description, status, tenant, metadata, and parent VTID.
- **Indexes:** optimized for chronological, family, status, tenant, and direct lookup queries.
- **RLS:** service_role has full access; authenticated users can read all, create new, update own tenant, but never delete (immutable audit trail).

### VTID API

Five endpoints on the gateway:
- `POST /vtid/create` -- create with family, type, description, tenant (required).
- `GET /vtid/:vtid` -- retrieve by ID.
- `PATCH /vtid/:vtid` -- update status or metadata (merges metadata).
- `GET /vtid/list` -- filter by family, status, tenant, limit.
- `GET /vtid/health` -- health check.

### Branching Rules

- **Fresh branch for every VTID** -- reusing old branches is forbidden.
- **Naming:** `feature/DEV-COMHU-XXXX-*` for Command Hub, `feature/VTID-XXXX-*` for backend, `claude/VTID-XXXX-*` for agent work.
- **Command Hub protection:** only `DEV-COMHU-*` VTIDs can modify `services/gateway/src/frontend/command-hub/`. CI guardrails enforce this with path ownership and golden fingerprint checks.

### Claude Operational Protocol (COP v1.0)

Defines Claude as Chief Autonomous Execution Officer under CEO/CTO governance:
- **Command hierarchy:** CEO -> CTO/OASIS -> Claude (Executor) -> Worker Agents -> Validator Agents.
- **Execution discipline:** every task needs a VTID; check OASIS, repo, and memory before executing; log progress; emit completion events.
- **Source control:** no direct pushes to `main`; PRs with structured body including VTID reference.
- **Verification:** run checks, verify health endpoints, confirm telemetry, validate CI.
- **Exact-Match Edit Protocol:** always verify target snippet exists before modification; halt and escalate on mismatch; no improvisation.
- **Enforcement:** violating the protocol triggers OASIS governance escalation and CEO review.

### CEO Handover: Canonical Frontend Source

Rule `GOV-FRONTEND-CANONICAL-SOURCE-0001`:
- Only one valid source tree for Command Hub.
- Build output locked to `dist/frontend/command-hub`.
- Claude must install artifacts, commit with VTID, execute SQL governance rule, run verification.
- Zero-touch principle: no deleting source dirs, no modifying build, no changing Express routing, no touching frontend files.

## Related Pages

- [[vtid-governance]]
- [[github-actions]]
- [[vitana-platform]]
- [[api-gateway-pattern]]

## Sources

- `raw/governance/VTID_SYSTEM.md`
- `raw/governance/VTID_BRANCHING.md`
- `raw/governance/CLAUDE_START_PROMPT.md`
- `raw/governance/CEO-HANDOVER-REVISED.md`

## Last Updated

2026-04-12
