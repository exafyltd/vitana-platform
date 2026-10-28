# VTID-05004 — plan sparring record

Partner: plan-sparring-partner agent (independent, read-only). Rounds: 2. Verdict: **CONVERGED**.

## Plan
In the Command Hub Kiro workspace card, a linked key shows a green "✓ Connected" (class `kiro-key-ok`).
Replace/Revoke are no longer in the default view; a small muted "Manage key" (`kiro-key-manage`) reveals
Replace, Revoke (still confirm()) and Done. No gateway, route or key-storage change. Cache-bust bumped,
every pinned staging probe repointed, ownership guard + symbol index updated, tests per F6.

## Round 1 findings (verbatim titles) and answers
- F1 [minor] rows loop needs special-casing for `kiro-key-ok` — accepted (index 2 + linked; textContent only).
- F2 revoke confirm() kept — no change needed.
- F3 [minor] repoint every probe pinning `20261109-vtid-05003` — accepted (grep + repoint, 17 files).
- F4 [minor] ownership guard pattern — accepted.
- F5 [minor] `managing` reset paths — accepted; failed revoke keeps managing via Object.assign.
- F6 [major→closed] test structure — accepted: linked = 0 `kiro-key-btn` + 1 `kiro-key-manage`; Manage → exactly Replace/Revoke/Done; Done clears; Revoke via Manage.
- F7 [minor] Done uses `kiro-key-btn` — accepted.
- Q1 hide vs remove Revoke — hide behind Manage key (removing it would leave no way to revoke a leaked key); listed as a decision taken.
- Q2 per-user key, own token — unchanged.

## Round 2
All findings closed, no new findings. CONVERGED.

## Owner approval
2026-10-09, in session: "yes, take it to staging".
