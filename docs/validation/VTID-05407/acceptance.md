# Acceptance — VTID-05407 (reviewer-session-id-permission / reviewer-perm)

Lane: `reviewer-session-id-permission/reviewer-perm` · executor `kiro` · seat `exafy` · reviewer agent
`vitana-lane-reviewer`. Repo: `exafyltd/vitana-platform`. Change types: **Tooling/docs**.

## What changed (only the three lane paths)
1. `.kiro/agents/vitana-lane-reviewer.md` (protected gate file)
   - **Permission (T1).** Added the one pattern
     `*scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer` to BOTH the `capability: shell` allow
     `match:` list AND the `capability: shell` deny `exclude:` list (they mirror each other). Nothing else added. The
     allow rule's metacharacter `exclude:` guard `["*;*","*&*","*|*","*>*","*<*","*\`*","*$(*"]` is unchanged.
   - **Instructions (T2).** New section "Your reviewer session id — generate it first": the agent runs
     `node <repo>/scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer` at the START of a review
     and uses the printed `agent-vitana-lane-reviewer-…` id in BOTH output blocks (the lane-log `### … · <reviewer
     session> · review` header and the `Collab-Session:` line). The verdict JSON (block 1) is unchanged (carries no
     session). **R1-F1:** the Hard-limits "only these shell commands" enumeration now includes that one node command,
     so the instructions no longer contradict the permission. **R2-F1 (fail loud):** if the command is denied, errors
     or prints no reviewer id, the agent returns verdict `changes` with one blocking finding naming the failure
     instead of leaving `<reviewer session>` literal (which would silently fall back to the land step,
     `.kiro/pipeline/lane-review.md:79-84`). Read-only hard limits unchanged: still denies
     `fs_write`/`fs_append`/`str_replace`/`delete_file`/`web_fetch`/`web_search`/`mcp`; still never
     commits/pushes/merges/approves; still never chains commands; the caller still commits the review entry. The
     model self-check and checklist items 1–10 are untouched.
2. `scripts/collab/queue.test.mjs`
   - **T3.** Added one genuinely new `node:test` case `VTID-05407: reviewer session-id round-trips to its agent and a
     reviewer id names no seat`. It asserts `sessionId('agent:vitana-lane-reviewer')` matches the id format and
     `SESSION_RE` (`isSessionId`), `agentOf(sessionId(...)) === 'agent:vitana-lane-reviewer'` (the scope-check
     accepts-the-entry invariant), and `sessionId('agent:vitana-lane-reviewer', date, '<seat>')` **throws** `a
     reviewer agent id names no seat`. T8 already covers the id shape + `agentOf` round-trip and the
     `agent:other`/`claude` throws, but NOT the reviewer-agent seat-rejection path — that is what this new case adds
     (R1-F2: not a duplicate of T7/T8). No existing test weakened, skipped, loosened or deleted.
3. `docs/validation/VTID-05407/**` — this evidence pack.

## Why the chosen permission pattern is the narrowest (empirical)
Pattern: `*scripts/collab/queue.mjs session-id --agent agent:vitana-lane-reviewer`.
- It pins the script-path tail (`scripts/collab/queue.mjs`), the exact subcommand (`session-id`) and the exact
  argument (`--agent agent:vitana-lane-reviewer`). The single leading `*` absorbs only `node ` and the varying
  `<path>` prefix (the Kiro Web clone path vs. the IDE path), which is required because the checkout path is not
  fixed. There is **no trailing `*`**, so an appended `--seat …` or any extra argument does not match.
- Candidates considered and rejected as too broad (see `permission-match.log`):
  - `node *` — admits ANY node command (including `queue.mjs claim/release/validate/scope-check`). Rejected.
  - `*queue.mjs *` — admits every `queue.mjs` subcommand. Rejected.
  - `*scripts/collab/queue.mjs session-id *` (trailing `*`) — would also admit `session-id --agent kiro --seat …`
    and `--agent agent:other`. Rejected: not pinned to the reviewer agent.
  The chosen pattern is the smallest that admits exactly the one command and denies all the above.
- `permission-match.log` is the output of `permsim.mjs`, a faithful model of the Kiro shell-permission engine
  (`*` = any chars incl. spaces, anchored full-string match; allow `match` + metachar `exclude`, deny `exclude`
  mirrors allow). All 19 admit/deny cases pass: the exact command (both this checkout and a different `<path>`) is
  ADMITTED; `queue.mjs claim/release/validate/scope-check`, `session-id --agent kiro --seat`, `session-id --agent
  agent:vitana-lane-reviewer --seat exafy`, `session-id --agent agent:other`, `ls`, `cat`, `node -e`, and every
  metachar-chained variant (`;`, `&&`, `|`, `>`, `$()`) are DENIED; the existing `git diff`/`gh pr view` reads still
  ADMITTED.
- **The authoritative check is the live reviewer-agent dispatch.** `permsim.mjs` is a model of the engine, not the
  engine itself; see `live-demonstration.md` for the live dispatch status and exact instructions.

## Verification
- `node --check scripts/collab/queue.mjs` → OK. See `commands.log`.
- `node --test scripts/collab/queue.test.mjs` → 54 pass, 0 fail (53 pre-existing + the new VTID-05407 case). See
  `commands.log`.
- Red→green of the new case: `red-green.log` (RED when the `names no seat` guard is absent; GREEN with it present).
- Permission admit/deny matrix: `permission-match.log`.
- Live reviewer-agent demonstration: `live-demonstration.md`.

## Protected gate file
`.kiro/agents/vitana-lane-reviewer.md` is listed in `scripts/collab/protected-gate-files.json`. Per
`collaboration.md` §3a it never merges on a reviewer-agent accept alone: the merge authority is the OWNER INSTRUCTION
naming this plan (`reviewer-session-id-permission`), recorded in the handoff/lane log — NOT a Claude review and NOT a
reviewer-agent self-approval. The final protected-file diff is presented for owner review. The agent's own checklist
item 9 still refuses to loosen its own gate unless the caller cites that owner instruction.
