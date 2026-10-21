# D- User Rewards strategy (session_01CJy9EepPdwUcjKtuUdb2sm)
- Created 2026-10-01, updated 2026-10-10T14:46 (idle). Branch claude/blissful-edison-sipsjl. (Earlier history before 10-10 not read; goal inferred.)
## Goal
Build the member rewards experience: "Mehr verdienen" tab in Wallet > Belohnungen and an admin Rewards Shop manager (photos, VTNA prices, shipping fees/countries).
## Done (live in production as of 2026-10-10)
- VTID-05037 "Mehr verdienen" (Wallet > Belohnungen: tabs Verdient / Mehr verdienen / Shop, "Dein naechstes Ziel").
- VTID-05036 Admin > Marketplace > Praemien-Shop verwalten (/admin/marketplace/rewards), frontend.
- VTID-05035 shop admin endpoints (commit 9c31d29, in prod via 66ac661; migration 20261010160000_vtid_05035_reward_shop_images_bucket).
- App prod = vitana-v1 4121088 (run 38058892877, success). Gateway prod went to 66ac661 (my own gateway run 38058890875 was cancelled by concurrent deploys; 66ac661 contains 05035). REWARD_SWEEP_ENABLED=true confirmed.
- All three VTIDs closed in ledger. PR numbers not seen.
## State now
- No open work seen. Commit 2cbecae (VTID-05043 migrations, other session) was NOT in prod at that time; its 3 migrations not confirmed applied.
## Blocked on / needs owner
- Owner: fill the shop (Admin > Marketplace > Praemien-Shop verwalten): items are saved switched off; add shipping fee per country; then switch items on.
## Next steps for Kiro
1. Nothing pending for this scope. Optional: a staging test that renders the admin screen is not possible (staging safety guard blocks /admin role lookup); covered by unit tests/screenshots only.
2. Any further rewards work needs a new sparred plan and VTID; prod publish = Claude Code / owner.
## Gotchas
- Gate 2 approval covered a range of 13 app and 29 gateway commits from other sessions; pinned promote can be cancelled by concurrent prod deploys.
- Do not test writes on prod; admin screen verification limited on staging.
