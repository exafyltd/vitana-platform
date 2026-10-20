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
2. Follow them over any general habit. Your role and limits are `.claude/rules/collaboration.md` §7/§7a/§7b: you plan,
   build, take the reviewer agent's verdict and merge to `main` (staging) under the PM merge rule §7b; CI allocates
   VTIDs; production only by the owner's PUBLISH; no live-system writes from session tools. A database change is a
   migration file in your PR. Blocked → fix forward (max 3), then park with the five-part stop message; hand to Claude
   only if Claude is available (§7).
3. Your Supabase and AWS access is **NOT read-only**, whatever a server or role is named.
   Treat every write to a live system as forbidden by rule. Never test against production.
4. Then follow the session-start steps in `.claude/rules/collaboration.md` §4
   (session id, `git fetch`, run the queue, claim a lane before touching it) and, for an approved plan, start or
   resume its driver (§8).

Account-level copies of this file (Kiro user rules, outside git) may be older; where they differ, this repository file
governs.
