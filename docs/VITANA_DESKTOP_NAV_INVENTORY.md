# VITANA Desktop Platform — Navigation / Routing Inventory

**Scope:** the VITANA **desktop** web platform (`vitana-v1`), analyzed from scratch
against the real app source — independent of the MAXINA mobile app. Built from:
`src/App.tsx` (route table), `src/config/navigation.ts` (authoritative sidebar +
sub-nav), and each area's page components (in-page tabs).

**Legend — route type**
- **`route`** — a real React-Router path (bookmarkable, deep-linkable).
- **`?param`** — in-page tab addressable via query param (`?tab=` / `?view=` / `?section=` / `?filter=`).
- **`state-only`** — an in-page tab with **no URL** (local component state); not deep-linkable today.

**Levels:** L1 = sidebar area · L2 = sub-nav page · L3 = in-page tab/sub-view.

Proposed `screen_id` follows the existing catalog convention `AREA.SCREEN`.

---

## 0. Two navigation layers (important)

Desktop navigation has **two distinct layers**, and they don't map 1:1 — this is the root of the mobile/desktop confusion in the catalog:

### 0a. The primary sidebar — **role-based on desktop** (`src/config/role-navigation.ts` via `AppLayout.tsx`)

**Desktop ≠ mobile, and the desktop sidebar differs per role.** Two distinct sources:
- **Desktop sidebar** → `AppLayout.tsx` calls `getRoleNavigation(role)` (`role-navigation.ts`). The role is **derived from the path** (`/admin/*`→admin, `/staff/*`→staff, `/professional/*`→professional, `/patient/*`→patient, else **community**).
- **Mobile drawer** → a *separate* flat list in `src/config/drawer-nav.config.ts`, rendered by `src/components/mobile/SideDrawerNav.tsx`. (This is the ~17-item list I earlier mis-attributed to desktop — it is **mobile only**.)

**Per-role desktop sidebars** (authoritative, from `role-navigation.ts`):

| Role | Sidebar items (in order) |
|------|--------------------------|
| **community** (14) | News `/home` · My Journey `/autopilot` · Community `/comm` · Discover `/discover` · Business Hub `/business` · Inbox `/inbox` · Health `/health` · Connectors `/connectors` · AI Assistant `/assistant` · Wallet `/wallet` · Sharing `/sharing` · Memory `/memory` · Settings `/settings` · Support `/support` |
| **patient** (9) | Dashboard · My Health · Appointments · Test Results · Care Team · Health Goals · Insurance · Notifications · Settings |
| **professional** (9) | Dashboard · My Patients · Schedule · Clinical Tools · Referrals · Billing · Professional Profile · Education · Settings |
| **staff** (9) | Dashboard · Patient Queue · Daily Tasks · Schedule · Reports · Communications · Staff Tools · Time Tracking · Settings |
| **admin** (13) | Derived from `ADMIN_SECTIONS` (`admin-navigation.ts`): Overview · Members · Assistant · Knowledge · Feedback · Navigator · Autopilot · Community · Content · Notifications · Insights · Settings · Audit & Compliance |
| **developer / infra** | No dedicated case → fall through to the **community** sidebar (dev tooling lives under `/dev/*`, reached directly, not via a role sidebar). |

> ⚠️ The `community` desktop sidebar has **14** items — the earlier screenshot only showed the first ~7 because the list scrolls. Note it promotes **My Journey** (`/autopilot`) to a top-level item (this is the screen with the Guided/Full mode toggle), and includes **Discover** (the screenshot cut it off).

### 0b. The area + sub-nav model (`src/config/navigation.ts`)
The logical areas each page belongs to, with their sub-navigation. This is the backbone of the inventory below:

| Area | Root route | Sub-nav items |
|------|-----------|---------------|
| **Home** | `/home` | (news feed — tabs only) |
| **AI** | `/ai` | Overview · Insights · Recommendations · Daily Summary · AI Companion |
| **Community** | `/comm` | Overview · Events & MeetUps · Find a Match · Live Rooms · Media Hub · Talk to Vitana |
| **Business** | `/business` | Overview · Services · Sell & Earn · Clients · Analytics |
| **Discover** | `/discover` | Overview · Supplements · Wellness Services · Doctors/Coaches · Deals & Offers · Orders |
| **Health** | `/health` | Overview · Services Hub · My Biology · My Plans · Education & Science |
| **Inbox** | `/inbox` | Overview · Inspiration · Archived |
| **Memory** | `/memory` | Overview · Timeline · Daily Diary · Recall & Search · Permissions |
| **Wallet** | `/wallet` | Overview · Balance & Benefits · Subscriptions · Rewards & Commissions |
| **Sharing** | `/sharing` | Overview · Campaigns · Distribution · Data & Consent |
| **Assistant** | `/assistant` | (tabbed hub) Voice · AI · Autopilot · Proactive · Referrals |
| **Settings** | `/settings` | Notifications · Preferences · Limitations · Privacy · Billing |

> The desktop **community** sidebar (0a) and the area model (0b) nearly align (sidebar = one entry per area, plus My Journey/Connectors/Support). The **mobile** drawer (`drawer-nav.config.ts`) is what flattens Community into Events/Find-a-Match/Live/Media and surfaces Diary/Orders as top-level — another reason mobile↔desktop screen lists don't line up 1:1. **Any role/platform-aware nav catalog must therefore be keyed by `(platform, role)`, not a single global sidebar.**

---

## 1. HEALTH — `/health`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | HEALTH.OVERVIEW | `/health` | route | Health dashboard: Vitana Index, pillar agents, today's actions, AI insights |
| L2 | HEALTH.SERVICES_HUB | `/health/services-hub` | route | Book appointments, screenings, wellness programs |
| L3 | · Preventive Care | `/health/services-hub?tab=preventiveCare` | ?tab (default) | Physicals, screenings, cardio/metabolic |
| L3 | · Medical Services | `/health/services-hub?tab=medicalServices` | ?tab | Specialists, telemedicine, labs, prescriptions |
| L3 | · Wellness Programs | `/health/services-hub?tab=wellnessPrograms` | ?tab | Nutrition/fitness/mental coaching, challenges |
| L3 | · Insurance Support | `/health/services-hub?tab=insuranceSupport` | ?tab | Claims, coverage, pre-auth, payment plans |
| L3 | · My Services | `/health/services-hub?tab=myServices` | ?tab | Appointments, history, providers, records |
| L2 | HEALTH.MY_BIOLOGY | `/health/my-biology` | route | Biomarkers, omics, supplements |
| L3 | · My Medical | `/health/my-biology?tab=medical` | ?tab (default) | Blood panels, hormones, cancer, allergy, imaging |
| L3 | · My Omics | `/health/my-biology?tab=omics` | ?tab | Genomics, metabolomics, microbiome, proteomics |
| L3 | · My Supplements | `/health/my-biology?tab=supplements` | ?tab | Supplement regimen across 40+ categories |
| L2 | HEALTH.PLANS | `/health/plans` | route | AI-personalized health plans |
| L3 | · All Plans | `/health/plans?tab=all` | ?tab (default) | Grid of 6 plan types + cross-plan widget |
| L3 | · Nutrition | `/health/plans?tab=nutrition` | ?tab | Nutrition plan + recipes + daily tracking |
| L3 | · Exercise | `/health/plans?tab=exercise` | ?tab | Workout plan + adherence tracking |
| L3 | · Hydration | `/health/plans?tab=hydration` | ?tab | Hydration targets + logging |
| L3 | · Sleep | `/health/plans?tab=sleep` | ?tab | Sleep goals + optimization |
| L3 | · Mental | `/health/plans?tab=mental` | ?tab | Stress management + mindfulness |
| L3 | · Supplement | `/health/plans?tab=supplement` | ?tab | Supplement plan detail |
| L2 | HEALTH.EDUCATION | `/health/education` | route | Health education library |
| L3 | · Articles | `/health/education?tab=articles` | ?tab (default) | Curated articles |
| L3 | · Videos | `/health/education?tab=videos` | ?tab | Educational videos |
| L3 | · Podcasts | `/health/education?tab=podcasts` | ?tab | Health podcasts |
| L2 | HEALTH.VITANA_INDEX | `/health/vitana-index` | route | Vitana Index scoring breakdown + 90-day goals |
| L2 | HEALTH.PILLARS | `/health/pillars` | route | Five pillars overview |
| L2 | HEALTH.CONDITIONS | `/health/conditions` | route | Health risk assessments + preventive plans |

> Redirects (not catalog screens): `/health/biomarker-results` → `/health/my-biology`; `/health/my-health-tracker` & `/health-tracker*` → `/health`. The legacy `/health-tracker/*` subtree exists but redirects into `/health`.

---

## 2. DISCOVER — `/discover`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | DISCOVER.OVERVIEW | `/discover` | route | Discover hub: AI recommendations, categories, Share & Earn |
| L3 | · Suggested | `/discover?tab=suggested` | ?tab | AI picks on the hub |
| L3 | · Categories | `/discover?tab=categories` | ?tab | Browse by category |
| L3 | · Share & Earn | `/discover?tab=share` | ?tab | Referral/share panel |
| L2 | DISCOVER.SUPPLEMENTS | `/discover/supplements` | route | Vitamins, minerals, longevity compounds (search/sort/filter) |
| L2 | DISCOVER.WELLNESS_SERVICES | `/discover/wellness-services` | route | Wellness services by category |
| L2 | DISCOVER.DOCTORS_COACHES | `/discover/doctors-coaches` | route | Find & book health professionals |
| L3 | · Find / Bookmarked / Upcoming / History | (state-only) | **state-only** | Provider browse vs saved vs appointments |
| L2 | DISCOVER.DEALS | `/discover/deals-offers` | route | Flash deals + trending |
| L3 | · Flash | `/discover/deals-offers?tab=flash` | ?tab | Limited-time flash deals |
| L3 | · Trending | `/discover/deals-offers?tab=trending` | ?tab | Trending services |
| L2 | DISCOVER.ORDERS | `/discover/orders` | route | Orders: products, services, tickets, vouchers |
| L3 | · Active / History | (state-only; history sub-filter all/events/products/services/refunds/vouchers) | **state-only** | Active vs past orders |
| L2 | DISCOVER.AI_PICKS | `/discover/ai-picks` | route | AI-generated marketplace recommendations |
| L2 | DISCOVER.MARKETPLACE | `/discover/marketplace` | route | Full commercial marketplace |
| L2 | DISCOVER.PRODUCT_DETAIL | `/discover/product/:id` | route (param) | Product landing (OG shareable) |
| L2 | DISCOVER.PROVIDER_PROFILE | `/discover/provider/:id` | route (param) | Provider detail |
| — | (Cart) | `/universal-cart` | route | Unified multi-item cart (`/cart` redirects here) |

---

## 3. BUSINESS — `/business`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | BUSINESS.OVERVIEW | `/business` | route | Business Hub: KPIs, earnings snapshot, latest actions |
| L2 | BUSINESS.SERVICES | `/business/services` | route | Coaching/consulting services + packages |
| L3 | · Services / Events / Packages | (state-only SplitBar) | **state-only** | Service types |
| L2 | BUSINESS.SELL_EARN | `/business/sell-earn` | route | Reseller ticket inventory, promotions, referrals (reseller-gated) |
| L3 | · Inventory / Promotions / Referrals | (state-only SplitBar) | **state-only** | Sell & Earn sub-views |
| L2 | BUSINESS.CLIENTS | `/business/clients` | route | Client CRM |
| L3 | · Active / Prospects / History | (state-only SplitBar) | **state-only** | Client pipeline |
| L2 | BUSINESS.ANALYTICS | `/business/analytics` | route | Performance, earnings ledger, growth |
| L3 | · Performance / Earnings / Growth | (state-only SplitBar) | **state-only** | Analytics sub-views |
| L2 | BUSINESS.LISTINGS | `/business/listings` | route | My Listings (pro-gated) |
| L2 | BUSINESS.OPPORTUNITIES | `/business/opportunities` | route | Business opportunities (commercial intents) |

> Legacy redirects: `/comm/my-business` & `/community/my-business` → `/business`. **Note:** Business L3 tabs are **state-only on desktop** (mobile addresses them via `?tab=insights.earnings`-style leaves) — a prime candidate for adding desktop `?tab=` deep-links.

---

## 4. COMMUNITY — `/comm`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | COMM.OVERVIEW | `/comm` | route | Community hub: highlights, events, people, media, groups |
| L2 | COMM.EVENTS | `/comm/events-meetups` | route | Browse events & meetups |
| L3 | · Hot / Today / Upcoming / Following | `/comm/events-meetups?tab=hot\|today\|upcoming\|following` | ?tab | Event filters |
| L2 | COMM.FIND_PARTNER | `/comm/find-partner` | route | Dance/fitness partner matching |
| L3 | · Matches | `/comm/find-partner?view=matches` | ?view | My matches |
| L3 | · Board | `/comm/find-partner?view=board` | ?view | Community board |
| L3 | · Posts | `/comm/find-partner?view=posts` | ?view | My posts |
| L3 | · Members | `/comm/find-partner?view=members` | ?view | Members directory (gated) |
| L2 | COMM.LIVE_ROOMS | `/comm/live-rooms` | route | Real-time audio/video rooms |
| L3 | · All / Live / Scheduled / Past | `/comm/live-rooms?tab=all\|live\|scheduled\|past` | ?tab | Room filters (`?live=<id>` opens a room) |
| L2 | COMM.MEDIA_HUB | `/comm/media-hub` | route | Music, podcasts, shorts |
| L3 | · Music / Podcasts / Shorts | `/comm/media-hub?tab=music\|podcasts\|shorts` | ?tab | Media types (`?short=<id>` opens player) |
| L2 | COMM.TALK_TO_VITANA | `/comm/talk-to-vitana` | route | Feedback & suggestions pipeline |
| L2 | COMM.GROUPS | `/comm/groups` | route | Browse/manage groups (`/comm/groups/:id` detail) |
| L2 | COMM.MEMBERS | `/comm/members` | route | Public members directory |
| L2 | COMM.OPEN_ASKS | `/comm/open-asks` | route | Public open-asks feed |
| — | Intents | `/intents/board` · `/intents/mine` · `/intents/match/:id` | route | Intent board / my intents / match detail |

> `/community/*` paths are legacy aliases of the `/comm/*` set.

---

## 5. AI — `/ai`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | AI.OVERVIEW | `/ai` | route | AI dashboard: priority actions, autopilot status, memory highlights |
| L2 | AI.INSIGHTS | `/ai/insights` | route | Patterns, trends, correlations, predictions |
| L2 | AI.RECOMMENDATIONS | `/ai/recommendations` | route | Personalized recommendations |
| L2 | AI.DAILY_SUMMARY | `/ai/daily-summary` | route | Daily wellness recap + actions |
| L2 | AI.COMPANION | `/ai/companion` | route | AI companion configuration |

> No L3 tabs — each AI sub-page is a standalone full-screen view.

---

## 6. ASSISTANT — `/assistant` (tabbed hub)

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | ASSISTANT.OVERVIEW | `/assistant` | route | Assistant settings hub |
| L3 | ASSISTANT.VOICE | `/assistant?tab=voice` | ?tab | Voice / TTS / STT settings |
| L3 | ASSISTANT.AI | `/assistant?tab=ai` | ?tab | AI model + personality |
| L3 | ASSISTANT.AUTOPILOT | `/assistant?tab=autopilot` | ?tab | Autopilot toggles + automation rules |
| L3 | ASSISTANT.PROACTIVE | `/assistant?tab=proactive` | ?tab | Proactive interaction settings |
| L3 | ASSISTANT.REFERRALS | `/assistant?tab=referrals` | ?tab | VAEA / affiliate config |

---

## 7. WALLET — `/wallet`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | WALLET.OVERVIEW | `/wallet` | route | Wallet hub: balance cards + quick actions |
| L3 | · Balance Overview / Recent Activity / Smart Actions | (state-only SplitBar; `?filter=<type>` jumps to Activity) | **state-only / ?filter** | Hub sub-views |
| L2 | WALLET.BALANCE | `/wallet/balance` | route | Credits, tokens, membership, optimization |
| L3 | · Credits | `/wallet/balance?tab=credits` | ?tab | Credits account |
| L3 | · Tokens | `/wallet/balance?tab=tokens` | ?tab | Tokens account |
| L3 | · Membership | `/wallet/balance?tab=membership` | ?tab | Membership benefits |
| L3 | · Optimization | `/wallet/balance?tab=optimization` | ?tab | Earning optimization |
| L2 | WALLET.SUBSCRIPTIONS | `/wallet/subscriptions` | route | Manage subscription plans |
| L2 | WALLET.REWARDS | `/wallet/rewards` | route | Rewards + reseller commissions |

---

## 8. MEMORY — `/memory`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | MEMORY.OVERVIEW | `/memory` | route | Memory hub |
| L3 | · Categories | `/memory?tab=categories` | ?tab | Memory categories |
| L3 | · Timeline | `/memory?tab=timeline` | ?tab | In-hub timeline |
| L3 | · Education | `/memory?tab=education` | ?tab | Memory education |
| L2 | MEMORY.TIMELINE | `/memory/timeline` | route | Historical memory timeline |
| L2 | MEMORY.DIARY | `/memory/diary` | route | Daily diary (voice/photos/text tabs — state-only) |
| L2 | MEMORY.RECALL | `/memory/recall` | route | AI recall & search |
| L2 | MEMORY.PERMISSIONS | `/memory/permissions` | route | Memory access permissions |

---

## 9. INBOX — `/inbox`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | INBOX.OVERVIEW | `/inbox` | route | Inbox / conversation list (Community + Professional contexts) |
| L3 | · Context: Global / Tenant | (state-only SplitBar) | **state-only** | Community vs Professional network |
| L3 | · Filter: All / Groups / Direct / Contacts | (state-only Tabs) | **state-only** | Conversation filter |
| L2 | INBOX.INSPIRATION | `/inbox/inspiration` | route | Curated inspiration messages |
| L2 | INBOX.ARCHIVED | `/inbox/archived` | route | Archived conversations |
| — | Deep-links | `/inbox/u/:recipientId` · `/inbox/t/:threadId` · `/inbox/g/:groupId` | route (param) | DM / thread / group deep-links |
| — | Reminders | `/reminders` | route | Reminder list (`?fire=<id>` overlay) |

---

## 10. SHARING — `/sharing`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | SHARING.OVERVIEW | `/sharing` | route | Blast Center, growth KPIs, analytics |
| L2 | SHARING.CAMPAIGNS | `/sharing/campaigns` | route | Create/manage campaigns (`/sharing/campaigns/:id` editor) |
| L2 | SHARING.DISTRIBUTION | `/sharing/distribution` | route | Content distribution across channels |
| L2 | SHARING.DATA_CONSENT | `/sharing/data-consent` | route | Data sharing & consent preferences |

---

## 11. HOME — `/home`

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | HOME.OVERVIEW | `/home` | route | News Feed (VTID-01900): longevity science + community updates |
| L3 | · All News | `/home?tab=all` | ?tab | Combined feed |
| L3 | · Longevity | `/home?tab=longevity` | ?tab (default) | Science articles |
| L3 | · Community | `/home?tab=community` | ?tab | Member contributions |
| — | Article Detail | `/news/:id` | route (param) | Full article reader |

> **Confirms earlier finding:** `/home/actions`, `/home/context`, `/home/aifeed`, `/home/matches`, `/dashboard*` all **redirect to `/home`** on desktop — i.e. `HOME.ACTIONS` / `HOME.CONTEXT` are genuinely **mobile-only** widgets, not desktop screens.

---

## 12. SETTINGS — `/settings`

`/settings` redirects to `/settings/notifications` on desktop. Sub-nav (`settingsNavigation`): Notifications · Preferences · Limitations · Privacy · Billing.

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L2 | SETTINGS.NOTIFICATIONS | `/settings/notifications` | route | Channels, quiet hours, categories (flat, no tabs) |
| L2 | SETTINGS.PREFERENCES | `/settings/preferences` | route | Theme / language / accessibility |
| L3 | · Appearance | `/settings/preferences?section=appearance` | ?section (default) | Theme + primary color |
| L3 | · Language & Region | `/settings/preferences?section=language` | ?section | Language + locale formatting |
| L3 | · Accessibility | `/settings/preferences?section=accessibility` | ?section | Font size, contrast, dyslexic font |
| L2 | SETTINGS.LIMITATIONS | `/settings/limitations` | route | Usage quotas / plan limits (flat) |
| L2 | SETTINGS.PRIVACY | `/settings/privacy` | route | Visibility, AI consent, security |
| L3 | · Profile Visibility | `/settings/privacy?section=profile` | ?section (default) | Public profile, activity, index sharing |
| L3 | · Data Sharing | `/settings/privacy?section=data` | ?section | AI consent, data usage, 3rd-party |
| L3 | · Security | `/settings/privacy?section=security` | ?section | Password, device sessions, login history |
| L2 | SETTINGS.BILLING | `/settings/billing` | route | Plan, Stripe portal, creator payouts (flat) |
| L2 | SETTINGS.CONNECTED_APPS | `/connectors` | route | OAuth integrations (`/settings/connected-apps` redirects here) |
| L2 | SETTINGS.SUPPORT | `/support` | route | Help, FAQ, bug report, feature request |
| L2 | SETTINGS.TENANT_ROLE | `/settings/tenant-role` | route | Switch tenant role / claim identity |

> **Confirms earlier cross-area twins:** `/settings/autopilot` → `/assistant?tab=autopilot` and `/settings/voice-ai` → `/assistant?tab=voice` (desktop puts these under **Assistant**, mobile under **Settings**). `/settings/social` had no desktop page found — likely mobile-only or folds into Connected Apps.

---

## 13. PROFILE & UTILITY

| Lvl | Screen | Route | Type | Purpose |
|-----|--------|-------|------|---------|
| L1 | PROFILE.ME | `/me/profile` | route | Edit own profile (drawer system) |
| L3 | · drawers | `/me/profile?drawer=identity\|about\|services\|dance\|partner\|offerings\|cover-library\|compliance\|showcase\|visibility\|account` | ?drawer | Open a specific edit drawer |
| L1 | PROFILE.PUBLIC | `/u/:identifier` | route (param) | View another user's public profile (@handle or UUID) |
| L1 | PROFILE.PRIVACY | `/profile/me/privacy` | route | Fine-grained profile visibility (E5) |
| L1 | PROFILE.MY_MATCHES | `/me/matches` | route | "People who match you" list |
| — | Search | `/search` | route | Global search (members/events/content/intents) |
| — | Reminders | `/reminders` | route | Reminder feed (`/inbox/reminder`,`/messages/reminder` redirect here) |
| — | Journey / Autopilot | `/autopilot` | route | Personalized journey (also a sidebar item; guided/full mode) |
| — | Invite Friends | `/invite` | route | Referral invites |
| — | Connectors | `/connectors` | route | Connected apps (also Settings + sidebar) |
| — | Cart | `/universal-cart` | route | Unified cart (`/cart` redirects) |
| — | Shop Feed | `/shop` | route | Video commerce feed |
| — | My Tickets | `/my-tickets` | route | Purchased event tickets |

> Redirects: `/profile` → `/me/profile`; `/profile/:id` → resolves → `/u/:identifier`; `/profile/subscriptions` → `/wallet/subscriptions` (desktop).

---

## Appendix A — Out-of-scope consoles (listed for completeness)

These are **separate desktop surfaces**, not part of the consumer navigation catalog the Vitana Navigator manages. Captured here so the inventory is complete.

- **Admin console** — `/admin/*`, 13 sidebar sections (`src/config/admin-navigation.ts`), each with a horizontal **sub-route** tab bar (NOT `?tab=` — real paths): Overview, Members, Assistant, Knowledge, Feedback, **Navigator** (`/admin/navigator` — the screen we manage all this from), Autopilot, Community, Content, Notifications, Insights, Settings, Audit & Compliance, plus Marketplace. ~110 admin routes total.
- **Role portals** — `/patient/*` (8), `/professional/*` (8), `/staff/*` (8): role-gated dashboards (own sidebars via `getRoleNavigation(role)`).
- **Dev Hub** — `/dev/*` + bare `/agents,/cicd,/oasis,/observability,/pipelines,/vtid,/gateway,/command,/docs,/analytics`: `DevAuthGuard`-gated internal tooling.
- **Auth / public** — `/` `/maxina` `/alkalma` `/earthlinks` `/exafy-admin` `/login` `/register` `/reset-password` `/onboarding/welcome` `/auth/confirmed` `/oauth/complete` `/_intro/:tenantSlug` `/e/:slug` `/pub/events/:id` `/pub/campaigns/:id` `/apply` `/redeem` `/privacy` `/terms` `/delete-account` `/logout`.

---

## Cross-cutting findings (so far)

1. **Deep-link coverage is uneven.** Health, Discover-Deals, Community, Wallet-Balance, Memory, Assistant use real `?tab=`/`?view=` deep-links. **Business, Discover (Doctors/Orders), Wallet-hub, Inbox** keep their L3 tabs **state-only (no URL)** — so the navigator/voice layer can't deep-link them. This is the desktop analogue of the "excluded state-only tabs" gap.
2. **Param vocabulary is inconsistent:** `?tab=`, `?view=`, `?section=`, `?filter=`, plus dotted leaves on mobile (`?tab=insights.earnings`). Worth standardizing for the catalog.
3. This inventory is the clean basis for a **desktop-native `nav_catalog`** rebuild — every L2/L3 here maps to one catalog row (screen_id + route + deep-link type), with state-only tabs flagged for a deep-link decision.
