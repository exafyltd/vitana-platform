# VTID-04400 — Orchestrator P3: commerce onboarding specialist (agent-as-tool)

Plan: `docs/ORCHESTRATOR-REDESIGN-PLAN.md` §5 P3 ("commerce onboarding (new `commerce` surface)").

## Acceptance criteria

- **AC-1 Off by default.** Without `ORCHESTRATOR_COMMERCE_SPECIALIST_ENABLED=true` nothing registers, no tool is declared, and the commerce catalog is the navigation-only set it was.
  TEST: services/gateway/test/services/orchestrator/vtid-04400-commerce-specialist.test.ts — "AC-1 off by default"
- **AC-2 Catalog when on.** The commerce catalog declares `ask_commerce_specialist`, `get_delegation_result` and `cancel_delegation` exactly once, next to navigation. The member, command-hub and anonymous catalogs never get it, and the budget priority list names it.
  TEST: services/gateway/test/services/orchestrator/vtid-04400-commerce-specialist.test.ts — "AC-2 catalog when on"
- **AC-3 Commerce authority from membership.** `org_admin`, `staff` and `professional` (the roles `partner_organization_members` stores) now resolve to a ceiling. The dispatcher passes the caller's memberships to the policy. A caller with no membership is refused.
  TEST: services/gateway/test/services/orchestrator/vtid-04400-commerce-specialist.test.ts — "AC-3 commerce authority from membership"
- **AC-4 Reads are the caller's own.** Every tool is pinned to the caller's memberships, and an organization can only be picked from among them. Pending invites are shown to an org_admin only, as a count. The run uses the triage stage and returns bounded findings. Errors never throw.
  TEST: services/gateway/test/services/orchestrator/vtid-04400-commerce-specialist.test.ts — "AC-4 reads are the caller’s own"
- **AC-5 Through the tool.** A member of an organization on the commerce route gets the findings. No membership is refused, and a load failure surfaces. orb-live dispatches the tool name.
  TEST: services/gateway/test/services/orchestrator/vtid-04400-commerce-specialist.test.ts — "AC-5 through the tool"

## Two defects fixed on the way
1. `dispatcher.delegateToAgent` evaluated policy with `orgs: []`. Every `commerce`-domain target resolved to ceiling `none` and was refused, whoever the caller.
2. `ORG_ROLE_CEILINGS` only had `owner`/`admin`/`member`. `partner_organization_members.role` is `org_admin`/`staff`/`professional` (CHECK constraint, migration `20260915120000`), so no real membership matched a ceiling.

## Never read
`business_details`, member or invitee identities (emails, user ids), invite tokens.

## Not verified live
- The flag is unset.
- Both LLM providers are currently refusing.
- Staging cannot place ECS tasks (AWS account block).

The first real signal is a commerce-route voice session with the flag on, calling `ask_commerce_specialist` and logging `llm.call.completed` with `service=commerce-specialist`. The cascade path and text-chat delegation are not part of this slice.
