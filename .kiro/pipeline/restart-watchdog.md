# Restart watchdog (VTID-05337)
A Kiro agent restart pauses every workflow step that was running ("Interrupted by agent restart; the previously
running step was paused for resume."). Nothing announces it, so a pipeline run can sit paused for hours. The watchdog
surfaces such runs at the next session start and on every prompt of the session that owns them.

## Mechanism
- Hook file `.kiro/hooks/vitana-workflow-watchdog.json` (`version: "v1"`): two command hooks, `SessionStart` and
  `UserPromptSubmit`, both running `node scripts/collab/workflow-watchdog.mjs`. The engine pipes
  `{session_id, hook_event_name, cwd}` to the command's stdin and forwards its stdout to the agent only on exit 0, so
  the script always exits 0. `.kiro/hooks/vitana-pipeline-start.json` is unchanged.
- The script enumerates the engine's run folders (`<home>/.kiro/sessions/<dir>/workflows/<wf id>/`, with
  `fs.readdirSync`, no glob), reads `workflow-state.json` (`status`, `pauseReason`, `stopInitiator`,
  `parentSessionId`, `workspacePath`, `createdAt`) and `run.beat` (`stampedAt`), and keeps the runs whose
  `workspacePath` is the hook's `cwd` (case-insensitive on Windows, separators normalised).
- Reported: every `paused` run, and every `running` run whose `run.beat` is older than 10 minutes. Not reported:
  `completed`, `failed`, `aborted`, a fresh heartbeat, other workspaces, unreadable or malformed files (skipped).
- `SessionStart` reports all such runs of the workspace; `UserPromptSubmit` only the runs whose `parentSessionId` is
  this session. Nothing found → no output.
- Fallback: when the engine's sessions folder cannot be read at all, the `run_id` of every
  `<cwd>/.agents/tasks/pipeline-*/run.json` is listed for an `inspect_workflow` check (`SessionStart` only).

## What the agent does with the report
- **Own run** (`parentSessionId` = this session): call `inspect_workflow <id>`, then `update_workflow` with
  `update_status running`.
- **Another session's run:** open that session or press Resume in the workflow panel. The engine's startup sweep
  auto-resumes only a run whose parked steps are all watch steps (engine log event
  `workflow.sweep.auto_resuming_watch_parked_run`); any other paused run waits for its owner. A session never resumes
  a run it does not own.
- **Paused by the user** (`stopInitiator: "user"`): listed as "paused by user — not resumed"; it stays paused (the
  sweep skips it too: `workflow.sweep.user_park_not_auto_resumed`).
- **Running, stale heartbeat:** no `run.beat` for 10 minutes, so probably no engine instance is driving it any more.
  The engine itself treats a beat as stale after 4.5 beat intervals (`staleAfterMs`) and its sweep then turns the run
  into `paused` (`workflow.sweep.reconciling_stale_run`); until that sweep runs, inspect the run from its owning
  session (`inspect_workflow <id>`) before resuming it.

## Authority and limits
- The engine's own state is the authority; the watchdog only reads it. It writes no file, makes no network call and
  never changes a run.
- The run-folder layout and field names are the installed engine's internals, not a documented API; they are
  version-sensitive. Every read tolerates absence (silent), so an engine change makes the watchdog quiet, not wrong.
- Tested on Windows (Kiro IDE). Kiro Web / Linux is untested (no workflow engine there).
- It cannot resume another session's run (only the owning parent session can call `update_workflow`).
- `.agents/` is local state, never committed: a fresh clone sees only the engine's state, and the `run.json`
  fallback finds nothing there.
