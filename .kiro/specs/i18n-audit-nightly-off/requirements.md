# Requirements — i18n-audit-nightly-off
1. `i18n-audit-llm.yml` has no `schedule` trigger and no `audit-nightly` job; manual dispatch still works.
2. The manual dispatch defaults to a provider that answers today (`deepseek`); `gemini` and `anthropic` remain
   selectable.
3. `CLAUDE.md` documents the manual command with the new default and why.
