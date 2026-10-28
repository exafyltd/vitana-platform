# Voice Tools Catalog — Expansion Plan v2 (425 new tools)

**Status: APPROVED 2026-07-12 — catalog seeded as `planned` in `tool-manifest.json`; implementation in 6 waves.**
Prepared 2026-07-12 · Based on full codebase analysis of `vitana-platform` (gateway routes, Command Hub, orb-tools registry) and `vitana-v1` (551+ screens, App.tsx routes, hooks).

## Approved decisions (owner review, 2026-07-12)

1. **Scope: keep all 425 tools** (150 community / 125 admin / 150 developer).
2. **Payment policy:** voice may *complete* only **internal user-to-user credit transfers** (`send_funds`, after 2-step confirm). Every card/Stripe charge (`start_checkout`, `buy_event_ticket`, `purchase_room_access`, `upgrade_subscription`, `add_voice_minutes`) is voice-*initiated* but hands off to the screen for final payment confirmation.
3. **`dev_publish_to_prod` is IN Wave 2**, with double-confirm + spoken reason recorded to OASIS.
4. **No Professional/Staff catalog** — out of scope, not planned.

This document is the source of truth the seed script (`scripts/voice-tools-plan-seed.mjs`) parses to generate the 425 `status: planned` manifest entries.

---

## 1. Where we are today (169 live tools)

| Role | Tools today | Coverage quality |
|---|---|---|
| Community | ~148 | Good on calendar, reminders, chat, intents, memory, health logging basics, groups/social basics. **Near-zero** on commerce, wallet actions, business hub, live rooms, tickets, subscriptions, campaigns, goals, content creation depth. |
| Admin | 9 | Insights/KPI readouts only. No user management, moderation, broadcast, marketplace, KB, governance, tenant ops. |
| Developer | 12 | Read-mostly (VTIDs, approvals, agents, routines). No deploy, CI/CD, governance, autopilot control, self-healing actions, testing, migrations. |

## 2. Proposed split (this plan)

| Role | New tools | New total |
|---|---|---|
| Community | **+150** | ~298 |
| Admin | **+125** | ~134 |
| Developer | **+150** | ~162 |
| **Total** | **+425** | **~594** |

*(You asked for ~350 split as 150 / 100–150 / 150 — the split itself sums to 400–450; this plan lands at 425. Easy to trim: each domain table below is independently cuttable.)*

## 3. Build principles (same architecture as the 169)

1. **One registry, two pipelines.** Every handler goes into `ORB_TOOL_REGISTRY` (`orb-tools-shared.ts`) → Vertex picks it up via the generic dispatch fallback in `orb-live.ts`; LiveKit gets a `@function_tool` wrapper in `tools.py`. Both wired from day one (no more Vertex-only stragglers).
2. **Role gating at the dispatcher.** Community tools: default. Admin tools: `admin | exafy_admin` via the resolved effective role. Developer tools: existing `developerGate()` (`developer | admin | exafy_admin`).
3. **Two-step confirm for every mutating/risky verb** (marked ⚠️ below) — same pattern as `dev_approve_pr`: first call returns a summary + confirmation token, second call with the token executes. Mandatory for: payments, purchases, deploys, publishes, merges, deletes, broadcasts, kill-switches, role grants.
4. **Backed by existing endpoints only.** Every tool below maps to a route/service that already exists (verified in this analysis). No new backend features are invented — voice tools are a thin dispatch layer.
5. **Manifest-first.** All 425 land in `tool-manifest.json` as `status: planned` when this plan is approved; flip to `live` per wave. The reconcile scanner + parity gate CI keep the catalog honest.
6. **i18n**: all user-facing response strings via the `tt()` catalog (DE/EN/ES/SR), per CLAUDE.md hard rule.

Priorities: **P0** = urgent, ships first (daily-use or unblocks role's core job) · **P1** = second wave · **P2** = completeness.

---

# PART A — COMMUNITY (+150)

The biggest gaps are the **money and creation surfaces**: users can talk to Vitana about their health, but can't buy, sell, pay, host, or publish by voice.

## A1. Commerce & Marketplace Discovery (16) — P0
Backed by `useMarketplace`, `useShopFeed`, `useShoppingAgent`, `useOrderManagement`, discover routes.

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `search_marketplace` | Search products with filters (scope, category, price) | R |
| 2 | `get_product_details` | Read out one product (price, rating, description) | R |
| 3 | `browse_supplements` | Supplements catalog | R |
| 4 | `add_supplement_to_regimen` | Add supplement to personal regimen | W |
| 5 | `list_my_supplements` | Current regimen | R |
| 6 | `remove_supplement_from_regimen` | Remove from regimen | W |
| 7 | `browse_wellness_services` | Wellness services directory | R |
| 8 | `get_provider_profile` | Provider/practitioner detail | R |
| 9 | `browse_doctors_coaches` | Doctors & coaches directory | R |
| 10 | `get_coach_compatibility` | Compatibility score with a coach | R |
| 11 | `browse_deals_offers` | Current deals & offers | R |
| 12 | `apply_discount_code` | Apply promo code | W |
| 13 | `get_ai_product_picks` | Shopping-agent recommendations | R |
| 14 | `list_my_orders` | Order history | R |
| 15 | `get_order_status` | Track one order | R |
| 16 | `reorder_last_order` ⚠️ | Repeat a previous order | W |

## A2. Cart & Checkout (8) — P0
Backed by `useCart`, `useUniversalCart`, `useStripePayment`, BudgetMeter.

| # | Tool | Does | R/W |
|---|---|---|---|
| 17 | `add_to_cart` | Add product to universal cart | W |
| 18 | `view_cart` | Read cart contents + total | R |
| 19 | `update_cart_item` | Change quantity | W |
| 20 | `remove_from_cart` | Remove item | W |
| 21 | `clear_cart` ⚠️ | Empty the cart | W |
| 22 | `set_shopping_budget` | Set/track budget meter | W |
| 23 | `review_agent_purchase_proposals` | Read pending AI purchase proposals | R |
| 24 | `start_checkout` ⚠️ | Begin Stripe checkout (hands off to screen for payment) | W |

## A3. Wallet & Payments (11) — P0
Backed by `useWallet`, `useWalletGateway`, send/request/exchange popups. Complements existing `get_wallet_balance`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 25 | `get_wallet_summary` | Balance + lifetime earnings + pending rewards + benefits | R |
| 26 | `list_wallet_transactions` | Recent transactions | R |
| 27 | `send_funds` ⚠️ | Transfer credits to a member (resolve recipient → confirm) | W |
| 28 | `request_payment` | Send a payment request | W |
| 29 | `exchange_currency` ⚠️ | Exchange between currencies/credits | W |
| 30 | `get_exchange_rate` | Current EUR/USD/token rate | R |
| 31 | `set_display_currency` | Toggle display currency | W |
| 32 | `get_referral_earnings` | Referral earnings snapshot | R |
| 33 | `get_commissions_summary` | Commissions this month | R |
| 34 | `get_pending_rewards` | Pending rewards | R |
| 35 | `list_payment_requests` | Incoming/outgoing requests | R |

## A4. Subscriptions & Billing (7) — P1
Backed by `useBilling`, `useMemberships`, billing routes.

| # | Tool | Does | R/W |
|---|---|---|---|
| 36 | `get_my_subscription` | Current plan, renewal date, minutes left | R |
| 37 | `compare_subscription_plans` | Plans + prices readout | R |
| 38 | `upgrade_subscription` ⚠️ | Upgrade plan | W |
| 39 | `cancel_subscription` ⚠️ | Cancel plan | W |
| 40 | `add_voice_minutes` ⚠️ | Buy extra minutes | W |
| 41 | `redeem_subscription_code` | Redeem sub code | W |
| 42 | `get_billing_history` | Invoices/preview | R |

## A5. Vouchers & Referrals (6) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 43 | `redeem_voucher` | Redeem gift/voucher code | W |
| 44 | `send_gift_voucher` ⚠️ | Gift a voucher to someone | W |
| 45 | `get_referral_link` | Read/share referral link | R |
| 46 | `invite_friend` ⚠️ | Send an invite | W |
| 47 | `get_referral_status` | Who joined via my link | R |
| 48 | `activate_reseller` ⚠️ | Activate reseller status | W |

## A6. Business Hub — seller/creator side (14) — P0
Backed by `useBusinessPackages`, `useCreator`, BusinessHub tabs. This is the "responsibility to execute work" surface for earning members.

| # | Tool | Does | R/W |
|---|---|---|---|
| 49 | `list_my_services` | My service listings | R |
| 50 | `create_service` ⚠️ | Create a service listing | W |
| 51 | `update_service` | Edit price/description/availability | W |
| 52 | `archive_service` ⚠️ | Take a service offline | W |
| 53 | `list_my_packages` | My packages | R |
| 54 | `create_package` ⚠️ | Create package/bundle | W |
| 55 | `list_my_clients` | Client list | R |
| 56 | `get_client_overview` | One client's history | R |
| 57 | `list_business_orders` | Incoming orders | R |
| 58 | `get_business_order_detail` | One order | R |
| 59 | `get_business_kpis` | Revenue/booking KPIs | R |
| 60 | `get_earnings_breakdown` | Earnings by source + ledger | R |
| 61 | `list_business_opportunities` | Missions/opportunities | R |
| 62 | `get_reseller_payouts` | Reseller sales & payouts | R |

## A7. Live Rooms / Go Live (9) — P1
Backed by `useLiveRoom*`, `useDailyRoom`, GoLivePopup, stream lifecycle hooks.

| # | Tool | Does | R/W |
|---|---|---|---|
| 63 | `list_live_rooms_now` | What's live right now | R |
| 64 | `get_live_room_details` | Room info, host, access price | R |
| 65 | `go_live` ⚠️ | Start hosting (opens room) | W |
| 66 | `create_live_room` ⚠️ | Create a room | W |
| 67 | `schedule_live_session` | Schedule future session | W |
| 68 | `purchase_room_access` ⚠️ | Buy access to a paid room | W |
| 69 | `extend_live_session` | Extend timer | W |
| 70 | `end_live_session` ⚠️ | End my stream | W |
| 71 | `play_room_recording` | Watch a past recording | R |

## A8. Messaging depth (9) — P0
Extends existing chat suite. Backed by `useHybridMessages`, `useMessageReactions`, `useWebRTC`, group chat pages.

| # | Tool | Does | R/W |
|---|---|---|---|
| 72 | `send_group_chat_message` | Message a group thread | W |
| 73 | `reply_to_message` | Quote-reply to a specific message | W |
| 74 | `react_to_message` | Emoji-react | W |
| 75 | `create_group_chat` | New group conversation | W |
| 76 | `add_group_chat_member` | Add member to group chat | W |
| 77 | `leave_group_chat` ⚠️ | Leave a group thread | W |
| 78 | `send_calendar_invite_in_chat` | Share a calendar invite in a DM | W |
| 79 | `start_voice_call` ⚠️ | Call a member (WebRTC) | W |
| 80 | `start_video_call` ⚠️ | Video-call a member | W |

## A9. Feed, Content, Shorts, Asks & Challenges (11) — P1
Extends existing post tools. Backed by feed/shorts/open-asks hooks.

| # | Tool | Does | R/W |
|---|---|---|---|
| 81 | `share_post` | Share/repost content | W |
| 82 | `bookmark_post` | Save content | W |
| 83 | `list_my_bookmarks` | Read saved items | R |
| 84 | `edit_my_post` | Edit own post | W |
| 85 | `delete_my_post` ⚠️ | Delete own post | W |
| 86 | `comment_on_short` | Comment on a short video | W |
| 87 | `post_open_ask` | Publish an Open Ask | W |
| 88 | `answer_open_ask` | Answer someone's ask | W |
| 89 | `list_open_asks` | Browse open asks | R |
| 90 | `join_challenge` | Join a community challenge | W |
| 91 | `get_challenge_progress` | My challenge standing | R |

## A10. Events & Tickets (10) — P0
Extends existing RSVP tools with the creation + ticketing side.

| # | Tool | Does | R/W |
|---|---|---|---|
| 92 | `create_event` ⚠️ | Create a community event | W |
| 93 | `update_my_event` | Edit my event | W |
| 94 | `cancel_my_event` ⚠️ | Cancel my event | W |
| 95 | `create_meetup` ⚠️ | Create a meetup | W |
| 96 | `update_my_meetup` | Edit my meetup | W |
| 97 | `invite_to_event` | Invite contacts/members | W |
| 98 | `buy_event_ticket` ⚠️ | Purchase a ticket | W |
| 99 | `list_my_event_tickets` | My event tickets | R |
| 100 | `share_event` | Share event link | W |
| 101 | `get_event_attendees` | Who's coming (organizer view) | R |

## A11. Health depth (15) — P0
Extends the 4 existing loggers + Index tools. Backed by `useHealthLogger`, `useHealthPlans`, `useVitanaIndex*`, lab/biomarker components.

| # | Tool | Does | R/W |
|---|---|---|---|
| 102 | `log_meal` | Log nutrition/meal | W |
| 103 | `log_vitals` | Log BP/HR/weight etc. | W |
| 104 | `log_mood` | Log mental-health check-in | W |
| 105 | `log_biomarker` | Record a lab value | W |
| 106 | `get_health_trends` | Trends across trackers | R |
| 107 | `get_health_streaks` | Vitana streaks | R |
| 108 | `order_lab_test` ⚠️ | Order a lab test | W |
| 109 | `get_lab_results` | Read biomarker/lab results | R |
| 110 | `generate_health_plan` ⚠️ | Run plan-generator wizard | W |
| 111 | `list_my_health_plans` | Active plans | R |
| 112 | `get_health_plan_progress` | Plan adherence | R |
| 113 | `list_my_conditions` | Conditions & risks | R |
| 114 | `get_health_education` | Education resources on a topic | R |
| 115 | `get_next_best_action` | Today's next best health action | R |
| 116 | `connect_health_device` ⚠️ | Start device pairing (navigates) | W |

## A12. Goals & Journey (6) — P1
Backed by `useGoalPlan`, `useMyJourney`, `useDailyPriority`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 117 | `set_goal` | Set a goal / north star | W |
| 118 | `list_my_goals` | Active goals | R |
| 119 | `update_goal` | Adjust a goal | W |
| 120 | `get_goal_progress` | Progress readout | R |
| 121 | `get_journey_checkpoints` | Journey checkpoints | R |
| 122 | `get_daily_priority` | Today's priority | R |

## A13. Memory & Diary extras (7) — P2
Extends existing 6 memory + 3 diary tools.

| # | Tool | Does | R/W |
|---|---|---|---|
| 123 | `edit_memory` | Correct a stored memory | W |
| 124 | `archive_memory` | Archive (soft-hide) memory | W |
| 125 | `reinforce_memory` | Mark memory as important | W |
| 126 | `promote_memory_to_knowledge` | Promote to knowledge base | W |
| 127 | `set_memory_permissions` | Memory privacy controls | W |
| 128 | `get_what_vitana_knows` | "What do you know about me" summary | R |
| 129 | `add_diary_photo` | Attach photo to diary (navigates to picker) | W |

## A14. Profile & Social depth (8) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 130 | `set_profile_theme` | Change profile theme | W |
| 131 | `get_profile_completeness` | Completeness % + missing items | R |
| 132 | `add_gallery_photo` | Add to gallery (navigates to picker) | W |
| 133 | `share_my_profile` | Share profile link/QR | R |
| 134 | `get_my_milestones` | Achievements & milestones | R |
| 135 | `view_member_profile` | Spoken summary of a member | R |
| 136 | `list_member_posts` | A member's recent posts | R |
| 137 | `update_service_offerings` | Edit services shown on profile | W |

## A15. Contacts, Campaigns & Social Sharing (10) — P1
Backed by `useContacts`, `useCampaigns`, `useScheduledPosts`, `useSocialPlatforms`. The growth engine.

| # | Tool | Does | R/W |
|---|---|---|---|
| 138 | `list_contacts` | My contacts | R |
| 139 | `add_contact` | Add a contact | W |
| 140 | `sync_contacts` ⚠️ | Trigger contact import/sync | W |
| 141 | `create_campaign` ⚠️ | Create sharing campaign | W |
| 142 | `activate_campaign` ⚠️ | Activate a campaign | W |
| 143 | `get_campaign_stats` | Campaign performance | R |
| 144 | `schedule_social_post` ⚠️ | Schedule post to socials | W |
| 145 | `list_scheduled_posts` | Scheduled queue | R |
| 146 | `cancel_scheduled_post` | Remove from queue | W |
| 147 | `share_to_social` ⚠️ | Share now to connected platform | W |

## A16. Notifications & Settings depth (3) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 148 | `set_notification_preferences` | Per-category notif prefs | W |
| 149 | `enable_do_not_disturb` | DND / quiet hours | W |
| 150 | `connect_google_account` ⚠️ | Start Google connect flow | W |

**Community total: 150** · P0: 69 · P1: 49 · P2: 32

---

# PART B — ADMIN (+125)

Today an admin can only *hear about* insights/KPIs. This catalog makes the whole Command Hub admin surface voice-operable: users, moderation, marketplace, broadcast, governance. All tools `admin_` prefixed, gated `admin | exafy_admin`, tenant-scoped. Every endpoint below already exists in `routes/tenant-admin/*` and `routes/admin-*.ts`.

## B1. Users & RBAC (8) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `admin_lookup_user` | Find user by name/email/vitana_id | R |
| 2 | `admin_list_users` | List/filter users | R |
| 3 | `admin_get_user_detail` | Full user record | R |
| 4 | `admin_roles_summary` | Role distribution | R |
| 5 | `admin_grant_role` ⚠️ | Grant a role | W |
| 6 | `admin_revoke_role` ⚠️ | Revoke a role | W |
| 7 | `admin_set_trust_tier` ⚠️ | Change trust tier | W |
| 8 | `admin_get_at_risk_members` | At-risk members (overview) | R |

## B2. Tenants & Settings (7) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 9 | `admin_list_tenants` | Tenants list | R |
| 10 | `admin_get_tenant` | Tenant detail | R |
| 11 | `admin_update_tenant_profile` ⚠️ | Edit tenant profile | W |
| 12 | `admin_get_feature_flags` | Read flags | R |
| 13 | `admin_set_feature_flag` ⚠️ | Flip a flag | W |
| 14 | `admin_update_branding` ⚠️ | Branding settings | W |
| 15 | `admin_list_tenant_integrations` | Integrations status | R |

## B3. Signups & Invitations (7) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 16 | `admin_list_signups` | Recent signups | R |
| 17 | `admin_get_signup_stats` | Signup funnel stats | R |
| 18 | `admin_list_signup_attempts` | Failed/pending attempts | R |
| 19 | `admin_repair_signup` ⚠️ | Repair a broken signup | W |
| 20 | `admin_create_invitation` ⚠️ | Invite someone | W |
| 21 | `admin_list_invitations` | Open invitations | R |
| 22 | `admin_revoke_invitation` ⚠️ | Revoke invitation | W |

## B4. Content Moderation (8) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 23 | `admin_list_moderation_queue` | Pending items | R |
| 24 | `admin_get_moderation_item` | One item detail | R |
| 25 | `admin_moderation_stats` | Queue stats | R |
| 26 | `admin_approve_content` ⚠️ | Approve item | W |
| 27 | `admin_reject_content` ⚠️ | Reject/remove item | W |
| 28 | `admin_flag_content` | Flag for review | W |
| 29 | `admin_list_reports` | User reports | R |
| 30 | `admin_get_report` | One report | R |

## B5. Community Oversight (8) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 31 | `admin_list_meetups` | All meetups | R |
| 32 | `admin_delete_meetup` ⚠️ | Remove a meetup | W |
| 33 | `admin_list_groups` | All groups | R |
| 34 | `admin_list_live_rooms` | All live rooms (supervision) | R |
| 35 | `admin_list_creators` | Creators list | R |
| 36 | `admin_list_memberships` | Memberships | R |
| 37 | `admin_community_stats` | Community-wide stats | R |
| 38 | `admin_activity_feed` | Tenant activity feed + alerts | R |

## B6. Marketplace Admin (12) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 39 | `admin_marketplace_overview` | Marketplace KPIs | R |
| 40 | `admin_list_merchants` | Merchants | R |
| 41 | `admin_update_merchant` ⚠️ | Edit merchant status | W |
| 42 | `admin_list_products` | Products (admin view) | R |
| 43 | `admin_update_product` ⚠️ | Edit/approve product | W |
| 44 | `admin_bulk_product_action` ⚠️ | Bulk enable/disable | W |
| 45 | `admin_get_feed_curation` | Curation rules | R |
| 46 | `admin_update_feed_curation` ⚠️ | Change curation | W |
| 47 | `admin_list_geo_policies` | Geo policies | R |
| 48 | `admin_update_geo_policy` ⚠️ | Edit geo policy | W |
| 49 | `admin_trigger_source_sync` ⚠️ | Sync a product network | W |
| 50 | `admin_get_ingestion_coverage` | Ingestion runs & coverage | R |

## B7. Billing & Wallet Admin (6) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 51 | `admin_credit_wallet` ⚠️ | Credit a user's wallet | W |
| 52 | `admin_debit_wallet` ⚠️ | Debit adjustment | W |
| 53 | `admin_get_founding_status` | Founding-member status | R |
| 54 | `admin_get_monetization_config` | Monetization config | R |
| 55 | `admin_update_monetization_config` ⚠️ | Update config | W |
| 56 | `admin_run_monetization_detect` | Run detection | W |

## B8. Knowledge Base Admin (8) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 57 | `admin_kb_search` | Search tenant KB | R |
| 58 | `admin_kb_list_docs` | List docs | R |
| 59 | `admin_kb_create_doc` ⚠️ | Create doc | W |
| 60 | `admin_kb_update_doc` ⚠️ | Update doc | W |
| 61 | `admin_kb_delete_doc` ⚠️ | Delete doc | W |
| 62 | `admin_kb_reindex` ⚠️ | Reindex KB | W |
| 63 | `admin_kb_baseline_optout` ⚠️ | Opt out of a baseline doc | W |
| 64 | `admin_system_kb_update` ⚠️ | Update system KB doc (exafy_admin) | W |

## B9. Assistant & Voice Config (7) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 65 | `admin_get_assistant_config` | Config per surface | R |
| 66 | `admin_set_assistant_config` ⚠️ | Update config | W |
| 67 | `admin_list_assistant_speeches` | Canned speeches | R |
| 68 | `admin_set_assistant_speech` ⚠️ | Edit a speech | W |
| 69 | `admin_get_awareness_config` | Awareness registry | R |
| 70 | `admin_set_awareness_config` ⚠️ | Set awareness signal config | W |
| 71 | `admin_bulk_set_awareness` ⚠️ | Bulk update | W |

## B10. Specialists / Personas (10) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 72 | `admin_list_specialists` | Personas | R |
| 73 | `admin_get_specialist` | One persona + versions | R |
| 74 | `admin_create_specialist` ⚠️ | New persona | W |
| 75 | `admin_update_specialist` ⚠️ | Edit persona | W |
| 76 | `admin_rollback_specialist` ⚠️ | Roll back version | W |
| 77 | `admin_set_specialist_tools` ⚠️ | Bind tools | W |
| 78 | `admin_set_specialist_kb` ⚠️ | Bind KB | W |
| 79 | `admin_set_specialist_status` ⚠️ | Enable/disable | W |
| 80 | `admin_test_specialist_connection` | Test connection | R |
| 81 | `admin_approve_specialist_ticket` ⚠️ | Approve lifecycle ticket | W |

## B11. Notifications & Broadcast (7) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 82 | `admin_compose_broadcast` | Draft a broadcast (returns preview) | W |
| 83 | `admin_send_broadcast` ⚠️ | Send to audience | W |
| 84 | `admin_list_broadcasts` | Sent history | R |
| 85 | `admin_notification_pref_stats` | Opt-in/out stats | R |
| 86 | `admin_create_notification_category` ⚠️ | New category | W |
| 87 | `admin_update_notification_category` ⚠️ | Edit category | W |
| 88 | `admin_test_notification_category` | Send test | W |

## B12. Governance & Controls (8) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 89 | `admin_governance_status` | Governance status | R |
| 90 | `admin_list_governance_rules` | Rules | R |
| 91 | `admin_list_violations` | Violations feed | R |
| 92 | `admin_list_proposals` | Proposals | R |
| 93 | `admin_create_proposal` ⚠️ | New proposal | W |
| 94 | `admin_update_proposal_status` ⚠️ | Approve/reject proposal | W |
| 95 | `admin_get_control_key` | Read a control (kill switches) | R |
| 96 | `admin_set_control_key` ⚠️ | Flip a control key | W |

## B13. Autopilot Admin (8) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 97 | `admin_get_autopilot_settings` | Settings | R |
| 98 | `admin_update_autopilot_settings` ⚠️ | Patch settings | W |
| 99 | `admin_list_autopilot_bindings` | Bindings | R |
| 100 | `admin_create_autopilot_binding` ⚠️ | New binding | W |
| 101 | `admin_delete_autopilot_binding` ⚠️ | Remove binding | W |
| 102 | `admin_list_autopilot_runs` | Runs | R |
| 103 | `admin_autopilot_run_stats` | Run stats | R |
| 104 | `admin_update_autopilot_wave` ⚠️ | Edit wave | W |

## B14. Analytics & Intent Engine (10) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 105 | `admin_analytics_summary` | Product analytics summary | R |
| 106 | `admin_assistant_analytics` | Assistant usage | R |
| 107 | `admin_journey_analytics` | Journeys | R |
| 108 | `admin_feature_analytics` | Feature usage | R |
| 109 | `admin_interest_analytics` | Interests | R |
| 110 | `admin_intent_engine_stats` | Intent/match KPIs | R |
| 111 | `admin_close_intent` ⚠️ | Force-close an intent | W |
| 112 | `admin_recompute_intent` ⚠️ | Recompute matches | W |
| 113 | `admin_resolve_dispute` ⚠️ | Resolve match dispute | W |
| 114 | `admin_archive_intent` ⚠️ | Archive intent | W |

## B15. Feedback & Support Admin (5) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 115 | `admin_list_feedback_tickets` | Support tickets | R |
| 116 | `admin_get_feedback_ticket` | One ticket | R |
| 117 | `admin_feedback_kpis` | Support KPIs | R |
| 118 | `admin_list_handoffs` | Recent handoffs | R |
| 119 | `admin_act_on_ticket` ⚠️ | Resolve/assign/respond | W |

## B16. Audit, i18n & Memory Ops (6) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 120 | `admin_audit_actions_log` | Admin actions audit | R |
| 121 | `admin_audit_access_log` | Access audit | R |
| 122 | `admin_i18n_translate` ⚠️ | Run translation job | W |
| 123 | `admin_i18n_audit` ⚠️ | Run LLM locale audit | W |
| 124 | `admin_run_memory_consolidator` ⚠️ | Run memory consolidation | W |
| 125 | `admin_run_embeddings_backfill` ⚠️ | Run embeddings backfill | W |

**Admin total: 125** · P0: 37 · P1: 55 · P2: 33

---

# PART C — DEVELOPER (+150)

Goal: a developer can run the platform's whole operational loop by voice — VTID lifecycle, governance, PRs, deploys, autopilot, healing, tests, migrations — with hard confirms on anything that mutates prod. All `dev_` prefixed, gated by `developerGate()`. Every endpoint verified to exist (routes listed per domain).

## C1. VTID / OASIS Lifecycle (15) — P0
`routes/vtid.ts`, `oasis-tasks.ts`, `execute.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `dev_allocate_vtid` ⚠️ | Allocate a new VTID | W |
| 2 | `dev_create_task` ⚠️ | Create OASIS task | W |
| 3 | `dev_update_task` ⚠️ | Patch task fields | W |
| 4 | `dev_cancel_task` ⚠️ | Cancel task | W |
| 5 | `dev_complete_task` ⚠️ | Mark complete | W |
| 6 | `dev_terminalize_vtid` ⚠️ | Set is_terminal + outcome | W |
| 7 | `dev_discover_tasks` | Discover eligible tasks | R |
| 8 | `dev_get_vtid_projection` | VTID projection | R |
| 9 | `dev_get_allocator_status` | Allocator on/off + health | R |
| 10 | `dev_query_oasis_events` | Query events by vtid/type/time | R |
| 11 | `dev_execute_vtid` ⚠️ | Trigger execution | W |
| 12 | `dev_run_exec_workflow` ⚠️ | Run a workflow | W |
| 13 | `dev_submit_evidence` | Submit evidence for a VTID | W |
| 14 | `dev_list_work_orders` | Work orders | R |
| 15 | `dev_get_work_order` | One work order | R |

## C2. Governance (13) — P0
`routes/governance.ts`, `governance-controls.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 16 | `dev_evaluate_governance` | Evaluate action against rules | R |
| 17 | `dev_governance_status` | Status snapshot | R |
| 18 | `dev_list_governance_rules` | Rules | R |
| 19 | `dev_get_governance_rule` | One rule by code | R |
| 20 | `dev_list_violations` | Violations | R |
| 21 | `dev_list_enforcements` | Enforcements | R |
| 22 | `dev_governance_feed` | Live feed | R |
| 23 | `dev_list_proposals` | Proposals | R |
| 24 | `dev_create_proposal` ⚠️ | New proposal | W |
| 25 | `dev_update_proposal` ⚠️ | Update status | W |
| 26 | `dev_get_control` | Read control key (EXECUTION_DISARMED etc.) | R |
| 27 | `dev_set_control` ⚠️ | Flip control key | W |
| 28 | `dev_get_control_history` | Key history | R |

## C3. CI/CD & Pull Requests (14) — P0
`routes/cicd.ts`, `services/github-service.ts`, `approvals.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 29 | `dev_create_pr` ⚠️ | Create PR from branch | W |
| 30 | `dev_get_pr_status` | PR state + mergeability | R |
| 31 | `dev_get_pr_checks` | Check runs for a PR | R |
| 32 | `dev_list_open_prs` | Open PRs w/ status | R |
| 33 | `dev_merge_pr` ⚠️ | Merge via governed pipeline | W |
| 34 | `dev_safe_merge` ⚠️ | Safe-merge flow | W |
| 35 | `dev_revert_pr` ⚠️ | Create revert PR | W |
| 36 | `dev_trigger_workflow` ⚠️ | Dispatch a GH workflow | W |
| 37 | `dev_list_workflow_runs` | Runs for a workflow | R |
| 38 | `dev_get_run_jobs` | Jobs + failures for a run | R |
| 39 | `dev_get_merge_lock` | Merge lock status | R |
| 40 | `dev_release_merge_lock` ⚠️ | Release stuck lock | W |
| 41 | `dev_cicd_health` | CI/CD pipeline health | R |
| 42 | `dev_approvals_feed` | Approvals activity feed | R |

## C4. Deployment & Release (13) — P0
`routes/operator.ts` (PUBLISH lives here), `canary-target.ts`, staging-first model.

| # | Tool | Does | R/W |
|---|---|---|---|
| 43 | `dev_deploy_service` ⚠️ | Deploy a service (staging path) | W |
| 44 | `dev_publish_to_prod` ⚠️⚠️ | The PUBLISH button by voice (double confirm + reason) | W |
| 45 | `dev_list_revisions` | Cloud Run revisions | R |
| 46 | `dev_list_deployments` | Deployment history | R |
| 47 | `dev_deployment_health` | Deploy health | R |
| 48 | `dev_promote_canary` ⚠️ | Promote canary | W |
| 49 | `dev_abort_canary` ⚠️ | Abort canary | W |
| 50 | `dev_revert_deploy` ⚠️ | Revert gateway | W |
| 51 | `dev_revert_both` ⚠️ | Revert gateway + frontend | W |
| 52 | `dev_canary_status` | Canary target status | R |
| 53 | `dev_staging_status` | What's on staging (env, build) | R |
| 54 | `dev_compare_staging_prod` | Diff staging vs prod builds | R |
| 55 | `dev_release_feed` | Recent releases | R |

## C5. Worker Orchestrator (10) — P1
`routes/worker-orchestrator.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 56 | `dev_list_workers` | Registered workers | R |
| 57 | `dev_orchestrator_stats` | Stats | R |
| 58 | `dev_list_pending_worker_tasks` | Pending queue | R |
| 59 | `dev_get_task_progress` | Progress of claimed task | R |
| 60 | `dev_release_claim` ⚠️ | Release a stuck claim | W |
| 61 | `dev_list_subagents` | Subagents | R |
| 62 | `dev_list_worker_skills` | Skills | R |
| 63 | `dev_cleanup_stale_claims` ⚠️ | Cleanup stale claims | W |
| 64 | `dev_orchestrator_health` | Health | R |
| 65 | `dev_route_to_subagent` ⚠️ | Route task to subagent | W |

## C6. Autopilot Controller & Loop (15) — P1
`routes/autopilot.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 66 | `dev_autopilot_loop_status` | Loop status | R |
| 67 | `dev_start_autopilot_loop` ⚠️ | Start loop | W |
| 68 | `dev_stop_autopilot_loop` ⚠️ | Stop loop | W |
| 69 | `dev_autopilot_loop_history` | Loop history | R |
| 70 | `dev_reset_loop_cursor` ⚠️ | Reset cursor | W |
| 71 | `dev_controller_status` | Controller status | R |
| 72 | `dev_list_controller_runs` | Runs | R |
| 73 | `dev_get_controller_run` | One run | R |
| 74 | `dev_plan_task` ⚠️ | Plan a VTID | W |
| 75 | `dev_start_task_work` ⚠️ | Start work | W |
| 76 | `dev_complete_task_work` ⚠️ | Complete work | W |
| 77 | `dev_validate_task` | Validate | R |
| 78 | `dev_list_pending_plans` | Pending plans | R |
| 79 | `dev_get_task_spec` | Spec for VTID | R |
| 80 | `dev_autopilot_pipeline_health` | Pipeline health + summary | R |

## C7. Dev-Autopilot Scanners & Findings (15) — P1
`routes/dev-autopilot.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 81 | `dev_trigger_scan` ⚠️ | Run a scanner | W |
| 82 | `dev_list_scanners` | Scanners | R |
| 83 | `dev_list_impact_rules` | Impact rules | R |
| 84 | `dev_get_auto_approve_config` | Auto-approve config | R |
| 85 | `dev_list_scan_runs` | Scan runs | R |
| 86 | `dev_get_scan_run` | One run | R |
| 87 | `dev_findings_queue` | Findings queue | R |
| 88 | `dev_get_finding` | One finding | R |
| 89 | `dev_generate_finding_plan` ⚠️ | Generate fix plan | W |
| 90 | `dev_reject_finding` ⚠️ | Reject finding | W |
| 91 | `dev_snooze_finding` | Snooze | W |
| 92 | `dev_approve_auto_execute` ⚠️ | Approve auto-execution | W |
| 93 | `dev_cancel_execution` ⚠️ | Cancel execution | W |
| 94 | `dev_list_executions` | Executions | R |
| 95 | `dev_get_execution_lineage` | Lineage | R |

## C8. Self-Healing (13) — P1
`routes/self-healing.ts`, voice-lab healing subset.

| # | Tool | Does | R/W |
|---|---|---|---|
| 96 | `dev_report_incident` ⚠️ | File an incident | W |
| 97 | `dev_healing_config` | Config | R |
| 98 | `dev_set_healing_mode` ⚠️ | Change mode | W |
| 99 | `dev_healing_kill_switch` ⚠️ | Flip kill switch | W |
| 100 | `dev_healing_history` | Heal history | R |
| 101 | `dev_healing_metrics` | Metrics summary | R |
| 102 | `dev_approve_heal` ⚠️ | Approve pending heal | W |
| 103 | `dev_reject_heal` ⚠️ | Reject heal | W |
| 104 | `dev_verify_heal` | Verify a heal | R |
| 105 | `dev_rollback_heal` ⚠️ | Roll back a heal | W |
| 106 | `dev_list_quarantine` | Quarantined items | R |
| 107 | `dev_release_quarantine` ⚠️ | Release from quarantine | W |
| 108 | `dev_shadow_comparison` | Staging shadow-comparison report | R |

## C9. Observability (15) — P0
`admin-health.ts`, `telemetry.ts`, `voice-lab.ts`, `orb-agent-trace.ts`, `conversation-hub.ts`, `supervisor-summary.ts`.

| # | Tool | Does | R/W |
|---|---|---|---|
| 109 | `dev_build_info` | Running revision/build per service | R |
| 110 | `dev_service_health` | /alive + health across services | R |
| 111 | `dev_error_rate` | Recent error rates | R |
| 112 | `dev_latency_summary` | Latency percentiles | R |
| 113 | `dev_telemetry_snapshot` | Telemetry snapshot | R |
| 114 | `dev_recent_events` | Recent OASIS/system events | R |
| 115 | `dev_agent_trace` | ORB agent trace | R |
| 116 | `dev_supervisor_summary` | Supervisor summary | R |
| 117 | `dev_get_session_turns` | Voice session turns | R |
| 118 | `dev_get_session_diagnostics` | Session diagnostics | R |
| 119 | `dev_conversation_decisions` | Greeting/NBA decisions | R |
| 120 | `dev_tool_failures` | Recent tool failures | R |
| 121 | `dev_tool_health` | Tool health dashboard | R |
| 122 | `dev_greeting_decisions` | Greeting monitor | R |
| 123 | `dev_get_agent_detail` | One registered agent detail | R |

## C10. Testing & QA (10) — P1
`routes/testing.ts`, `test-contracts.ts`, orb-monitor.

| # | Tool | Does | R/W |
|---|---|---|---|
| 124 | `dev_run_test_suite` ⚠️ | Run a suite | W |
| 125 | `dev_list_test_suites` | Suites | R |
| 126 | `dev_list_test_runs` | Runs | R |
| 127 | `dev_get_test_run` | One run + failures | R |
| 128 | `dev_run_e2e` ⚠️ | Trigger E2E workflow | W |
| 129 | `dev_orb_monitor_status` | ORB monitor status | R |
| 130 | `dev_trigger_orb_monitor` ⚠️ | Trigger ORB monitor | W |
| 131 | `dev_list_test_contracts` | Test contracts | R |
| 132 | `dev_run_orb_selfcheck` ⚠️ | ORB tools selfcheck | W |
| 133 | `dev_voice_lab_probe` | Voice-lab probe | R |

## C11. Database & Migrations (6) — P2 (all dispatch-guarded)
`RUN-STAGING-MIGRATION.yml`, `RUN-MIGRATION.yml`, backfill scripts.

| # | Tool | Does | R/W |
|---|---|---|---|
| 134 | `dev_list_pending_migrations` | Unapplied migration files | R |
| 135 | `dev_run_staging_migration` ⚠️ | Dispatch staging migration | W |
| 136 | `dev_run_prod_migration` ⚠️⚠️ | Dispatch prod migration (double confirm + reason) | W |
| 137 | `dev_migration_status` | Last migration run status | R |
| 138 | `dev_run_backfill` ⚠️ | Run a named backfill | W |
| 139 | `dev_schema_info` | Table/schema summary from DATABASE_SCHEMA.md | R |

## C12. Dev Access, Simulator & Meta (11) — P2
`dev-access.ts`, `dev-auth.ts`, Command Hub Simulator/catalog.

| # | Tool | Does | R/W |
|---|---|---|---|
| 140 | `dev_list_dev_users` | Dev-access users | R |
| 141 | `dev_grant_access` ⚠️ | Grant dev access | W |
| 142 | `dev_revoke_access` ⚠️ | Revoke dev access | W |
| 143 | `dev_mint_token` ⚠️ | Mint a dev token | W |
| 144 | `dev_open_hub_panel` | Navigate Command Hub to module/tab | R |
| 145 | `dev_run_simulator` | Dry-run conversation decision for a user | R |
| 146 | `dev_journey_context` | Journey context readout | R |
| 147 | `dev_voice_catalog_stats` | Catalog stats (live/planned/parity) | R |
| 148 | `dev_get_voice_tool_detail` | One tool's manifest entry | R |
| 149 | `dev_run_routine_now` ⚠️ | Fire a routine immediately | W |
| 150 | `dev_system_briefing` | Composite morning briefing: health + deploys + approvals + violations + failing checks | R |

**Developer total: 150** · P0: 57 · P1: 63 · P2: 30

---

# PART D — Delivery plan

## Phasing (each wave = one PR, independently shippable)

| Wave | Content | Tools | Why first |
|---|---|---|---|
| **1** | Community P0: Commerce+Cart+Wallet+Messaging depth+Events/Tickets+Health depth | ~69 | Users' most-asked verbs: buy, pay, send, book, log |
| **2** | Developer P0: VTID lifecycle, Governance, CI/CD, Deploy, Observability | ~57 | Makes the ops loop voice-drivable; devs dogfood daily |
| **3** | Admin P0: Users/RBAC, Moderation, Marketplace, Broadcast, Governance, Feedback | ~37 | Admin daily-drivers |
| **4** | Community P1 + Admin P1 | ~104 | Business hub depth, live rooms, campaigns; tenant/KB/autopilot admin |
| **5** | Developer P1: autopilot control, scanners, healing, orchestrator, testing | ~63 | Autonomy operations |
| **6** | All P2: memory extras, profile depth, specialists, migrations, dev access | ~95 | Completeness |

## Safety tiers

- **Read (R)** — no confirm, rate-limited.
- **Write (W)** — executes with spoken confirmation of the result.
- **⚠️ Confirm** — 2-step confirm token (existing `dev_approve_pr` pattern).
- **⚠️⚠️ Double confirm** — `dev_publish_to_prod`, `dev_run_prod_migration`: 2-step confirm **plus** a spoken reason recorded to OASIS, mirroring the escape-hatch script's `--reason` requirement.

## Per-wave engineering checklist (matches how the first 169 shipped)

1. Handlers in new `services/gateway/src/services/orb-tools/<domain>-tools.ts` modules, spread into `ORB_TOOL_REGISTRY`.
2. Declarations added to Vertex catalog (role-gated) + LiveKit `tools.py` wrappers — **key names verified against handler `args.*` reads** (the pillar-bug lesson: a regression test per param contract).
3. `tool-manifest.json` entries (planned → live per wave); reconcile scanner + parity gate green.
4. Jest tests per module + `spec.json` parity entries.
5. Staging deploy → live voice smoke test per wave (with test-artifact cleanup, per standing rule).

## Review outcome

The four open questions were resolved on 2026-07-12 — see "Approved decisions" at the top of this document.

---

# Marketplace Voice Assistant (Discover) — expansion v3

**APPROVED 2026-07-20 (owner request: complete conversational shopping journey).**

Vitana becomes a **Marketplace Discover Assistant**: understand the need →
clarify → discover options → explain relevance (concise, never spec-dumps) →
compare → choose → confirmed add-to-basket → book/order → follow up. Covers
products, services, practitioners, and health diagnostics (blood tests,
metabolomics, microbiome, genomics, cardiovascular assessment).

**Wave MVA-1 (this PR)** builds the 35 tools whose backing systems exist today
(`products`, `services_catalog`, universal cart, shopping-agent `runPropose`,
`memory_facts`, `memory_items`, `shop_saved_products`, `user_offers_memory`).
Everything else seeds as `planned` — honest roadmap entries that go live when
their backends (diagnostic-test catalog, practitioner booking/availability,
bundles, returns) exist. No tool ever fabricates data for a missing backend.

**Health-domain boundary (hard rule for every A24/A25 tool and any
health-adjacent recommendation):** the assistant may explain what a test
measures, why it could be relevant to a stated goal, compare scope/logistics,
and facilitate ordering — it must NEVER diagnose, prescribe, promise outcomes,
present a test as medically necessary, hide limitations, or use health context
without consent. Payment is never taken by voice: cart-staging + screen
handoff only.

## A17. Marketplace Discover Assistant orchestrators (5) — P0

The user-facing conversational layer that coordinates the atomic tools below.

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `start_marketplace_discover_assistant` | Start a guided shopping conversation for a product, service, practitioner or diagnostic need; records the goal and returns the first clarifying step | W |
| 2 | `build_personalized_shopping_guide` | Convert a broad need into a concise recommendation path across products and services, grounded in the shopping agent | R |
| 3 | `refine_marketplace_recommendations` | Update the current picks from conversational feedback (cheaper, no pills, at home, different brand) | R |
| 4 | `explain_marketplace_recommendation` | The concise what-it-is / what-for / why-for-you / limits explanation of a current pick | R |
| 5 | `complete_marketplace_selection` ⚠️ | Confirm the selected option and route it to the basket (two-step confirm; never charges) | W |

## A18. Shopping intent & preferences (8) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `capture_shopping_goal` | Record what the user wants to achieve, solve, explore or purchase in the active guide | W |
| 2 | `clarify_shopping_need` | Return the smallest set of missing criteria (budget, format, urgency, exclusions) still needed | R |
| 3 | `classify_marketplace_intent` | Determine whether the need maps to a product, service, diagnostic test, practitioner or combination | R |
| 4 | `extract_purchase_criteria` | Extract budget, location, urgency, format, priorities, exclusions and desired outcome from natural language | R |
| 5 | `save_marketplace_preferences` ⚠️ | Save reusable shopping preferences (dietary, values, exclusions, budget) with user permission | W |
| 6 | `get_marketplace_preferences` | Retrieve saved shopping preferences relevant to the current request | R |
| 7 | `reset_marketplace_preferences` ⚠️ | Remove saved marketplace preferences after confirmation | W |
| 8 | `exclude_marketplace_brand_or_category` ⚠️ | Persistently exclude a brand or category from future recommendations | W |

## A19. Personalization & transparency (5) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `get_marketplace_context` | Return the minimum relevant user context (saved preferences, budget, recent orders) for the current request | R |
| 2 | `explain_personalization_basis` | Explain in plain language which stored information shaped a recommendation | R |
| 3 | `dismiss_marketplace_recommendation` | Dismiss a recommended product or service so it is not proposed again | W |
| 4 | `show_sponsored_status` | State whether an item is sponsored, promoted or commission-bearing | R |
| 5 | `explain_no_suitable_option` | Explain honestly when no appropriate marketplace option was found | R |

## A20. Unified discovery (8) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `discover_marketplace_options` | Unified search across products AND services for one stated need | R |
| 2 | `search_products_by_need` | Search products by purpose and outcome rather than exact product name | R |
| 3 | `search_services_by_need` | Search services (wellness, nutrition, therapy, labs) by desired outcome | R |
| 4 | `search_marketplace_by_values` | Filter products by dietary tags, certifications and value preferences | R |
| 5 | `search_marketplace_alternatives` | Find alternatives to a product the user dislikes or cannot use | R |
| 6 | `search_marketplace_by_budget` | Find options within a defined total budget across categories | R |
| 7 | `search_local_services` | Search services available near the user | R |
| 8 | `search_marketplace_by_availability` | Search by delivery date or appointment availability | R |

## A21. Guided recommendation (7) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `generate_top_marketplace_picks` | Return a small number of best-fit options with short per-pick rationales (never stages the cart silently) | R |
| 2 | `recommend_marketplace_path` | Recommend whether to start with a product, service, diagnostic or combination for the stated goal | R |
| 3 | `rerank_marketplace_options` | Re-rank current options when the user changes a priority | R |
| 4 | `recommend_lower_cost_option` | Find a suitable less expensive alternative to a current pick | R |
| 5 | `recommend_premium_option` | Find a higher-quality or more comprehensive alternative | R |
| 6 | `recommend_non_product_alternative` | Suggest a service or non-purchase approach when a product is not the best fit | R |
| 7 | `recommend_complete_solution` | Build a product-and-service combination that addresses one broader goal | R |

## A22. Concise explanation (6) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `explain_why_recommended` | Explain why the assistant selected this option for this user, from the recorded rationale | R |
| 2 | `summarize_product_for_user` | Personalized short summary: what it is, what for, why it may fit, key limits — never the full spec | R |
| 3 | `get_key_product_facts` | Only the most important facts: price, form, usage, availability, safety notes | R |
| 4 | `explain_how_to_use_product` | Practical use instructions (dosage, serving) without overwhelming detail | R |
| 5 | `explain_relevant_limitations` | Surface only the limitations relevant to this user | R |
| 6 | `explain_evidence_summary` | Concise description of evidence strength and uncertainty for a product or service claim | R |

## A23. Comparison & shortlist (7) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `compare_marketplace_options` | Compare up to three options on the criteria that matter to this user | R |
| 2 | `highlight_meaningful_differences` | Explain only the differences likely to affect the user's choice | R |
| 3 | `identify_best_value_option` | Determine the strongest value for the user's needs, not just the lowest price | R |
| 4 | `answer_product_question` | Answer one focused question about one product | R |
| 5 | `shortlist_marketplace_options` ⚠️ | Save products to the user's shortlist for later comparison | W |
| 6 | `view_marketplace_shortlist` | Read the current shortlist aloud | R |
| 7 | `remove_from_marketplace_shortlist` ⚠️ | Remove an option from the shortlist | W |

## A24. Diagnostics & health services (10) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `browse_diagnostic_tests` | Browse diagnostic services by type: blood, metabolomics, microbiome, genomics, hormones, longevity panels | R |
| 2 | `find_test_by_health_goal` | Find diagnostic categories matching a stated goal without diagnosing | R |
| 3 | `find_test_by_biomarker` | Search tests containing a named biomarker | R |
| 4 | `get_test_details` | Biomarker list, sample method, preparation and result timeline for one test | R |
| 5 | `check_home_collection_availability` | Check whether home sample collection is available for a test | R |
| 6 | `order_home_test_kit` ⚠️ | Stage an eligible home test kit into the basket after confirmation | W |
| 7 | `book_lab_appointment` ⚠️ | Book a laboratory or sample-collection appointment | W |
| 8 | `get_ordered_test_status` | Track kit shipment, sample receipt, processing and result readiness | R |
| 9 | `prepare_for_diagnostic_service` | Concise preparation checklist (fasting, timing, medication questions for a professional) | R |
| 10 | `recommend_diagnostic_test` | Recommend suitable diagnostic categories for a stated information need, never a diagnosis | R |

## A25. Practitioner selection (6) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `find_practitioner_by_specialty` | Find practitioners by specialty, goal and user preferences | R |
| 2 | `get_practitioner_credentials` | Relevant qualifications and verification status | R |
| 3 | `get_practitioner_availability` | Open appointment slots | R |
| 4 | `get_practitioner_pricing` | Session and package pricing | R |
| 5 | `compare_practitioners_for_user` | Compare a practitioner shortlist on the user's priorities | R |
| 6 | `book_practitioner_appointment` ⚠️ | Book an available appointment after confirmation | W |

## A26. Bundles & plans (5) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `build_marketplace_solution_plan` | Concise multi-step product and service plan for one goal | R |
| 2 | `create_diagnostic_and_consultation_bundle` | Pair a diagnostic service with suitable result interpretation | R |
| 3 | `check_bundle_compatibility` | Check whether bundle components logically work together, without duplication | R |
| 4 | `add_bundle_to_cart` ⚠️ | Stage all purchasable bundle items into the basket after confirmation | W |
| 5 | `save_marketplace_plan` | Save a marketplace plan to resume later | W |

## A27. Suitability & compatibility (6) — P1

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `check_product_suitability` | Check one product against saved preferences, exclusions and dietary needs | R |
| 2 | `check_dietary_compatibility` | Check vegan, vegetarian, gluten-free or other dietary requirements for a product | R |
| 3 | `check_cart_duplication` | Detect repeated or overlapping products in the basket | R |
| 4 | `check_delivery_restrictions` | Check country and shipping limitations for a product | R |
| 5 | `check_test_overlap` | Identify duplicated biomarkers across diagnostic packages | R |
| 6 | `check_service_prerequisites` | Identify referrals, preparation or eligibility requirements for a service | R |

## A28. Pricing & value (4) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `compare_marketplace_prices` | Compare prices of equivalent options including reference prices | R |
| 2 | `explain_price_difference` | Explain why two similar options are priced differently | R |
| 3 | `review_shopping_budget` | Read the monthly shopping budget, current spend and remaining headroom | R |
| 4 | `estimate_total_ownership_cost` | Show recurring or long-term cost rather than only the initial price | R |

## A29. Cart confirmation & checkout handoff (6) — P0

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `confirm_marketplace_selection` ⚠️ | Read back the exact selected option (name, price, key terms) and obtain explicit confirmation before any cart action | R |
| 2 | `add_selected_option_to_cart` ⚠️ | Stage the confirmed option into the universal basket (never charges; screen handoff for payment) | W |
| 3 | `add_shortlist_item_to_cart` ⚠️ | Stage an item from the shortlist into the basket after confirmation | W |
| 4 | `review_cart_suitability` | Check duplicates and conflicts with saved preferences before checkout | R |
| 5 | `explain_cart_item` | Explain why a specific basket item is there (origin, rationale) | R |
| 6 | `confirm_cart_total` | Read back total price and any recurring charges before the screen handoff | R |

## A30. Post-purchase & follow-up (6) — P2

| # | Tool | Does | R/W |
|---|---|---|---|
| 1 | `get_next_order_action` | Tell the user the next required step for an order (delivery, sample, appointment) | R |
| 2 | `submit_marketplace_review` ⚠️ | Record the user's rating of a purchased product or service after confirmation | W |
| 3 | `schedule_reorder_reminder` | Schedule an optional reorder reminder | W |
| 4 | `start_return_request` | Start a return process for an eligible order | W |
| 5 | `cancel_marketplace_order` ⚠️ | Cancel an eligible order after confirmation | W |
| 6 | `report_marketplace_issue` | Report an order, product or service problem | W |

## Wave MVA-1 build slice (35 live in this PR)

- **A17 (5/5)** — guide state persisted per-user in `memory_items`
  (`content_json.type = 'marketplace_guide_state'`); picks grounded in
  `runPropose()` + `services_catalog`; completion routes through the
  two-step confirm + universal-cart staging path.
- **A18 (6/8)** — `capture_shopping_goal`, `clarify_shopping_need`,
  `classify_marketplace_intent`, `save/get/reset_marketplace_preferences`
  (`memory_facts` `marketplace_pref_*` keys via `write_fact`).
- **A19 (2/5)** — `get_marketplace_context`,
  `dismiss_marketplace_recommendation` (`user_offers_memory.state='dismissed'`).
- **A20 (5/8)** — unified/need/values/alternatives search over `products` +
  `services_catalog` (same query family as A1).
- **A21 (3/7)** — `generate_top_marketplace_picks` (propose-only `runPropose`
  wrapper), `recommend_marketplace_path`, `recommend_lower_cost_option`.
- **A22 (3/6)** — `explain_why_recommended`, `summarize_product_for_user`,
  `get_key_product_facts`.
- **A23 (4/7)** — compare + shortlist trio (`shop_saved_products`).
- **A27 (2/6)** — `check_product_suitability`, `check_cart_duplication`.
- **A28 (1/4)** — `review_shopping_budget` (`user_limitations` cap +
  monthly spend).
- **A29 (4/6)** — `confirm_marketplace_selection`,
  `add_selected_option_to_cart`, `review_cart_suitability`,
  `explain_cart_item`.

The remaining 54 tools stay `planned` until their backends exist
(diagnostic-test catalog with biomarker data, practitioner
booking/availability, bundles, returns/refunds, geo search).
