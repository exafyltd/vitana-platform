# Watcher session hooks (VTID-03464)

Phase 5 of `docs/WATCHER-AGENT-PLAN.md` (VTID-03454).

## What it does

`scripts/watcher/session-hook.sh` records what a Claude Code session did onto
the Watcher timeline, and at session end reconciles the repo state.

| Hook | Records |
|---|---|
| `SessionStart` | `running` step with the current branch |
| `Stop` | `completed` step — `success` if the tree is clean and pushed, `failure` otherwise; plus a `doc_updated`/`failure` step when the unpushed files include docs |

## Why the Stop hook exists

From this repo's own changelog, 2026-07-29:

> VTID-03419 executed a genuine production cutover, and "the doc-update step
> in VTID-03419's own spec was apparently never pushed before that session's
> context was summarized." The infrastructure change was real; the paper
> trail describing it was lost. A later session had to rediscover it.

That is not a code bug, and no test would have caught it. It is a session
that ended with work on disk and nothing pushed. The Stop hook looks for
exactly that shape, and treats *docs* left unpushed as the sharper signal —
a doc is often the only record that the work happened at all.

The step is recorded with `outcome=failure` deliberately. These rows are what
Phase 2's distiller learns from; recording an unpushed session as a success
would teach the memory that ending unpushed is fine.

## Safety contract

The hook is an observer of the session it runs in, so it must never be able
to break it:

- **Exits 0 always.**
- **Strict no-op** when `WATCHER_SESSION_TOKEN` is unset — the ingest endpoint
  is closed without it anyway (503), so firing would be pure noise.
- **Never writes to the repo.** No staging, no committing, no pushing. It
  reports; a human decides.
- **5s curl timeout.** A slow or dead gateway must not hang a session.
- **No `jq` dependency** — hooks run on machines we do not control, and a hard
  dependency would make this silently stop firing.

## Enabling it

Set both on the developer machine:

```bash
export WATCHER_SESSION_TOKEN=<the shared secret set on the gateway>
export WATCHER_GATEWAY_URL=https://gateway.vitanaland.com   # optional
```

The hooks are already registered in `.claude/settings.json`
(`SessionStart` / `Stop`). With no token they run and exit silently.

## Verified behaviour

| Case | Result |
|---|---|
| No token | exit 0, nothing posted |
| Clean tree, pushed | `completed` / `success` |
| Dirty tree, no docs | `completed` / `failure`, `dirty_doc_files: 0` |
| Dirty tree incl. docs | `completed` / `failure` **and** `doc_updated` / `failure`, `dirty_doc_files: 1` |
