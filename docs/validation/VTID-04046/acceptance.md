# VTID-04046 — the agent executor's system prompt states today's date

**Defect (live, 2026-09-18, Run #6b / VTID-04045 / execution 7e7260fe):** the agent has no
clock and `buildAgentSystemPrompt` carried no date, so a task needing one made it search the
repository for a recent-looking date. Measured on the run's own step feed: turns 10-14
(`search_text 202609(19|20|21|22|23)`, `2026-09-1[0-9]`, `2026-09-(19|2[0-9]|3[01])`,
`2026091[0-9]-vtid`, `VTID-0404[0-9]`) and turn 58 (`20260918-vtid-04033`) were date hunts —
6 of a 60-turn budget — and the run still ended at the cap without calling `finish`.

**Fix:** one line in the system prompt, before the "How to work" section: the date, plus an
instruction never to search the repository for one. `isoDay()` is exported and the field is
optional (defaults to the runner's own clock), so the caller need not thread it.

AC-1 — `isoDay` formats a Date as `YYYY-MM-DD` in UTC, including a late-evening UTC time, and its no-argument default is well formed.
TEST: services/gateway/test/vtid-04046-agent-prompt-date.test.ts

AC-2 — the prompt states the supplied date and tells the agent not to search the repository for one.
TEST: services/gateway/test/vtid-04046-agent-prompt-date.test.ts

AC-3 — with no date supplied the prompt falls back to the runner clock.
TEST: services/gateway/test/vtid-04046-agent-prompt-date.test.ts

AC-4 — the date is stated before the "How to work" section, so it reads as context rather than a step, and nothing else about the prompt contract changes.
TEST: services/gateway/test/vtid-04046-agent-prompt-date.test.ts

AC-5 — (live, post image rebuild) an agent run that needs a date uses it directly instead of searching. The signal is zero date-shaped `search_text` calls in the step feed of the next run on a dated task.
CURL: POST https://preview-aws-gateway.vitanaland.com/api/v1/operator/chat/stream — recorded after the executor image is rebuilt from this merge
