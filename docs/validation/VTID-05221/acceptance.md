# VTID-05221 — acceptance

This PR (spec only) — the Kiro hand-off for the multi-tenant program:
AC-1: `.kiro/specs/multi-tenant/` holds requirements.md, design.md, tasks.md (task groups tagged per lane),
handoff.md and lanes/provisioning-ui.md + lanes/ac10-recheck.md.
  TEST: `node scripts/collab/queue.mjs validate --base origin/main --head HEAD` → "all valid"; the queue lists
  multi-tenant/provisioning-ui (`ready`, next_actor kiro, seat hotmail) and multi-tenant/ac10-recheck (`ready`, claude).
AC-2: the spec links the program records instead of copying them, and states the successor rules (migration queue
order + lane ranges, dark-by-default, 05147 AC-5, Lane C whitelist, D12/D13/D14, production read-only).
  TEST: review of design.md.

The provisioning-ui lane's own acceptance (Vitest, staging spec) lives in `tasks.md` (P7–P9) and ships with the Kiro PR
in vitana-v1 under `docs/validation/VTID-05221/`.
