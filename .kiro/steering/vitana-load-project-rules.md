---
inclusion: always
---
# Vitana: load the project rules first (every session)

At the start of EVERY session, before anything else:

1. Read these files from the repository and treat them as binding project rules:
   - `.kiro/steering/vitana-kiro-notes.md`
   - `CLAUDE.md` (and `.claude/CLAUDE.md`)
   - `.claude/rules/collaboration.md` (especially §7, §7a and §7b)

   If the session has both repos, read them in `vitana-platform` (the files are the same in `vitana-v1`).
2. Follow them over any general habit. **Your role: you plan, build and review, and you carry each change end to end
   to a verified staging build** (collaboration §7 and §7b, owner decision 2026-10-18):

   plan PR → PLAN-SPAR → converge → VTID (allocated by CI) → build → independent review → merge → staging deploy →
   STAGING-VERIFY → Gate 2 message to the owner.

   - **Merge (§7b)** only when all of these hold:
     - the owner explicitly instructed that merge in this conversation, per PR or as a set they listed. A standing
       "merge everything", the Gate 1 "yes" and the policy approval do **not** count;
     - the PR targets `main` and its deploy path is staging only;
     - the review is from another reviewer, on the current head;
     - every required check is green, or is a known false positive on a governance-artifact check that §7b lets you
       `--admin`-override.

     Record the owner's instruction and the merge SHA in the lane log (or the plan's handoff). Without such an
     instruction, stop at a green, reviewed PR and ask the owner for it in one line.
   - **Gate 2:** send the message with the STAGING-VERIFY evidence. Its "yes" is carried out by PUBLISH or Claude
     Code, never by you.
   - **Never:**
     - deploy production (PUBLISH, `publish-to-prod.sh`, any `AWS-PROD-DEPLOY-*`), even after the owner's Gate 2
       "yes";
     - dispatch a workflow;
     - approve a PR on GitHub;
     - allocate a VTID (CI does);
     - review your own lane;
     - use `--admin` on anything except a governance-artifact false positive (never on a failing test or build).
3. **Your Supabase and AWS access is NOT read-only**, whatever a server or role is named.
   - Never test against production. Staging tests are read-only.
   - Never write to a live system outside the staging pipeline that a §7b merge triggers. That means no
     INSERT/UPDATE/DELETE/DDL, no `apply_migration`, no `deploy_edge_function`, and no hand-made mutating AWS call.
   - A database change is a migration file in your PR.
   - Blocked any other way → say so, log it in the lane file, and hand it back (`next_actor: claude`).
4. Then follow the session-start steps in `.claude/rules/collaboration.md` §4: session id, `git fetch`, run the queue,
   and claim a lane before touching it.
