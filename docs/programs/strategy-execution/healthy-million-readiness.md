# Healthy Million replication readiness (M-HM, 19 acceptance criteria)

- **Status:** Discovery document. Read-only review of code and specs. Nothing in this document is implemented by it.
- **Owner:** Project owner (decisions); multi-tenant programme owner (prerequisites); Kiro session
  `kiro-exafy-202611110004-e38b`, seat `exafy` (author).
- **Pinned HEADs:** vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`, vitana-v1
  `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`, strategy input `vitanaland-strategy` `fb77090e1ffc7d1ef3c250b0aa721768c3df9425`.
  Every `path:line` below resolves on these commits (`docs/validation/VTID-05690/commands.log`).
- **VTID:** VTID-05690 (lane `hm-readiness` of plan `strategy-execution-wave1`).
- **Plan:** `.kiro/specs/strategy-execution-wave1/plan.md` §4.6; tasks `.kiro/specs/strategy-execution-wave1/tasks.md`
  (lane `hm-readiness`); sparring record `.kiro/specs/strategy-execution-wave1/sparring/verdict.md`.

## 1. What this document is

The strategy defines Healthy Million as the first destination after Maxina that must run the complete product as its own
tenant, and lists 19 acceptance criteria for milestone M-HM
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:58-88`). This document checks each criterion
against what the Maxina implementation does today and names what must land first.

Boundaries of this lane:

- **No tenant, pack or content is created.** No `provision_tenant()` call, no brand pack row, no content override, no
  knowledge document, no copy. The document only reads code, specs and the migration queue.
- **Replication does not start from this document.** It stays gated on three foundations: the multi-tenant foundation
  (migration queue and mt-* lanes), the mobile foundation (one shared native app with destination branding) and the
  website foundation (a Healthy Million public site). Section 4 lists what each must deliver.
- **Tenant creation is an owner step after Gate 2** of the multi-tenant launch work. No agent provisions Healthy
  Million (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:106`). `provision_tenant()` refuses any
  caller who is not an `exafy_admin` (`supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:105-106`).
- Nothing was read from a live system. Facts about production (applied migrations, run ids) come from the committed
  migration queue, not from a database query.

Healthy Million appears nowhere in either repository (`git grep -il "healthy[ _-]?million"` returns 0 files in both,
`docs/validation/VTID-05690/commands.log`).

### Terms

- **Tenant-scoped:** the code reads the tenant from the request, token or context and filters by it.
- **Maxina-hardwired:** a Maxina literal, route, seed value or fallback decides the behaviour.
- **Mixed:** tenant-scoped design with a Maxina literal or fallback on a path a Healthy Million member would reach.
- **Status class** (tasks.md common acceptance): Verified operational (only with a run id); Verified implemented, not
  operational; Implemented but incomplete; Designed but not implemented; Deprecated/superseded; Unknown.
- **Readiness:** `ready` (nothing blocks the criterion); `blocked by X`; `unknown` (could not be decided read-only).
- **Lane state versus queue state.** A DB lane in state `done` means its migration file is merged. The migration is
  live only when its queue row says `applied`. Every row after row 8 is pending or queued for owner approval
  (`docs/multitenancy/MIGRATION-QUEUE.md:26-81`). Applying any of them is owner stop 1 of the owner-autonomy rules.

## 2. Summary table

| # | Criterion (short) | Tenant handling today | Status class | Readiness |
|---|---|---|---|---|
| 1 | Own identity and branding | Mixed | Implemented but incomplete | blocked by VTID-05483, VTID-05484, VTID-05494, VTID-05245 (queue row 11) |
| 2 | Own landing page and public site | Mixed (app portal); no site | Implemented but incomplete (portal); Designed but not implemented (site) | blocked by the website foundation, queue rows 30-31, VTID-05502, VTID-05325 |
| 3 | Own experience in the shared native app | Mixed | Implemented but incomplete | blocked by the mobile foundation (VTID-05598, VTID-05599, VTID-05505, VTID-05664) |
| 4 | Registration and onboarding with its own copy and media | Maxina-hardwired copy, tenant-scoped signup | Implemented but incomplete | blocked by VTID-05496, VTID-05499, VTID-05324 (rows 9-10) |
| 5 | Profiles, community, posts, events, matching, marketplace | Mixed | Implemented but incomplete | blocked by community isolation (no approved plan), mt-network-r2 rows, VTID-05486, VTID-05574 |
| 6 | Vitana guidance with its own facts; no Maxina persona | Maxina-hardwired persona | Implemented but incomplete | blocked by VTID-05499, VTID-05497 (row 40) |
| 7 | Content and configuration through tenant packs | Tenant-scoped schema, packs not live | Implemented but incomplete | blocked by queue rows 8a, 9, 10 and VTID-05494 |
| 8 | Tenant administration and provisioning | Tenant-scoped | Implemented but incomplete | blocked by VTID-05490, VTID-05492, VTID-05323, rows 32-33 |
| 9 | Tenant-owner analytics, aggregated and privacy-safe | Tenant-scoped, no cohort threshold | Implemented but incomplete | blocked by VTID-05326, VTID-05594 |
| 10 | Five pillars with Mental Health | Tenant-agnostic (same for all) | Implemented but incomplete | blocked by VTID-05691 and its follow-ups |
| 11 | Data isolation suite and isolation health at zero | Tenant-scoped design, suite red, not in CI | Implemented but incomplete | blocked by VTID-05443, queue rows 12-18 |
| 12 | Maxina golden suite unchanged | Golden pins Maxina | Verified implemented, not operational | ready for the web golden; blocked by VTID-05448 for the gateway golden |
| 13 | No Maxina or Mariia string in Healthy Million surfaces | Maxina-hardwired (128 + 53 + 30 files) | Implemented but incomplete | blocked by VTID-05496, VTID-05499, VTID-05494, VTID-05483 and native work |
| 14 | No Maxina fork | Generic portal exists beside the Maxina portal | Implemented but incomplete | ready as a constraint; blocked where only Maxina screens exist (criterion 4) |
| 15 | No duplicated mobile app | One Expo app | Implemented but incomplete | ready as a constraint |
| 16 | No separate intelligence architecture | Tenant + user scoped memory | Implemented but incomplete | ready as a constraint; overlays blocked by VTID-05499, VTID-05497 |
| 17 | No cross-tenant leakage (memory, recommendations, push, search, matching, analytics) | Mixed | Implemented but incomplete | blocked by VTID-05486, VTID-05574, VTID-05598, community isolation |
| 18 | Health data member-owned; no tenant-admin access | Member-owned by rule, home-tenant column not applied | Implemented but incomplete | blocked by queue rows 43-44, VTID-05596, VTID-05594 |
| 19 | Research enrolment disabled until governance approved | No research feature exists | Designed but not implemented (governance) | ready today by absence; unknown once Healthy Million content is written |

No criterion is fully ready. Criteria 12, 14, 15, 16 and 19 are ready only as constraints that later work must keep.

## 3. Criterion by criterion

### Identity and presence

**1. Own identity and branding (name, tokens, assets, legal entity, sender) from its brand pack**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:64`)

- Today: the brand pack schema exists. `tenant_settings` has `display_name`, `brand`, `legal_entity_line`,
  `support_email`, `sender_name`, `sender_email` and `persona_facts`
  (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:35-49`), applied as queue row 5
  (`docs/multitenancy/MIGRATION-QUEUE.md:22`). Maxina's values are seed data in the same migration, including
  `sender_name = 'Maxina by VITANA'` (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:213-220`).
- The frontend reads the registry entry for the name and logo on the generic portal
  (`vitana-v1/src/pages/portals/TenantPortal.tsx:147`), but the brand colour variables are written and not consumed
  (`vitana-v1/src/hooks/useTenant.tsx:123`). When the registry call fails, the only compiled tenant is Maxina
  (`vitana-v1/src/lib/tenant-registry.ts:75-88`).
- Tenant handling: Mixed. Status: Implemented but incomplete.
- Prerequisites: `mt-frontend-brand-r3` lanes `brand-surface-r3` VTID-05483 and `theme-tokens-r3` VTID-05484, both
  `ready` (`.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:37`,
  `.kiro/specs/mt-frontend-brand-r3/lanes/theme-tokens-r3.md:18`); `mt-packs-r2` lane `brand-content-templating`
  VTID-05494 (`.kiro/specs/mt-packs-r2/lanes/brand-content-templating.md:17`); per-tenant email branding, queue row 11
  (`docs/multitenancy/MIGRATION-QUEUE.md:29`), lane `email-brand-db` VTID-05245 in review
  (`.kiro/specs/mt-frontend-brand/lanes/email-brand-db.md:15`).
- Readiness: blocked by VTID-05483, VTID-05484, VTID-05494 and the apply of queue row 11.

**2. Own landing page and public site, separate from Maxina and vitanaland.com**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:65`)

- Today: the app has a generic tenant intro and portal: `/_intro/:tenantSlug` (`vitana-v1/src/App.tsx:819`) and the
  catch-all `/:tenantSlug` portal (`vitana-v1/src/App.tsx:2337`), which resolves the slug and has no Maxina fallback
  (`vitana-v1/src/pages/portals/TenantPortal.tsx:33`, `vitana-v1/src/pages/portals/TenantPortal.tsx:64`). The intro page
  still adds Maxina CSS classes for every tenant (`vitana-v1/src/pages/IntroExperience.tsx:27`). The vitanaland.com
  apex maps to Maxina (`vitana-v1/src/config/domain-tenant-mapping.ts:5-8`).
- No public site exists for any destination: no Website Factory renderer or skeleton code is in either repository
  (`git grep` in `docs/validation/VTID-05690/commands.log`). The strategy records the same
  (`vitanaland-strategy/07-WEBSITES/README.md:27`, `vitanaland-strategy/07-WEBSITES/README.md:80`).
- A healthymillion.com domain needs `tenant_domains` and host resolution, queue rows 30-31, not applied
  (`docs/multitenancy/MIGRATION-QUEUE.md:48-49`), lane `host-resolution-gw` VTID-05502 `ready`
  (`.kiro/specs/mt-m3-r2/lanes/host-resolution-gw.md:16`). Custom domains are an M3 item
  (`docs/MULTI-TENANT-PLAN.md:119`).
- Tenant handling: Mixed for the app portal. Status: Implemented but incomplete (portal); Designed but not implemented
  (public site).
- Prerequisites: website foundation (strategy SB-WF-01/SB-WF-02, `vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:52`);
  `mt-launch` lane `support-landing` VTID-05325 (`.kiro/specs/mt-launch/lanes/support-landing.md:18`); rows 30-31.
- Readiness: blocked by the website foundation, queue rows 30-31 and VTID-05502, VTID-05325.

**3. Own experience in the shared native app, without a separate app**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:66`)

- Today: one Expo app in `vitana-v1/apps/mobile`. Its development identifiers are iOS `com.exafy.maxina.dev` and Android
  `com.vitanaland.app.dev` (`vitana-v1/apps/mobile/app.config.ts:27-30`), URL scheme `maxina`
  (`vitana-v1/apps/mobile/app.config.ts:217`), and there is no production build profile
  (`vitana-v1/apps/mobile/app.config.ts:34`). The native tenant registry falls back to the compiled Maxina registry
  (`vitana-v1/apps/mobile/src/identity/tenant-registry.ts:54`, `vitana-v1/apps/mobile/src/identity/tenant-registry.ts:73`).
  53 non-test files under `apps/mobile/src` contain "maxina" (commands.log).
- `docs/MULTI-TENANT-PLAN.md:60` (§4.8) still describes a Capacitor shell; the native-app plan chose Expo and rejected
  Capacitor (`vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md:74-77`). The tenancy rules of §4.8 still apply.
- Tenant handling: Mixed. Status: Implemented but incomplete.
- Prerequisites (mobile foundation): `mt-native-health-r2` lanes `native-push-tenant` VTID-05598 and
  `native-tenant-isolation-tests` VTID-05599 (`.kiro/specs/mt-native-health-r2/lanes/native-push-tenant.md:17`,
  `.kiro/specs/mt-native-health-r2/lanes/native-tenant-isolation-tests.md:16`); `mt-m3-r2` lane `native-domains-aasa`
  VTID-05505 (`.kiro/specs/mt-m3-r2/lanes/native-domains-aasa.md:19`); owner gate G3 for store accounts, lane
  `store-submission-owner` VTID-05664 (`.kiro/specs/native-wave3-release-r2/lanes/store-submission-owner.md:15`,
  `vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md:118-120`).
- Readiness: blocked by the mobile foundation (VTID-05598, VTID-05599, VTID-05505, VTID-05664) and by native brand
  neutralisation, which has no lane yet (proposed follow-up F1).

### Complete product journey

**4. Registration and onboarding with Healthy Million copy and media**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:70`)

- Today: signup lands in the tenant flagged `is_default`, not the oldest tenant
  (`supabase/migrations/20261014000200_vtid_05149_signup_default_tenant.sql:120`,
  `supabase/migrations/20261014000200_vtid_05149_signup_default_tenant.sql:181`), applied as queue row 3
  (`docs/multitenancy/MIGRATION-QUEUE.md:20`). The welcome screen plays the Maxina intro video and shows the
  `welcomeMaxina` string for every member (`vitana-v1/src/pages/onboarding/OnboardingWelcome.tsx:44`,
  `vitana-v1/src/pages/onboarding/OnboardingWelcome.tsx:142`). The onboarding-coach route has no tenant handling
  (0 "tenant" matches, commands.log). The welcome-team sender list starts with `mariia`
  (`services/gateway/src/services/welcome-team/config.ts:31`, `services/gateway/src/services/welcome-team/config.ts:61`).
- Tenant handling: tenant-scoped signup; Maxina-hardwired onboarding copy, video and welcome sender.
- Status: Implemented but incomplete.
- Prerequisites: `mt-packs-r2` lanes `frontend-brand-neutralise` VTID-05496 and `persona-pack` VTID-05499
  (`.kiro/specs/mt-packs-r2/lanes/frontend-brand-neutralise.md:21`, `.kiro/specs/mt-packs-r2/lanes/persona-pack.md:24`);
  `mt-launch` lane `pack-intake-db` VTID-05324 (`.kiro/specs/mt-launch/lanes/pack-intake-db.md:19`, state `executing`),
  queue rows 9-10 (`docs/multitenancy/MIGRATION-QUEUE.md:27-28`); welcome-team per tenant has no lane (follow-up F2).
- Readiness: blocked by VTID-05496, VTID-05499, VTID-05324 and rows 9-10.

**5. Profiles, community, posts, activities and events, matching, marketplace/services as enabled by its capability
configuration** (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:71`)

- Today, per surface:
  - Community dispatch uses the actor's tenant (`services/gateway/src/routes/community.ts:410`).
  - Member count is gated by `requireTenant` but the query is filtered by user only
    (`services/gateway/src/routes/community-members.ts:64`).
  - Chat groups filter by tenant (`services/gateway/src/routes/chat-groups.ts:85`).
  - The Discover feed takes the tenant row first (`services/gateway/src/routes/discover-feed.ts:126`).
  - Matches carry `tenant_id` (`services/gateway/src/routes/matchmaking-repository.ts:31`).
  - Marketplace reads the tenant from identity (`services/gateway/src/routes/community-marketplace.ts:141`).
  - Posts, calendar and other community tables are listed as global/shared in the plan's starting state
    (`docs/MULTI-TENANT-PLAN.md:30`).
- Capability configuration is `tenant_settings.feature_flags`, merged by
  `tenant_settings_merge_feature_flags` (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:176`) and
  written by tenant admins (`services/gateway/src/routes/tenant-admin/settings.ts:67`).
- Tenant handling: Mixed. Status: Implemented but incomplete.
- Prerequisites: community isolation has no approved plan. `mt-community-isolation-r2` exists only on the branch
  `kiro/mt-community-isolation-r2/plan`, its sparring verdict is escalated and its lanes have no VTID (not on
  `origin/main`, so no line is cited; commands.log shows the branch check). `mt-network-r2` scope migrations, queue rows
  45-56 and 63-65 (`docs/multitenancy/MIGRATION-QUEUE.md:63-74`, `docs/multitenancy/MIGRATION-QUEUE.md:79-81`);
  lane `matching-discover-scope-v1` VTID-05574 (`.kiro/specs/mt-network-r2/lanes/matching-discover-scope-v1.md:21`);
  `mt-discover-r2` lane `discover-shared-predicate` VTID-05486
  (`.kiro/specs/mt-discover-r2/lanes/discover-shared-predicate.md:48`) and supplier rows 26-29
  (`docs/multitenancy/MIGRATION-QUEUE.md:44-47`).
- Readiness: blocked by community isolation (needs a re-plan that converges), the mt-network-r2 rows, VTID-05574 and
  VTID-05486.

**6. Vitana guidance with Healthy Million facts and intents; one Vitana identity; no Maxina persona**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:72`)

- Today: the signed-in base identity names Maxina (`services/gateway/src/services/ai-personality-service.ts:86`). The
  anonymous instruction presents Vitana as "brand presenter for the Maxina Community"
  (`services/gateway/src/routes/orb-live.ts:7448`) and tells the Mariia Maksina origin story
  (`services/gateway/src/routes/orb-live.ts:7503`). The knowledge manual is pinned to `kb/instruction-manual/maxina`
  (`services/gateway/src/orb/live/instruction/live-system-instruction.ts:1282`). The `persona_facts` column exists
  (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:47`) but `orb-live.ts` does not read it
  (commands.log). Assistant config per tenant exists behind `requireTenantAdmin`
  (`services/gateway/src/routes/tenant-admin/assistant-config.ts:30`).
- Tenant handling: Maxina-hardwired persona; tenant-scoped assistant config. Status: Implemented but incomplete.
- Prerequisites: `persona-pack` VTID-05499 (fixed Vitana block plus tenant facts block,
  `.kiro/specs/mt-packs-r2/plan.md:129-130`); `kb-overlay-code` VTID-05497 (`.kiro/specs/mt-packs-r2/lanes/kb-overlay-code.md:18`)
  after queue row 40 (`docs/multitenancy/MIGRATION-QUEUE.md:58`); `tenant-db-and-slug-cleanup` VTID-05468
  (`.kiro/specs/mt-identity-r2/lanes/tenant-db-and-slug-cleanup.md:34`), which persona-pack needs.
- Readiness: blocked by VTID-05499, VTID-05497, VTID-05468 and row 40.

**7. Tenant content and configuration managed through tenant packs**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:73`)

- Today: the brand pack is applied (row 5). `tenant_content_overrides` is queue row 8a, pending
  (`docs/multitenancy/MIGRATION-QUEUE.md:26`), although its lane is `done` (merged file). Pack intake and the content
  pipeline are rows 9-10, pending (`docs/multitenancy/MIGRATION-QUEUE.md:27-28`). The packs plan keeps everything dark
  behind `MT_RESOLUTION_V2` and `feature_flags.mt.packs` (`.kiro/specs/mt-packs-r2/plan.md:310`).
- Tenant handling: tenant-scoped schema; packs not live. Status: Implemented but incomplete.
- Prerequisites: apply of rows 8a, 9, 10 (owner approval); `brand-content-templating` VTID-05494; `pack-intake-admin`
  VTID-05323 (`.kiro/specs/mt-launch/lanes/pack-intake-admin.md:25`).
- Readiness: blocked by rows 8a, 9, 10, VTID-05494 and VTID-05323.

**8. Tenant administration through the existing tenant-admin module and provisioning**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:74`)

- Today: `requireTenantAdmin` (`services/gateway/src/middleware/require-tenant-admin.ts:63`) lets `exafy_admin` through
  (`services/gateway/src/middleware/require-tenant-admin.ts:96`) and denies a caller whose token tenant differs from the
  target (`services/gateway/src/middleware/require-tenant-admin.ts:114`). `provision_tenant()` exists
  (`supabase/migrations/20261014000500_vtid_05150_provision_tenant.sql:55`), applied as row 6 with no tenant created
  (`docs/multitenancy/MIGRATION-QUEUE.md:23`). Tenant admin pages exist in vitana-v1
  (`vitana-v1/src/pages/admin/TenantManagement.tsx:171`, `vitana-v1/src/pages/admin/settings/FeatureFlags.tsx:31`).
- The strategy names vitana-v1 PR #1438 (provisioning UI) as in review. This lane did not call GitHub, so its state is
  Unknown here.
- Tenant handling: Tenant-scoped. Status: Implemented but incomplete.
- Prerequisites: `mt-tenant-admin-r2` lanes `tenant-admin-api` VTID-05490, `tenant-admin-pages` VTID-05492,
  `command-hub-tenant-module` VTID-05489 (`.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-api.md:25`,
  `.kiro/specs/mt-tenant-admin-r2/lanes/tenant-admin-pages.md:28`,
  `.kiro/specs/mt-tenant-admin-r2/lanes/command-hub-tenant-module.md:20`); lifecycle rows 32-33
  (`docs/multitenancy/MIGRATION-QUEUE.md:50-51`); `pack-intake-admin` VTID-05323.
- Readiness: blocked by VTID-05490, VTID-05492, VTID-05489, VTID-05323 and rows 32-33.

**9. Analytics for the tenant owner, aggregated and privacy-safe**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:75`)

- Today: tenant-admin analytics are gated and tenant-filtered
  (`services/gateway/src/routes/tenant-admin/product-analytics.ts:39`,
  `services/gateway/src/routes/tenant-admin/insights-repository.ts:56`) and state that they return aggregates only
  (`services/gateway/src/routes/tenant-admin/product-analytics.ts:20`). No minimum-cohort or k-anonymity threshold was
  found in the tenant-admin analytics files (grep in commands.log). The non-admin
  `services/gateway/src/routes/product-analytics-repository.ts` has no tenant reference.
- Tenant handling: Tenant-scoped (admin routes). Status: Implemented but incomplete.
- Prerequisites: `mt-launch` lane `tenant-owner-analytics` VTID-05326 (`.kiro/specs/mt-launch/lanes/tenant-owner-analytics.md:17`);
  `mt-native-health-r2` lane `health-analytics-lineage-guard` VTID-05594
  (`.kiro/specs/mt-native-health-r2/lanes/health-analytics-lineage-guard.md:18`); a small-cohort rule has no lane
  (follow-up F3).
- Readiness: blocked by VTID-05326 and VTID-05594.

**10. Five-pillar experiences with all five pillars, Mental Health included**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:76`)

- Today: the five keys are fixed for every tenant (`services/gateway/src/lib/vitana-pillars.ts:21-27`). The gateway
  label returns the key itself (`services/gateway/src/lib/vitana-pillars.ts:29-31`), and the web label reads "Mental"
  (`vitana-v1/src/i18n/en/health.json:42`, `vitana-v1/src/i18n/en/vitanaIndex.json:15`,
  `vitana-v1/src/i18n/en/healthNative.json:292`).
- Tenant handling: tenant-agnostic, which is what the criterion needs. Status: Implemented but incomplete (label).
- Prerequisites: lane `mental-health-label` VTID-05691 of this wave (web i18n values); the gateway `pillarLabel()` and
  native labels are follow-ups of that lane (plan §4.8).
- Readiness: blocked by VTID-05691 and its follow-ups.

### Isolation and reuse

**11. Data isolation: zero cross-tenant reads in the isolation suite, and `ci_tenant_isolation_health()` at zero**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:80`)

- Today: `ci_tenant_isolation_health()` is defined
  (`supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:20`), service-role only
  (`supabase/migrations/20261014000300_vtid_05149_ci_tenant_isolation_health.sql:126-127`), applied as row 4
  (`docs/multitenancy/MIGRATION-QUEUE.md:21`), and called report-only by the morning health check
  (`.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:545`, `.github/workflows/MORNING-SYSTEM-HEALTH-CHECK.yml:552`).
  No run result is recorded here, so it is not "Verified operational". The strict isolation suite is red by design
  today (`scripts/ci/sql-tests/run-mt-isolation-test.sh:7-8`) and no workflow runs it (grep in commands.log). The
  local-stack gate does run in CI (`.github/workflows/MT-LOCAL-STACK.yml:50`).
- Bare tenant policies are rewritten by queue rows 12-13 and the access-token hook by rows 17-18, all queued
  (`docs/multitenancy/MIGRATION-QUEUE.md:30-36`).
- Tenant handling: tenant-scoped design. Status: Implemented but incomplete.
- Prerequisites: `mt-guardrails-r2` lane `ci-wiring` VTID-05443 (`.kiro/specs/mt-guardrails-r2/lanes/ci-wiring.md:17`);
  rows 12-18.
- Readiness: blocked by VTID-05443 and queue rows 12-18. The strategy's production check is read-only and comes after
  the isolated-environment run, never instead of it.

**12. Maxina golden suite unchanged, except recorded owner-approved exceptions**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:81`)

- Today: the web golden test pins Maxina's registry, sidebar, login, intro and routing behaviour, including
  `displayNameOffPortal: 'Maxina'` (`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:114-122`), and checks that
  `/maxina` still maps to `MaxinaPortal` (`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:165-170`). It runs
  with `npm test`. The gateway golden suite is not built: lane `maxina-golden-suite` VTID-05448 is `ready`
  (`.kiro/specs/mt-guardrails-r2/lanes/maxina-golden-suite.md:16`), and the packs plan waits for it
  (`.kiro/specs/mt-packs-r2/plan.md:56-57`). The only recorded planned exception is Network presence
  (`docs/MULTI-TENANT-PLAN.md:67`).
- Tenant handling: the golden pins Maxina-hardwired behaviour on purpose. Status: Verified implemented, not operational.
- Readiness: ready for the web golden; blocked by VTID-05448 for the gateway golden.

**13. No Maxina or Mariia string in Healthy Million surfaces, web and native, store identifiers excepted**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:82`)

- Today: "maxina" appears in 128 non-test `.ts`/`.tsx` files under `vitana-v1/src` and 53 under `vitana-v1/apps/mobile/src`;
  "Mariia", "Maksina" or "Maria Maxina" in 30 non-test files under `services/gateway/src` and 6 under `vitana-v1/src`
  (commands.log). Examples a member would meet: `services/gateway/src/routes/orb-live.ts:7503`,
  `services/gateway/src/services/welcome-team/config.ts:61`, `vitana-v1/src/pages/onboarding/OnboardingWelcome.tsx:142`.
  Store identifiers are exempt (`docs/MULTI-TENANT-PLAN.md:60`).
- Spelling: the repositories spell the character "Mariia Maksina"; "Maria Maxina" appears only as the spoken form the
  voice ranker maps to it (`services/gateway/src/services/voice-tools/community-member-ranker.ts:369`). The strategy
  uses "Maria Maxina" and asks the brand owner to confirm (`vitanaland-strategy/07-WEBSITES/README.md:31`).
- Tenant handling: Maxina-hardwired. Status: Implemented but incomplete.
- Prerequisites: VTID-05496, VTID-05499, VTID-05494, VTID-05483; a scan that proves the criterion has no lane
  (follow-up F4); native strings have no lane (F1).
- Readiness: blocked by those lanes and F1, F4.

**14. No Maxina fork: no copied code path, route tree or database**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:83`)

- Today: Maxina keeps its own portal and confirmation screens (`vitana-v1/src/App.tsx:876`, `vitana-v1/src/App.tsx:832`),
  while new tenants use the generic `TenantPortal` (`vitana-v1/src/App.tsx:118-119`, `vitana-v1/src/App.tsx:2337`).
  The multi-tenant principle is "mirror the platform, not the content" (`docs/MULTI-TENANT-PLAN.md:19`). One database
  serves every tenant.
- Tenant handling: generic route tree exists beside the Maxina one. Status: Implemented but incomplete.
- Readiness: ready as a constraint (Healthy Million uses the generic routes); blocked where only a Maxina screen exists
  (onboarding, criterion 4).

**15. No duplicated mobile app** (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:84`)

- Today: one Expo app (`vitana-v1/apps/mobile/app.config.ts:27-30`); the plan requires one native app per store for
  every tenant (`docs/MULTI-TENANT-PLAN.md:60`).
- Status: Implemented but incomplete.
- Readiness: ready as a constraint. It stays ready while no second app is created.

**16. No separate intelligence architecture** (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:85`)

- Today: `memory_items.tenant_id` is NOT NULL (`supabase/migrations/20251231000000_vtid_01104_memory_core_v1.sql:43`);
  memory reads filter by tenant (`services/gateway/src/services/orb-memory-bridge-repository.ts:29`); the context
  builder refuses a lens without tenant and user (`services/gateway/src/services/context-pack-builder.ts:173`).
- Tenant handling: tenant + user scoped. Status: Implemented but incomplete.
- Readiness: ready as a constraint; the tenant overlays are blocked by VTID-05499 and VTID-05497.

**17. No cross-tenant leakage in memory, recommendations, push, search, matching or analytics**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:86`)

- Today, per surface:
  - Memory: tenant-filtered (`services/gateway/src/services/orb-memory-bridge-repository.ts:29`).
  - Push: device tokens filtered by user and tenant
    (`services/gateway/src/services/notification-service-repository.ts:37-42`); the plan records that a dual member
    loses the other tenant's pushes (`docs/MULTI-TENANT-PLAN.md:60`).
  - Search: product search has no tenant filter (`services/gateway/src/routes/discover-search-repository.ts:29`);
    chat search does (`services/gateway/src/routes/chat-search.ts:105`).
  - Recommendations: autopilot recommendations are tenant-filtered
    (`services/gateway/src/routes/autopilot-recommendations-repository.ts:38`); the Discover recommendations repository
    has no tenant reference (commands.log).
  - Matching: the intent-matches route requires a tenant (`services/gateway/src/routes/intent-matches.ts:38`) but its
    repository has no tenant filter (commands.log).
  - Analytics: admin routes are tenant-filtered (criterion 9); the non-admin repository is not.
- Tenant handling: Mixed. Status: Implemented but incomplete.
- Prerequisites: VTID-05486 (Discover predicate), VTID-05574 (matching scope), VTID-05598 (push), community isolation
  (criterion 5), VTID-05599 (native isolation tests).
- Readiness: blocked by those items.

**18. Health data stays member-owned; a Healthy Million tenant admin sees no member health data**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:87`)

- Today: the hard rule is in the plan (`docs/MULTI-TENANT-PLAN.md:61`). The partner-health tenant-admin branch was
  removed; only `exafy_admin` gets the admin scope (`services/gateway/src/routes/admin-partner-health.ts:77`,
  `services/gateway/src/routes/admin-partner-health.ts:88-89`). A sampled health policy reads owner plus tenant
  (`supabase/migrations/20251231000000_vtid_01078_health_brain_phase_c1.sql:261-265`). The frozen health home tenant
  column (`supabase/migrations/20261102130000_vtid_05595_health_home_tenant_column.sql:45`) is queue rows 43-44,
  queued (`docs/multitenancy/MIGRATION-QUEUE.md:61-62`), although its lane is `done`.
- Tenant handling: member-owned by rule; not all health tables were checked policy by policy (Unknown for the rest).
- Status: Implemented but incomplete.
- Prerequisites: rows 43-44; `health-tenant-accessor` VTID-05596 (`.kiro/specs/mt-native-health-r2/lanes/health-tenant-accessor.md:23`);
  `health-analytics-lineage-guard` VTID-05594.
- Readiness: blocked by rows 43-44, VTID-05596 and VTID-05594.

**19. Research enrolment stays disabled until research governance is approved**
(`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:88`)

- Today: no research enrolment feature or flag exists in either repository. The only related code is a consent-type
  constant `research_participation` (`services/openclaw-bridge/src/skills/vitana-compliance.ts:22`). The research
  governance definition is open in the strategy (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:55`).
- Status: Designed but not implemented (governance).
- Readiness: ready today by absence. Unknown once Healthy Million content is written: any enrolment wording or flag must
  default off (follow-up F5).

## 4. What must land before replication starts

Replication (strategy SB-HM-02) does not start until all three foundations below hold. None of them is started or changed
by this document.

**Multi-tenant foundation**

1. Owner-approved apply of the queued migrations Healthy Million depends on: rows 8a, 9, 10 (packs, intake), 11 (email
   branding), 12-18 (policies, membership, token hook), 26-29 (Discover), 30-31 (domains, if healthymillion.com is used),
   32-33 (lifecycle), 40 (knowledge overlay), 43-44 (health home tenant), 45-56 and 63-65 (Network scopes)
   (`docs/multitenancy/MIGRATION-QUEUE.md:26-81`). Each apply is owner stop 1.
2. Lanes, in dependency order: VTID-05468; VTID-05443 and VTID-05448 (CI isolation and golden); VTID-05483, VTID-05484,
   VTID-05494, VTID-05496, VTID-05499, VTID-05497; VTID-05323, VTID-05324, VTID-05325, VTID-05326; VTID-05489,
   VTID-05490, VTID-05492; VTID-05486, VTID-05574; VTID-05594, VTID-05596.
3. Community isolation: `mt-community-isolation-r2` escalated in sparring and has no VTIDs. It needs a re-plan that
   converges before criterion 5 or 17 can pass.

**Mobile foundation**

4. VTID-05598, VTID-05599, VTID-05505 and owner gate G3 (VTID-05664); native brand neutralisation (F1); the §4.8
   wording reconciled with Expo (strategy item, `vitanaland-strategy/02-PLATFORM/native-mobile-alignment.md:63-69`).

**Website foundation**

5. A Healthy Million public site: Website Factory minimum (strategy SB-WF-01/SB-WF-02) or an interim landing inside the
   shared app under the same programme (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:52`).
   Neither exists in code.

**Owner steps, in this order**

6. Healthy Million definition: operator, purpose, research governance, consent and legal
   (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:55`).
7. Gate 2 of the multi-tenant launch work.
8. Tenant creation by the owner (`provision_tenant()`), only after Gate 2
   (`vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md:56`).

## 5. Verification notes on the strategy input

These differ from, or add to, `vitanaland-strategy/06-DESTINATIONS/healthy-million-replication.md`:

- The strategy says `community-members.ts` "has none" for tenant context. The route does require a tenant
  (`requireTenant`), but its count query is filtered by user only (`services/gateway/src/routes/community-members.ts:64`).
- The strategy marks `content-overrides-db` and `kb-overlay-db` as done. The lanes are done (files merged), but their
  migrations are not applied: rows 8a and 40 are pending or queued (`docs/multitenancy/MIGRATION-QUEUE.md:26`,
  `docs/multitenancy/MIGRATION-QUEUE.md:58`). The same holds for `health-home-tenant-db` (rows 43-44).
- The strategy cites `mt-community-isolation-r2` as planned. It is not on `origin/main`; its plan branch is escalated
  with no VTIDs.
- PR #1438 and the RUN-MIGRATION run ids are taken from the strategy and the queue file. This lane made no GitHub or
  database call, so they are not re-verified.
- The strategy cites MULTI-TENANT-PLAN line 20 for the isolation and golden criteria; confirmed
  (`docs/MULTI-TENANT-PLAN.md:20`).

## 6. Proposed follow-ups (not done by this lane)

Each needs its own sparred plan and VTID. None changes Maxina behaviour unless its plan records an owner-approved golden
exception.

| ID | Title | Files | Risk | Owner | Gate |
|---|---|---|---|---|---|
| F1 | Native brand neutralisation (strings, registry fallback, scheme leak check) | `vitana-v1/apps/mobile/src/**` | Medium: native UI text for every member | Native-app programme | Plan sparring; NATIVE-CI; STAGING-VERIFY |
| F2 | Welcome-team sender per tenant | `services/gateway/src/services/welcome-team/**` | Medium: messages to real members | Multi-tenant programme | Plan sparring; owner approval for any migration |
| F3 | Minimum-cohort rule for tenant-owner analytics | `services/gateway/src/routes/tenant-admin/**` | Low to medium: privacy | Multi-tenant programme | Plan sparring |
| F4 | "No Maxina/Mariia string" scan for a non-Maxina tenant journey (local stack) | `scripts/mt/**`, tests | Low | Multi-tenant programme | Plan sparring |
| F5 | Research enrolment flag that defaults off, before any Healthy Million research copy | gateway and vitana-v1 (to be named in the plan) | High: health research consent | Project owner and research governance | Owner decision; plan sparring |
| F6 | M-HM acceptance suite (SB-HM-03) built from criteria 1-19, isolated environment only | tests (to be named) | Low | Multi-tenant programme | Plan sparring |
