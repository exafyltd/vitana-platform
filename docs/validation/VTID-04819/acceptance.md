# VTID-04819 — Jev P3 E8: payment ↔ invoice match on allocations, shadow mode

Plan: `docs/JEV-INTEGRATION-PLAN.md` §10.4 E8 (P3).

`finance.payment.allocate` (allocate-payment / apply-advance-to-invoice) ties a received payment to an invoice.
Entity resolution makes sure both ids exist; nothing checks that they belong together — the same party, a fitting
amount, the same currency, an invoice that is still open.

VALIDATION_PROFILE: gateway_backend

## Acceptance criteria

AC-1: New decision `payment_invoice_match` (business data, `pii: 'redact'`, internal plane, backoffice roles): does the payment belong to the invoice, and the main issue (none / amount / party / currency / already settled / unclear) — from amounts, currencies, dates, references, whether the parties are the same and whether the payment reference names the invoice.
  TEST: services/gateway/test/vtid-04819-payment-invoice-match.test.ts
AC-2: After an executed `finance.payment.allocate`, the payment and the invoice are read through the bridge's own read actions (`get-payment`, `get-sales-invoice`; tenant routing, the requester as actor, channel system). The parties are compared in the gateway and never sent (customers can be people).
  TEST: services/gateway/test/vtid-04819-payment-invoice-match.test.ts
AC-3: Gate `payment_invoice_match` (`JEV_PAYMENT_INVOICE_MATCH_MODE`, exact values; anything else off). Off reads, asks and writes nothing. In shadow, one `jev_shadow_decisions` row per allocation (`subject_type = erp_payment_allocation`, `system_action = allocated`); agreement at once where the rule is certain (different party or currency → no match; same party + currency + exact open or total amount → match); missing records or ids → nothing; Jev down → fallback row; never throws.
  TEST: services/gateway/test/vtid-04819-payment-invoice-match.test.ts
AC-4: Both command paths run it after the command, never awaited; commands, receipts and responses are unchanged (Backoffice suites green). Both gateways pin `JEV_PAYMENT_INVOICE_MATCH_MODE=shadow`, never enforce; generated pins agree; the prod Jev comment is shortened so the task-definition step stays under GitHub's 20,000-char limit (19,759).
  TEST: services/gateway/test/vtid-04819-payment-invoice-match.test.ts
  TEST: services/gateway/test/vtid-04782-crm-gates.test.ts
  TEST: services/gateway/test/orb/live/upstream/staging-deploy-workflow-bash-syntax.test.ts

## Scope

SCOPE_ALLOWLIST:
- services/gateway/src/services/jev/jev-decisions.ts (one decision)
- services/gateway/src/services/jev/gates/payment-match-gate.ts (new)
- services/gateway/src/services/backoffice/command-orchestrator.ts (one fire-and-forget call on both paths)
- .github/workflows/AWS-STAGE-DEPLOY-GATEWAY.yml, .github/workflows/AWS-PROD-DEPLOY-GATEWAY.yml (shadow pin; shorter Jev comment)
- services/gateway/src/services/conversation/conversation-flag-pins.generated.ts
- services/gateway/test/vtid-04819-payment-invoice-match.test.ts
- docs/JEV-INTEGRATION-PLAN.md, docs/validation/VTID-04819/**

## OASIS

OASIS_IMPACT: none new. Each allocation emits the existing `jev.decision.*` event (source `jev:gate:payment_invoice_match`).

## MERGE_PAYLOAD_PREVIEW

Squash merge to `main` → staging deploy with `JEV_PAYMENT_INVOICE_MATCH_MODE=shadow`. Backoffice commands are unchanged; the extra ERP calls are two get reads per allocation.

## Not in this PR

Enforce (asking before a doubtful allocation is made).
