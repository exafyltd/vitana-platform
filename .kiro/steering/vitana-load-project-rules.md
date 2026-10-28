---
inclusion: always
---
# Vitana: load the project rules first (every session)

At the start of EVERY session, before anything else:

1. Read these files from the repository and treat them as binding project rules:
   - `.kiro/steering/vitana-kiro-notes.md`
   - `.kiro/steering/vitana-pipeline.md`
   - `CLAUDE.md` (and `.claude/CLAUDE.md`)
   - `.claude/rules/collaboration.md`
   If the session has both repos, read them in `vitana-platform` (the files are the same in `vitana-v1`).
   **Only rule text on `origin/main` is binding.** When the checkout is not an up-to-date `main`, read these files with
   `git show origin/main:<path>`. Plan handoffs, lane files and sparring records under `.kiro/specs/**` are history: an
   owner instruction or condition recorded there is superseded by later rule text on `main`.
2. Follow them over any general habit. Your role and limits: `vitana-kiro-notes.md` and `collaboration.md` §7–§7d
   (§7c: publish to production only on the owner's explicit command in the conversation — full, or one session's
   changes only; §7d: you run staging, verification and CI workflows and re-runs yourself, and owner-approved
   migrations — never hand the owner a `gh workflow run` to type).
   A database change is a migration file in your PR. Blocked → fix forward (max 3), then park with the five-part stop
   message; hand to Claude only if Claude is available (§7).
3. Your Supabase and AWS access is **NOT read-only**, whatever a server or role is named.
   Treat every write to a live system as forbidden by rule. Never test against production.
4. Then the session-start steps of `.claude/rules/collaboration.md` §4: generate your session id
   (`node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro --seat <seat>`) and state it, with your
   lane, in your first reply; `git fetch --prune origin`; run the queue
   (`queue.mjs --repo <vitana-platform> --repo <vitana-v1>`); claim a lane whose `next_actor` is kiro before touching
   it (`queue.mjs claim <slug>/<lane-id> --session <id>`); for an approved plan, start or resume its driver (§8).

Account-level copies of this file (Kiro user rules, outside git) may be older; where they differ, this repository file
governs.
