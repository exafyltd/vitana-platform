Read-only query against `oasis_events` (`topic='llm.call.completed'`), 2026-09-16 to 2026-09-22. Rows recorded at $0 were repriced from their tokens at Opus 4.5 $5/$25 and Sonnet $3/$15 per 1M tokens. Only agent-days above $2 are listed.

| day | agent (`service`) | USD |
|---|---|---|
| 09-17 | db-i18n-translator | 33.57 |
| 09-18 | db-i18n-translator | 33.42 |
| 09-18 | autopilot-agent | 24.00 |
| 09-19 | db-i18n-translator | 33.30 |
| 09-19 | autopilot-agent | 4.57 |
| 09-20 | autopilot-agent | 45.25 |
| 09-20 | db-i18n-translator | 33.50 |
| 09-21 | db-i18n-translator | 14.49 |
| 09-21 | autopilot-agent | 7.95 |
| 09-21 | dev-autopilot-planning | 3.10 |
| 09-21 | self-healing-triage | 2.29 |
| 09-22 | dev-autopilot-planning | 58.39 |
| 09-22 | db-i18n-translator | 33.32 |
| 09-22 | autopilot-agent | 19.85 |

The same window as recorded, without repricing: every Bedrock row showed `cost_estimate_usd = 0`. That was 5,178 calls, including db-i18n-translator (4,106 calls) and dev-autopilot-planning (212 calls, 13.4M input tokens).
