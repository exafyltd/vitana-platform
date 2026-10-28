# Requirements — commerce-step-owner

1. Every open required onboarding step in the onboarding status (`GET /api/v1/partner-onboarding/:orgId` and every
   other response carrying `checklist`) has `owner`: `assistant`, `supplier` or `vitanaland`. Steps that are done,
   not required or `not_required` have none.
2. The verification step's owner follows its open checks; unknown checks and reviewer requests mean `supplier`.
3. The Commerce MCP status shows the same `owner` per open step and on `next_action`; nothing it shows today changes.
4. One source: the MCP's list of supplier-only steps is derived from the checklist module.
5. "Still needed" on the supplier screen groups open steps: "Only you can do this", "Your AI assistant can do this"
   (only while the Commerce MCP is reachable), "Vitanaland is checking"; it also lists `in_progress` steps.
6. A checklist without `owner` renders as today's single list. No new field, step, dialog or button for the supplier.
7. Every new string in all 11 locales; plain business words only.
8. No migration, no new route, no write; staging tests read-only.
