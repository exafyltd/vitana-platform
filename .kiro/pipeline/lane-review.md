# Lane review: the reviewer agent `vitana-lane-reviewer` on `claude-sonnet-5.5`

Binding: `common-rules.md`. The review step runs the workspace agent `.kiro/agents/vitana-lane-reviewer.md` with
`modelId: claude-sonnet-5.5`. The agent is read-only: it returns two text blocks and writes nothing. The **land step**
(a writing agent) stores them and commits the review entry. Approvals come only from this agent, never from another
Kiro seat or session, and never from the lane's own session.

## When the agent reviews
Only if `RUN/lanes/<LANE>/state.json` has `done: false`, `status: in_review`, and
`RUN/reviews/<LANE>-<head7>.json` (head7 = first 7 hex of `head_sha`) does not exist yet. Otherwise its final
message is exactly `no review needed (<status>)`.

## What the review step's prompt gives the agent
Lane key `<slug>/<LANE>`, PR URL(s) and number(s), the head SHA per repo, the repo checkout paths, the spec paths on
`origin/main`, `RUN/lanes/<LANE>/impl-notes.md`, and any lane-specific check. If the plan carries an owner instruction
covering its protected gate files, the prompt names it (checklist item 9).

## What the agent checks (its checklist, in its definition)
Acceptance criteria of the lane in `tasks.md` + lane file; files within `paths`; CI on the current head (failed
required check = blocking, running = non-blocking note); every new behaviour has a test red on base; no test
weakening; no production or live writes, no hand VTID, no PUBLISH / `publish-to-prod.sh` / `AWS-PROD-*`; no
hardcoded spoken strings; i18n / design / RTL if UI is touched; protected gate files
(`scripts/collab/protected-gate-files.json`) are blocking for agent-only acceptance. It does not re-run suites.

## What it returns
1. The verdict JSON (plan interface §4.2):
   `{"verdict":"accept"|"changes","head_sha":"<40-hex>","findings":[{"severity":"blocking"|"non-blocking","file":"<path>","line":<n>|null,"issue":"<text>"}],"model":"claude-sonnet-5.5","agent":"vitana-lane-reviewer"}`;
   `accept` only with zero blocking findings.
2. The lane-log review entry (§4.1) with the trailers
   `Collab-Session: <reviewer session>`, `Collab-Review: <slug>/<LANE>`, `Collab-Verdict: accept|changes`,
   `Collab-Reviewer: agent:vitana-lane-reviewer (claude-sonnet-5.5)`, `Collab-Reviewed-Head: <40-hex>`.
   `Collab-Review` keeps the lane key; the verdict is only in `Collab-Verdict`.
3. Model not `claude-sonnet-5.5` or unknown → only
   `{"error":"model_unavailable","required":"claude-sonnet-5.5","agent":"vitana-lane-reviewer"}`. That is "no
   review": the lane stays `in_review`, the land step logs it loudly in `blockers.md`, nothing is substituted. A
   verdict whose `model` or `agent` differ is ignored and logged.

## How the land step stores it
From the review step's output: `RUN/reviews/<LANE>-<head7>.md` (the whole output), `<LANE>-<head7>.json` (block 1
exactly), `<LANE>-<head7>-entry.md` (block 2 with `<reviewer session>` replaced by a reviewer session id: `queue.mjs
session-id --agent agent:vitana-lane-reviewer` once that form exists on `main`, else `--agent kiro --seat
<reviewer_seat>`; never a session in the lane's executing log). Then `lane-land.md` step 2.
