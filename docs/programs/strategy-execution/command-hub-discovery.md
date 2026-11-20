# Command Hub discovery (strategy execution wave 1)

- **Status:** Discovery record. Read-only. Nothing in Command Hub, the gateway, a schema, a flag or a workflow is changed by this document.
- **Owner:** Project owner (approver); developer-experience owner for the follow-ups.
- **Pinned HEAD:** `exafyltd/vitana-platform` `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`. Every `file:line` below is checked against this commit (`docs/validation/VTID-05687/commands.log`).
- **VTID:** VTID-05687 (lane `strategy-execution-wave1/ch-discovery`).
- **Plan:** `.kiro/specs/strategy-execution-wave1/plan.md` §2, §3, §4.1.
- **Builds on:** the strategy inventory in GitLab project `vitana/vitanaland-strategy` (`02-PLATFORM/command-hub-modernisation.md`, `13-EXISTING-PLATFORM-AND-IMPLEMENTATION-INVENTORY/command-hub.md`). Each fact taken from there was re-read at the pinned HEAD. One correction: those files cite the PUBLISH bypass at `routes/operator.ts:2198-2218`; it is at `routes/operator.ts:2202-2219`.

## 1. Status classes used

Every statement about a system carries one of these classes.

| Class | Meaning here |
|---|---|
| Verified operational | Proven by a recorded run id. **No tab reaches this class in this document**, because the lane calls no live system. |
| Verified implemented, not operational | The render code and a serving route exist at HEAD and match. Not proven to work in a deployed environment. |
| Implemented but incomplete | Code exists, but a call has no serving route, a part is static, or a stated purpose is not met. |
| Designed but not implemented | A placeholder or a design without code. |
| Deprecated/superseded | Static, GCP-era or pointer content that another screen or source replaces. |
| Unknown | Not determinable from the code. |

## 2. Method

1. Sections and tabs come from `NAVIGATION_CONFIG` (`app.js:3236-3549`): 26 sections and 135 tabs. 25 sections are in the sidebar. Feedback is routable but has `"sidebar": false` (`app.js:3541`) and `renderSidebar` skips it (`app.js:5825`).
2. Render functions come from the dispatcher `renderModuleContent` (`app.js:8050-8446`). Tabs drawn by extracted modules were read in those files (`frontend/command-hub/operator-console.js`, `frontend/command-hub/delivery.js`, `frontend/command-hub/loops-catalog.js`, `frontend/command-hub/voice-supervisor.js`).
3. API calls were extracted from each render function and the helpers it calls (up to three levels), including prefixed helpers such as `_convFetch` (`app.js:7303`) and `fetchVcaop` (`app.js:14056`). The HTTP method was read from the `fetch` options next to the URL.
4. Each API path was matched to a route definition in `services/gateway/src/routes/**` through its mount in `services/gateway/src/index.ts` (304 `mountRouterSync` mounts). Auth is the route middleware on that line plus any `router.use` before it. Where there is none, the first lines of the handler were searched for a check (`verifyExafyAdmin`, `verifyAdminAccess`, `getBearerToken`, an `exafy_admin` test). "No auth found at route or handler start" means this static search found none. It does not prove the endpoint is open in a deployed environment; that is **Unknown** because nothing live was probed.
5. Data: tables and RPCs named in the route handler (`.from('…')`, `.rpc('…')`, PostgREST `table?select=` and `/rest/v1/…` strings). When the handler names none, the tables named anywhere in the route file are listed and marked "route file only". Reads inside service modules were not traced.
6. Where two route files define the same path, both are listed. The earlier mount in `index.ts` answers; the route guard (`governance/route-guard.ts:1-9`) reports the duplicate as an OASIS event.

Citation shorthand: `app.js:N` is `services/gateway/src/frontend/command-hub/app.js`. Paths that start with `routes/`, `frontend/`, `services/gitlab-events/`, `services/project-manager/`, `governance/`, `middleware/` or the file `index.ts` are under `services/gateway/src/`. Other paths are relative to the repository root.

### 2.1 Permissions, all sections

- The shell requires a signed-in user before it draws anything (`app.js:5554`).
- The sidebar has no role or tenant filter (`app.js:5788-5835`). Every signed-in viewer sees all 25 sidebar sections. The server route is the only gate.
- The Command Hub HTML is served with a CSP and no auth of its own (`routes/command-hub.ts:57-81`).
- Of the 252 distinct route handlers the tabs reach, the static search found no auth for 59. 54 are reads. 5 are writes:
  - `PATCH /api/v1/specs/:vtid` (`routes/specs.ts:745`)
  - `POST /api/v1/agents/triage/investigate` (`routes/triage-agent.ts:168`)
  - `PUT /api/v1/ai-personality/:surface_key` (`routes/ai-personality.ts:69`) and `POST /api/v1/ai-personality/:surface_key/reset` (`routes/ai-personality.ts:120`)
  - `POST /api/v1/llm/routing-policy/reset` (`routes/llm.ts:236`), which trusts a caller-supplied `x-actor-role` header (`routes/llm.ts:242-247`).
  
  Several unauthenticated reads use the service role key, for example the board (`routes/board-adapter.ts:118-127`) and OASIS events (`routes/events.ts:578-585`). Exposure on the deployed gateway is **Unknown**. Follow-up F-02 asks for a security review before anything else is built on these routes.

## 3. Section and tab inventory

Each tab lists its `NAVIGATION_CONFIG` line, render function, API calls with the serving route and auth, data read, status and gaps. Section labels come from `SECTION_LABELS` (`app.js:3551-3578`).

### 3.1 Overview (`overview`, `app.js:3238`)
Purpose: one attention screen. The other four former Overview tabs are router redirects (`OVERVIEW_TAB_REDIRECTS`, `app.js:12205`).

- **`system-overview`** (`app.js:3243`)
  - Render: `renderOverviewSystemView` (`app.js:27788`)
  - API → route (auth):
    - `GET /api/v1/admin/health-registry` → `routes/admin-health.ts:113` (no auth found at route or handler start)
    - `GET /api/v1/admin/health/summary` → `routes/admin-health.ts:143` (requireAdminAuth; in-handler: authenticated)
    - `POST /api/v1/autopilot/recommendations/generate-personal` → `routes/autopilot-recommendations.ts:1001` (optionalAuth)
    - `POST /api/v1/autopilot/recommendations/community-scan` → `routes/autopilot-recommendations.ts:2282` (optionalAuth; in-handler: exafy_admin)
    - `POST /api/v1/autopilot/recommendations/generate` → `routes/autopilot-recommendations.ts:2332` (optionalAuth)
    - `POST /api/v1/autopilot/recommendations/:id/activate` → `routes/autopilot-recommendations.ts:1783` (optionalAuth)
    - `GET /api/v1/commandhub/board` → `routes/board-adapter.ts:118` (no auth found at route or handler start)
    - `GET /api/v1/ops/attention` → `routes/ops-attention.ts:38` (requireAdminAuth)
    - `GET /api/v1/ops/pipeline-summary` → `routes/ops-pipeline-summary.ts:65` (requireAdminAuth)
  - Data: handler: `autopilot_recommendations`, `oasis_events`, `oasis_specs`, `vtid_ledger`; route file only (service layer, not traced): `rpc`
  - Status: Verified implemented, not operational
  - Gaps: No plans, lanes, claims, seats, driver heartbeats or GitLab state.

### 3.2 Admin (`admin`, `app.js:3247`)
Purpose: users, roles, tenants, moderation, analytics, billing. Most admin routes check the caller inside the handler (`verifyAdminAccess`, `verifyExafyAdmin`), not as route middleware.

- **`users`** (`app.js:3250`)
  - Render: `renderAdminUsersView` (`app.js:12933`)
  - API → route (auth):
    - `GET /api/v1/admin/users` → `routes/admin-users.ts:128` (in-handler: verifyAdminAccess)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Auth is checked inside the handler (`routes/admin-users.ts:48`, dual mode: exafy_admin or tenant admin).
- **`permissions`** (`app.js:3251`)
  - Render: `renderAdminPermissionsView` (`app.js:13076`)
  - API → route (auth):
    - `GET /api/v1/admin/users` → `routes/admin-users.ts:128` (in-handler: verifyAdminAccess)
    - `GET /api/v1/admin/users/roles-summary` → `routes/admin-users.ts:220` (in-handler: verifyAdminAccess)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Reads the same admin-users route; no permission catalogue route.
- **`tenants`** (`app.js:3252`)
  - Render: `renderAdminTenantsView` (`app.js:13210`)
  - API → route (auth):
    - `GET /api/v1/admin/ai-assistants/catalog` → `routes/admin/ai-integrations.ts:53` (in-handler: requireAdmin)
    - `PATCH /api/v1/admin/ai-assistants/catalog/:provider` → `routes/admin/ai-integrations.ts:68` (in-handler: requireAdmin)
    - `GET /api/v1/admin/ai-assistants/connections` → `routes/admin/ai-integrations.ts:189` (in-handler: requireAdmin)
    - `GET /api/v1/admin/ai-assistants/consent-log` → `routes/admin/ai-integrations.ts:252` (in-handler: requireAdmin)
    - `GET /api/v1/admin/ai-assistants/policies/:tenant` → `routes/admin/ai-integrations.ts:94` (in-handler: requireAdmin)
    - `PUT /api/v1/admin/ai-assistants/policies/:tenant` → `routes/admin/ai-integrations.ts:119` (in-handler: requireAdmin)
    - `GET /api/v1/admin/tenants` → `routes/admin-tenants.ts:76` (in-handler: verifyExafyAdmin)
    - `GET /api/v1/admin/tenants/:id` → `routes/admin-tenants.ts:127` (in-handler: verifyExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Overlaps the multi-tenant programme lane `mt-tenant-admin-r2` / `command-hub-tenant-module`. Tenant auth is checked in the handler (`routes/admin-tenants.ts:63`).
- **`content-moderation`** (`app.js:3253`)
  - Render: `renderAdminContentModerationView` (`app.js:13405`)
  - API → route (auth):
    - `GET /api/v1/admin/moderation/reports` → `routes/admin-moderation.ts:50` (in-handler: verifyExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`identity-access`** (`app.js:3254`)
  - Render: `renderAdminIdentityAccessView` (`app.js:14758`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Implemented but incomplete
  - Gaps: Reads generic OASIS events; no identity or session store is read.
- **`analytics`** (`app.js:3255`)
  - Render: `renderAdminAnalyticsView` (`app.js:34101`)
  - API → route (auth):
    - `GET /api/v1/admin/notifications/preferences/stats` → `routes/admin-notifications.ts:179` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/signups/stats` → `routes/admin-signups.ts:64` (requireExafyAdmin)
    - `GET /api/v1/admin/tenants` → `routes/admin-tenants.ts:76` (in-handler: verifyExafyAdmin)
    - `GET /api/v1/admin/users` → `routes/admin-users.ts:128` (in-handler: verifyAdminAccess)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`billing-dashboard`** (`app.js:3256`)
  - Render: `renderAdminBillingDashboardView` (`app.js:13638`)
  - API → route (auth):
    - `GET /api/v1/billing/admin/metrics` → `routes/billing.ts:1241` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`billing-codes`** (`app.js:3257`)
  - Render: `renderAdminBillingCodesView` (`app.js:13891`)
  - API → route (auth):
    - `GET /api/v1/billing/admin/redemption-codes` → `routes/billing.ts:1169` (requireAuth, requireExafyAdmin)
    - `PATCH /api/v1/billing/admin/redemption-codes/:code` → `routes/billing.ts:1205` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/billing/admin/redemption-codes/generate` → `routes/billing.ts:1082` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.3 Commerce (`commerce`, `app.js:3261`)
Purpose: operator view of VCAOP and marketplace sources. VCAOP calls go through `fetchVcaop` (`app.js:14056`, prefix `/api/v1/vcaop`).

- **`overview`** (`app.js:3264`)
  - Render: `renderCommerceOverviewView` (`app.js:14139`)
  - API → route (auth):
    - `GET /api/v1/vcaop/affiliate-programs` → `routes/vcaop.ts:63` (requireAuth)
    - `GET /api/v1/vcaop/commissions` → `routes/vcaop.ts:184` (requireAuth)
    - `GET /api/v1/vcaop/onboarding/inbox` → `routes/vcaop.ts:220` (requireAuth)
    - `GET /api/v1/vcaop/providers` → `routes/vcaop.ts:56` (requireAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
  - Gaps: VCAOP is not the canonical supplier root; supplier review also lives in `partner-review.html`.
- **`providers-onboarding`** (`app.js:3265`)
  - Render: `renderCommerceProvidersOnboardingView` (`app.js:14169`)
  - API → route (auth):
    - `GET /api/v1/vcaop/affiliate-programs` → `routes/vcaop.ts:63` (requireAuth)
    - `GET /api/v1/vcaop/commissions` → `routes/vcaop.ts:184` (requireAuth)
    - `POST /api/v1/vcaop/onboarding/batch` → `routes/vcaop.ts:228` (requireAuth)
    - `GET /api/v1/vcaop/onboarding/inbox` → `routes/vcaop.ts:220` (requireAuth)
    - `GET /api/v1/vcaop/providers` → `routes/vcaop.ts:56` (requireAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
- **`commissions-rewards`** (`app.js:3266`)
  - Render: `renderCommerceCommissionsView` (`app.js:14256`)
  - API → route (auth):
    - `GET /api/v1/vcaop/affiliate-programs` → `routes/vcaop.ts:63` (requireAuth)
    - `GET /api/v1/vcaop/commissions` → `routes/vcaop.ts:184` (requireAuth)
    - `GET /api/v1/vcaop/onboarding/inbox` → `routes/vcaop.ts:220` (requireAuth)
    - `GET /api/v1/vcaop/providers` → `routes/vcaop.ts:56` (requireAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
- **`affiliate-programs`** (`app.js:3267`)
  - Render: `renderCommerceAffiliateProgramsView` (`app.js:14306`)
  - API → route (auth):
    - `GET /api/v1/vcaop/affiliate-programs` → `routes/vcaop.ts:63` (requireAuth)
    - `GET /api/v1/vcaop/commissions` → `routes/vcaop.ts:184` (requireAuth)
    - `GET /api/v1/vcaop/onboarding/inbox` → `routes/vcaop.ts:220` (requireAuth)
    - `GET /api/v1/vcaop/providers` → `routes/vcaop.ts:56` (requireAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
- **`marketplace-shops`** (`app.js:3268`)
  - Render: `renderAdminMarketplaceShopsView` (`app.js:14320`)
  - API → route (auth):
    - `GET /api/v1/admin/marketplace/providers` → `routes/admin-marketplace.ts:279` (requireTenantAdmin)
    - `GET /api/v1/admin/marketplace/sources` → `routes/admin-marketplace.ts:344` (requireTenantAdmin)
    - `POST /api/v1/admin/marketplace/sources` → `routes/admin-marketplace.ts:353` (requireTenantAdmin)
    - `PATCH /api/v1/admin/marketplace/sources/:id` → `routes/admin-marketplace.ts:381` (requireTenantAdmin)
    - `POST /api/v1/admin/marketplace/sync/:network` → `routes/admin-marketplace.ts:396` (requireTenantAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`marketplace-review`** (`app.js:3269`)
  - Render: `renderAdminMarketplaceReviewView` (`app.js:14659`)
  - API → route (auth):
    - `GET /api/v1/admin/marketplace/products` → `routes/admin-marketplace.ts:122` (requireTenantAdmin)
    - `POST /api/v1/admin/marketplace/products/bulk-action` → `routes/admin-marketplace.ts:154` (requireTenantAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.4 Knowledge Base (`knowledge-base`, `app.js:3273`)
Purpose: Guided Journey curriculum checklist (VTID-03278).

- **`checklist`** (`app.js:3276`)
  - Render: `renderKbChecklistView` (`app.js:7138`)
  - API → route (auth):
    - `POST /api/v1/admin/journey-checklist/rollback` → `routes/journey-checklist-admin.ts:224` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/journey-checklist/topics` → `routes/journey-checklist-admin.ts:64` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/journey-checklist/topics/:id` → `routes/journey-checklist-admin.ts:83` (requireAuth, requireExafyAdmin)
    - `PATCH /api/v1/admin/journey-checklist/topics/:id` → `routes/journey-checklist-admin.ts:115` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/admin/journey-checklist/topics/:id/disable` → `routes/journey-checklist-admin.ts:128` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/journey-checklist/versions` → `routes/journey-checklist-admin.ts:196` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: The section name suggests a general knowledge base; System Knowledge lives under Docs.

### 3.5 Assistant (`assistant`, `app.js:3280`)
Purpose: assistant overview, personality and learning metrics.

- **`overview`** (`app.js:3283`)
  - Render: `renderAssistantOverviewView` (`app.js:47088`)
  - API → route (auth):
    - `GET /api/v1/events` → `routes/events.ts:282` (no auth found at route or handler start)
    - `GET /api/v1/orb/debug/awareness` → `routes/orb-live.ts:15067` (optionalAuth)
    - `GET /api/v1/voice-lab/live/sessions` → `routes/voice-lab.ts:751` (requireVoiceLabDevAccess)
  - Data: handler: `oasis_events`, `user_tenants`; route file only (service layer, not traced): `voice_architecture_reports`
  - Status: Verified implemented, not operational
- **`sessions`** (`app.js:3284`)
  - Render: `renderVoiceLabPlaceholderPanel` (`app.js:17581`)
  - API: none. Placeholder panel `renderVoiceLabPlaceholderPanel('Sessions', 'VTID-01218C')` at `app.js:8100`. Voice → Sessions holds the real list.
  - Status: Designed but not implemented
- **`personality`** (`app.js:3285`)
  - Render: `renderVoiceLabPersonalityPanel` (`app.js:18034`)
  - API → route (auth):
    - `GET /api/v1/ai-personality` → `routes/ai-personality.ts:28` (no auth found at route or handler start)
    - `PUT /api/v1/ai-personality/:surface_key` → `routes/ai-personality.ts:69` (no auth found at route or handler start)
    - `POST /api/v1/ai-personality/:surface_key/reset` → `routes/ai-personality.ts:120` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Personality read and reset routes have no route-level auth.
- **`experiments`** (`app.js:3286`)
  - Render: `renderVoiceLabExperimentsPanel` (`app.js:17631`)
  - API: none. Local runtime-control panel only. Its model options are dead Gemini Live ids (`app.js:17750-17751`); voice runs on Amazon Nova Sonic.
  - Status: Deprecated/superseded
- **`metrics`** (`app.js:3287`)
  - Render: `renderAssistantLearningHealthView` (`app.js:7691`)
  - API → route (auth):
    - `GET /api/v1/admin/conversation/metrics/learning` → `routes/conversation-hub.ts:560` (adminOnly)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.6 Conversation (`conversation`, `app.js:3294`)
Purpose: read-only cockpit of the conversation brain. Reads go through `_convFetch` (`app.js:7303`, prefix `/api/v1`).

- **`config`** (`app.js:3297`)
  - Render: `renderConversationConfigView` (`app.js:7364`)
  - API → route (auth):
    - `GET /api/v1/admin/conversation/config` → `routes/conversation-hub.ts:141` (adminOnly)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`monitor`** (`app.js:3298`)
  - Render: `renderConversationMonitorView` (`app.js:7602`)
  - API → route (auth):
    - `GET /api/v1/admin/conversation/decisions` → `routes/conversation-hub.ts:267` (adminOnly)
    - `GET /api/v1/admin/conversation/metrics/summary` → `routes/conversation-hub.ts:518` (adminOnly)
    - `GET /api/v1/admin/conversation/offer-outcomes` → `routes/conversation-hub.ts:378` (adminOnly)
    - `GET /api/v1/admin/conversation/shadow-ranking` → `routes/conversation-hub.ts:478` (adminOnly)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`tools`** (`app.js:3299`)
  - Render: `renderConversationToolHealthView` (`app.js:7700`)
  - API → route (auth):
    - `GET /api/v1/admin/conversation/tool-failures` → `routes/conversation-hub.ts:300` (adminOnly)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`simulator`** (`app.js:3300`)
  - Render: `renderConversationSimulatorView` (`app.js:7940`)
  - API → route (auth):
    - `GET /api/v1/admin/conversation/preview` → `routes/conversation-hub.ts:178` (adminOnly)
    - `GET /api/v1/admin/conversation/sessions` → `routes/conversation-hub.ts:357` (adminOnly)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Dry run; it never speaks.
- **`awareness`** (`app.js:3301`)
  - Render: `renderVoiceAwarenessView` (`app.js:40271`)
  - API → route (auth):
    - `GET /api/v1/awareness/audit` → `routes/awareness-config.ts:58` (requireAdminAuth)
    - `GET /api/v1/awareness/config` → `routes/awareness-config.ts:39` (requireAdminAuth)
    - `GET /api/v1/orb/debug/awareness` → `routes/orb-live.ts:15067` (optionalAuth)
    - `GET /api/v1/voice/awareness/watchdogs` → `routes/voice-awareness.ts:21` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/voice/improvement/items/:id/create-vtid` → `routes/voice-improve.ts:92` (requireAuthWithTenant; in-handler: exafy_admin)
    - `GET /api/v1/voice/teach-vitanaland/state` → `routes/voice-teach-inspector.ts:36` (requireAuthWithTenant, requireExafyAdmin)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/voice/improvement/items/:p`
  - Data: handler: `allocate_global_vtid`, `user_tenants`, `vtid_ledger`
  - Status: Implemented but incomplete
- **`journey-context`** (`app.js:3302`)
  - Render: `renderJourneyContextView` (`app.js:40572`)
  - API → route (auth):
    - `GET /api/v1/admin/conversation/sessions` → `routes/conversation-hub.ts:357` (adminOnly)
    - `GET /api/v1/voice/concept-mastery/preview` → `routes/voice-concept-mastery.ts:30` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/continuity/preview` → `routes/voice-continuity.ts:29` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/feature-discovery/preview` → `routes/voice-feature-discovery.ts:41` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/greeting-policy/preview` → `routes/voice-greeting-policy.ts:63` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/journey-context/preview` → `routes/voice-journey-context.ts:47` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/journey-context/state` → `routes/voice-journey-context.ts:104` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/journey-stage/preview` → `routes/voice-journey-stage.ts:32` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/next-action/inspector` → `routes/voice-next-action-inspector.ts:80` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/voice/wake-timeline/analysis` → `routes/voice-wake-timeline.ts:203` (requireAuthWithTenant, requireExafyAdmin)
    - `GET /api/v1/voice/wake-timeline/recent` → `routes/voice-wake-timeline.ts:85` (requireAuthWithTenant, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`tool-catalog`** (`app.js:3303`)
  - Render: `renderVoiceToolsCatalogView` (`app.js:46782`)
  - API → route (auth):
    - `GET /api/v1/voice-tools/catalog` → `routes/voice-tools-catalog.ts:80` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/voice-tools/catalog/stats` → `routes/voice-tools-catalog.ts:118` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.7 Voice (`voice`, `app.js:3315`)
Purpose: voice supervisor cockpit (VTID-04777 to 04780). Overview, Tenants & Roles and Sessions are drawn by `voice-supervisor.js` (API base at `frontend/command-hub/voice-supervisor.js:35`).

- **`overview`** (`app.js:3318`)
  - Render: `renderVoiceSupervisorScreen` (`app.js:18298`) → `renderVoiceSupervisorOverview` (`frontend/command-hub/voice-supervisor.js:1161`)
  - API → route (auth):
    - `GET /api/v1/voice/supervisor/meta` → `routes/voice-supervisor.ts:166` (requireSupervisorAccess)
    - `GET /api/v1/voice/supervisor/overview` → `routes/voice-supervisor.ts:194` (requireSupervisorAccess)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`segments`** (`app.js:3319`)
  - Render: `renderVoiceSupervisorScreen` (`app.js:18298`) → `renderVoiceSupervisorSegments` (`frontend/command-hub/voice-supervisor.js:1164`)
  - API → route (auth):
    - `GET /api/v1/voice/supervisor/segments` → `routes/voice-supervisor.ts:216` (requireSupervisorAccess)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: The only tenant × role matrix in Command Hub.
- **`sessions`** (`app.js:3320`)
  - Render: `renderVoiceSupervisorScreen` (`app.js:18298`), `mountVoiceLabSessionDrawer` (`app.js:18281`)
  - API → route (auth):
    - `POST /api/v1/agents/triage/investigate` → `routes/triage-agent.ts:168` (no auth found at route or handler start)
    - `GET /api/v1/voice/supervisor/sessions` → `routes/voice-supervisor.ts:237` (requireSupervisorAccess)
  - Data: route file only (service layer, not traced): `oasis_events`
  - Status: Verified implemented, not operational
- **`issues-healing`** (`app.js:3321`)
  - Render: `renderVoiceIssuesHealingView` (`app.js:39830`)
  - API → route (auth):
    - `GET /api/v1/dev-autopilot/findings/:id` → `routes/dev-autopilot.ts:869` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/approve-auto-execute` → `routes/dev-autopilot.ts:1035` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/reject` → `routes/dev-autopilot.ts:952` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/snooze` → `routes/dev-autopilot.ts:1002` (requireDevRole)
    - `GET /api/v1/voice-lab/healing/reports/:id` → `routes/voice-lab.ts:1267` (requireVoiceLabDevAccess)
    - `POST /api/v1/voice-lab/healing/reports/:id/execute` → `routes/voice-lab.ts:1403` (requireExafyAdmin, requireVoiceLabDevAccess; in-handler: exafy_admin)
    - `GET /api/v1/voice/improvement/briefing` → `routes/voice-improve.ts:75` (requireDevAccess)
    - `POST /api/v1/voice/improvement/items/:id/create-vtid` → `routes/voice-improve.ts:92` (requireAuthWithTenant; in-handler: exafy_admin)
    - `GET /api/v1/voice/supervisor/fixes` → `routes/voice-supervisor.ts:292` (requireSupervisorAccess)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/voice/improvement/items/:p`
  - Data: handler: `allocate_global_vtid`, `autopilot_recommendations`, `dev_autopilot_plan_versions`, `voice_architecture_reports`, `vtid_ledger`; route file only (service layer, not traced): `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_runs`, `dev_autopilot_scanners`, `dev_autopilot_signals`, `oasis_events`
  - Status: Implemented but incomplete
- **`test-bench`** (`app.js:3322`)
  - Render: `renderVoiceTestBenchView` (`app.js:39894`)
  - API → route (auth):
    - `GET /api/v1/voice-lab/tests/cases` → `routes/voice-lab.ts:316` (livekitTestsAuthGate)
    - `GET /api/v1/voice-lab/tests/coverage` → `routes/voice-lab.ts:486` (livekitTestsAuthGate; in-handler: exafy_admin)
    - `POST /api/v1/voice-lab/tests/run` → `routes/voice-lab.ts:204` (livekitTestsAuthGate)
    - `GET /api/v1/voice-lab/tests/runs` → `routes/voice-lab.ts:272` (livekitTestsAuthGate)
    - `POST /api/v1/voice-lab/nova/tests/run` → `routes/voice-lab.ts:357` (livekitTestsAuthGate)
    - `GET /api/v1/voice-lab/nova/tests/runs` → `routes/voice-lab.ts:387` (livekitTestsAuthGate)
    - `GET /api/v1/voice-lab/nova/decision` → `routes/voice-lab.ts:406` (optionalAuth)
    - `POST /api/v1/orb/livekit/token` → `routes/orb-livekit.ts:725` (optionalAuth)
    - `GET /api/v1/orb/context-bootstrap` → `routes/orb-livekit.ts:1008` (optionalAuth)
    - `GET /api/v1/orb/nova-sonic/health` → `routes/orb-livekit.ts:645` (no auth found at route or handler start)
    - `GET /api/v1/orb/health` → `routes/orb-live.ts:17416` (no auth found at route or handler start)
    - `POST /api/v1/orb/tts` → `routes/orb-live.ts:16942` (optionalAuth)
    - … 1 more matched routes, omitted for length
  - API note: The bench also embeds the ORB widget runtime (`frontend/command-hub/orb-widget.js`); its tool calls reach many member routes and are not listed here.
  - Data: handler: `oasis_events`, `user_tenants`; route file only (service layer, not traced): `advance_capability_awareness`, `agent_personas`, `autopilot_recommendations`, `build_specialist_context`, `community_recommendations`, `feedback_handoff_events`, `intent_match_recommendations`, `matches_daily`
  - Status: Verified implemented, not operational
- **`providers`** (`app.js:3323`)
  - Render: `renderVoiceProvidersView` (`app.js:39334`)
  - API → route (auth):
    - `GET /api/v1/orb/active-provider` → `routes/orb-livekit.ts:485` (optionalAuth)
    - `POST /api/v1/orb/active-provider` → `routes/orb-livekit.ts:556` (requireAuthWithTenant; in-handler: exafy_admin)
    - `GET /api/v1/voice/config` → `routes/voice-config.ts:103` (no auth found at route or handler start)
    - `PUT /api/v1/voice/config` → `routes/voice-config.ts:124` (requireAuthWithTenant; in-handler: exafy_admin)
    - `POST /api/v1/voice/preview` → `routes/voice-config.ts:194` (requireAuthWithTenant; in-handler: exafy_admin)
    - `GET /api/v1/voice/quality-by-provider` → `routes/voice-improve.ts:248` (requireDevAccess)
    - `GET /api/v1/voice/tts-voices` → `routes/voice-config.ts:164` (no auth found at route or handler start)
  - Data: route file only (service layer, not traced): `allocate_global_vtid`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: The Nova Sonic transport keeps the legacy wire value `vertex` (VTID-03970).

### 3.8 Autonomy (`autonomy`, `app.js:3327`)
Purpose: autonomy supervision. Overlaps the Autopilot section.

- **`autopilot-community`** (`app.js:3330`)
  - Render: `renderAutopilotCommunityView` (`app.js:46982`)
  - API: none. Static pointer card that soft-navigates to Autopilot → Registry (`app.js:46982`).
  - Status: Deprecated/superseded
- **`autopilot-developer`** (`app.js:3331`)
  - Render: `renderDevAutopilotView` (`app.js:36972`)
  - API → route (auth):
    - `GET /api/v1/dev-autopilot/config` → `routes/dev-autopilot.ts:1397` (requireDevRole)
    - `POST /api/v1/dev-autopilot/config/kill-switch` → `routes/dev-autopilot.ts:1407` (requireDevRole)
    - `POST /api/v1/dev-autopilot/config/update` → `routes/dev-autopilot.ts:1429` (requireDevRole)
    - `GET /api/v1/dev-autopilot/executions` → `routes/dev-autopilot.ts:1322` (requireDevRole)
    - `GET /api/v1/dev-autopilot/findings/:id` → `routes/dev-autopilot.ts:869` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/generate-plan` → `routes/dev-autopilot.ts:891` (requireDevRole)
    - `GET /api/v1/dev-autopilot/queue` → `routes/dev-autopilot.ts:793` (requireDevRole)
    - `GET /api/v1/dev-autopilot/runs` → `routes/dev-autopilot.ts:406` (requireDevRole)
    - `GET /api/v1/dev-autopilot/spend` → `routes/dev-autopilot.ts:1459` (requireDevRole)
  - Data: handler: `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`; route file only (service layer, not traced): `dev_autopilot_impact_rules`, `dev_autopilot_scanners`, `dev_autopilot_signals`, `oasis_events`
  - Status: Verified implemented, not operational
- **`loops`** (`app.js:3332`)
  - Render: `LoopsCatalog` (`frontend/command-hub/loops-catalog.js:320`) → `render` (`frontend/command-hub/loops-catalog.js:306`)
  - API → route (auth):
    - `GET /api/v1/autonomy/loops` → `routes/autonomy-loops.ts:25` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Loop catalogue only; no loop is started from here.
- **`self-healing`** (`app.js:3333`)
  - Render: `renderSelfHealingView` (`app.js:42057`)
  - API → route (auth):
    - `GET /api/v1/self-healing/active` → `routes/self-healing.ts:676` (no auth found at route or handler start)
    - `POST /api/v1/self-healing/approve` → `routes/self-healing.ts:891` (requireAdminOnly)
    - `GET /api/v1/self-healing/config` → `routes/self-healing.ts:605` (no auth found at route or handler start)
    - `PATCH /api/v1/self-healing/config` → `routes/self-healing.ts:620` (requireAdminOnly)
    - `GET /api/v1/self-healing/history` → `routes/self-healing.ts:704` (no auth found at route or handler start)
    - `GET /api/v1/self-healing/history/classes` → `routes/self-healing.ts:749` (no auth found at route or handler start)
    - `POST /api/v1/self-healing/kill-switch` → `routes/self-healing.ts:540` (requireAdminOnly)
    - `GET /api/v1/self-healing/pending-approval` → `routes/self-healing.ts:845` (no auth found at route or handler start)
    - `POST /api/v1/self-healing/reject` → `routes/self-healing.ts:999` (requireAdminOnly)
    - `POST /api/v1/self-healing/rollback/:vtid` → `routes/self-healing.ts:1122` (requireAdminOnly)
    - `PATCH /api/v1/specs/:vtid` → `routes/specs.ts:745` (no auth found at route or handler start)
    - `GET /api/v1/specs/:vtid` → `routes/specs.ts:1342` (no auth found at route or handler start)
    - … 1 more matched routes, omitted for length
  - Data: handler: `oasis_spec_approvals`, `oasis_spec_validations`, `oasis_specs`, `self_healing_log`, `self_healing_snapshots`, `system_config`, `vtid_ledger`; route file only (service layer, not traced): `dev_autopilot_executions`
  - Status: Verified implemented, not operational
  - Gaps: Read routes (active, config, history, pending-approval) have no route-level auth; writes use `requireAdminOnly`. The rollback reporting gap is tracked by lane `autonomy-risks`.
- **`autonomy-pulse`** (`app.js:3334`)
  - Render: `renderAutonomyPulseView` (`app.js:38451`)
  - API → route (auth):
    - `GET /api/v1/autonomy/pulse` → `routes/autonomy-pulse.ts:476` (requireDevRole)
    - `POST /api/v1/dev-autopilot/executions/:id/approve` → `routes/dev-autopilot.ts:1117` (requireDevRole)
    - `POST /api/v1/dev-autopilot/executions/:id/cancel` → `routes/dev-autopilot.ts:1079` (requireDevRole; in-handler: exafy_admin)
    - `POST /api/v1/dev-autopilot/executions/:id/reject` → `routes/dev-autopilot.ts:1122` (requireDevRole)
    - `GET /api/v1/dev-autopilot/findings/:id` → `routes/dev-autopilot.ts:869` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/approve-auto-execute` → `routes/dev-autopilot.ts:1035` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/reject` → `routes/dev-autopilot.ts:952` (requireDevRole)
    - `POST /api/v1/dev-autopilot/findings/:id/snooze` → `routes/dev-autopilot.ts:1002` (requireDevRole)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/dev-autopilot/executions/:p`
  - Data: handler: `autopilot_recommendations`, `dev_autopilot_plan_versions`; route file only (service layer, not traced): `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_runs`, `dev_autopilot_scanners`, `dev_autopilot_signals`, `oasis_events`
  - Status: Implemented but incomplete
- **`autonomy-trace`** (`app.js:3335`)
  - Render: `renderAutonomyTraceView` (`app.js:38753`)
  - API → route (auth):
    - `GET /api/v1/autonomy/trace` → `routes/autonomy-trace.ts:507` (requireDevRole)
  - Data: route file only (service layer, not traced): `dev_autopilot_executions`, `oasis_events`, `self_healing_log`
  - Status: Verified implemented, not operational

### 3.9 Operator (`operator`, `app.js:3339`)
Purpose: operator pipeline and operations tools, drawn by `operator-console.js`.

- **`dashboard`** (`app.js:3342`)
  - Render: `renderOperatorDashboardView` (`frontend/command-hub/operator-console.js:3146`)
  - API → route (auth):
    - `GET /api/v1/approvals/pending` → `routes/approvals.ts:396` (no auth found at route or handler start)
    - `GET /api/v1/operator/heartbeat` → `routes/operator.ts:1206` (no auth found at route or handler start)
    - `GET /api/v1/ops/pipeline-summary` → `routes/ops-pipeline-summary.ts:65` (requireAdminAuth)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`task-queue`** (`app.js:3343`)
  - Render: `renderOperatorTaskQueueView` (`frontend/command-hub/operator-console.js:2926`)
  - API → route (auth):
    - `GET /api/v1/tasks` → `routes/tasks.ts:28` (no auth found at route or handler start)
  - Data: handler: `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`event-stream`** (`app.js:3344`)
  - Render: `renderOperatorEventStreamView` (`frontend/command-hub/operator-console.js:3512`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
  - Gaps: A third OASIS event view (with Operations → events and OASIS → events).
- **`deployments`** (`app.js:3345`)
  - Render: `renderOperatorDeploymentsView` (`frontend/command-hub/operator-console.js:3728`)
  - API → route (auth):
    - `GET /api/v1/approvals/pending` → `routes/approvals.ts:396` (no auth found at route or handler start)
    - `GET /api/v1/operator/deployments` → `routes/operator.ts:1695` (no auth found at route or handler start)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: Overlaps Infrastructure → deployments and Delivery → releases. The deployments routes have no route-level auth.
- **`runbook`** (`app.js:3346`)
  - Render: `renderOperatorRunbookView` (`frontend/command-hub/operator-console.js:3956`)
  - API → route (auth):
    - `GET /api/v1/autopilot/recommendations` → `routes/autopilot-recommendations.ts:639` (optionalAuth)
    - `GET /api/v1/ops/pipeline-summary` → `routes/ops-pipeline-summary.ts:65` (requireAdminAuth)
  - Data: route file only (service layer, not traced): `autopilot_recommendations`, `oasis_specs`, `rpc`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`localization`** (`app.js:3347`)
  - Render: `renderOperatorLocalizationView` (`frontend/command-hub/operator-console.js:4182`)
  - API → route (auth):
    - `POST /api/v1/admin/i18n-ops/audit` → `routes/admin-i18n-ops.ts:318` (requireExafyAdmin)
    - `GET /api/v1/admin/i18n-ops/locales` → `routes/admin-i18n-ops.ts:177` (requireExafyAdmin)
    - `POST /api/v1/admin/i18n-ops/translate` → `routes/admin-i18n-ops.ts:283` (requireExafyAdmin)
    - `GET /api/v1/admin/i18n-ops/workflow-runs` → `routes/admin-i18n-ops.ts:353` (requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.10 Operations (`command-hub`, `app.js:3351`)
Purpose: the original core (tasks board, Operator Chat, events, VTIDs, approvals). Labelled "Operations" in the sidebar. The board keeps local title, status and spec overrides in `localStorage` (`app.js:501`, `:529`, `:558`) beside server state.

- **`tasks`** (`app.js:3354`)
  - Render: `renderTasksView` (`app.js:8586`)
  - API → route (auth):
    - `GET /api/v1/commandhub/board` → `routes/board-adapter.ts:118` (no auth found at route or handler start)
    - `PATCH /api/v1/oasis/tasks/:id` → `routes/oasis-tasks.ts:332` (requireLedgerWriteAuth)
    - `DELETE /api/v1/oasis/tasks/:id` → `routes/oasis-tasks.ts:383` (requireLedgerWriteAuth)
    - `GET /api/v1/vtid/:vtid` → `routes/vtid.ts:1174` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid` → `routes/tasks.ts:206` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid/execution-status` → `routes/tasks.ts:322` (no auth found at route or handler start)
  - Data: handler: `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: Board read routes have no route-level auth and read with the service role (`routes/board-adapter.ts:118-127`). Local overrides can disagree with `vtid_ledger`.
- **`live-console`** (`app.js:3355`)
  - Render: `renderCommandHubLiveConsoleView` (`app.js:28261`)
  - API → route (auth):
    - `POST /api/v1/operator/chat` → `routes/operator.ts:809` (operatorMachineAuth, optionalAuth)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: Operator Chat is also one of the two Gate 2 channels (CLAUDE.md rule 49).
- **`events`** (`app.js:3356`)
  - Render: `renderCommandHubEventsView` (`app.js:21755`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
- **`vtids`** (`app.js:3357`)
  - Render: `renderVtidsView` (`app.js:22010`)
  - API → route (auth):
    - `GET /api/v1/vtid/projection` → `routes/vtid.ts:885` (no auth found at route or handler start)
  - Data: handler: `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`approvals`** (`app.js:3358`)
  - Render: `renderApprovalsView` (`app.js:22547`)
  - API → route (auth):
    - `GET /api/v1/approvals/feed` → `routes/approvals.ts:478` (no auth found at route or handler start)
    - `POST /api/v1/cicd/autonomous-pr-merge` → `routes/cicd.ts:1342` (requireServiceOrAdmin)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: `POST /api/v1/cicd/autonomous-pr-merge` merges GitHub PRs (`routes/cicd.ts:18`). It is a second merge path beside the §7b PM rule and is GitHub-only.

### 3.11 Delivery (`delivery`, `app.js:3364`)
Purpose: merge queue, pipelines and releases (VTID-05547). Drawn by `delivery.js` (loaded on demand, `app.js:8055`). The route reads only `vtid_ledger` and `oasis_events` (`routes/delivery.ts:10-11`, `:67`, `:74`). GitLab facts arrive as OASIS rows from the webhook (section 5).

- **`merge-queue`** (`app.js:3367`)
  - Render: `deliveryModule` (`app.js:8012`) → `renderQueue` (`frontend/command-hub/delivery.js:192`)
  - API → route (auth):
    - `GET /api/v1/delivery/summary` → `routes/delivery.ts:101` (requireServiceOrAdmin)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: No view of plans, lanes, claims, seats or driver heartbeats. GitLab MR review state is shown only as far as the webhook maps it.
- **`pipeline-runs`** (`app.js:3369`)
  - Render: `deliveryModule` (`app.js:8012`) → `renderPipelines` (`frontend/command-hub/delivery.js:221`)
  - API → route (auth):
    - `GET /api/v1/delivery/summary` → `routes/delivery.ts:101` (requireServiceOrAdmin)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`releases`** (`app.js:3370`)
  - Render: `deliveryModule` (`app.js:8012`) → `renderReleases` (`frontend/command-hub/delivery.js:256`)
  - API → route (auth):
    - `GET /api/v1/delivery/summary` → `routes/delivery.ts:101` (requireServiceOrAdmin)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: Release truth is split with Operator → deployments and Infrastructure → deployments.

### 3.12 Governance (`governance`, `app.js:3374`)
Purpose: governance rules, evaluations, violations, controls. The whole router uses `optionalAuth` (`routes/governance.ts:12`).

- **`rules`** (`app.js:3377`)
  - Render: `renderGovernanceRulesView` (`app.js:19098`)
  - API → route (auth):
    - `GET /api/v1/governance/rules` → `routes/governance.ts:20` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: These rules are not the repository rule files (CLAUDE.md, collaboration.md) that gate delivery.
- **`categories`** (`app.js:3378`)
  - Render: `renderGovernanceCategoriesView` (`app.js:20256`)
  - API → route (auth):
    - `GET /api/v1/governance/categories` → `routes/governance.ts:19` (optionalAuth)
    - `GET /api/v1/governance/rules` → `routes/governance.ts:20` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`evaluations`** (`app.js:3379`)
  - Render: `renderGovernanceEvaluationsView` (`app.js:19569`)
  - API → route (auth):
    - `GET /api/v1/governance/evaluations` → `routes/governance.ts:25` (optionalAuth)
    - `GET /api/v1/governance/rules` → `routes/governance.ts:20` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`violations`** (`app.js:3380`)
  - Render: `renderGovernanceViolationsView` (`app.js:26247`)
  - API → route (auth):
    - `GET /api/v1/governance/violations` → `routes/governance.ts:26` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`history`** (`app.js:3381`)
  - Render: `renderGovernanceHistoryView` (`app.js:19837`)
  - API → route (auth):
    - `GET /api/v1/governance/history` → `routes/governance.ts:32` (optionalAuth)
    - `GET /api/v1/governance/rules` → `routes/governance.ts:20` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`proposals`** (`app.js:3382`)
  - Render: `renderGovernanceProposalsView` (`app.js:26416`)
  - API → route (auth):
    - `GET /api/v1/governance/proposals` → `routes/governance.ts:22` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
  - Gaps: Proposal creation is not built ("coming soon", `app.js:26433`).
- **`controls`** (`app.js:3383`)
  - Render: `renderGovernanceControlsView` (`app.js:20644`)
  - API → route (auth):
    - `GET /api/v1/governance/controls` → `routes/governance-controls.ts:77` (no auth found at route or handler start)
    - `GET /api/v1/governance/controls/:key` → `routes/governance-controls.ts:99` (no auth found at route or handler start)
    - `POST /api/v1/governance/controls/:key` → `routes/governance-controls.ts:146` (requireServiceOrAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: `GET /api/v1/governance/controls` has no route-level auth.

### 3.13 Agents (`agents`, `app.js:3387`)
Purpose: Agent Registry, skills, pipelines, memory, LLM telemetry.

- **`registered-agents`** (`app.js:3390`)
  - Render: `renderRegisteredAgentsView` (`app.js:15390`)
  - API → route (auth):
    - `GET /api/v1/agents/registry` → `routes/agents-registry.ts:207` (no auth found at route or handler start)
    - `GET /api/v1/worker/orchestrator/health` → `routes/worker-orchestrator.ts:707` (no auth found at route or handler start)
    - `GET /api/v1/worker/skills` → `routes/worker-orchestrator.ts:788` (no auth found at route or handler start)
    - `GET /api/v1/worker/subagents` → `routes/worker-orchestrator.ts:742` (no auth found at route or handler start)
  - Data: handler: `rpc`; route file only (service layer, not traced): `agents_registry`, `dev_autopilot_executions`, `self_healing_log`, `vtid_ledger`, `worker_registry`
  - Status: Verified implemented, not operational
  - Gaps: Lists platform agents, not the delivery accounts (Kiro seats, Claude Code). Registry and worker routes have no route-level auth.
- **`skills`** (`app.js:3391`)
  - Render: `renderAgentsSkillsView` (`app.js:15488`)
  - API → route (auth):
    - `GET /api/v1/agents/registry` → `routes/agents-registry.ts:207` (no auth found at route or handler start)
    - `GET /api/v1/worker/orchestrator/health` → `routes/worker-orchestrator.ts:707` (no auth found at route or handler start)
    - `GET /api/v1/worker/skills` → `routes/worker-orchestrator.ts:788` (no auth found at route or handler start)
    - `GET /api/v1/worker/subagents` → `routes/worker-orchestrator.ts:742` (no auth found at route or handler start)
  - Data: handler: `rpc`; route file only (service layer, not traced): `agents_registry`, `dev_autopilot_executions`, `self_healing_log`, `vtid_ledger`, `worker_registry`
  - Status: Verified implemented, not operational
- **`pipelines`** (`app.js:3392`)
  - Render: `renderAgentsPipelinesView` (`app.js:16036`)
  - API → route (auth):
    - `GET /api/v1/commandhub/board` → `routes/board-adapter.ts:118` (no auth found at route or handler start)
    - `GET /api/v1/events` → `routes/events.ts:282` (no auth found at route or handler start)
    - `GET /api/v1/oasis/vtid-ledger` → `routes/oasis-vtid-ledger.ts:30` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid` → `routes/vtid.ts:1174` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid` → `routes/tasks.ts:206` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid/execution-status` → `routes/tasks.ts:322` (no auth found at route or handler start)
  - Data: handler: `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`memory`** (`app.js:3393`)
  - Render: `renderAgentsMemoryView` (`app.js:26570`)
  - API → route (auth):
    - `GET /api/v1/memory/garden/summary` → `routes/memory.ts:2067` (in-handler: getBearerToken)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Shows the memory garden summary, not agent memory.
- **`telemetry`** (`app.js:3394`)
  - Render: `renderAgentsTelemetryView` (`app.js:16444`)
  - API → route (auth):
    - `GET /api/v1/llm/routing-policy` → `routes/llm.ts:134` (no auth found at route or handler start)
    - `GET /api/v1/llm/telemetry` → `routes/llm.ts:338` (no auth found at route or handler start)
    - `GET /api/v1/llm/telemetry/summary` → `routes/llm.ts:406` (requireAdminAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: One of three model/provider views (with Integrations → LLM Providers and Models & Evaluations).

### 3.14 Autopilot (`autopilot`, `app.js:3398`)
Purpose: Dev Autopilot and automation registry. Every tab except Orchestrator starts with the supervisor strip `renderAutopilotSupervisorStrip` (`app.js:43307`).

- **`registry`** (`app.js:3401`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotRegistryView` (`app.js:43580`)
  - API → route (auth):
    - `POST /api/v1/automations/execute/:id` → `routes/automations.ts:124` (requireInternalOrAdmin)
    - `GET /api/v1/automations/registry` → `routes/automations.ts:98` (no auth found at route or handler start)
    - `GET /api/v1/automations/registry/summary` → `routes/automations.ts:110` (no auth found at route or handler start)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_scanners`
  - Status: Verified implemented, not operational
- **`scanners`** (`app.js:3402`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotScannersView` (`app.js:43903`)
  - API → route (auth):
    - `GET /api/v1/dev-autopilot/scanners` → `routes/dev-autopilot.ts:455` (requireDevRole)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: handler: `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_scanners`, `dev_autopilot_signals`; route file only (service layer, not traced): `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `oasis_events`
  - Status: Verified implemented, not operational
- **`impact-rules`** (`app.js:3403`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotImpactRulesView` (`app.js:44099`)
  - API → route (auth):
    - `GET /api/v1/dev-autopilot/impact-rules` → `routes/dev-autopilot.ts:538` (requireDevRole)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: handler: `dev_autopilot_config`, `dev_autopilot_impact_rules`; route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_executions`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_scanners`, `dev_autopilot_signals`, `oasis_events`
  - Status: Verified implemented, not operational
- **`auto-approve`** (`app.js:3404`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotAutoApproveView` (`app.js:44282`)
  - API → route (auth):
    - `GET /api/v1/dev-autopilot/auto-approve` → `routes/dev-autopilot.ts:587` (requireDevRole)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: handler: `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_scanners`; route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_signals`, `oasis_events`
  - Status: Verified implemented, not operational
- **`runs`** (`app.js:3405`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotRunsView` (`app.js:44461`)
  - API → route (auth):
    - `GET /api/v1/dev-autopilot/runs` → `routes/dev-autopilot.ts:406` (requireDevRole)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: handler: `dev_autopilot_runs`; route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_scanners`, `dev_autopilot_signals`
  - Status: Verified implemented, not operational
- **`live`** (`app.js:3406`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotLiveView` (`app.js:44658`)
  - API → route (auth):
    - `GET /api/v1/admin/feedback/tickets` → `routes/feedback-admin.ts:73` (requireAdminAuth)
    - `GET /api/v1/admin/feedback/tickets/:id` → `routes/feedback-admin.ts:124` (requireAdminAuth)
    - `POST /api/v1/admin/feedback/tickets/:id/approve` → `routes/feedback-actions.ts:166` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/draft-answer` → `routes/feedback-actions.ts:97` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/draft-resolution` → `routes/feedback-actions.ts:141` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/draft-spec` → `routes/feedback-actions.ts:119` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/mark-duplicate` → `routes/feedback-actions.ts:233` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/reject` → `routes/feedback-actions.ts:220` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/resolve` → `routes/feedback-actions.ts:207` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/send-answer` → `routes/feedback-actions.ts:193` (in-handler: decodeJwtSub, getBearerToken)
    - `GET /api/v1/admin/tenants/:id` → `routes/admin-tenants.ts:127` (in-handler: verifyExafyAdmin)
    - `GET /api/v1/admin/tenants/:tenantId/tickets/:id` → `routes/tenant-specialists.ts:468` (no auth found at route or handler start)
    - … 3 more matched routes, omitted for length
  - API note: The execution stream URL built in `followOperatorExecution` carries the auth token as a query parameter (`app.js:23046`).
  - Data: handler: `autopilot_recommendations`, `dev_autopilot_executions`, `oasis_events`; route file only (service layer, not traced): `dev_autopilot_config`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_scanners`, `dev_autopilot_signals`
  - Status: Verified implemented, not operational
- **`engine`** (`app.js:3407`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotEngineView` (`app.js:45028`)
  - API → route (auth):
    - `POST /api/v1/automations/dispatch` → `routes/automations.ts:151` (requireInternalOrAdmin)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_scanners`
  - Status: Implemented but incomplete
  - Gaps: Cron table is static reference data from a GCP-era script (`app.js:45060`).
- **`growth`** (`app.js:3408`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotGrowthView` (`app.js:45250`)
  - API → route (auth):
    - `GET /api/v1/automations/runs` → `routes/automations.ts:183` (requireInternalOrAdmin)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_scanners`
  - Status: Verified implemented, not operational
- **`mission-alignment`** (`app.js:3409`)
  - Render: `renderAutopilotSupervisorStrip` (`app.js:43307`), `renderAutopilotMissionAlignmentView` (`app.js:45905`)
  - API → route (auth):
    - `GET /api/v1/autopilot/recommendations` → `routes/autopilot-recommendations.ts:639` (optionalAuth)
    - `GET /api/v1/dev-autopilot/supervisor` → `routes/dev-autopilot.ts:435` (requireDevRole)
  - Data: route file only (service layer, not traced): `autopilot_recommendations`, `dev_autopilot_config`, `dev_autopilot_executions`, `dev_autopilot_impact_rules`, `dev_autopilot_outcomes`, `dev_autopilot_plan_versions`, `dev_autopilot_runs`, `dev_autopilot_scanners`
  - Status: Verified implemented, not operational
- **`orchestrator`** (`app.js:3410`)
  - Render: `renderAutopilotOrchestratorView` (`app.js:45867`); endpoints in `ORCH_ENDPOINTS` (`app.js:45498`)
  - API → route (auth):
    - `GET /api/v1/orchestrator/runs/summary` → `routes/orchestrator.ts:107` (requireDevRole)
    - `GET /api/v1/orchestrator/runs` → `routes/orchestrator.ts:98` (requireDevRole)
    - `GET /api/v1/orchestrator/agents` → `routes/orchestrator.ts:117` (requireDevRole)
    - `GET /api/v1/orchestrator/policy` → `routes/orchestrator.ts:169` (requireAuth; in-handler: exafy_admin)
    - `GET /api/v1/orchestrator/policy/shadow` → `routes/orchestrator.ts:125` (requireDevRole)
    - `GET /api/v1/orchestrator/budgets` → `routes/orchestrator.ts:147` (requireDevRole)
    - `GET /api/v1/orchestrator/delegations` → `routes/orchestrator.ts:142` (requireDevRole)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Read-only aggregate across four execution paths; it owns none of them.

### 3.15 OASIS (`oasis`, `app.js:3414`)
Purpose: event and ledger inspection. `oasis_events.vtid` is free text with no FK to `vtid_ledger` (`supabase/migrations/20251209000000_add_task_stage.sql:10-36`).

- **`events`** (`app.js:3417`)
  - Render: `renderOasisEventsView` (`app.js:21211`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/oasis/events/smart` → `routes/events.ts:691` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
  - Gaps: Event read routes have no route-level auth (`routes/events.ts:578`).
- **`vtid-ledger`** (`app.js:3418`)
  - Render: `renderOasisVtidLedgerView` (`app.js:22268`)
  - API → route (auth):
    - `GET /api/v1/events` → `routes/events.ts:282` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid` → `routes/vtid.ts:1174` (no auth found at route or handler start)
    - `GET /api/v1/vtid/:vtid` → `routes/tasks.ts:206` (no auth found at route or handler start)
    - `GET /api/v1/vtid/projection` → `routes/vtid.ts:885` (no auth found at route or handler start)
  - Data: handler: `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
- **`entities`** (`app.js:3419`)
  - Render: `renderOasisEntitiesView` (`app.js:26702`)
  - API → route (auth):
    - `GET /api/v1/vtid/list` → `routes/vtid.ts:760` (no auth found at route or handler start)
  - Data: handler: `vtid_ledger`
  - Status: Verified implemented, not operational
- **`streams`** (`app.js:3420`)
  - Render: `renderOasisStreamsView` (`app.js:26812`)
  - API → route (auth):
    - `GET /api/v1/events/stream` → `routes/events.ts:945` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
- **`command-log`** (`app.js:3421`)
  - Render: `renderOasisCommandLogView` (`app.js:26993`)
  - API → route (auth):
    - `GET /api/v1/operator/history` → `routes/operator.ts:1259` (no auth found at route or handler start)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: Shows Operator history, not session (Kiro/Claude) work, which lives in git trailers and claim refs.

### 3.16 Databases (`databases`, `app.js:3425`)
Purpose: database information. Three of five tabs are static.

- **`supabase`** (`app.js:3428`)
  - Render: `renderDatabasesSupabaseView` (`app.js:35518`)
  - API: none. Static cards (`app.js:35515`); GCP project cards removed (`app.js:35538`). The store is moving to Aurora.
  - Status: Deprecated/superseded
- **`vectors`** (`app.js:3429`)
  - Render: `renderDatabasesVectorsView` (`app.js:35645`)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/memory/embeddings/generate`
  - Status: Implemented but incomplete
  - Gaps: Calls `GET /api/v1/memory/embeddings/generate` (`app.js:35766`). The only matching route is `POST /api/v1/memory/admin/embeddings/generate` (`routes/semantic-memory.ts:427`), so the stats call cannot reach a handler.
- **`cache`** (`app.js:3430`)
  - Render: `renderDatabasesCacheView` (`app.js:35785`)
  - API: none. Static description of cache strategy (`app.js:35783`).
  - Status: Deprecated/superseded
- **`analytics`** (`app.js:3431`)
  - Render: `renderDatabasesAnalyticsView` (`app.js:35862`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
- **`clusters`** (`app.js:3432`)
  - Render: `renderDatabasesClustersView` (`app.js:35949`)
  - API: none. Static Cloud SQL / pool description (`app.js:35947`), GCP note at `app.js:35970`.
  - Status: Deprecated/superseded

### 3.17 Infrastructure (`infrastructure`, `app.js:3436`)
Purpose: services, deployments, logs, config.

- **`services`** (`app.js:3439`)
  - Render: `renderInfraServicesView` (`app.js:36075`)
  - API → route (auth):
    - `GET /api/v1/assistant/health` → `routes/assistant.ts:441` (no auth found at route or handler start)
    - `GET /api/v1/autopilot/health` → `routes/autopilot.ts:1127` (requireServiceToken)
    - `GET /api/v1/cicd/health` → `routes/cicd.ts:662` (no auth found at route or handler start)
    - `GET /api/v1/operator/health` → `routes/operator.ts:1191` (no auth found at route or handler start)
  - Called but no route definition found in `routes/**` or `index.ts`: `/health`
  - Data: route file only (service layer, not traced): `count_tasks_by_status`, `oasis_events`, `vtid_ledger`
  - Status: Implemented but incomplete
  - Gaps: Health probes call `/health` (`app.js:36024`, served at `index.ts:643`); platform rule ALWAYS 14 names `/alive`. No AWS ECS service view.
- **`deployments`** (`app.js:3440`)
  - Render: `renderInfraDeploymentsView` (`app.js:36182`)
  - API → route (auth):
    - `GET /api/v1/operator/deployments` → `routes/operator.ts:1695` (no auth found at route or handler start)
  - Data: route file only (service layer, not traced): `oasis_events`, `vtid_ledger`
  - Status: Verified implemented, not operational
  - Gaps: Overlaps Operator → deployments and Delivery → releases.
- **`logs`** (`app.js:3441`)
  - Render: `renderInfraLogsView` (`app.js:36328`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
- **`config`** (`app.js:3442`)
  - Render: `renderInfraConfigView` (`app.js:36503`)
  - API → route (auth):
    - `GET /api/v1/governance/controls` → `routes/governance-controls.ts:77` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Deprecated/superseded
  - Gaps: A live part reads governance controls; the rest is the GCP-disabled notice (`app.js:36605`).

### 3.18 Security (Dev) (`security-dev`, `app.js:3446`)
Purpose: policies, roles, secrets, audit, RLS.

- **`policies`** (`app.js:3449`)
  - Render: `renderSecurityPoliciesView` (`app.js:42674`)
  - API → route (auth):
    - `GET /api/v1/governance/rules` → `routes/governance.ts:20` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`roles`** (`app.js:3450`)
  - Render: `renderSecurityRolesView` (`app.js:42784`)
  - API → route (auth):
    - `GET /api/v1/dev-access/users` → `routes/dev-access.ts:268` (in-handler: exafy_admin, verifyExafyAdmin)
  - Data: route file only (service layer, not traced): `oasis_events`
  - Status: Verified implemented, not operational
- **`keys-secrets`** (`app.js:3451`)
  - Render: `renderSecurityKeysSecretsView` (`app.js:42857`)
  - API: none. Static text; the service-account list is replaced by the GCP-disabled notice (`app.js:42929`).
  - Status: Deprecated/superseded
- **`audit-log`** (`app.js:3452`)
  - Render: `renderSecurityAuditLogView` (`app.js:42952`)
  - API → route (auth):
    - `GET /api/v1/governance/history` → `routes/governance.ts:32` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`rls-access`** (`app.js:3453`)
  - Render: `renderSecurityRlsAccessView` (`app.js:43069`)
  - API: none. Static text (`app.js:43069`) that says every query is tenant-scoped. The multi-tenant programme has not finished that work, so the text overstates the current state.
  - Status: Deprecated/superseded

### 3.19 Integrations & Tools (`integrations-tools`, `app.js:3457`)
Purpose: MCP, LLM providers, APIs, tools, plugins.

- **`mcp-connectors`** (`app.js:3460`)
  - Render: `renderIntegrationsMcpView` (`app.js:28477`)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/workers/connector/list`
  - Status: Implemented but incomplete
  - Gaps: Calls `GET /api/v1/workers/connector/list` (`app.js:28450`); no route definition serves that path.
- **`llm-providers`** (`app.js:3461`)
  - Render: `renderIntegrationsLlmProvidersView` (`app.js:28909`)
  - API → route (auth):
    - `GET /api/v1/admin/ai-assistants/catalog` → `routes/admin/ai-integrations.ts:53` (in-handler: requireAdmin)
    - `PATCH /api/v1/admin/ai-assistants/catalog/:provider` → `routes/admin/ai-integrations.ts:68` (in-handler: requireAdmin)
    - `GET /api/v1/admin/ai-assistants/connections` → `routes/admin/ai-integrations.ts:189` (in-handler: requireAdmin)
    - `GET /api/v1/admin/ai-assistants/consent-log` → `routes/admin/ai-integrations.ts:252` (in-handler: requireAdmin)
    - `GET /api/v1/admin/ai-assistants/policies/:tenant` → `routes/admin/ai-integrations.ts:94` (in-handler: requireAdmin)
    - `PUT /api/v1/admin/ai-assistants/policies/:tenant` → `routes/admin/ai-integrations.ts:119` (in-handler: requireAdmin)
    - `GET /api/v1/llm/models` → `routes/llm.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/llm/providers/health` → `routes/llm.ts:455` (no auth found at route or handler start)
    - `GET /api/v1/llm/routing-policy` → `routes/llm.ts:134` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Hardcodes the Maxina tenant policy path `/api/v1/admin/ai-assistants/policies/maxina` (`app.js:29187`). LLM model and routing reads have no route-level auth.
- **`apis`** (`app.js:3462`)
  - Render: `renderIntegrationsApisView` (`app.js:29309`)
  - API note: Static list of route-group names (`app.js:29309`); no route is called. The list can drift from `index.ts`.
  - Status: Deprecated/superseded
- **`tools`** (`app.js:3463`)
  - Render: `renderIntegrationsToolsView` (`app.js:29429`)
  - API → route (auth):
    - `GET /api/v1/conversation/tool-health` → `routes/conversation.ts:1124` (no auth found at route or handler start)
    - `GET /api/v1/conversation/tools` → `routes/conversation.ts:1141` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`plugins`** (`app.js:3464`)
  - Render: `renderIntegrationsPluginsView` (`app.js:29578`)
  - API → route (auth):
    - `GET /api/v1/llm/models` → `routes/llm.ts:578` (no auth found at route or handler start)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/workers/connector/list`
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Deprecated/superseded
  - Gaps: Appends a static registry that marks Cloud Run as active (`app.js:29553-29559`), and calls the missing `/api/v1/workers/connector/list` (`app.js:29515`).
- **`service-mesh`** (`app.js:3465`)
  - Render: `renderIntegrationsServiceMeshView` (`app.js:29692`)
  - API: none. GCP-disabled notice only (`app.js:29692-29695`).
  - Status: Deprecated/superseded

### 3.20 Diagnostics (`diagnostics`, `app.js:3469`)
Purpose: health, latency, errors, SSE, debug.

- **`health-checks`** (`app.js:3472`)
  - Render: `renderDiagnosticsHealthChecksView` (`app.js:29730`)
  - API → route (auth):
    - `GET /api/v1/assistant/health` → `routes/assistant.ts:441` (no auth found at route or handler start)
    - `GET /api/v1/autopilot/health` → `routes/autopilot.ts:1127` (requireServiceToken)
    - `GET /api/v1/cicd/health` → `routes/cicd.ts:662` (no auth found at route or handler start)
    - `GET /api/v1/operator/health` → `routes/operator.ts:1191` (no auth found at route or handler start)
  - Called but no route definition found in `routes/**` or `index.ts`: `/health`
  - Data: route file only (service layer, not traced): `count_tasks_by_status`, `oasis_events`, `vtid_ledger`
  - Status: Implemented but incomplete
  - Gaps: Probes `/health` (`app.js:29707`), not `/alive` (ALWAYS 14).
- **`latency`** (`app.js:3473`)
  - Render: `renderDiagnosticsLatencyView` (`app.js:29777`)
  - API → route (auth):
    - `GET /api/v1/governance/rules` → `routes/governance.ts:20` (optionalAuth)
    - `GET /api/v1/memory/garden/summary` → `routes/memory.ts:2067` (in-handler: getBearerToken)
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/operator/health` → `routes/operator.ts:1191` (no auth found at route or handler start)
    - `GET /api/v1/vtid/list` → `routes/vtid.ts:760` (no auth found at route or handler start)
  - Called but no route definition found in `routes/**` or `index.ts`: `/health`
  - Data: handler: `oasis_events`, `vtid_ledger`
  - Status: Implemented but incomplete
  - Gaps: Includes a `/health` probe.
- **`errors`** (`app.js:3474`)
  - Render: `renderDiagnosticsErrorsView` (`app.js:29842`)
  - API → route (auth):
    - `GET /api/v1/oasis/events` → `routes/events.ts:578` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
- **`sse`** (`app.js:3475`)
  - Render: `renderDiagnosticsSseView` (`app.js:29893`)
  - API → route (auth):
    - `GET /api/v1/events/stream` → `routes/events.ts:945` (no auth found at route or handler start)
  - Data: handler: `oasis_events`
  - Status: Verified implemented, not operational
- **`debug-panel`** (`app.js:3476`)
  - Render: `renderDiagnosticsDebugPanelView` (`app.js:29966`)
  - API: none. Client state only (route, state keys, user agent), no API (`app.js:29966`).
  - Status: Verified implemented, not operational

### 3.21 Models & Evaluations (`models-evaluations`, `app.js:3480`)
Purpose: models, evaluations, benchmarks, routing, playground. The LLM routes have no route-level auth for reads.

- **`models`** (`app.js:3483`)
  - Render: `renderModelsListView` (`app.js:30191`)
  - API → route (auth):
    - `GET /api/v1/llm/models` → `routes/llm.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/llm/routing-policy` → `routes/llm.ts:134` (no auth found at route or handler start)
    - `GET /api/v1/llm/telemetry` → `routes/llm.ts:338` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`evaluations`** (`app.js:3484`)
  - Render: `renderModelsEvaluationsView` (`app.js:30239`)
  - API → route (auth):
    - `GET /api/v1/llm/models` → `routes/llm.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/llm/routing-policy` → `routes/llm.ts:134` (no auth found at route or handler start)
    - `GET /api/v1/llm/telemetry` → `routes/llm.ts:338` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
  - Gaps: Derived from telemetry; empty-state text when there is none.
- **`benchmarks`** (`app.js:3485`)
  - Render: `renderModelsBenchmarksView` (`app.js:30323`)
  - API → route (auth):
    - `GET /api/v1/llm/models` → `routes/llm.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/llm/routing-policy` → `routes/llm.ts:134` (no auth found at route or handler start)
    - `GET /api/v1/llm/telemetry` → `routes/llm.ts:338` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Implemented but incomplete
  - Gaps: Derived from telemetry (`app.js:30350`).
- **`routing`** (`app.js:3486`)
  - Render: `renderModelsRoutingView` (`app.js:30374`)
  - API → route (auth):
    - `GET /api/v1/llm/models` → `routes/llm.ts:578` (no auth found at route or handler start)
    - `GET /api/v1/llm/routing-policy` → `routes/llm.ts:134` (no auth found at route or handler start)
    - `POST /api/v1/llm/routing-policy/reset` → `routes/llm.ts:236` (no auth found at route or handler start)
    - `GET /api/v1/llm/telemetry` → `routes/llm.ts:338` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Routing reset can change LLM routing; must respect ALWAYS 10a to 10c (Bedrock for Claude stages).
- **`playground`** (`app.js:3487`)
  - Render: `renderModelsPlaygroundView` (`app.js:30452`)
  - API → route (auth):
    - `POST /api/v1/assistant/chat` → `routes/assistant.ts:86` (optionalAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.22 Testing & QA (`testing-qa`, `app.js:3491`)
Purpose: test catalogue, runs, launches, end-to-end, test contracts.

- **`overview`** (`app.js:3494`)
  - Render: `renderTestingOverviewView` (`app.js:30969`)
  - API → route (auth):
    - `GET /api/v1/testing/catalog` → `routes/testing.ts:106` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/testing/results/summary` → `routes/testing.ts:205` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/testing/results/sync` → `routes/testing.ts:255` (requireAuth, requireExafyAdmin; in-handler: exafy_admin)
  - Data: handler: `ci_test_runs`, `ci_test_sync_state`; route file only (service layer, not traced): `oasis_events`
  - Status: Verified implemented, not operational
- **`catalog`** (`app.js:3495`)
  - Render: `renderTestingCatalogView` (`app.js:31108`)
  - API → route (auth):
    - `GET /api/v1/testing/catalog` → `routes/testing.ts:106` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/testing/catalog/suite` → `routes/testing.ts:125` (requireAuth, requireExafyAdmin; in-handler: exafy_admin)
    - `GET /api/v1/testing/results/summary` → `routes/testing.ts:205` (requireAuth, requireExafyAdmin)
  - Data: handler: `ci_test_runs`, `ci_test_sync_state`, `oasis_events`
  - Status: Verified implemented, not operational
- **`runs`** (`app.js:3496`)
  - Render: `renderTestingRunsView` (`app.js:31238`)
  - API → route (auth):
    - `GET /api/v1/testing/results/runs` → `routes/testing.ts:235` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/testing/run` → `routes/testing.ts:404` (requireAuth, requireExafyAdmin)
  - Data: handler: `ci_test_runs`; route file only (service layer, not traced): `ci_test_sync_state`, `oasis_events`
  - Status: Verified implemented, not operational
  - Gaps: STAGING-VERIFY results are shown in Delivery, not here.
- **`run-tests`** (`app.js:3497`)
  - Render: `renderTestingRunTestsView` (`app.js:31299`)
  - API → route (auth):
    - `POST /api/v1/testing/launch` → `routes/testing.ts:293` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/testing/launchable` → `routes/testing.ts:282` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/testing/launches` → `routes/testing.ts:350` (requireAuth, requireExafyAdmin)
  - Data: handler: `oasis_events`; route file only (service layer, not traced): `ci_test_runs`, `ci_test_sync_state`
  - Status: Verified implemented, not operational
- **`e2e`** (`app.js:3498`)
  - Render: `renderTestingE2eView` (`app.js:31437`)
  - API → route (auth):
    - `GET /api/v1/testing/cycles` → `routes/testing.ts:489` (no auth found at route or handler start)
    - `POST /api/v1/testing/cycles/:id/run` → `routes/testing.ts:517` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/testing/run` → `routes/testing.ts:404` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/testing/runs` → `routes/testing.ts:374` (no auth found at route or handler start)
    - `GET /api/v1/testing/runs/:id` → `routes/testing.ts:389` (no auth found at route or handler start)
    - `GET /api/v1/testing/suites` → `routes/testing.ts:90` (in-handler: exafy_admin)
  - Called but no route definition found in `routes/**` or `index.ts`: `/api/v1/testing/cycles/:p`
  - Data: route file only (service layer, not traced): `ci_test_runs`, `ci_test_sync_state`, `oasis_events`
  - Status: Implemented but incomplete
- **`test-contracts`** (`app.js:3499`)
  - Render: `renderTestContractsPanel` (`app.js:41735`)
  - API → route (auth):
    - `GET /api/v1/test-contracts` → `routes/test-contracts.ts:85` (requireDevAccess)
    - `GET /api/v1/test-contracts/:id` → `routes/test-contracts.ts:115` (requireDevAccess)
    - `POST /api/v1/test-contracts/:id/run` → `routes/test-contracts.ts:180` (requireAuthWithTenant; in-handler: exafy_admin)
    - `GET /api/v1/test-contracts/missing` → `routes/test-contracts-missing.ts:187` (requireDevAccess)
    - `POST /api/v1/test-contracts/missing/:dedupe_key/allocate` → `routes/test-contracts-missing.ts:210` (requireAuthWithTenant; in-handler: exafy_admin)
    - `POST /api/v1/test-contracts/scheduled-run` → `routes/test-contracts-scheduled.ts:186` (requireInternalOrAdmin)
  - Data: handler: `autopilot_recommendations`, `test_contract_runs`, `test_contracts`, `vtid_ledger`
  - Status: Verified implemented, not operational

### 3.23 Intelligence & Memory (Dev) (`intelligence-memory-dev`, `app.js:3503`)
Purpose: developer inspection of memory. All five tabs share `renderMemoryOpsView(tab)` (`app.js:48946`), dispatched at `app.js:8179-8182`.

- **`memory-vault`** (`app.js:3506`)
  - Render: `renderMemoryOpsView` (`app.js:48946`) → `memoryOpsRenderMemoryVault` (`app.js:49122`)
  - API → route (auth):
    - `GET /api/v1/admin/memory/health` → `routes/admin-memory-broker.ts:156` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/memory/profile` → `routes/admin-memory-broker.ts:110` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/admin/memory/profile` → `routes/admin-memory-broker.ts:130` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/memory-orchestrator/status` → `routes/admin-memory-orchestrator.ts:51` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/admin/consolidator/run` → `routes/admin-memory-broker.ts:290` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: A developer surface that reads member memory; access must follow the memory consent and role rules. Lane `security-evidence` covers the live grant check.
- **`knowledge-graph`** (`app.js:3507`)
  - Render: `renderMemoryOpsView` (`app.js:48946`) → `memoryOpsRenderKnowledgeGraph` (`app.js:49254`)
  - API → route (auth):
    - `GET /api/v1/admin/memory/graph-sample` → `routes/admin-memory-broker.ts:238` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Samples the relationship graph, not a designed knowledge graph.
- **`embeddings`** (`app.js:3508`)
  - Render: `renderMemoryOpsView` (`app.js:48946`) → `memoryOpsRenderEmbeddings` (`app.js:49303`)
  - API → route (auth):
    - `GET /api/v1/admin/memory/embeddings` → `routes/admin-memory-broker.ts:262` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`recall`** (`app.js:3509`)
  - Render: `renderMemoryOpsView` (`app.js:48946`) → `memoryOpsRenderRecall` (`app.js:49341`)
  - API → route (auth):
    - `GET /api/v1/admin/memory/context` → `routes/admin-memory-broker.ts:52` (requireAuth, requireExafyAdmin)
    - `POST /api/v1/admin/memory/context` → `routes/admin-memory-broker.ts:77` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`inspector`** (`app.js:3510`)
  - Render: `renderMemoryOpsView` (`app.js:48946`) → `memoryOpsRenderInspector` (`app.js:49421`)
  - API → route (auth):
    - `GET /api/v1/admin/memory/health` → `routes/admin-memory-broker.ts:156` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.24 Docs (`docs`, `app.js:3514`)
Purpose: screens, API inventory, schemas, architecture, workforce, system knowledge, manuals. The router also has a `specialists` branch (`app.js:8386`, `renderDocsSpecialistsView`) with no tab in NAVIGATION_CONFIG.

- **`screens`** (`app.js:3517`)
  - Render: `renderDocsScreensView` (`app.js:22715`)
  - API → route (auth):
    - `GET /api/v1/oasis/specs/:specKey` → `routes/oasis-specs.ts:46` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`api-inventory`** (`app.js:3518`)
  - Render: `renderDocsApiInventoryView` (`app.js:34206`)
  - API → route (auth):
    - `GET /api/v1/assistant/health` → `routes/assistant.ts:441` (no auth found at route or handler start)
  - API note: One live health call (`app.js:34220`); the rest is a static endpoint list (`app.js:34206`) that can drift.
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Deprecated/superseded
- **`database-schemas`** (`app.js:3519`)
  - Render: `renderDocsDatabaseSchemasView` (`app.js:34290`)
  - API: none. Static schema text (`app.js:34290`); `DATABASE_SCHEMA.md` is the maintained source.
  - Status: Deprecated/superseded
- **`architecture`** (`app.js:3520`)
  - Render: `renderDocsArchitectureView` (`app.js:34360`)
  - API: none. Static architecture cards (`app.js:34360`).
  - Status: Deprecated/superseded
- **`workforce`** (`app.js:3521`)
  - Render: `renderDocsWorkforceView` (`app.js:34409`)
  - API: none. Static agent-type list (`app.js:34409`); it does not show the delivery accounts.
  - Status: Deprecated/superseded
- **`system-knowledge`** (`app.js:3522`)
  - Render: `renderDocsSystemKnowledgeView` (`app.js:34560`)
  - API → route (auth):
    - `GET /api/v1/admin/system-kb/docs` → `routes/admin-system-kb.ts:35` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/system-kb/docs/:id` → `routes/admin-system-kb.ts:58` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`manuals`** (`app.js:3523`)
  - Render: `renderDocsManualsView` (`app.js:34987`)
  - API → route (auth):
    - `GET /api/v1/admin/system-kb/docs` → `routes/admin-system-kb.ts:35` (requireAuth, requireExafyAdmin)
    - `GET /api/v1/admin/system-kb/docs/:id` → `routes/admin-system-kb.ts:58` (requireAuth, requireExafyAdmin)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

### 3.25 Routines (`routines`, `app.js:3527`)
Purpose: scheduled routine catalogue and history.

- **`catalog`** (`app.js:3530`)
  - Render: `renderRoutinesCatalogView` (`app.js:47359`)
  - API → route (auth):
    - `GET /api/v1/routines` → `routes/routines.ts:131` (no auth found at route or handler start)
    - `GET /api/v1/routines/:name` → `routes/routines.ts:202` (no auth found at route or handler start)
  - Data: handler: `routine_runs`, `routines`
  - Status: Verified implemented, not operational
  - Gaps: `GET /api/v1/routines` has no route-level auth (`routes/routines.ts:131`).
- **`history`** (`app.js:3531`)
  - Render: `renderRoutinesHistoryView` (`app.js:47501`)
  - API → route (auth):
    - `GET /api/v1/routines` → `routes/routines.ts:131` (no auth found at route or handler start)
    - `GET /api/v1/routines/:name` → `routes/routines.ts:202` (no auth found at route or handler start)
    - `GET /api/v1/routines/:name/runs/:id` → `routes/routines.ts:244` (no auth found at route or handler start)
  - Data: handler: `routine_runs`, `routines`
  - Status: Verified implemented, not operational

### 3.26 Feedback (`feedback`, `app.js:3539`)
Purpose: support tickets, hand-offs, KPIs, specialist audit (VTID-02605). Routable, no sidebar entry (`app.js:3541`, skipped at `app.js:5825`).

- **`inbox`** (`app.js:3543`)
  - Render: `renderFeedbackInboxView` (`app.js:47744`)
  - API → route (auth):
    - `GET /api/v1/admin/feedback/tickets` → `routes/feedback-admin.ts:73` (requireAdminAuth)
    - `GET /api/v1/admin/feedback/tickets/:id` → `routes/feedback-admin.ts:124` (requireAdminAuth)
    - `POST /api/v1/admin/feedback/tickets/:id/approve` → `routes/feedback-actions.ts:166` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/draft-answer` → `routes/feedback-actions.ts:97` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/draft-resolution` → `routes/feedback-actions.ts:141` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/draft-spec` → `routes/feedback-actions.ts:119` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/mark-duplicate` → `routes/feedback-actions.ts:233` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/reject` → `routes/feedback-actions.ts:220` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/resolve` → `routes/feedback-actions.ts:207` (in-handler: decodeJwtSub, getBearerToken)
    - `POST /api/v1/admin/feedback/tickets/:id/send-answer` → `routes/feedback-actions.ts:193` (in-handler: decodeJwtSub, getBearerToken)
    - `GET /api/v1/admin/tenants/:id` → `routes/admin-tenants.ts:127` (in-handler: verifyExafyAdmin)
    - `GET /api/v1/admin/tenants/:tenantId/tickets/:id` → `routes/tenant-specialists.ts:468` (no auth found at route or handler start)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
  - Gaps: Ticket action routes check a bearer token inside the handler (`routes/feedback-actions.ts:98`).
- **`handoffs`** (`app.js:3544`)
  - Render: `renderFeedbackHandoffsView` (`app.js:48269`)
  - API → route (auth):
    - `GET /api/v1/admin/feedback/handoffs/recent` → `routes/feedback-admin.ts:156` (requireAdminAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`kpis`** (`app.js:3545`)
  - Render: `renderFeedbackKpisView` (`app.js:48308`)
  - API → route (auth):
    - `GET /api/v1/admin/feedback/kpis` → `routes/feedback-admin.ts:183` (requireAdminAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational
- **`audit`** (`app.js:3546`)
  - Render: `renderFeedbackAuditView` (`app.js:48715`)
  - API → route (auth):
    - `GET /api/v1/admin/specialists/audit` → `routes/specialists-admin.ts:516` (requireAdminAuth)
  - Data: none read directly in the route files (service layer, not traced)
  - Status: Verified implemented, not operational

Any key the dispatcher does not handle falls through to a text placeholder (`app.js:8437-8443`). All 135 tabs have a branch, so none reaches it today.

## 4. Cross-cutting findings

| Topic | Evidence | Status | Effect |
|---|---|---|---|
| Three event views over one store | Operations → events, OASIS → events, Operator → event-stream all read `GET /api/v1/oasis/events` (`routes/events.ts:578`) | Verified implemented, not operational | Three screens, one source |
| Three model and provider views | Agents → telemetry, Integrations → LLM Providers, Models & Evaluations all read `routes/llm.ts` | Verified implemented, not operational | Same data, three places |
| Three release views | Operator → deployments and Infrastructure → deployments (`routes/operator.ts:1695`), Delivery → releases (`routes/delivery.ts:101`) | Verified implemented, not operational | No single release truth |
| Four execution paths, no owner | Dev Autopilot (`routes/dev-autopilot.ts`), worker orchestrator (`routes/worker-orchestrator.ts`), automations (`routes/automations.ts`), the Kiro plan/lane pipeline (git). Autopilot → Orchestrator aggregates only (`app.js:45498`) | Implemented but incomplete | Ownership of a run is not visible |
| Two merge paths | `POST /api/v1/cicd/autonomous-pr-merge` (`routes/cicd.ts:1342`, GitHub) from Operations → approvals, beside the PM merge rule (`.claude/rules/collaboration.md` §7b) | Verified implemented, not operational | A merge can bypass the lane reviewer record |
| Local shadow task state | `localStorage` title, status and spec overrides (`app.js:501`, `:529`, `:558`) | Verified implemented, not operational | The board can disagree with `vtid_ledger` |
| GCP-era static screens | `app.js:29553-29559`, `:29683`, `:35538`, `:35970`, `:36605`, `:42929`, `:45060` | Deprecated/superseded | Misleading content |
| Calls with no serving route | `/api/v1/memory/embeddings/generate` (`app.js:35766`), `/api/v1/workers/connector/list` (`app.js:28450`, `:29515`) | Implemented but incomplete | Those panels cannot load their data |
| `/health` instead of `/alive` | `app.js:29707`, `:36024`; served at `index.ts:643` | Implemented but incomplete | Conflicts with CLAUDE.md ALWAYS 14 |
| Hardcoded tenant | `app.js:29187` (`policies/maxina`) | Implemented but incomplete | Not tenant-aware |
| Orphan router branch | `docs/specialists` (`app.js:8386`) with no tab | Implemented but incomplete | Reachable only by URL |

Agent supervision gaps (the reason for section 6):

- No tab shows plans, lanes, lane state, `next_actor`, claims, seats, driver heartbeats or session ids. Search of the frontend finds no call to `/api/v1/project-manager/*`, `/api/v1/plans/spar/*` or `/api/v1/supervisor/summary`.
- Agents → registered-agents lists platform agents from `GET /api/v1/agents/registry` (`routes/agents-registry.ts:207`), not delivery accounts.
- Docs → workforce is static text (`app.js:34409`).
- Operations → approvals reads GitHub pull requests (`routes/approvals.ts:478`, `:490`), not GitLab merge requests.

## 5. GitLab today

- **Inbound webhook.** `POST /api/v1/internal/gitlab/webhook` is gated by a Standard Webhooks HMAC signature, not a JWT (`routes/internal-gitlab-webhook.ts:1-31`, handler `:101`). The raw body parser is mounted first (`index.ts:632`). A delivery stage middleware runs before the route (`index.ts:1292`) and the router is mounted at `index.ts:1294`. Status: Verified implemented, not operational.
- **Mapping.** `services/gitlab-events/delivery-mapper.ts` maps merge request, push and pipeline events to OASIS topics (`services/gitlab-events/delivery-mapper.ts:49-64`): `scm.gitlab.merge_request.updated`, `scm.gitlab.push`, `scm.gitlab.pipeline.*`, `delivery.review.recorded`, `delivery.lane.updated`, `delivery.landed`, `staging.deploy.*`. The VTID comes from the merge request title (`services/gitlab-events/delivery-mapper.ts:274-342`). Pushes are mapped only on agent branches `kiro/`, `claude/`, `assist/`, `pm-agent/` (`services/gitlab-events/delivery-mapper.ts:86`, `:569-573`). Collab trailers (`Collab-Session`, `Collab-Lane`, `Collab-Verdict`, …) are parsed from GitLab commits (`services/gitlab-events/delivery-mapper.ts:93-94`, `:590`, `:616`). Lane file changes become `delivery.lane.updated` (`services/gitlab-events/delivery-mapper.ts:644-660`). A repository not yet delivered on GitLab is written in shadow mode (`services/gitlab-events/delivery-mapper.ts:31-35`). Only `vitana-platform` and `vitana-v1` are mapped (`services/gitlab-events/delivery-mapper.ts:83`).
- **Read side.** Delivery reads those OASIS rows plus `vtid_ledger` (`routes/delivery.ts:10-14`, `:67`, `:74`).
- **Not present.** No Command Hub call reads the GitLab API. No view of GitLab projects, review threads, environments or pipeline jobs exists.
- **Still GitHub.** The board approvals feed (`routes/approvals.ts:478`), the auto-merge path (`routes/cicd.ts:1342`) and the Project Manager observer (`services/project-manager/observe-live.ts:1-22`) read or write GitHub.

## 6. Target supervisory design

### 6.1 Principles

- **GitLab is authoritative** for source, branches, merge requests, reviews, CI/CD pipelines, environments and releases. Command Hub reads it and links to it. It never recreates a merge request, review, pipeline or environment.
- **No new store and no new execution engine.** Every panel below reads a source that exists at HEAD. Actions go to the system that owns them.
- **VTID format stays `VTID-XXXXX`** (5 digits, `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:105-106`). VTIDs are allocated only by CI PLAN-SPAR (`scripts/collab/plan-spar.mjs:231`).
- **OASIS writes only through `emitOasisEvent`** (`services/oasis-event-service.ts:59`).
- **Navigation is filtered by the caller's grants**; the server route stays the authority.
- Every panel shows its source and how old the data is.

### 6.2 Sources the design reads (all exist at HEAD)

| Source | Where | What it gives |
|---|---|---|
| `vtid_ledger` | `supabase/migrations/20251217000000_vtid_ledger_and_allocator.sql:82` (allocator) | VTID, title, status, terminal state |
| `oasis_events` | `supabase/migrations/20251209000000_add_task_stage.sql:10-36` | Lifecycle, delivery and GitLab facts. `vtid` is free text, no FK |
| Lane and handoff files | `.kiro/specs/<slug>/lanes/*.md`, `handoff.md` (`.claude/rules/collaboration.md` §2) | Plan, lane state, `next_actor`, executor, seat, paths, VTID |
| Claim refs | `refs/heads/collab-claim/<slug>/<lane-id>` (`scripts/collab/queue.mjs:56`, `.claude/rules/collaboration.md` §5) | Which session holds a lane |
| Driver heartbeat refs | `refs/heads/collab-driver/<slug>` (`scripts/collab/plan-driver.mjs:29`, `:68`, `:73`; `.claude/rules/collaboration.md` §8) | Whether a plan has a live driver (alive < 45 min) |
| Session identity | `Collab-Session` / `Collab-Lane` trailers (`.claude/rules/collaboration.md` §3); session id format `kiro-<seat>-…` (`docs/programs/areas.yaml:9`) | Which account did what |
| Seats | `docs/programs/areas.yaml:14-18` | The configured Kiro seats (four at HEAD) |
| GitLab webhook events | `routes/internal-gitlab-webhook.ts:101`, `services/gitlab-events/delivery-mapper.ts:49-64` | MRs, pushes, pipelines, reviews, lane updates, landings, staging deploys |
| Delivery summary | `GET /api/v1/delivery/summary` (`routes/delivery.ts:101`) | Merge queue, pipelines, releases, latest STAGING-VERIFY |
| Project Manager status | `GET /api/v1/project-manager/status` (`routes/project-manager.ts:43`, `requireServiceOrAdmin`) | The PM's last observation of plans, lanes, claims and heartbeats (`services/project-manager/observe-live.ts:6-21`) and its decisions |
| Sparring sessions | `GET /api/v1/plans/spar/:id` (`routes/plans-spar.ts:66`) | Plan sparring state |

### 6.3 Panels

All panels are read views unless an action is named. Each action calls an existing owning route.

1. **Delivery accounts (the 13-account model).** The owner's target is 12 Kiro accounts and 1 Claude Code account. HEAD configures four Kiro seats (`docs/programs/areas.yaml:14-18`), and `CLAUDE.md` says Claude Code is retired. The panel lists every account the roster names and shows any account without evidence as "no evidence", never as active. Per account: seat, live sessions (from `Collab-Session` trailers and claim refs), claimed lanes, plans it drives (heartbeat refs), VTIDs, open merge requests, latest pipeline, review verdicts it gave or received, parked lanes and blockers, and the time of its last commit. Duplicate work shows as two claims or two open lanes on one path. Source: the Project Manager observation (6.2) for the git side, GitLab webhook events in OASIS for the GitLab side. Status: Designed but not implemented. Dependency: the roster decision of lane `delivery-capacity`.
2. **Plans and lanes.** One row per plan: state, driver alive or stale, lanes by state, `next_actor`, VTIDs, sparring verdict. A lane opens its lane log, its merge request in GitLab and its OASIS timeline. Source: lane files, claim and driver refs, `vtid_ledger`, `GET /api/v1/plans/spar/:id`. Status: Designed but not implemented.
3. **GitLab delivery.** Extends Delivery (`routes/delivery.ts:101`). Per repository: merge requests with review state, pipelines, environments and releases, each linking to GitLab. Merge requests come from the webhook events. Anything the webhook does not carry (review threads, environment state) is read through a read-only GitLab adapter or shown as a link. Status: Implemented but incomplete (merge queue, pipelines and releases exist; reviews and environments do not).
4. **VTID trace.** For one VTID: ledger row, OASIS timeline, lanes and sessions, merge requests, pipelines, STAGING-VERIFY run, deploy events. Source: Operations → VTIDs and OASIS → VTID ledger already read the ledger and projection (`routes/vtid.ts:885`). The trace adds git and GitLab facts by VTID. The ledger-link options are for lane `oasis-traceability`. Status: Implemented but incomplete.
5. **OASIS.** One event view (today three, section 4). Writes stay with `emitOasisEvent`. Status: Verified implemented, not operational.
6. **Tenant administration.** Admin → tenants (`routes/admin-tenants.ts:76`) becomes the multi-tenant programme's tenant module (`mt-tenant-admin-r2`). No second tenant wizard. Voice → Tenants & Roles stays the tenant × role health view. Status: Implemented but incomplete.
7. **Autopilot and workers.** One autonomy area that merges Autonomy and Autopilot. For every run it shows the owning plane (Dev Autopilot, worker orchestrator, automations, Kiro pipeline), using Autopilot → Orchestrator's existing read routes (`routes/orchestrator.ts:98-169`). Kill switches and approvals stay on their routes (`routes/dev-autopilot.ts:1407`, `routes/self-healing.ts:540`). No setting or autonomy level is changed by this design. Status: Implemented but incomplete.
8. **Integrations.** MCP connectors, LLM providers and tools read their live routes. Static GCP-era lists go. Status: Implemented but incomplete.
9. **Release and PUBLISH.** Shows, next to the PUBLISH button, the exact-commit STAGING-VERIFY result and the commit list between production and the staging commit. The gate behaviour is the owner's decision (section 7). Status: Implemented but incomplete.

### 6.4 What the design does not do

- It does not add a task database, an event store, a ledger or an ID scheme.
- It does not run, schedule or merge work itself.
- It does not mirror GitLab data into a new table. GitLab facts that are needed in OASIS already arrive through the webhook.
- It does not change any autonomy setting.

## 7. PUBLISH: code and standing rule disagree (for the owner)

- **Code at HEAD.** `publishAwsFlow` (`routes/operator.ts:2155`) reads the STAGING-VERIFY gate and then sets `allowed: true` (`routes/operator.ts:2202-2219`). A publish without a passing run writes `production.publish.gate_skipped` and continues. The comment says "removed by owner decision 2026-11-08". The change is VTID-05620 (commit `2daf4efef2`, PR #4868), sparred and converged (`docs/validation/VTID-05620/plan-sparring.md`). The Command Hub client still contains the retired override prompt for a 409 refusal (`frontend/command-hub/command-hub-staging.js:894-910`); the server no longer sends it.
- **Standing rule at HEAD.** `CLAUDE.md` rule 46 says a change is done when STAGING-VERIFY passed on the exact deployed commit. Rule 50 says "IF STAGING-VERIFY fails → THEN no ready message and no PUBLISH". Rule 50a lists a passed STAGING-VERIFY on the exact commit as a requirement for both publish scopes. `.claude/rules/collaboration.md` §7c pins publishes to "the commit that passed STAGING-VERIFY". None of these was amended with VTID-05620.
- **Related facts, same function.** The frontend leg dispatches `AWS-PROD-DEPLOY-FRONTEND.yml` on `main` with no commit pin (`routes/operator.ts:2318-2325`). `software_versions` is written with `status: 'success'` and `production.publish.completed` is emitted at dispatch time (`routes/operator.ts:2362-2387`). A GCP mirror step remains behind `GCP_DUAL_PUBLISH_ENABLED` (`routes/operator.ts:2331-2340`).
- **The decision needed.** The rule text and the code cannot both stand. The owner either amends `CLAUDE.md` rules 46, 50 and 50a and collaboration.md §7c to match the code, or keeps the rules and the code is changed in a sparred plan. This lane makes no recommendation and changes nothing. `CLAUDE.md` is a protected gate file, so either path needs the owner's instruction naming a plan.

## 8. Proposed follow-ups

Each is a separate plan with its own sparring. None is done by this lane.

| # | Title | Files | Risk | Owner | Gate |
|---|---|---|---|---|---|
| F-01 | Owner decision on the PUBLISH rule/code conflict | `CLAUDE.md` rules 46/50/50a, `.claude/rules/collaboration.md` §7c, or `routes/operator.ts` | High: production publishing | Project owner | Owner instruction naming a plan; protected gate file |
| F-02 | Security review of routes with no auth found | `routes/specs.ts`, `routes/triage-agent.ts`, `routes/ai-personality.ts`, `routes/llm.ts`, `routes/events.ts`, `routes/board-adapter.ts`, `routes/vtid.ts`, `routes/approvals.ts`, `routes/worker-orchestrator.ts`, `routes/routines.ts` and the other routes marked in section 3 | High: unauthenticated writes and service-role reads, exposure Unknown | Security owner | Sparred plan; no live probing without an authorised environment |
| F-03 | Fix calls with no serving route | `app.js` (`fetchDbVectorStats`, connector list calls), `routes/semantic-memory.ts` | Low | Developer-experience owner | Sparred plan (front end plus route) |
| F-04 | Filter navigation by the caller's grants | `app.js` (`renderSidebar`) | Medium: hides screens; server stays the gate | Developer-experience owner | Sparred plan |
| F-05 | Delivery accounts and plans/lanes panels (6.3 items 1 and 2) | new Command Hub module, read route over the PM observation | Medium | Developer-experience owner | After the `delivery-capacity` roster decision; sparred plan |
| F-06 | GitLab delivery view: reviews and environments (6.3 item 3) | `routes/delivery.ts`, `frontend/command-hub/delivery.js`, a read-only GitLab adapter | Medium: GitLab credentials (read scope) | Developer-experience owner | Sparred plan; credential change needs the owner |
| F-07 | Move GitHub-only reads to GitLab | `routes/approvals.ts`, `routes/cicd.ts`, `services/project-manager/observe-live.ts` | Medium | Developer-experience owner | After each repository's GitLab cutover |
| F-08 | One event view, one model view, one release view | `app.js` (OASIS, Operations, Operator, Agents, Integrations, Models, Infrastructure tabs) | Low | Developer-experience owner | Sparred plan |
| F-09 | One autonomy area with run ownership | `app.js` (Autonomy, Autopilot), `routes/orchestrator.ts` (read only) | Medium; no autonomy setting changes | Developer-experience owner | Sparred plan |
| F-10 | Retire GCP-era static tabs | `app.js` (Databases, Infrastructure → config, Security → keys-secrets / rls-access, Integrations → apis / plugins / service-mesh, Docs static tabs, Assistant → experiments) | Low | Developer-experience owner | Sparred plan after a consumer check |
| F-11 | Health probes to `/alive` | `app.js` (`fetchDiagHealthChecks`, `fetchInfraServices`) | Low | Developer-experience owner | `frontend-simple` does not apply (gateway repo); sparred plan |
| F-12 | Remove local task overrides | `app.js` (`localStorage` overrides) | Medium: board behaviour | Developer-experience owner | Sparred plan |
| F-13 | Tenant-aware AI-assistant policy view | `app.js` (`policies/maxina`) | Low | Multi-tenant programme | Coordinate with `mt-tenant-admin-r2` |
| F-14 | Decide the second merge path | `routes/cicd.ts` (`autonomous-pr-merge`), Operations → approvals | Medium: merge governance | Project owner | Sparred plan |
