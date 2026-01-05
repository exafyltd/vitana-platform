# Vitana Work MCP Server

MCP server that enables Claude Code to discover, pick up, and manage Vitana tasks.

## Overview

This MCP server provides tools for Claude Code to:
- List pending tasks
- Pick up a task (fetch spec + get routing decision from orchestrator)
- Report progress
- Submit evidence (PR, commits, deploys)
- Complete tasks

**Important:** The MCP server does NOT make routing decisions—it calls the existing orchestrator endpoint.

## Tools

| Tool | Parameters | Returns |
|------|------------|---------|
| `list_pending_tasks` | none | `[{vtid, title, status, created_at}]` |
| `pickup_task` | `vtid: string` | `{vtid, title, spec, session_name, run_id, target, assigned_subagents, confidence, rationale}` |
| `report_progress` | `vtid: string, message: string` | `{ok: boolean, event_id: string}` |
| `submit_evidence` | `vtid: string, type: 'pr'\|'commit'\|'deploy', url: string` | `{ok: boolean, event_id: string}` |
| `complete_task` | `vtid: string, summary: string` | `{ok: boolean}` |

## Installation

```bash
cd mcp/vitana-work
npm install
npm run build
```

## Configuration

### Environment Variables

```bash
VITANA_GATEWAY_URL=https://gateway-q74ibpv6ia-uc.a.run.app
VITANA_API_KEY=optional-if-needed
```

### Claude Code Configuration

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "vitana-work": {
      "command": "node",
      "args": ["/path/to/vitana-platform/mcp/vitana-work/dist/index.js"],
      "env": {
        "VITANA_GATEWAY_URL": "https://gateway-q74ibpv6ia-uc.a.run.app"
      }
    }
  }
}
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
        "Task completed."
```

## Backend Endpoints Used

| Tool | Endpoint |
|------|----------|
| `list_pending_tasks` | `GET /api/v1/workorders` |
| `pickup_task` | `GET /api/v1/workorders/:vtid` + `POST /api/v1/worker/orchestrator/route` |
| `report_progress` | `POST /api/v1/oasis/events` |
| `submit_evidence` | `POST /api/v1/evidence` |
| `complete_task` | `PATCH /api/v1/oasis/tasks/:vtid` |

## Safety Rules

1. **Low confidence routing:** If orchestrator returns confidence < 70%, MCP includes a warning in the response
2. **No direct OASIS writes:** MCP calls gateway endpoints only, never writes to Supabase directly
3. **Actor identification:** All calls include `actor: "claude-code"` for traceability

## File Structure

```
mcp/vitana-work/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── tools/
│   │   ├── list-pending.ts
│   │   ├── pickup-task.ts
│   │   ├── report-progress.ts
│   │   ├── submit-evidence.ts
│   │   └── complete-task.ts
│   └── lib/
│       └── gateway-client.ts  # HTTP client for gateway calls
└── dist/                  # Compiled output (after build)
```

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run (requires environment variables)
npm start
```
