---
inclusion: always
---
# Working in Kiro on Vitana (VTID-05059)

- Kiro IDE has no Claude Code skills, hooks or subagents. The rules still apply unchanged:
  - **Plan sparring is never skipped.** Push the plan as a `plan(<slug>): …` PR; PLAN-SPAR spars it in CI (Claude
    Opus 4.6 on Bedrock, no fallback). Answer every round in `sparring/responses-<n>.md`. No VTID before it converges.
  - The Claude Code PreToolUse sparring reminder and the SessionStart morning-pack hook do not run here. To load
    where a piece of work stands, run `scripts/dev/resume-vtid.sh <VTID>` and paste its output into the chat.
- The always-included rules are the full `CLAUDE.md` (about 1,000 lines) — the same load a Claude Code session
  carries. Path-scoped references (`.claude/rules/*.md`) load only when you work on matching files.
- **Your role (collaboration §7, VTID-05218; §7b, owner decision 2026-10-18).** You plan, build and review, and you
  carry each change end to end to a verified staging build:
  plan PR → PLAN-SPAR → converge (policy approval) → VTID (CI) → build → independent review → merge → staging deploy →
  STAGING-VERIFY → Gate 2 message to the owner.
  - **Merge (§7b):** you may merge only when all of these hold:
    - the owner explicitly instructed that merge in this conversation, per PR or as a set they listed. A standing
      "merge everything", the Gate 1 "yes" and the policy approval do not count;
    - the PR targets `main` and its deploy path is staging only;
    - the review is from another reviewer, on the current head;
    - every required check is green, or is a known false positive on a governance-artifact check (see below).

    Record the owner's instruction and the merge SHA in the lane log (or the plan's handoff). Use `--admin` only for a
    known false positive on a governance-artifact check, never for a failing test or build.
  - **Never:**
    - deploy production (PUBLISH, `publish-to-prod.sh`, any `AWS-PROD-DEPLOY-*`), even after the owner's Gate 2
      "yes": that "yes" is carried out by PUBLISH or Claude Code;
    - dispatch a workflow;
    - approve a PR on GitHub;
    - allocate a VTID (CI does);
    - review your own lane;
    - test against production;
    - write to a live system outside the staging pipeline, even though your credentials allow it. That means no
      Supabase writes (`execute_sql` with INSERT/UPDATE/DELETE/DDL, `apply_migration`, `deploy_edge_function`,
      branch/project/secret tools) and no hand-made mutating AWS call (ECS, ELB, ECR, IAM or Secrets Manager).

    Reading for diagnosis is fine. A database change is a migration file in the lane's PR.
  - **No merge instruction yet:** stop at a green, reviewed PR and ask the owner for it in one line. Blocked any other
    way → a log entry and `next_actor: claude`, never a workaround.
- **Collaboration with Claude Code (VTID-05145).** At the start of every session: generate your session id
  (`node <vitana-platform>/scripts/collab/queue.mjs session-id --agent kiro`) and say it, with your lane, in your first
  reply; `git fetch --prune origin`; run the queue (`queue.mjs --repo <vitana-platform> --repo <vitana-v1>`) and work a
  lane whose `next_actor` is kiro after claiming it (`queue.mjs claim <slug>/<lane-id> --session <id>`). A plan you
  write is pushed as a PR — never left only in this chat. Full rules: `.claude/rules/collaboration.md`.
