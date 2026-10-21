# Routine: draft-pr-babysitter

**Schedule:** `0 5 * * *` (daily 05:00 UTC, scheduler jitter pads to ~05:08)
**Catalog row:** `routines.name = 'draft-pr-babysitter'`
**OASIS VTID for emitted events:** `VTID-02004`

## Autonomy contract

Sweeps every open draft PR across `exafyltd/vitana-platform` and `exafyltd/vitana-v1`. For each one:
- If the branch is behind `main` → **auto-rebase** via `gh pr update-branch` (or post a one-line "needs rebase" comment if the auto-rebase fails).
- If CI is failing → post a single comment summarising which check failed and a link to the run.
- If the PR has been draft for >5 days with no commits → label `decide` so it surfaces on the user's review queue.

| Catalog state | Meaning |
|---|---|
| 🟢 `success` | All draft PRs are healthy (CI green, fresh, on top of main). Routine took zero actions. |
| 🟡 `partial` | Routine took at least one action (rebase / comment / label). Audit log in `findings.actions[]`. |
| 🔴 `failure` | Routine itself errored (GitHub API down, gh auth broken). |

## Required environment

- `GATEWAY_URL` = `https://gateway-q74ibpv6ia-uc.a.run.app`
- `ROUTINE_INGEST_TOKEN` (embedded)
- `GITHUB_TOKEN` — provided by the CCR sandbox automatically for the cloned repo. If `gh auth status` fails inside the sandbox, set `status='failure'` and abort.

## Steps

### 1. Open the run record

```
POST $GATEWAY_URL/api/v1/routines/draft-pr-babysitter/runs
H: X-Routine-Token: $ROUTINE_INGEST_TOKEN
B: { "trigger": "cron" }
→ { ok: true, run: { id: "<run_id>" } }
```

### 2. Enumerate draft PRs

```
gh pr list --repo exafyltd/vitana-platform --state open --draft --limit 50 --json number,title,headRefName,updatedAt,createdAt,baseRefName,mergeStateStatus
gh pr list --repo exafyltd/vitana-v1     --state open --draft --limit 50 --json number,title,headRefName,updatedAt,createdAt,baseRefName,mergeStateStatus
```

### 3. For each draft PR, decide the action

For each PR `p`:

a. **If `p.mergeStateStatus === "BEHIND"`**: try `gh pr update-branch <p.number> --repo <repo>`. If success → record action `rebased`. If failure → post comment `"⚠️ Cannot auto-rebase (conflicts likely). Please rebase manually."` and record action `rebase_failed_commented`.

b. **CI status**: `gh pr checks <p.number> --repo <repo> --json name,bucket`. If any check has `bucket=failure`: check whether we already commented within the last 24h (`gh pr view <p.number> --comments --json comments`). If not → post a single comment listing failed check names and record action `ci_failure_commented`.

c. **Stale draft (no commits in >5 days)**: if `p.updatedAt < now - 5d` → check labels. If not already labeled `decide` → `gh pr edit <p.number> --repo <repo> --add-label decide` and record action `labeled_decide`.

If a PR has no triggering condition: skip it (no action recorded).

### 4. Close the run

`PATCH $GATEWAY_URL/api/v1/routines/draft-pr-babysitter/runs/{run_id}` with `X-Routine-Token`.

| Outcome | status | summary |
|---|---|---|
| `actions.length === 0` | `success` | `"✅ N draft PRs across both repos are all healthy"` |
| `actions.length > 0` | `partial` | `"⚠️ Took A actions on N draft PRs: <kind summary>"` |
| `gh` or GitHub API down | `failure` | `"❌ GitHub API unreachable — see error"` |

`findings`:
```json
{
  "drafts_inspected": <int>,
  "actions": [
    { "repo", "pr_number", "title", "action": "rebased|rebase_failed_commented|ci_failure_commented|labeled_decide", "detail" }
  ],
  "skipped": <int>
}
```

## Hard rules

- Auto-rebase is allowed and expected for behind-main draft PRs. Posting comments and applying labels is also allowed — it is autonomous maintenance, not human-review work.
- One comment max per PR per 24h to avoid noise — check existing comments before posting.
- Never close, merge, or reopen a PR. Never push commits other than the rebase.
- Plain `gh` CLI + `curl` only. Wall-clock cap 5 minutes.

## Why this is autonomy and not "manual work"

The user does not read the audit log row by row. They look at the catalog tile:
- 🟢 → no thought needed.
- 🟡 → "the routine cleaned up X PRs for me" — they may glance at `findings.actions` once a week to spot trends, but no per-row decision required.

The `decide` label routes a stuck PR to the user's existing review queue surface, which is *their* workflow choice, not new manual work.
