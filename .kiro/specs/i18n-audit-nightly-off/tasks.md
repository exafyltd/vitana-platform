# Tasks — i18n-audit-nightly-off
<!-- lane: workflow-off -->
Code starts only after the VTID is allocated (plan § Lane).
- [ ] T1 `i18n-audit-llm.yml`: remove `schedule:` and job `audit-nightly`; drop `pull-requests: write`; header
      comment updated.
- [ ] T2 `i18n-audit-llm.yml`: `provider` input default `deepseek`.
- [ ] T3 `CLAUDE.md`: audit command uses `provider=deepseek`, one-sentence reason, Bedrock follow-up named.
- [ ] T4 `scripts/i18n-audit-llm.mjs`: fallback provider `deepseek`; usage comment updated.
- [ ] T5 Verify: YAML parses, PR-GATE green; after merge `gh workflow view` lists only `workflow_dispatch` and no
      scheduled run or new `auto/i18n-audit-*` branch appears the next night.
Acceptance: requirements 1–3 hold, and the script and workflow defaults agree.
