# Destination identity: vitanaland.com, Maxina and Vitana

- **Status:** Discovery and strategy document. Read-only review of code and specs. It changes no route, domain, map,
  test, identifier or store listing, and performs no migration.
- **Owner:** Project owner (decisions); multi-tenant programme owner and native-app programme owner (execution); Kiro
  session `kiro-exafy-202611110004-e38b`, seat `exafy` (author).
- **Pinned HEADs:** vitana-platform `6dc6e1ba0c18252ec2f3fbf5651d245e200f9835`, vitana-v1
  `e31bf4627ff3c705c20f8e6b718ce4dd03353b7f`, strategy input `vitanaland-strategy` `fb77090e1ffc7d1ef3c250b0aa721768c3df9425`.
  Every `path:line` below resolves on these commits (`docs/validation/VTID-05689/commands.log`).
- **VTID:** VTID-05689 (lane `destination-identity` of plan `strategy-execution-wave1`).
- **Plan:** `.kiro/specs/strategy-execution-wave1/plan.md` §4.7; tasks `.kiro/specs/strategy-execution-wave1/tasks.md`
  (lane `destination-identity`); sparring record `.kiro/specs/strategy-execution-wave1/sparring/verdict.md`.

Status classes follow `tasks.md`: Verified operational (only with a run id); Verified implemented, not operational;
Implemented but incomplete; Designed but not implemented; Deprecated/superseded; Unknown.

## 1. Principles (from the approved strategy)

1. **vitanaland.com is the ecosystem.** It presents the Longevity Economy, the independent destinations and Vitana, not
   one tenant (`vitanaland-strategy/07-WEBSITES/README.md:15`, `vitanaland-strategy/07-WEBSITES/README.md:25`).
2. **Maxina is an independent destination.** It has its own character and its own social-wellness story, and it is not
   the default identity of Vitanaland (`vitanaland-strategy/07-WEBSITES/README.md:28`). The character belongs only to
   Maxina: no other destination and no ecosystem surface tells her story or uses her as a sender.
3. **Vitana is the universal companion.** One Vitana identity across tenants and devices; the destination supplies facts,
   never a second Vitana (`vitanaland-strategy/02-PLATFORM/native-mobile-alignment.md:54`). The multi-tenant plan already
   splits a fixed Vitana block from a tenant block and names the hierarchy "<Community> on Vitanaland, with Vitana"
   (`docs/MULTI-TENANT-PLAN.md:56`).
4. **No site borrows another's identity** (`vitanaland-strategy/07-WEBSITES/README.md:19`).

**Character spelling.** The strategy writes "Maria Maxina". The repositories write "Mariia Maksina", for example the
anonymous Vitana instruction (`services/gateway/src/routes/orb-live.ts:7503`) and the apply page
(`vitana-v1/src/pages/Apply.tsx:68`). "Maria Maxina" appears in code only as the spoken form that the voice ranker maps to
"Mariia Maksina" (`services/gateway/src/services/voice-tools/community-member-ranker.ts:369`,
`services/gateway/src/services/orb-tools-shared.ts:2099`). The strategy already asks the brand owner to confirm the
canonical spelling (`vitanaland-strategy/07-WEBSITES/README.md:31`). This document does not choose one.

## 2. Current default identity (what a visitor gets today)

Today Maxina is the default identity of the shared app. Status for the whole set: Verified implemented, not operational
for the ecosystem principle (the code is deployed behaviour, but the ecosystem identity it should express does not exist).

### 2.1 Web (vitana-v1)

| Behaviour | Evidence | Tenant handling |
|---|---|---|
| Hosts `vitanaland.com`, `www.vitanaland.com` and `e.vitanaland.com` map to `maxina` | `vitana-v1/src/config/domain-tenant-mapping.ts:5-8`; pinned by `vitana-v1/src/config/domain-tenant-mapping.test.ts:5-9` | Maxina-hardwired |
| `/` renders `ShareEntry` (or `/commerce` on the commerce host), with the portal grid `Index` as fallback | `vitana-v1/src/App.tsx:818` | Mixed |
| `ShareEntry` looks up the host in the map and redirects `/` to `/_intro/maxina` when no share link is present | `vitana-v1/src/pages/ShareEntry.tsx:25-26`, `vitana-v1/src/pages/ShareEntry.tsx:94-96` | Maxina-hardwired |
| On an unmapped host, `Index` shows a portal grid led by a Maxina card that opens `/_intro/maxina` | `vitana-v1/src/pages/Index.tsx:28-31`, `vitana-v1/src/pages/Index.tsx:62-69` | Maxina-hardwired |
| `/login` and `/register` redirect to `/`, so on vitanaland.com they end at the Maxina intro | `vitana-v1/src/App.tsx:821-822` | Maxina-hardwired (through the map) |
| `/auth`, the catalog's generic sign-in alias, redirects to `/maxina` | `vitana-v1/src/App.tsx:831` | Maxina-hardwired |
| `/maxina` is its own portal component; other tenants use the generic `TenantPortal` | `vitana-v1/src/App.tsx:876`, `vitana-v1/src/App.tsx:878`, `vitana-v1/src/App.tsx:2337` | Mixed |
| `/earthlinks/*` lands on the Maxina equivalent | `vitana-v1/src/App.tsx:879-882` | Maxina-hardwired (retired tenant) |
| Guest sign-in: stored tenant slug, else the host map, else `maxina` | `vitana-v1/src/lib/guest-auth.ts:24-26` | Mixed with Maxina fallback |
| AuthGuard OAuth retry falls back to `maxina` | `vitana-v1/src/components/AuthGuard.tsx:267`, `vitana-v1/src/components/AuthGuard.tsx:271` | Maxina fallback |
| Registry outage: the only compiled tenant is Maxina | `vitana-v1/src/lib/tenant-registry.ts:75-88` | Maxina fallback |
| Legacy portal slugs are `maxina` and `alkalma` | `vitana-v1/src/lib/tenant-registry.ts:295` | Maxina literal |
| Sidebar name: portal slug, then stored slug, then tenant, then "Community" | `vitana-v1/src/lib/tenant-registry.ts:339-356` | Tenant-scoped (neutral final fallback) |

### 2.2 The Maxina golden test

`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx` (VTID-05151) pins today's Maxina behaviour twice, once from
the live-shaped registry and once from the compiled fallback:

- `displayNameOffPortal: 'Maxina'`, computed for `/home` with stored slug `maxina`
  (`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:91`, `vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:114`).
  The name comes from the stored slug, not from a hard-coded fallback (`vitana-v1/src/lib/tenant-registry.ts:339-356`).
- Login route `/maxina`, intro `/_intro/maxina`, logout `/maxina`, landing `/onboarding/welcome`, auto-switch on visit
  (`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:115-122`).
- `App.tsx` must keep `/maxina` → `MaxinaPortal` and `/maxina/confirmed`
  (`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:165-170`).
- Nothing may consume `var(--brand-*)` (`vitana-v1/src/lib/tenant-registry.maxina-golden.test.tsx:172-187`).

The golden does not cover the host map, `/auth` or the guest fallback. Those are pinned by the domain-map test above and
by the route lines themselves. The gateway golden suite of the multi-tenant programme is not built yet: lane
`maxina-golden-suite` VTID-05448 is `ready` (`.kiro/specs/mt-guardrails-r2/lanes/maxina-golden-suite.md:16`).

### 2.3 Native (vitana-v1/apps/mobile)

| Item | Evidence | Note |
|---|---|---|
| Development identifiers: iOS `com.exafy.maxina.dev`, Android `com.vitanaland.app.dev` | `vitana-v1/apps/mobile/app.config.ts:27-30`, used at `vitana-v1/apps/mobile/app.config.ts:196-197` | Store identifiers, not user-visible |
| App name "Vitana Dev" / "Vitana Test" | `vitana-v1/apps/mobile/app.config.ts:213` | Platform brand already |
| URL scheme `maxina` | `vitana-v1/apps/mobile/app.config.ts:217` | Used for link tests (`vitana-v1/apps/mobile/app.config.ts:216`) |
| No production profile in Wave 0 | `vitana-v1/apps/mobile/app.config.ts:34` | Store release is later |
| Native registry outage falls back to the compiled Maxina registry | `vitana-v1/apps/mobile/src/identity/tenant-registry.ts:54`, `vitana-v1/apps/mobile/src/identity/tenant-registry.ts:73` | Maxina fallback |
| Target store listings: update of iOS `com.exafy.maxina` and Android `com.vitanaland.app`; signing ownership not confirmed | `vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md:67-69`, `vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md:78-80`, `vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md:118-120` | Owner gate G3 |

### 2.4 Multi-tenant plan §4.8 and decisions

- §4.8: one native app per store, tenant from the server-side claim only, "never a silent Maxina default", platform brand
  for store name, icon and splash, destination branding in-app, and "no Maxina constants … except immutable store
  identifiers (bundle id `com.exafy.maxina`, AASA appID)" (`docs/MULTI-TENANT-PLAN.md:60`). §4.8 still says Capacitor;
  the native-app plan chose Expo (`vitana-v1/docs/programs/native-app/NATIVE-APP-PLAN.md:74-77`). The tenancy rules
  apply to the Expo app (`app.config.ts`, native strings, store metadata) instead of `capacitor.config`.
- D5: tenant entry is `vitanaland.com/<slug>`; custom domains later (`docs/MULTI-TENANT-PLAN.md:81`,
  `docs/MULTI-TENANT-PLAN.md:166`). Custom domains need an app release each for native deep links
  (`docs/MULTI-TENANT-PLAN.md:60`).
- D16: one platform-branded "Vitanaland" app that reuses the existing listings if ownership is confirmed
  (`docs/MULTI-TENANT-PLAN.md:90`, `docs/MULTI-TENANT-PLAN.md:177`).
- Principle: "mirror the platform, not the content"; Maxina becomes tenant 1 with a content pack
  (`docs/MULTI-TENANT-PLAN.md:19`).

### 2.5 Gateway and data

- The anonymous Vitana presents itself as "brand presenter for the Maxina Community on Vitanaland.com"
  (`services/gateway/src/routes/orb-live.ts:7448`); the signed-in base identity names Maxina
  (`services/gateway/src/services/ai-personality-service.ts:86`).
- Maxina's brand pack row is seed data: name, colours, sender "Maxina by VITANA" from `noreply@vitanaland.com`
  (`supabase/migrations/20261014000400_vtid_05150_tenant_brand_pack.sql:213-220`).
- The welcome-team sender list includes `mariia` (`services/gateway/src/services/welcome-team/config.ts:61`). This is
  correct for Maxina members and must stay Maxina-only.

## 3. Existing work this path must coordinate with

### 3.1 `mt-frontend-brand-r3` (approved, lanes `ready`)

- Amendment 1 of `mt-frontend-brand`; supersedes `brand-surface` VTID-05242 and `theme-tokens` VTID-05246
  (`.kiro/specs/mt-frontend-brand-r3/plan.md:44-53`).
- `brand-surface-r3` VTID-05483 (`.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:37`) replaces Maxina literals
  in CommerceJoin, AuthGuard, RedemptionLanding, RedeemVoucher and store links
  (`.kiro/specs/mt-frontend-brand-r3/plan.md:100-104`). Its `useActiveTenantSlug()` keeps `maxina` as the default for an
  anonymous visitor (`.kiro/specs/mt-frontend-brand-r3/plan.md:136-141`), because anonymous visitors have no tenant
  (`.kiro/specs/mt-frontend-brand-r3/plan.md:106`). Its paths include `src/App.tsx`
  (`.kiro/specs/mt-frontend-brand-r3/lanes/brand-surface-r3.md:22`), but only to mount `useTenantMeta()`
  (`.kiro/specs/mt-frontend-brand-r3/plan.md:221`).
- `theme-tokens-r3` VTID-05484 (`.kiro/specs/mt-frontend-brand-r3/lanes/theme-tokens-r3.md:18`) sets theme variables
  for non-default tenants only and leaves the C2 golden unchanged (`.kiro/specs/mt-frontend-brand-r3/plan.md:187-188`).
- Rollout: no flag; Maxina byte-identical by construction; tenant values render only for a non-Maxina tenant, which
  needs owner-approved provisioning (`.kiro/specs/mt-frontend-brand-r3/plan.md:244-249`).
- **Not covered by this spec:** the host map, `/auth`, `/login`/`/register`, the guest fallback and the Maxina golden.
  The plan has no mention of `DOMAIN_TENANT_MAP`, `guest-auth`, `displayNameOffPortal` or `/auth` (grep count 0 in
  commands.log).

### 3.2 `mt-packs-r2` (approved)

- Goal: Maxina becomes tenant pack 1 (`.kiro/specs/mt-packs-r2/plan.md:4`); everything dark behind `MT_RESOLUTION_V2`
  and `feature_flags.mt.packs`, Maxina byte-identical under the golden suite (`.kiro/specs/mt-packs-r2/plan.md:127`,
  `.kiro/specs/mt-packs-r2/plan.md:310`).
- `persona-pack` VTID-05499 (`.kiro/specs/mt-packs-r2/lanes/persona-pack.md:24`) splits a fixed Vitana block from a
  tenant block (`.kiro/specs/mt-packs-r2/plan.md:129-130`). This is where "Vitana is universal" becomes code.
- `frontend-brand-neutralise` VTID-05496 (`.kiro/specs/mt-packs-r2/lanes/frontend-brand-neutralise.md:21`) puts
  `{{brand}}` into i18n, keeps `/maxina` routes as aliases and lets the widget pass the tenant before login; the brand
  resolves to Maxina by default (`.kiro/specs/mt-packs-r2/plan.md:247-251`).
- `brand-content-templating` VTID-05494 (`.kiro/specs/mt-packs-r2/lanes/brand-content-templating.md:17`).
- The gateway golden fixture does not exist yet and waits for VTID-05448 (`.kiro/specs/mt-packs-r2/plan.md:56-57`).
- **Not covered by this spec either:** grep count 0 for the host map, `/auth`, guest fallback and `displayNameOffPortal`
  (commands.log).

### 3.3 Other specs that touch identity

- Custom domains: `tenant_domains` and host resolution, queue rows 30-31, queued for owner approval
  (`docs/multitenancy/MIGRATION-QUEUE.md:48-49`); lanes `host-resolution-gw` VTID-05502 and `native-domains-aasa`
  VTID-05505 (`.kiro/specs/mt-m3-r2/lanes/host-resolution-gw.md:16`, `.kiro/specs/mt-m3-r2/lanes/native-domains-aasa.md:19`).
- Store accounts and signing: owner gate G3, lane `store-submission-owner` VTID-05664
  (`.kiro/specs/native-wave3-release-r2/lanes/store-submission-owner.md:15`).
- CI wiring of isolation and golden suites: `ci-wiring` VTID-05443 (`.kiro/specs/mt-guardrails-r2/lanes/ci-wiring.md:17`).

The gap: no approved spec owns the ecosystem default (host map, `/`, `/auth`, `/login`, `/register`, guest fallback, the
anonymous Vitana on the apex). The path below proposes one.

## 4. Migration-aware path (ordered; nothing here is performed)

Invariants for every step:

- **The live Maxina app does not break.** The Maxina golden test and the domain-map test stay unchanged until a sparred
  plan changes them with a recorded, owner-approved golden exception. `/maxina`, `/_intro/maxina`, `/maxina/confirmed`
  and `/maxina/app` keep working. A member with a stored `tenant_slug` keeps landing in their tenant, because the guest
  route reads the stored slug before the host map (`vitana-v1/src/lib/guest-auth.ts:24-25`).
- **Store identifiers are immutable once published.** iOS `com.exafy.maxina`, Android `com.vitanaland.app`, the AASA
  appID and the URL scheme `maxina` are never renamed. A neutral scheme, if wanted, is added beside `maxina`, never in
  place of it. Identifiers stay invisible to members (`docs/MULTI-TENANT-PLAN.md:60`).
- **The ecosystem landing ships dark.** Every merged code change in this area is dark by default
  (`docs/MULTI-TENANT-PLAN.md:132`), because PUBLISH promotes the whole staging build. The owner turns it on.
- **No test against production.** Staging specs are read-only; anything that writes is proven by unit tests.
- **The character stays with Maxina.** Ecosystem and other-destination surfaces never use Mariia Maksina's story, name
  or welcome sender.

Steps:

1. **Record (this document).** No change. Status: Designed but not implemented.
2. **Land the planned neutralisation first.** `brand-surface-r3` VTID-05483, `theme-tokens-r3` VTID-05484,
   `frontend-brand-neutralise` VTID-05496, `brand-content-templating` VTID-05494 and `persona-pack` VTID-05499 run as
   their plans say, Maxina byte-identical. `src/App.tsx` is a hot file, so the ecosystem plan (step 4) merges after
   `brand-surface-r3`, never in parallel.
3. **Guard the golden before changing defaults.** `maxina-golden-suite` VTID-05448 and `ci-wiring` VTID-05443 land, so a
   later identity change cannot alter Maxina unnoticed.
4. **Sparred plan "ecosystem landing" (new, proposed follow-up D1).** It is a standard change (it touches `src/App.tsx`
   routes and adds a screen, so it cannot be `frontend-simple`). It adds an ecosystem landing for the vitanaland.com
   apex behind an owner-controlled flag, off by default. With the flag off, `DOMAIN_TENANT_MAP`, `ShareEntry`, `Index`
   and every golden stay byte-identical. With the flag on, the apex `/` shows the ecosystem landing and lists Maxina as
   one destination; share links keep priority (`vitana-v1/src/pages/ShareEntry.tsx:23-26`). The plan names its golden
   exceptions and the owner approves them. It depends on the Website Factory topology decision DEC-003/004
   (`vitanaland-strategy/07-WEBSITES/README.md:55`); before that decision, the landing is a governed vitana-v1 change,
   not a second app. It also needs a Spotlight archetype, a screen-registry entry and a parity-ledger row (vitana-v1
   rules).
5. **Generic sign-in (same or next plan).** With the flag on, `/auth`, `/login` and `/register` lead to a neutral sign-in
   or community picker instead of `/maxina`, and the guest fallback uses the same neutral route. With the flag off,
   today's targets stay. A member with a stored slug is unaffected (step invariants).
6. **Anonymous Vitana on the apex.** Through `persona-pack`'s anonymous tenant input, a visitor on the ecosystem landing
   meets Vitana as the ecosystem companion; the Maxina presenter instruction (`services/gateway/src/routes/orb-live.ts:7448`)
   is used only when the resolved tenant is Maxina. Spoken wording stays model-composed from facts and intents
   (platform NEVER 41).
7. **Native identity.** Store name, icon and splash use the platform brand (D16); destination branding is applied in-app
   after the tenant claim resolves; the compiled Maxina fallback becomes a neutral picker (the "never a silent Maxina
   default" rule of §4.8). Bundle ids and the `maxina` scheme stay. Store listing questions are owner decisions DEC-063
   and G3 (VTID-05664).
8. **Destination domains when needed.** A destination with its own domain (for example healthymillion.com) uses queue
   rows 30-31 after owner approval, VTID-05502 and VTID-05505, with an app release per associated domain
   (`docs/MULTI-TENANT-PLAN.md:60`).
9. **Turn on.** After STAGING-VERIFY and Gate 2, the owner turns the flag on. Rollback is turning it off; no data moves,
   so no migration and no data rollback are involved.

## 5. Verification notes on the inputs

- The lane brief cites app.config.ts lines 26-28. At the pinned commit the identifiers block is `vitana-v1/apps/mobile/app.config.ts:27-30`
  (iOS on line 28, Android on line 29); the scheme is on line 217 as stated.
- The brief cites domain-tenant-mapping.ts lines 6-8; those are the three host entries (`vitana-v1/src/config/domain-tenant-mapping.ts:6-8`), inside the map declared on
  line 5.
- The sidebar shows "Maxina" off-portal because the golden sets the stored slug to `maxina`, not because of a
  hard-coded name; the neutral final fallback is "Community" (`vitana-v1/src/lib/tenant-registry.ts:347`).
- §4.8 of the multi-tenant plan describes Capacitor; the app is Expo. Recorded here and in the strategy, not resolved.

## 6. Proposed follow-ups (not done by this lane)

| ID | Title | Files | Risk | Owner | Gate |
|---|---|---|---|---|---|
| D1 | Ecosystem landing on the vitanaland.com apex behind a flag | `vitana-v1/src/App.tsx`, `vitana-v1/src/pages/**`, `vitana-v1/src/config/domain-tenant-mapping.ts`, design manifest, screen registry, parity ledger | High: changes what every apex visitor sees | Project owner; multi-tenant programme | Plan sparring; owner-approved golden exceptions; STAGING-VERIFY; Gate 2 |
| D2 | Neutral generic sign-in for `/auth`, `/login`, `/register` and the guest fallback | `vitana-v1/src/App.tsx`, `vitana-v1/src/lib/guest-auth.ts`, `vitana-v1/src/components/AuthGuard.tsx` | High: sign-in path of real members | Multi-tenant programme | Plan sparring; STAGING-VERIFY; Gate 2 |
| D3 | Anonymous ecosystem Vitana (tenant-aware anonymous instruction) | `services/gateway/src/routes/orb-live.ts` (hot file) and persona-pack seams | Medium: voice behaviour for visitors | Multi-tenant programme | Plan sparring after VTID-05499 |
| D4 | Native neutral fallback and destination branding in-app | `vitana-v1/apps/mobile/src/identity/**` | Medium | Native-app programme | Plan sparring; NATIVE-CI |
| D5 | Canonical character spelling | brand owner record; then copy | Low | Maxina brand owner | Owner decision |
| D6 | Reconcile §4.8 wording with the Expo app | `docs/MULTI-TENANT-PLAN.md` | Low | Multi-tenant programme owner | Plan PR |
