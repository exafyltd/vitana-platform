# Dev Autopilot Worker

A tiny Node.js process that runs the Dev Autopilot's LLM calls through your **Claude Pro/Max subscription** instead of a pay-per-token API key.

## Why this exists

Before this service, the Dev Autopilot's planning + execution steps called `api.anthropic.com` directly from the gateway (Cloud Run) using `ANTHROPIC_API_KEY`. That draws from an API-credit balance billed separately from your Claude subscription — so you were paying twice.

This worker:

1. Polls the Supabase `dev_autopilot_worker_queue` table for pending LLM tasks the gateway put there.
2. Shells out to `claude -p <prompt>` (Claude Code CLI in headless mode). Claude Code uses your logged-in subscription session, so the call is covered by your Pro/Max plan.
3. Writes the result back to the queue. The gateway, which was polling, picks it up and continues the state machine (branch → files → PR → merge).

## Quickstart — Arch A (your workstation)

The fastest way to prove the shape works. Runs only while your machine is on.

```bash
# 1. Prereqs: node 20+, Claude Code installed and logged in
claude login                     # one-time, opens browser
claude --version                 # sanity check

# 2. Build the worker
cd services/autopilot-worker
npm install

# 3. Point it at your Supabase
export SUPABASE_URL="https://<your-project>.supabase.co"
export SUPABASE_SERVICE_ROLE="<service-role-key>"

# 4. Tell the gateway to route through the worker
# (set on your gateway Cloud Run service, NOT here)
#   DEV_AUTOPILOT_USE_WORKER=true

# 5. Run
npm run dev
```

The worker prints one line per claimed task. When the gateway enqueues a plan or execute task, you'll see it picked up within `POLL_INTERVAL_MS` (default 5s) and completed in ~30–90s per task.

## Quickstart — Arch B (always-on VM)

When you want the autopilot running while you sleep. Any small Linux box works (Hetzner €5, a home NAS, a cheap EC2, a Raspberry Pi).

```bash
# One-time on the VM
ssh vm
sudo apt install nodejs npm
npm install -g @anthropic-ai/claude-code   # or whatever the current install path is
claude login                                # opens a device-code URL; complete in browser

# Clone + build
git clone https://github.com/exafyltd/vitana-platform.git
cd vitana-platform/services/autopilot-worker
npm install
npm run build

# Run as a systemd service so it restarts on reboot
sudo tee /etc/systemd/system/autopilot-worker.service <<'EOF'
[Unit]
Description=Vitana Dev Autopilot worker
After=network-online.target

[Service]
Type=simple
User=vitana
WorkingDirectory=/home/vitana/vitana-platform/services/autopilot-worker
EnvironmentFile=/home/vitana/vitana-platform/services/autopilot-worker/.env
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

# .env file (NOT committed)
tee ~/vitana-platform/services/autopilot-worker/.env <<'EOF'
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE=<service-role-key>
POLL_INTERVAL_MS=5000
TASK_TIMEOUT_MS=600000
EOF

sudo systemctl enable --now autopilot-worker
sudo journalctl -u autopilot-worker -f
```

## Configuration

Env vars read by the worker:

| Var | Default | Meaning |
|---|---|---|
| `SUPABASE_URL` | *(required)* | Supabase project URL |
| `SUPABASE_SERVICE_ROLE` | *(required)* | Service-role key (read+write to the queue table) |
| `POLL_INTERVAL_MS` | `5000` | How often to check for new tasks when idle |
| `TASK_TIMEOUT_MS` | `600000` | Hard kill limit for a single `claude -p` subprocess |
| `MAX_CONCURRENT` | `1` | Parallel task ceiling. Keep at 1 for your workstation; a VM with capacity can go to 2-3 |
| `CLAUDE_CLI_PATH` | `claude` | Override the CLI path if it's not on PATH |

And on the **gateway** side (Cloud Run env vars):

| Var | Default | Meaning |
|---|---|---|
| `DEV_AUTOPILOT_USE_WORKER` | `false` | Flip to `true` to route LLM calls via the queue. When `false`, the gateway calls the Messages API directly with its `ANTHROPIC_API_KEY` as before |

## Ops

### Watch the queue

```sql
select id, kind, status, finding_id,
       extract(epoch from (now() - created_at))::int as age_s,
       attempts, error_message
from dev_autopilot_worker_queue
order by created_at desc
limit 20;
```

### Stuck rows

The gateway's `backgroundExecutorTick` calls `reclaimStuckWorkerTasks()` every 30s. Any row stuck in `running` longer than 15 min gets marked `failed` with a `reclaimed by watchdog` error, and the Dev Autopilot bridge + self-heal flow picks it up normally.

### Retire when you move on

To turn the queue off and go back to direct API calls, set `DEV_AUTOPILOT_USE_WORKER=false` on the gateway and stop the worker. No schema rollback needed; the queue table stays empty.

## What the worker does NOT do

- **Does not talk to GitHub.** Branch creation, file writes, and PR opening stay on the gateway — that path already works and is the right place for it (gateway has the GitHub tokens and the state-machine row).
- **Does not interpret the prompt.** It's a pure "run Claude Code on this prompt, return the text" service. All prompt construction, scope validation, safety-gate checks, and output parsing live on the gateway.
- **Does not implement pre-PR validation.** That's the next piece (running `tsc --noEmit` + `jest` on the generated files before the gateway opens the PR). It'll go here in a follow-up because this is where the filesystem work naturally lives.
