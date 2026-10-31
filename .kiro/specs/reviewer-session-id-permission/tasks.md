# Tasks — reviewer-session-id-permission
Authoritative plan: `plan.md` (between the plan markers). VTID: allocated by CI PLAN-SPAR after policy approval;
never by hand. Branch `kiro/reviewer-session-id-permission/<lane>`, PR title
`VTID-xxxxx (reviewer-session-id-permission/<lane>): …`, trailers `Collab-Session` + `Collab-Lane` on every commit,
identity `kiro-agent[bot]`, no `Co-Authored-By: Claude` trailer, evidence in `docs/validation/<VTID>/`
(`acceptance.md`, `commands.log`, `scope.json`). Squash merge under §7b. `.kiro/agents/vitana-lane-reviewer.md` is a
protected gate file: the merge authority is the OWNER INSTRUCTION naming this plan, not a Claude review and not a
reviewer-agent self-approval. Acceptance below is what the reviewer agent `vitana-lane-reviewer` checks.

<!-- lane: reviewer-perm -->
## Lane `reviewer-perm` — vitana-platform (executor: kiro, reviewer agent)
- [ ] T1 `.kiro/agents/vitana-lane-reviewer.md`: add the narrowest matching pattern for the reviewer session-id
      command to BOTH the `capability: shell` allow `match:` (`:26`) AND the `capability: shell` deny `exclude:`
      (`:30`). Candidate to test first: `*scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`.
      The metacharacter `exclude:` (`:27`) stays unchanged. Validate the real match in the Kiro permission engine via
      a live reviewer-agent dispatch; narrow/widen only the single wildcard to the smallest pattern that admits
      exactly the one command; never fall back to a broad `node *` / `*queue.mjs *`.
- [ ] T2 `.kiro/agents/vitana-lane-reviewer.md`: update the instructions so the agent runs
      `node <path>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer` at the START of a review
      and uses the printed id as its reviewer session in BOTH output blocks (the lane-log entry's `### … ·
      <reviewer session> · review` line and the `Collab-Session: <reviewer session>` line). **Expand the Hard limits
      shell-command enumeration (`:48-49`) in the SAME edit (R1-F1)** to include that command, so "only these shell
      commands" agrees with the new permission rule and the agent does not read its own instructions as forbidding
      the command it is told to run. The verdict JSON (no session) is unchanged; the other hard limits (read-only;
      never edit/commit/push/merge; no live calls) stay.
- [ ] T3 `scripts/collab/queue.test.mjs`: add the genuinely new case(s), not duplicates of existing T7/T8 (R1-F2).
      `VTID-05276 T8` (`:994`) already covers `sessionId('agent:vitana-lane-reviewer')` id shape + `agentOf()`;
      `VTID-05276 T7` (`:976`) already covers scope-check accepting an agent review entry and rejecting it from a Kiro
      seat. New: `sessionId('agent:vitana-lane-reviewer', date, '<seat>')` throws `a reviewer agent id names no seat`
      (`queue.mjs:911`); optionally a case strengthening the non-agent-id rejection in scope-check. Each new case is
      red on `origin/main` and green on the head. No existing test weakened, skipped or loosened.
- [ ] T4 `docs/validation/<VTID>/`: `acceptance.md`, `commands.log`, `scope.json`, plus the LIVE reviewer-agent
      demonstration evidence — a fresh `vitana-lane-reviewer` generated its own id, reviewed a specified head, and
      returned a record whose `Collab-Session` passes `queue.mjs scope-check`; an unrelated command stayed denied.

**Acceptance**
- Change types: Tooling/docs
- Outcome: the reviewer agent `vitana-lane-reviewer` runs exactly the one reviewer session-id command at the start of
  a review and returns its verdict with its own generated id; a fresh dispatch demonstrates it reviews a specified
  head and returns a record that `queue.mjs scope-check` accepts (`agentOf(Collab-Session) === reviewer_seat`).
- Permission admits exactly `node <path>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer` (the
  same narrow pattern in BOTH the allow `match:` and the deny `exclude:`); it still DENIES `queue.mjs claim`,
  `queue.mjs release`, `queue.mjs validate`, `queue.mjs scope-check` and any arbitrary shell command, proven by the
  live demonstration. The metacharacter `exclude:` guard is unchanged, so no appended `;`/`&`/`|`/`>`/`<`/backtick/`$(`
  is admitted.
- Reviewer stays read-only w.r.t. repo files: `fs_write`/`fs_append`/`str_replace`/`delete_file`/`web_fetch`/
  `web_search`/`mcp` still denied; the agent never commits, pushes or merges; the caller still commits the review entry.
- `node --test scripts/collab/queue.test.mjs` passes incl. the new cases; each new case is red on `origin/main` for
  the reason the change proves and green on the head, recorded in `docs/validation/<VTID>/`.
- `node scripts/collab/preflight.mjs …` passes on the lane branch; Lane scope passes (only the three lane paths change).
- `.kiro/agents/vitana-lane-reviewer.md` is a protected gate file: the merge relies on the owner's named-plan
  instruction this session (recorded in the lane log), NOT the reviewer-agent accept alone and NOT self-approval; the
  final protected-file diff is presented for owner review.
- Only the lane paths change; no rule weakened; no production or live-system write.
<!-- lane: reviewer-perm -->
