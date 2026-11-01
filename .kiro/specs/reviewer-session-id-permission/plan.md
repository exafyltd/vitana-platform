# Plan — reviewer-session-id-permission

Let the independent reviewer agent `vitana-lane-reviewer` generate its own reviewer session id (the `queue.mjs
session-id --agent agent:vitana-lane-reviewer` command it already backs) and return it with its verdict, so the id
in the review entry originates from the reviewer session itself. Add exactly that one command to the agent's shell
permission and nothing else; the agent stays read-only w.r.t. repo files.

<!-- plan:begin -->
## Goal (owner, Kiro Web conversation)
"The owner, in this Kiro Web conversation, explicitly authorized the narrowly scoped protected-file change under plan
name reviewer-session-id-permission, to be kept entirely within Kiro (no Claude Code, no Kiro IDE handoff), and
instructed: use the narrowest permission supported by Kiro; validate actual command matching (do not blindly use the
proposed wildcard); confirm the generator's behavior and ensure unrelated shell commands remain denied; keep the
reviewer read-only w.r.t. repo files; present the final protected-file diff for owner review; do not substitute
self-approval or depend on Claude; after it is active, demonstrate a fresh reviewer agent generates its own id,
reviews a specified head, and returns a scope-check-accepted record."

The owner's instruction naming this plan (`reviewer-session-id-permission`) is the protected-gate-file merge
authority for `.kiro/agents/vitana-lane-reviewer.md` — **not** a Claude review, **not** a reviewer-agent
self-approval.

## Today (verified in code)
1. **The reviewer agent cannot run the session-id generator.** `.kiro/agents/vitana-lane-reviewer.md:25-28` is the
   one `capability: shell` **allow** rule: `match:` (`:26`) is exactly
   `["git -C * diff*", "git -C * log*", "git -C * show*", "git -C * fetch origin*", "git -C * merge-base*",
   "git -C * rev-parse*", "gh pr view*", "gh pr checks*", "gh run view*"]`, guarded by the metacharacter `exclude:`
   (`:27`) `["*;*", "*&*", "*|*", "*>*", "*<*", "*\`*", "*$(*"]`. `.kiro/agents/vitana-lane-reviewer.md:29-31` is the
   `capability: shell` **deny** rule whose `exclude:` (`:30`) mirrors that same match-list, so every other shell
   command is denied. A `node … queue.mjs session-id …` command matches no allow pattern and is caught by the deny
   rule. The agent's instructions tell it to leave `<reviewer session>` literal for the caller to fill in (agent
   body, "Output: exactly two blocks" and the `Collab-Session: <reviewer session>` line).
2. **The generator already exists and is the right one.** `scripts/collab/queue.mjs` `sessionId()` (`:907`) mints a
   reviewer id when the agent is a reviewer agent: `agent-<name>-YYYYMMDDHHMM-xxxx` (`:910-913`), and refuses a
   `--seat` for it. The CLI `session-id` subcommand prints it (`:946`). `agentOf()` (`:77`) maps
   `agent-vitana-lane-reviewer-…` back to `agent:vitana-lane-reviewer`. The scope-check validator accepts a review
   entry when `agentOf(Collab-Session) === reviewer_seat` (`queue.mjs:710-713`, the reviewer-agent branch at `:711`).
   There is no provenance or attestation requirement in policy today — the review entry is accepted purely on the id
   shape. The point of this change is that the id now originates from the reviewer session itself (it runs the
   command), rather than being handed to it by the caller.
3. **`.kiro/agents/vitana-lane-reviewer.md` is a protected gate file.** `scripts/collab/protected-gate-files.json:14`
   lists `.kiro/agents/vitana-lane-reviewer.md`. Per `collaboration.md` §3a a change to it never merges on a
   reviewer-agent accept alone; it needs a legacy `claude` review on the current head **or the owner's instruction
   naming the plan**. The agent's own checklist item 9 refuses to loosen its own gate unless the caller cites an
   owner instruction covering this plan's protected files.

## Lane `reviewer-perm` (the only lane)
Executor kiro, seat `exafy`, reviewer agent `vitana-lane-reviewer`, platform. Paths limited to exactly:
`.kiro/agents/vitana-lane-reviewer.md`, `scripts/collab/queue.test.mjs`, `docs/validation/**`. It:
1. Adds the narrowest matching pattern for the session-id command to **both** the allow `match:` (`:26`) **and** the
   deny `exclude:` (`:30`) of `.kiro/agents/vitana-lane-reviewer.md`, so the command is admitted and every unrelated
   command stays denied. Both lists move together (the deny `exclude:` mirrors the allow `match:`; admitting a
   command means adding the same pattern to both).
2. Updates the agent's instructions so it runs the command at the **start** of a review and uses the printed id as
   its reviewer session in **both** output blocks (the verdict JSON is not changed — it carries no session; the
   lane-log review entry's `### … · <reviewer session> · review` line and `Collab-Session: <reviewer session>`
   line now carry the id the agent itself generated, instead of being left literal for the caller). **The Hard
   limits shell-command enumeration must move with it (sparring R1-F1):** the sentence at
   `.kiro/agents/vitana-lane-reviewer.md:48-49` lists "only these shell commands: `git -C <repo>
   diff|log|show|fetch origin|merge-base|rev-parse`, `gh pr view`, `gh pr checks`, `gh run view`." The lane adds the
   session-id command to that enumeration in the same edit, so the instruction text and the permission rule agree and
   the agent does not read "only these shell commands" as forbidding the command it is told to run.
3. Adds `queue.test.mjs` cases and records the live reviewer-agent demonstration evidence under
   `docs/validation/<VTID>/`.

## Permission approach — narrowest pattern, validated empirically
- The command to permit, verbatim and with **no shell metacharacter**, is
  `node <path>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`. The `<path>` prefix varies by
  checkout (the Kiro Web clone path, the IDE path), so the pattern must tolerate a leading-path prefix while pinning
  the rest exactly.
- **Narrowest candidate to test first:**
  `*scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`. It pins the script path tail, the
  `session-id` subcommand and the exact `--agent agent:vitana-lane-reviewer` argument; the only wildcard is the
  leading `*` that absorbs `node ` and the checkout path. The existing metacharacter `exclude:` (`:27`) still blocks
  any `;`, `&`, `|`, `>`, `<`, backtick or `$(` appended to it, so the pattern cannot be abused to chain a second
  command.
- **Validation is empirical, in the build lane (not this plan).** The Kiro permission engine's glob semantics are the
  authoritative check for which pattern Kiro actually admits. The build lane dispatches a **live** fresh
  `vitana-lane-reviewer` agent and confirms: (a) the agent runs the session-id command and gets its own id; (b) the
  agent reviews a specified head and returns a review entry whose `Collab-Session` passes `queue.mjs scope-check`
  (`agentOf(...) === reviewer_seat`); (c) an unrelated shell command (e.g. `queue.mjs claim`, `queue.mjs release`,
  `queue.mjs validate`, `queue.mjs scope-check`, or any arbitrary command) stays **denied**. If the first candidate
  does not match in the live engine, the lane narrows or widens the single wildcard to the smallest pattern that
  admits exactly the one command and re-demonstrates; it never falls back to a broad `node *` or `*queue.mjs *`
  wildcard. The chosen final pattern is whatever the live demonstration proves admits exactly the one command and
  nothing else.

## Tests
`node --test scripts/collab/queue.test.mjs`. **Existing coverage (sparring R1-F2):** `VTID-05276 T8`
(`queue.test.mjs:994`) already asserts `sessionId('agent:vitana-lane-reviewer')` returns an
`agent-vitana-lane-reviewer-…` id, `agentOf()` maps it back, and `isReviewerAgent` recognises it; `VTID-05276 T7`
(`:976`) already asserts the scope-check validator accepts an agent review entry and rejects the same entry from a
Kiro seat. The lane does not duplicate those assertions. **The genuinely new case** this change adds asserts that
`sessionId('agent:vitana-lane-reviewer', date, '<seat>')` throws `a reviewer agent id names no seat`
(`queue.mjs:911`) — the one behaviour T7/T8 do not cover — plus, if needed, a case that `agentOf()` returns `''` for
a non-agent id used as a review `Collab-Session` so scope-check rejects it (strengthening, not loosening, the
non-agent-id path of T7). Each new case is red on `origin/main` for the reason the change proves and green on the
head; red→green is recorded in the lane's evidence. No existing test is weakened, skipped or loosened. Note: which
pattern the Kiro permission engine admits is validated live (the live reviewer-agent demonstration), not by a unit
test.

## Measurement
`docs/validation/<plan VTID>/timings.json` (schema `vitana.plan-timings/v1`), fields `null` where a source is
missing. This change deploys nothing (collab tooling + an agent definition), so there is no staging surface and no
Gate 2; `staging_verify_*` stay `null`.

## Risks
- **Over-broad permission.** Mitigated by pinning the whole command tail (`session-id --agent
  agent:vitana-lane-reviewer`) with a single leading wildcard, keeping the metacharacter `exclude:` guard, and
  proving in the live demonstration that unrelated commands stay denied. The chosen pattern is the narrowest the Kiro
  engine admits for exactly this one command.
- **Reviewer gaining write power.** It does not: `fs_write`, `fs_append`, `str_replace`, `delete_file`, `web_fetch`,
  `web_search` and `mcp` stay denied; the command is read-only (it prints an id). The agent still never
  commits, pushes, merges or writes repo files; the caller still commits the review entry.
- **Self-granting its own gate.** Refused: `.kiro/agents/vitana-lane-reviewer.md` is a protected gate file, so the
  lane's reviewer-agent accept alone never merges it. The merge authority is the owner instruction naming this plan,
  recorded in the lane log and presented as the final protected-file diff for owner review.
- **Entirely within Kiro.** No Claude Code and no Kiro IDE handoff; the owner instruction (not a Claude review and not
  self-approval) is the protected-gate-file authority.

## Unchanged
The reviewer agent's other permission rules (`fs_write`/`web_fetch`/`web_search`/`mcp` deny), the verdict JSON shape,
the review-entry format, the model self-check chain, `sessionId()`/`agentOf()`/the scope-check validator in
`queue.mjs`, `protected-gate-files.json`, and every other governance path. No production or live-system change.
<!-- plan:end -->
