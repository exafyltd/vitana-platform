# Vitana Work MCP Server

MCP server that enables Claude Code to discover, pick up, and manage Vitana tasks.

## Overview

This is a **local developer tool** (Claude Code plugin). It runs on your machine via stdio transport—no cloud deployment required.

The MCP server provides tools for Claude Code to:
- List pending tasks
- Pick up a task (fetch spec + get routing decision from orchestrator)
- Report progress
- Submit evidence (PR, commits, deploys)
- Move tasks to validation (governance-safe, not terminal completion)

**Important:** The MCP server does NOT make routing decisions—it calls the existing orchestrator endpoint at `POST /api/v1/worker/orchestrator/route`.

## Tools

| Tool | Parameters | Returns |
|------|------------|---------|
| `list_pending_tasks` | none | `[{vtid, title, status, created_at}]` |
| `pickup_task` | `vtid: string` | `{vtid, title, spec, session_name, run_id, target, assigned_subagents, confidence, rationale}` |
| `report_progress` | `vtid: string, message: string` | `{ok: boolean, event_id: string}` |
| `submit_evidence` | `vtid: string, type: 'pr'\|'commit'\|'deploy', url: string` | `{ok: boolean, event_id: string}` |
| `complete_task` | `vtid: string, summary: string` | `{ok: boolean}` — moves to `in_validation`, NOT terminal completion |

## Local Runbook

### 1. Install Dependencies

```bash
cd mcp/vitana-work
npm install
```

### 2. Build

```bash
npm run build
```

This produces `dist/index.js` (the MCP server entry point).

### 3. Verify Build Output

```bash
ls -la dist/
# Should contain: index.js, index.d.ts, lib/, tools/
```

### 4. Configure Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "vitana-work": {
      "command": "node",
      "args": ["/absolute/path/to/vitana-platform/mcp/vitana-work/dist/index.js"],
      "env": {
        "VITANA_GATEWAY_URL": "https://gateway-q74ibpv6ia-uc.a.run.app"
      }
    }
  }
}
```

### 5. Restart Claude Code

After updating settings, restart Claude Code for the MCP server to be available.

## Smoke Test Checklist

After setup, verify each tool works:

### ✅ `list_pending_tasks()`
- [ ] Returns array of pending tasks
- [ ] Each task has `vtid`, `title`, `status`, `created_at`

### ✅ `pickup_task("VTID-XXXXX")`
- [ ] Returns spec from `GET /api/v1/workorders/:vtid`
- [ ] Returns routing result from `POST /api/v1/worker/orchestrator/route`
- [ ] Response includes: `run_id`, `target`, `assigned_subagents`, `confidence`, `rationale`
- [ ] `session_name` is formatted as `"XXXXX - {title}"`
- [ ] Low confidence (< 70%) includes warning message

### ✅ `report_progress("VTID-XXXXX", "message")`
- [ ] Returns `{ok: true, event_id: "..."}`
- [ ] OASIS event visible in Command Hub

### ✅ `submit_evidence("VTID-XXXXX", "pr", "https://...")`
- [ ] Returns `{ok: true, event_id: "..."}`
- [ ] Evidence recorded in system

### ✅ `complete_task("VTID-XXXXX", "summary")`
- [ ] Returns `{ok: true}`
- [ ] Task status changes to `in_validation` (NOT `completed`)
- [ ] `task.ready_for_validation` event emitted to OASIS

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VITANA_GATEWAY_URL` | `https://gateway-q74ibpv6ia-uc.a.run.app` | Gateway API base URL |
| `VITANA_API_KEY` | (optional) | API key if gateway requires auth |

## Backend Endpoints Used

| Tool | Endpoint |
|------|----------|
| `list_pending_tasks` | `GET /api/v1/workorders` |
| `pickup_task` | `GET /api/v1/workorders/:vtid` + `POST /api/v1/worker/orchestrator/route` |
| `report_progress` | `POST /api/v1/oasis/events` |
| `submit_evidence` | `POST /api/v1/evidence` |
| `complete_task` | `POST /api/v1/oasis/events` (task.ready_for_validation) + `PATCH /api/v1/oasis/tasks/:vtid` |

## Safety Rules

1. **Low confidence routing:** If orchestrator returns confidence < 70%, MCP includes a warning in the response
2. **No direct OASIS writes:** MCP calls gateway endpoints only, never writes to Supabase directly
3. **Actor identification:** All calls include `actor: "claude-code"` for traceability
4. **Governance-safe completion:** `complete_task` moves to `in_validation` status, not terminal `completed`

## File Structure

```
mcp/vitana-work/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts           # MCP server entry point (stdio transport)
│   ├── tools/
│   │   ├── list-pending.ts
│   │   ├── pickup-task.ts
│   │   ├── report-progress.ts
│   │   ├── submit-evidence.ts
│   │   └── complete-task.ts
│   └── lib/
│       └── gateway-client.ts  # HTTP client for gateway calls
└── dist/                  # Compiled output (after npm run build)
    ├── index.js           # Entry point for Claude Code config
    ├── lib/
    └── tools/
```

## Usage Example

```
User: "What tasks are waiting?"
Claude: [calls list_pending_tasks()]
        "2 pending tasks:
         - VTID-01165: Add user authentication
         - VTID-01166: Fix memory leak"

User: "Pick up 01165"
Claude: [calls pickup_task("VTID-01165")]
        "Got it. Rename this session to: 01165 - Add user authentication
         Routed to: backend (confidence: 85%)
         Here's the spec: ..."
        [starts working]

Claude: [calls report_progress("VTID-01165", "Implemented auth middleware")]
        "Progress logged."

Claude: [calls submit_evidence("VTID-01165", "pr", "https://github.com/.../pull/42")]
        "Evidence submitted."

Claude: [calls complete_task("VTID-01165", "Auth system implemented with JWT")]
        "Task moved to validation."
```
