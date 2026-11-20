# VTID-05695 acceptance (session-handover-gitlab/claude-md-platform)

AC-1 CLAUDE.md has the section "SESSION HANDOVER: STRAIGHT TO GITLAB" right after the collaboration section, text equal to plan §3.
TEST: node --test scripts/collab/session-handover-rule.test.mjs

AC-2 No other line of CLAUDE.md changes (diff is 20 added lines, 0 removed).
TEST: git diff --numstat origin/main -- CLAUDE.md

AC-3 Collab tests and the Kiro steering guard stay green.
TEST: node --test scripts/collab/*.test.mjs
