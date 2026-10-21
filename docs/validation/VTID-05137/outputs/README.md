# VTID-05137 — outputs

- Migration applied before merge: RUN-MIGRATION run [38375845593](https://github.com/exafyltd/vitana-platform/actions/runs/38375845593) — success.
- Read-only check after the run: `user_notifications_push_outcome_check` contains `coalesced` and is validated; `idx_user_notifications_chat_conv` exists.
- Baseline (read-only, 2026-10-13): 4,334 chat pushes in 14 days, 3,412 (79%) sent < 5 min after a previous push to the same recipient for the same conversation.
- Test results: this PR's CI (Gateway Jest).
