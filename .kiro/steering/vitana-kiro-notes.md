---
inclusion: always
---
# Working in Kiro on Vitana (VTID-05059)

- Kiro IDE has no Claude Code skills, hooks or subagents. The rules still apply unchanged:
  - **Plan sparring is never skipped.** Spar a new plan through the Command Hub Operator or a Claude Code session
    (skill `plan-sparring`) before any VTID is allocated.
  - The Claude Code PreToolUse sparring reminder and the SessionStart morning-pack hook do not run here. To load
    where a piece of work stands, run `scripts/dev/resume-vtid.sh <VTID>` and paste its output into the chat.
- The always-included rules are the full `CLAUDE.md` (about 1,000 lines) — the same load a Claude Code session
  carries. Path-scoped references (`.claude/rules/*.md`) load only when you work on matching files.
