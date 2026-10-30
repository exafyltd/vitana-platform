# Live reviewer-agent demonstration — VTID-05407

Goal (owner): after the permission + instruction change is active, a fresh `vitana-lane-reviewer` agent can
(a) generate its own reviewer session id, (b) independently review a specified head per its checklist, and
(c) return a record that `queue.mjs scope-check` accepts; and an unrelated shell command stays denied.

## Honest status of the live custom-agent dispatch

This evidence was produced by the FEAT-002 build sub-agent. A sub-agent in this environment cannot itself spawn the
Kiro custom agent `vitana-lane-reviewer` (custom-agent dispatch is the orchestrator's capability, not a tool exposed
to this sub-agent). So the **authoritative live dispatch — a real `vitana-lane-reviewer` agent session, with its
prompt beginning `Reviewer chain model for this step: <model>. ` and its own tool permissions loaded from the edited
agent definition — remains to be run by the orchestrator.** Exact instructions are in the last section.

Everything the live dispatch would exercise that CAN be reproduced deterministically from repo code was reproduced
and is recorded below. Nothing here is faked: the commands and their outputs were run during this build.

## What WAS executed (reproducible, node-level)

### 1. The exact command the agent is now permitted to run prints a reviewer id
```
$ node <path>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer
agent-vitana-lane-reviewer-202610291140-6b0e      # (a fresh id each run)
```
A `--seat` is rejected (a reviewer id names no seat), exit 2 — see `commands.log`. This is the only new command the
agent may run; it writes nothing (it prints an id).

### 2. The permission pattern admits exactly that command and denies everything else
`permission-match.log` is the output of `permsim.mjs`, a faithful model of the Kiro shell-permission glob engine
(`*` = any chars incl. spaces; anchored full-string match; allow `match` + metachar `exclude`; deny `exclude`
mirrors allow). 19/19 cases pass: the session-id command (this checkout and a different `<path>`) is ADMITTED;
`queue.mjs claim/release/validate/scope-check`, `session-id --agent kiro --seat`, `session-id --agent
agent:vitana-lane-reviewer --seat exafy`, `session-id --agent agent:other`, `ls`, `cat`, `node -e`, and every
metachar-chained variant (`; && | > $()`) are DENIED; the existing `git diff` / `gh pr view` reads still work.
`node *` and `*queue.mjs *` were shown to admit `queue.mjs claim …` and rejected as too broad. **This is a model of
the engine; the live dispatch is the authoritative confirmation that Kiro's real engine admits/denies the same set.**

### 3. The record the agent returns is accepted by `queue.mjs scope-check` (and rejected from a Kiro seat)
Reproduced end to end over a throwaway git fixture: a kiro lane with `reviewer_seat: agent:vitana-lane-reviewer`, a
review entry appended whose `Collab-Session` is a **self-minted** `agent-vitana-lane-reviewer-…` id (minted by the
exact permitted command), then `queue.mjs scope-check` run on it:
```
reviewer self-minted id: agent-vitana-lane-reviewer-202610291143-8184
=== scope-check (expect no errors, exit 0) ===
✅ **lane scope** — lane demo/lane-a: every change is inside its paths
exit=0
=== control: same entry from a Kiro SEAT session (must FAIL) ===
❌ **lane scope** — 1 problem(s) (lane demo/lane-a):
- 169dad0d: review entry on demo/lane-a from kiro-exafy-202610291205-ab12, but reviewer_seat is agent:vitana-lane-reviewer
exit=1
```
This proves the acceptance is specifically `agentOf(Collab-Session) === reviewer_seat` (`queue.mjs:710-713`): the
self-minted reviewer id passes; a Kiro-seat id for the same lane fails. `agentOf('agent-vitana-lane-reviewer-…')
=== 'agent:vitana-lane-reviewer'` was also asserted directly and in the new unit test (`VTID-05407` in
`queue.test.mjs`, see `red-green.log`).

## What the agent will do at review start (the instruction the edit added)
Per the edited `.kiro/agents/vitana-lane-reviewer.md` ("Your reviewer session id — generate it first"):
1. Run `node <repo>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer` → prints its own id.
2. Review the specified head per checklist items 1–10 (unchanged).
3. Emit block 1 (verdict JSON, no session) and block 2 (lane-log entry) whose `### … · <id> · review` header and
   `Collab-Session: <id>` both carry that self-minted id.
4. **Fail loud:** if the command is denied/errors/prints no reviewer id → verdict `changes` with one blocking
   finding naming the failure, never a literal `<reviewer session>` (no silent fallback to the land step).

## Remaining authoritative check — for the orchestrator to run
Dispatch a FRESH `vitana-lane-reviewer` custom agent (so its permissions load from the edited, committed agent
definition on this lane's PR head). Prompt MUST begin exactly with:
`Reviewer chain model for this step: claude-sonnet-5.5. ` (or `claude-opus-5.5` / `claude-sonnet-4.5` — any chain
model). Give it: the lane key `reviewer-session-id-permission/reviewer-perm`, this lane's PR number/url, the reviewed
head SHA (40 hex), and the platform checkout path `/projects/sandbox/vitana-platform` (or another real lane PR head).
Confirm, from the transcript:
- (a) the agent RUNS `node <path>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer` and gets a
  fresh `agent-vitana-lane-reviewer-YYYYMMDDHHMM-xxxx` id (the permission ADMITS it);
- (b) it independently reviews the specified head and returns the two output blocks with that self-minted id in both
  the header and `Collab-Session:`;
- (c) appending that block-2 entry and running `node scripts/collab/queue.mjs scope-check …` accepts it
  (`agentOf(Collab-Session) === reviewer_seat`) — reproduced at node level above;
- (d) an unrelated command given to the agent — e.g. `node <path>/scripts/collab/queue.mjs claim …` or `ls` — is
  DENIED by the engine (the permission does NOT admit it).
Capture the full transcript and append it here.
