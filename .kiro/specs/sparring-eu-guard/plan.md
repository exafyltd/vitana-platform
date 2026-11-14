---
change_class: standard
---
# plan(sparring-eu-guard): keep the plan sparring inside the EU and off a US default region

Author: Claude Code, seat `claude`, session id recorded in handoff.md, 2026-11-11. Premises read at vitana-platform
`origin/main` (e7e0c116). Privacy rule: no plan text, finding or response quotes an email address; cite `file:line`.

<!-- plan:begin -->
## 0. Premises (each one a file on main)
1. The partner chain is Bedrock Opus 4.6 (`eu.anthropic.claude-opus-4-6-v1`) → Bedrock Sonnet 4.6
   (`eu.anthropic.claude-sonnet-4-6`) → DeepSeek last resort: `services/gateway/src/constants/llm-defaults.ts:115,128,149`.
2. The last-resort tier calls DeepSeek's own API, `https://api.deepseek.com/chat/completions`:
   `services/gateway/src/services/llm-router.ts:879`. That is outside the EU and outside Bedrock.
3. The tier is on unless the variable is exactly `false`: `llm-defaults.ts:157-158`
   (`PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED !== 'false'`). The tier is added in `partner.ts:142-144`.
4. The Bedrock adapter reads its region as `AWS_BEDROCK_REGION || AWS_REGION || 'us-east-1'`:
   `services/gateway/src/providers/bedrock.ts:148-150`. A process without either variable sends EU model ids to us-east-1.
5. The gateway task definitions set both variables to eu-central-1 (checked read-only by the owner, 2026-11-11), so
   production sparring is not affected by premise 4 today. The default is still a defect.
6. Owner decisions: D4 keep DeepSeek; D5 Bedrock EU only; D13 (which DeepSeek option) is open. Nothing here chooses D13.

## 1. Problem
- Sparring can send a plan's text to DeepSeek's own API. That breaks D5 and is an uncontrolled data transfer.
- A process that lacks the region variables silently uses a US region for EU models. The error is opaque.

## 2. Change (code lands only after this plan converges and a VTID is allocated)
C1. The DeepSeek direct-API tier is OFF unless `PLAN_SPARRING_DEEPSEEK_FALLBACK_ENABLED` is exactly `true`.
    The default flips from on to off. `partner.ts` and `llm-defaults.ts` change together.
C2. The Bedrock region has no default, in both `providers/bedrock.ts:148-150` and `services/dev-memory-embedding.ts:42-43`
    (round 1, R1-F1). With neither `AWS_BEDROCK_REGION` nor `AWS_REGION` set, the adapter returns `not_configured` with the
    message "AWS_BEDROCK_REGION or AWS_REGION must be set (EU region)". It never falls back.
C3. Tests (red on base first): (a) with the flag unset, no deepseek tier is in `tiers`; (b) with the flag `true`, the tier
    is present; (c) with both region variables unset, `bedrock.ts` and `dev-memory-embedding.ts` each return `not_configured`
    and send no request.
C4. Nothing else changes. D13 (Bedrock DeepSeek V3.2 in eu-north-1 versus the other options) is a follow-up plan.

## 3. Acceptance
- Unit tests C3(a)–(c) red on main, green on the branch.
- `services/gateway` Jest for `plan-sparring` and `providers/bedrock` green.
- A real sparring round on a test plan converges with no DeepSeek entry in `model_log` (read-only; no production write).

## 4. Risks
- If Bedrock quota fails for both Bedrock tiers, sparring stops (`model_unavailable`). That is the intended fail-closed
  behaviour under D5. The owner decides whether to turn the DeepSeek tier on again (C1 variable).
- Rolling out C2 with an ECS task that lacks the variables would fail loudly. The task definitions already set them.

## 5. Out of scope
- Replacing the DeepSeek tier with Bedrock DeepSeek V3.2 (D13). Separate plan after the owner answers D13.
- Any production task-definition change. Deploys go through the pipeline.
<!-- plan:end -->
