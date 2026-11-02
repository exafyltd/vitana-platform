---
slug: mt-community-isolation-r2
author: kiro
author_seat: hotmail
executor: kiro
next_actor: kiro
state: drafted
updated: 2026-11-01T15:20Z
---
# Handoff — mt-community-isolation-r2
Re-plan of `mt-community-isolation` (branch `kiro/mt-community-isolation/plan`; PLAN-SPAR session `ed136e24`
escalated at the round cap). WS3 Community half: `tenant_id` + RLS rewrite on the community content tables, the
per-tenant Founding pool, the `platform_only_accounts` view, tenant-scoped gateway reads and the daily-matches pool.
Plan: `plan.md`.

## Log

### 2026-11-01T15:20Z · kiro-hotmail-202611011452-6d16 · drafted
Owner instruction 2026-11-01: "you make the decisions for me". The escalated plan is re-planned rather than approved
as escalated.
- Round-3 findings are answered in `plan.md` "Re-plan answers". R3-F1: `resolvePersonByName` scopes its own query
  and sanitises its `.or()` term. R3-F2: `user_matches` filters the other party's column.
- Premises were re-verified on platform `62990ce285` and vitana-v1 `58c76c956`, and the line refs were corrected.
- Migration slots are day-shifted to `20261102*`, which keeps the cross-spec C3/O4 order.
- The WS1 dependency is named as `mt-identity-r2`.
- All lanes are `executor: kiro` with reviewer `agent:vitana-lane-reviewer`. Migrations are applied only on the
  owner's approval (§7d).

The plan PR opens when PLAN-SPAR capacity allows (`collaboration.md` §8a), after `mt-guardrails-r2` and
`mt-identity-r2`.
