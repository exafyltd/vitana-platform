# VCAOP — ESCALATIONS (Tier-B awaiting approval + safe-default decisions)

> Tier-B items requiring human sign-off (runbook Sec. 0.4), plus safety/legal
> safe-default decisions taken under the "more restrictive option" rule (Sec. 11.2 step 8).

## Tier-B items AWAITING-APPROVAL

_None yet._ No Tier-B action has been required or taken in the guardrails layer.

## Safe-default decisions (chose the more restrictive option, logged, continued)

| ID | Context | Decision | Rationale |
|----|---------|----------|-----------|
| SD-001 | Branch selection: runbook says `feature/vcaop`; this session is harness-governed to `claude/vibrant-lovelace-DBM5k` with "never push to a different branch without explicit permission." | Work on `claude/vibrant-lovelace-DBM5k`; bring the specs onto it. Never push `main`, never force-push. | More restrictive / honors the explicit session constraint while still satisfying runbook Sec. 0.6 (dedicated non-main branch, PR not auto-merged). User explicitly permitted "bring them onto your working branch." |
