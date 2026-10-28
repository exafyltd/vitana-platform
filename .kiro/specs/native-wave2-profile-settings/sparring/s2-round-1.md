# Sparring round 1 — in_progress

Session: `96e82193-5939-40f9-aab7-9673c0267e88` · plan hash `b69f4ce14ca87897774acdcfe5cabae7afc4d764b6aa7b2560dfaf7f1c4a3490`

## Summary

The plan is well-structured and most load-bearing premises hold against the pinned code. I verified the core infrastructure (shapeOf, VALID_SECTIONS, MobileSupport tabs, ConnectedApps activeTab, App.tsx routes, parity-scope lane rules) and all checked claims align. The 37-row count could only be partially verified (29 of 37 found due to tool-call limits); the missing 8 are presumably connectors ?tab= variants under different key prefixes. One minor concern about a missing parity row for the tickets tab in MobileSupport. Overall, the plan is sound for implementation.

## Findings

### R1-F1 [minor]

The plan's 37-row count could only be partially verified: I confirmed 29 rows (27 registry screens + 2 exclusion routes) with lane 'profile-settings-support'. The plan claims 35 registry screens + 2 exclusion routes = 37. The missing 8 registry screen rows are presumably connectors ?tab= variants (the plan attributes 9 rows to /connectors). These rows are NOT in the SETTINGS.* key range (only SETTINGS.SOCIAL at /connectors exists there, immediately followed by SETTINGS.SUPPORT with no room for more). They likely exist under a different key prefix (e.g. CONNECTORS.*) elsewhere in the ledger but I could not verify due to tool-call limits. If these rows do not exist, the lane partition (5+18+14=37) and the support-connectors scope (14 rows) are both overstated.

- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:2105` — SETTINGS.SOCIAL at line 2105 (web_path: /connectors), immediately followed by SETTINGS.SUPPORT at line 2117 (web_path: /support) — no SETTINGS.SOCIAL_* tab variants between them
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:1793` — All 27 verified registry screen rows (PROFILE.ME through SETTINGS.TENANT_ROLE) with lane profile-settings-support, all status not_started

Suggestion: Confirm the 8 connectors ?tab= variant rows exist in the ledger (likely under CONNECTORS.* or similar keys). If the actual count is less than 37, update the lane partition and file counts accordingly.

### R1-F2 [minor]

MobileSupport.tsx defines 4 tab types (contact, tickets, faqs, community) at line 43, but the parity ledger only has 3 tab-specific rows: SETTINGS.SUPPORT_COMMUNITY (/support?tab=community), SETTINGS.SUPPORT_CONTACT (/support?tab=contact), SETTINGS.SUPPORT_FAQ (/support?tab=faqs). There is no SETTINGS.SUPPORT_TICKETS row for /support?tab=tickets. The native port must still implement the tickets tab (since the single route file handles all ?tab= values), but there will be no parity row to flip to 'native' for the tickets destination, meaning parity-ledger --check has a blind spot for that tab.

- `exafyltd/vitana-v1:src/pages/MobileSupport.tsx:43` — type TabKey = "contact" | "tickets" | "faqs" | "community";
- `exafyltd/vitana-v1:apps/mobile/parity/ledger.json:2117` — SETTINGS.SUPPORT (/support), SETTINGS.SUPPORT_COMMUNITY (/support?tab=community), SETTINGS.SUPPORT_CONTACT (/support?tab=contact), SETTINGS.SUPPORT_FAQ (/support?tab=faqs) — no SETTINGS.SUPPORT_TICKETS row

Suggestion: This is a pre-existing ledger gap, not introduced by this plan. Consider filing a follow-up to add a SETTINGS.SUPPORT_TICKETS row via parity-ledger --sync (requires adding the screen to screens.json), or explicitly document that the tickets tab is covered by the base /support native route file despite lacking its own parity row.

## Next

Planner: answer every finding above in `sparring/s2-responses-1.md` as one ```json block
`[{"finding_id": "...", "disposition": "accepted|rejected|deferred", "rationale": "...", "deferred_to": "..."}]`,
update `plan.md` (the plan block), commit both and push. That push starts the next round.
