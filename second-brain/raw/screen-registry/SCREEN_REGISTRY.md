# VITANA Screen Registry

**Version**: 1.2  
**Last Updated**: 2025-12-16  
**Total Screens**: 551

---

## Table of Contents

1. [Overview](#overview)
2. [Statistics](#statistics)
3. [Legend](#legend)
4. [PUBLIC & AUTHENTICATION](#public--authentication)
5. [COMMUNITY ROLE SCREENS](#community-role-screens)
6. [PATIENT ROLE SCREENS](#patient-role-screens)
7. [PROFESSIONAL ROLE SCREENS](#professional-role-screens)
8. [STAFF ROLE SCREENS](#staff-role-screens)
9. [ADMIN ROLE SCREENS](#admin-role-screens)
10. [DEV HUB SCREENS](#dev-hub-screens)
11. [GLOBAL OVERLAYS & COMPONENTS](#global-overlays--components)
12. [Cross-Reference Tables](#cross-reference-tables)

---

## Overview

This registry catalogs every screen, view, and major UI component in the VITANA platform. Each entry includes routing information, access control, implementation status, and architectural notes.

**Purpose**: Enable precise communication about features, planning, and implementation across the entire team.

---

## Statistics

| Category | Count |
|----------|-------|
| Public/Auth Screens | 24 |
| Community Role Screens | 89 |
| Patient Role Screens | 9 |
| Professional Role Screens | 9 |
| Staff Role Screens | 9 |
| Admin Role Screens | 117 |
| Dev Hub Screens | 136 |
| Global Overlays | 53 |
| Home Screens | 20 |
| Discover Screens | 10 |
| Health Screens | 12 |
| Inbox Screens | 8 |
| AI Screens | 6 |
| Wallet Screens | 8 |
| Sharing Screens | 6 |
| Memory Screens | 10 |
| Settings Screens | 20 |
| Business Hub Screens | 5 |
| **TOTAL** | **551** |

---

## Legend

### Status Icons
- ✅ **Implemented**: Fully functional screen
- 🚧 **Placeholder**: Route exists, minimal content
- ❌ **Missing**: Planned but not yet created

### UI Patterns
- **3-card-header**: Dashboard with 3 card navigation options
- **split-screen**: Left list + right detail panel
- **horizontal-list**: Scrollable card carousel
- **card-grid**: Responsive grid of cards
- **orb-overlay**: Full-screen VITANA Orb experience
- **sub-page-header**: Standard header with navigation tabs
- **data-table**: Tabular data with filters/search
- **wizard**: Multi-step form flow
- **drawer**: Slide-in panel overlay
- **dialog**: Modal popup

### Tenant Codes
- **Global**: Available across all tenants
- **Maxina**: Maxina-specific
- **Alkalma**: Alkalma-specific
- **Earthlinks**: Earthlinks-specific
- **Exafy**: Internal Exafy admin only

---

# PUBLIC & AUTHENTICATION

---

## AUTH-001: Landing Page

- **CanonicalId**: AUTH.00.001.A.PUBLIC.CLI
- **Module**: Public
- **Portal(s)**: All (Global Landing)
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Landing.tsx
- **Component Path**: src/pages/Landing.tsx
- **UI Pattern**: Marketing landing page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Hero section, Features, Pricing, Footer
- **Status**: ✅ Implemented
- **Purpose**: Main public entry point; marketing and onboarding funnel
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Public page, no sensitive data
- **Event Triggers**: landing_page_viewed, cta_clicked
- **Dependencies**: None (entry point)
- **Notes**: Main public entry point; redirects authenticated users to their role dashboard

---

## AUTH-002: Generic Auth

- **CanonicalId**: AUTH.00.002.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: All
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/auth`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Auth.tsx
- **Component Path**: src/pages/Auth.tsx
- **UI Pattern**: Tabbed auth (Sign In / Join)
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Sign In tab, Join tab, Social login buttons
- **Status**: ✅ Implemented
- **Purpose**: User authentication and registration when tenant is not specified
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, profiles
- **Compliance Notes**: GDPR consent required; secure password handling; session management
- **Event Triggers**: auth_signin_attempt, auth_signup_attempt, auth_success, auth_failure
- **Dependencies**: Supabase Auth, Social OAuth providers
- **Notes**: Generic auth page; can be used when no tenant specified

---

## AUTH-003: Maxina Portal Login

- **CanonicalId**: AUTH.00.003.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Maxina
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/maxina`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/MaxinaPortal.tsx
- **Component Path**: src/pages/portals/MaxinaPortal.tsx
- **UI Pattern**: Premium glassmorphic auth with video background
- **Tenant Availability**: Maxina
- **Subscreens / Tabs / Modals**: Sign In tab, Join Maxina tab, Social login (Google, Apple), Footer navigation
- **Status**: ✅ Implemented
- **Purpose**: Maxina tenant-specific authentication with premium wellness brand experience
- **Primary APIs Used**: Supabase Auth API, Social OAuth APIs
- **DB Tables / Models Used**: auth.users, profiles, tenants
- **Compliance Notes**: GDPR consent; secure password handling; session management; wellness platform terms
- **Event Triggers**: maxina_auth_signin, maxina_auth_signup, auth_success, ambient_music_played
- **Dependencies**: Supabase Auth, Google/Apple OAuth, Ambient music player, Video background loader
- **Notes**: Features daily rotating video background, ambient music, glassmorphic card, premium button styling

---

## AUTH-004: Alkalma Portal Login

- **CanonicalId**: AUTH.00.004.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Alkalma
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/alkalma`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/AlkalmaPortal.tsx
- **Component Path**: src/pages/portals/AlkalmaPortal.tsx
- **UI Pattern**: Branded auth screen
- **Tenant Availability**: Alkalma
- **Subscreens / Tabs / Modals**: Sign In tab, Join tab
- **Status**: 🚧 Placeholder
- **Purpose**: Alkalma tenant-specific authentication
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, profiles, tenants
- **Compliance Notes**: GDPR consent; secure password handling; session management
- **Event Triggers**: alkalma_auth_signin, alkalma_auth_signup, auth_success
- **Dependencies**: Supabase Auth
- **Notes**: Needs visual upgrade to match Maxina premium design

---

## AUTH-005: Earthlinks Portal Login

- **CanonicalId**: AUTH.00.005.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Earthlinks
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/earthlinks`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/EarthlinksPortal.tsx
- **Component Path**: src/pages/portals/EarthlinksPortal.tsx
- **UI Pattern**: Branded auth screen
- **Tenant Availability**: Earthlinks
- **Subscreens / Tabs / Modals**: Sign In tab, Join tab
- **Status**: 🚧 Placeholder
- **Purpose**: Earthlinks tenant-specific authentication
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, profiles, tenants
- **Compliance Notes**: GDPR consent; secure password handling; session management
- **Event Triggers**: earthlinks_auth_signin, earthlinks_auth_signup, auth_success
- **Dependencies**: Supabase Auth
- **Notes**: Needs visual upgrade to match Maxina premium design

---

## AUTH-006: Community Portal Login

- **CanonicalId**: AUTH.00.006.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Community (public)
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/community`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/CommunityPortal.tsx
- **Component Path**: src/pages/portals/CommunityPortal.tsx
- **UI Pattern**: Branded auth screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Sign In tab, Join Community tab
- **Status**: 🚧 Placeholder
- **Purpose**: Public community authentication for users not part of specific tenant
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, profiles
- **Compliance Notes**: GDPR consent; secure password handling; session management
- **Event Triggers**: community_auth_signin, community_auth_signup, auth_success
- **Dependencies**: Supabase Auth
- **Notes**: For users not part of specific tenant

---

## AUTH-007: Exafy Admin Portal Login

- **CanonicalId**: AUTH.00.007.A.ADMIN.INT
- **Module**: Authentication
- **Portal(s)**: Exafy (Internal)
- **Roles with access**: Exafy Admin only
- **External Route (client URL)**: `/exafy-admin`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/ExafyAdminPortal.tsx
- **Component Path**: src/pages/portals/ExafyAdminPortal.tsx
- **UI Pattern**: Branded auth screen
- **Tenant Availability**: Exafy
- **Subscreens / Tabs / Modals**: Sign In only (no public join)
- **Status**: 🚧 Placeholder
- **Purpose**: Exafy organization admin authentication
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, profiles, admin_roles
- **Compliance Notes**: Admin-only access; MFA recommended; session timeout; audit logging required
- **Event Triggers**: exafy_admin_signin, auth_success, admin_access_logged
- **Dependencies**: Supabase Auth, Admin role verification
- **Notes**: Internal portal for Exafy organization administrators

---

## AUTH-008: Intro Experience

- **CanonicalId**: AUTH.00.008.A.PUBLIC.CLI
- **Module**: Onboarding
- **Portal(s)**: All tenants
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/_intro/:tenantSlug`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/intro/IntroExperience.tsx
- **Component Path**: src/pages/intro/IntroExperience.tsx
- **UI Pattern**: Video background with voice welcome
- **Tenant Availability**: Global (tenant-specific content)
- **Subscreens / Tabs / Modals**: Welcome message, "Play Welcome" TTS, Continue to Login, VITANA Orb intro animation
- **Status**: ✅ Implemented
- **Purpose**: Premium onboarding experience with voice welcome and ambient music
- **Primary APIs Used**: TTS API (Vertex AI), Video service
- **DB Tables / Models Used**: tenants
- **Compliance Notes**: Public content; audio autoplay compliance
- **Event Triggers**: intro_viewed, intro_audio_played, intro_continued, vitana_orb_revealed
- **Dependencies**: Video loader, TTS service, Ambient music player, VitanaGuideOrbIntro
- **Notes**: Features ambient music, daily rotating video, voice greeting, smooth transitions to login

---

## AUTH-009: Email Confirmation (Maxina)

- **CanonicalId**: AUTH.00.009.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Maxina
- **Roles with access**: Public (via email link)
- **External Route (client URL)**: `/maxina/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/MaxinaConfirmed.tsx
- **Component Path**: src/pages/portals/MaxinaConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Maxina
- **Subscreens / Tabs / Modals**: Success message, Continue button
- **Status**: ✅ Implemented
- **Purpose**: Email verification confirmation for Maxina users
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Email verification required; secure token handling
- **Event Triggers**: email_confirmed, account_verified
- **Dependencies**: Supabase Auth email verification
- **Notes**: Shown after email verification link clicked

---

## AUTH-010: Email Confirmation (Alkalma)

- **CanonicalId**: AUTH.00.010.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Alkalma
- **Roles with access**: Public (via email link)
- **External Route (client URL)**: `/alkalma/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/AlkalmaConfirmed.tsx
- **Component Path**: src/pages/portals/AlkalmaConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Alkalma
- **Subscreens / Tabs / Modals**: Success message, Continue button
- **Status**: ✅ Implemented
- **Purpose**: Email verification confirmation for Alkalma users
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Email verification required; secure token handling
- **Event Triggers**: email_confirmed, account_verified
- **Dependencies**: Supabase Auth email verification
- **Notes**: Shown after email verification link clicked

---

## AUTH-011: Email Confirmation (Earthlinks)

- **CanonicalId**: AUTH.00.011.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Earthlinks
- **Roles with access**: Public (via email link)
- **External Route (client URL)**: `/earthlinks/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/EarthlinksConfirmed.tsx
- **Component Path**: src/pages/portals/EarthlinksConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Earthlinks
- **Subscreens / Tabs / Modals**: Success message, Continue button
- **Status**: ✅ Implemented
- **Purpose**: Email verification confirmation for Earthlinks users
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Email verification required; secure token handling
- **Event Triggers**: email_confirmed, account_verified
- **Dependencies**: Supabase Auth email verification
- **Notes**: Shown after email verification link clicked

---

## AUTH-012: Email Confirmation (Community)

- **CanonicalId**: AUTH.00.012.A.PUBLIC.CLI
- **Module**: Authentication
- **Portal(s)**: Community
- **Roles with access**: Public (via email link)
- **External Route (client URL)**: `/community/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/CommunityConfirmed.tsx
- **Component Path**: src/pages/portals/CommunityConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Success message, Continue button
- **Status**: ✅ Implemented
- **Purpose**: Email verification confirmation for Community users
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Email verification required; secure token handling
- **Event Triggers**: email_confirmed, account_verified
- **Dependencies**: Supabase Auth email verification
- **Notes**: Shown after email verification link clicked

---

## AUTH-013: Email Confirmation (Exafy)

- **CanonicalId**: AUTH.00.013.A.ADMIN.INT
- **Module**: Authentication
- **Portal(s)**: Exafy
- **Roles with access**: Exafy Admin (via email link)
- **External Route (client URL)**: `/exafy-admin/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/ExafyAdminConfirmed.tsx
- **Component Path**: src/pages/portals/ExafyAdminConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Exafy
- **Subscreens / Tabs / Modals**: Success message, Continue button
- **Status**: ✅ Implemented
- **Purpose**: Email verification confirmation for Exafy admin users
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, admin_roles
- **Compliance Notes**: Admin email verification; audit logging required
- **Event Triggers**: admin_email_confirmed, account_verified, admin_access_logged
- **Dependencies**: Supabase Auth email verification, Admin role verification
- **Notes**: Shown after email verification link clicked

---

## AUTH-014: Not Found (404)

- **CanonicalId**: AUTH.00.014.A.ALL.CLI
- **Module**: Error
- **Portal(s)**: All
- **Roles with access**: All
- **External Route (client URL)**: `*` (catch-all)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/NotFound.tsx
- **Component Path**: src/pages/NotFound.tsx
- **UI Pattern**: Error screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: 404 message, Back to Home button
- **Status**: ✅ Implemented
- **Purpose**: Error handling for invalid routes
- **Primary APIs Used**: None
- **DB Tables / Models Used**: None
- **Compliance Notes**: Public error page; no sensitive data exposure
- **Event Triggers**: 404_error_viewed, route_not_found
- **Dependencies**: React Router
- **Notes**: Shown for invalid routes

---

## AUTH-015: Legacy Profile Redirect

- **CanonicalId**: AUTH.00.015.A.ALL.CLI
- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: All
- **External Route (client URL)**: `/profile/:id`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/LegacyProfileRedirect.tsx
- **Component Path**: src/components/LegacyProfileRedirect.tsx
- **UI Pattern**: Redirect component
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: ✅ Implemented
- **Purpose**: Backwards compatibility for old profile URL format
- **Primary APIs Used**: Profile API (to resolve ID to handle)
- **DB Tables / Models Used**: profiles
- **Compliance Notes**: None (redirect only)
- **Event Triggers**: legacy_profile_redirect
- **Dependencies**: React Router, Profile service
- **Notes**: Redirects old profile URLs to new `/u/:handle` format

---

## AUTH-013: Email Confirmation (Exafy)

- **CanonicalId**: AUTH.00.013.A.ADMIN.INT
- **Module**: Authentication
- **Portal(s)**: Exafy
- **Roles with access**: Exafy Admin (via email link)
- **External Route (client URL)**: `/exafy-admin/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/ExafyAdminConfirmed.tsx
- **Component Path**: src/pages/portals/ExafyAdminConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Exafy
- **Subscreens / Tabs / Modals**: Success message, Continue button
- **Status**: ✅ Implemented
- **Notes**: Shown after email verification link clicked

---

## AUTH-014: Not Found (404)

- **CanonicalId**: AUTH.00.014.A.ALL.CLI
- **Module**: Error
- **Portal(s)**: All
- **Roles with access**: All
- **External Route (client URL)**: `*` (catch-all)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/NotFound.tsx
- **Component Path**: src/pages/NotFound.tsx
- **UI Pattern**: Error screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: 404 message, Back to Home button
- **Status**: ✅ Implemented
- **Notes**: Shown for invalid routes

---

## AUTH-015: Legacy Profile Redirect

- **CanonicalId**: AUTH.00.015.A.ALL.CLI
- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: All
- **External Route (client URL)**: `/profile/:id`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/LegacyProfileRedirect.tsx
- **Component Path**: src/components/LegacyProfileRedirect.tsx
- **UI Pattern**: Redirect component
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: ✅ Implemented
- **Notes**: Redirects old profile URLs to new `/u/:handle` format

---

## AUTH-016: Maxina Portal

- **CanonicalId**: AUTH.00.016.A.MAXINA.CLI
- **Module**: Portal
- **Portal(s)**: Maxina
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/maxina`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/MaxinaPortal.tsx
- **Component Path**: src/pages/portals/MaxinaPortal.tsx
- **UI Pattern**: Auth portal with video background
- **Tenant Availability**: Maxina
- **Subscreens / Tabs / Modals**: Sign In tab, Join Maxina tab, Social login options
- **Status**: ✅ Implemented
- **Purpose**: Maxina tenant-specific authentication portal with premium video background and glassmorphic design
- **Primary APIs Used**: Supabase Auth API, Google OAuth, Apple OAuth
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Public authentication page; HIPAA/GDPR compliant auth flow
- **Event Triggers**: portal_viewed, auth_initiated, login_success, login_failed, social_login_clicked
- **Dependencies**: AuthContext, SoundscapeContext (ambient music)
- **Notes**: Premium auth experience with daily rotating video backgrounds; part of VITANA ecosystem

---

## AUTH-017: Maxina Email Confirmed

- **CanonicalId**: AUTH.00.017.A.MAXINA.CLI
- **Module**: Portal
- **Portal(s)**: Maxina
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/maxina/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/MaxinaConfirmed.tsx
- **Component Path**: src/pages/portals/MaxinaConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Maxina
- **Subscreens / Tabs / Modals**: Success message, Continue to app button
- **Status**: ✅ Implemented
- **Purpose**: Email confirmation success page for Maxina portal
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Post-registration confirmation; no sensitive data
- **Event Triggers**: email_confirmed_viewed, continue_clicked
- **Dependencies**: AuthContext
- **Notes**: Post-email-verification landing page

---

## AUTH-018: Alkalma Portal

- **CanonicalId**: AUTH.00.018.A.ALKALMA.CLI
- **Module**: Portal
- **Portal(s)**: Alkalma
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/alkalma`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/AlkalmaPortal.tsx
- **Component Path**: src/pages/portals/AlkalmaPortal.tsx
- **UI Pattern**: Auth portal
- **Tenant Availability**: Alkalma
- **Subscreens / Tabs / Modals**: Sign In tab, Join Alkalma tab
- **Status**: ✅ Implemented
- **Purpose**: Alkalma tenant-specific authentication portal
- **Primary APIs Used**: Supabase Auth API, Social OAuth
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Public authentication page; HIPAA/GDPR compliant
- **Event Triggers**: portal_viewed, auth_initiated
- **Dependencies**: AuthContext
- **Notes**: Tenant-specific auth portal for Alkalma

---

## AUTH-019: Alkalma Email Confirmed

- **CanonicalId**: AUTH.00.019.A.ALKALMA.CLI
- **Module**: Portal
- **Portal(s)**: Alkalma
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/alkalma/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/AlkalmaConfirmed.tsx
- **Component Path**: src/pages/portals/AlkalmaConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Alkalma
- **Subscreens / Tabs / Modals**: Success message
- **Status**: ✅ Implemented
- **Purpose**: Email confirmation success page for Alkalma portal
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Post-registration confirmation
- **Event Triggers**: email_confirmed_viewed
- **Dependencies**: AuthContext
- **Notes**: Post-email-verification landing page

---

## AUTH-020: Earthlinks Portal

- **CanonicalId**: AUTH.00.020.A.EARTHLINKS.CLI
- **Module**: Portal
- **Portal(s)**: Earthlinks
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/earthlinks`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/EarthlinksPortal.tsx
- **Component Path**: src/pages/portals/EarthlinksPortal.tsx
- **UI Pattern**: Auth portal
- **Tenant Availability**: Earthlinks
- **Subscreens / Tabs / Modals**: Sign In tab, Join Earthlinks tab
- **Status**: ✅ Implemented
- **Purpose**: Earthlinks tenant-specific authentication portal
- **Primary APIs Used**: Supabase Auth API, Social OAuth
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Public authentication page
- **Event Triggers**: portal_viewed, auth_initiated
- **Dependencies**: AuthContext
- **Notes**: Tenant-specific auth portal for Earthlinks

---

## AUTH-021: Earthlinks Email Confirmed

- **CanonicalId**: AUTH.00.021.A.EARTHLINKS.CLI
- **Module**: Portal
- **Portal(s)**: Earthlinks
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/earthlinks/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/EarthlinksConfirmed.tsx
- **Component Path**: src/pages/portals/EarthlinksConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Earthlinks
- **Subscreens / Tabs / Modals**: Success message
- **Status**: ✅ Implemented
- **Purpose**: Email confirmation success page for Earthlinks portal
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Post-registration confirmation
- **Event Triggers**: email_confirmed_viewed
- **Dependencies**: AuthContext
- **Notes**: Post-email-verification landing page

---

## AUTH-022: Community Portal

- **CanonicalId**: AUTH.00.022.A.COMMUNITY.CLI
- **Module**: Portal
- **Portal(s)**: Community (Public)
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/community-portal`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/CommunityPortal.tsx
- **Component Path**: src/pages/portals/CommunityPortal.tsx
- **UI Pattern**: Auth portal
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Sign In tab, Join Community tab
- **Status**: ✅ Implemented
- **Purpose**: Public community authentication portal
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Public authentication page
- **Event Triggers**: portal_viewed, auth_initiated
- **Dependencies**: AuthContext
- **Notes**: General public portal for community access

---

## AUTH-023: Community Email Confirmed

- **CanonicalId**: AUTH.00.023.A.COMMUNITY.CLI
- **Module**: Portal
- **Portal(s)**: Community (Public)
- **Roles with access**: Public (unauthenticated)
- **External Route (client URL)**: `/community-portal/confirmed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/CommunityConfirmed.tsx
- **Component Path**: src/pages/portals/CommunityConfirmed.tsx
- **UI Pattern**: Confirmation screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Success message
- **Status**: ✅ Implemented
- **Purpose**: Email confirmation success page for Community portal
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Post-registration confirmation
- **Event Triggers**: email_confirmed_viewed
- **Dependencies**: AuthContext
- **Notes**: Post-email-verification landing page

---

## AUTH-024: Exafy Admin Portal

- **CanonicalId**: AUTH.00.024.A.EXAFY.CLI
- **Module**: Portal
- **Portal(s)**: Exafy (Internal)
- **Roles with access**: Exafy Admin only
- **External Route (client URL)**: `/exafy-admin`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/portals/ExafyAdminPortal.tsx
- **Component Path**: src/pages/portals/ExafyAdminPortal.tsx
- **UI Pattern**: Admin auth portal
- **Tenant Availability**: Exafy (Internal)
- **Subscreens / Tabs / Modals**: Admin login
- **Status**: ✅ Implemented
- **Purpose**: Internal Exafy admin authentication portal
- **Primary APIs Used**: Supabase Auth API
- **DB Tables / Models Used**: auth.users, admin roles
- **Compliance Notes**: Internal admin access only; elevated security
- **Event Triggers**: admin_portal_viewed, admin_auth_initiated
- **Dependencies**: AuthContext, Admin role verification
- **Notes**: Internal admin portal for Exafy platform management

---

# COMMUNITY ROLE SCREENS

---

## HOME-001: Home Overview

- **CanonicalId**: HOME.00.001.A.ALL.CLI
- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/home`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Home.tsx
- **Component Path**: src/pages/Home.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Context, Actions, Matches, AI Feed cards
- **Status**: ✅ Implemented
- **Purpose**: Primary dashboard for all authenticated users; role-aware home screen
- **Primary APIs Used**: User profile API, Matches API, AI recommendations API
- **DB Tables / Models Used**: profiles, daily_matches, ai_recommendations, calendar_events
- **Compliance Notes**: User-specific data; RLS enforced
- **Event Triggers**: home_viewed, card_clicked, screen_id:HOME-001
- **Dependencies**: AuthProvider, RoleProvider, UtilityBar
- **Notes**: Primary dashboard for all authenticated users; Screen ID D1-001

---

## HOME-002: Context

- **CanonicalId**: HOME.00.002.A.ALL.CLI
- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/home/context`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/home/Context.tsx
- **Component Path**: src/pages/home/Context.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: User context and recent activity summary
- **Primary APIs Used**: Activity API, Context API
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: User-specific data; RLS enforced
- **Event Triggers**: context_viewed, screen_id:HOME-002
- **Dependencies**: AuthProvider
- **Notes**: User context and recent activity; Screen ID D1-001-01

---

## HOME-003: Actions

- **CanonicalId**: HOME.00.003.A.ALL.CLI
- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/home/actions`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/home/Actions.tsx
- **Component Path**: src/pages/home/Actions.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: Quick actions and shortcuts dashboard
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: User-specific data; RLS enforced
- **Event Triggers**: actions_viewed, action_clicked, screen_id:HOME-003
- **Dependencies**: AuthProvider
- **Notes**: Quick actions and shortcuts; Screen ID D1-001-02

---

## HOME-004: Matches

- **CanonicalId**: HOME.00.004.A.ALL.CLI
- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/home/matches`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/home/Matches.tsx
- **Component Path**: src/pages/home/Matches.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: AI-powered connection matches and recommendations
- **Primary APIs Used**: Matches API, AI recommendations API
- **DB Tables / Models Used**: daily_matches
- **Compliance Notes**: User-specific data; AI-generated content; RLS enforced
- **Event Triggers**: matches_viewed, match_actioned, screen_id:HOME-004
- **Dependencies**: AuthProvider, AI service
- **Notes**: AI-powered connection matches; Screen ID D1-001-03

---

## HOME-005: AI Feed

- **CanonicalId**: HOME.00.005.A.ALL.CLI
- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/home/aifeed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/home/AIFeed.tsx
- **Component Path**: src/pages/home/AIFeed.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: Personalized AI-generated content feed
- **Primary APIs Used**: AI Feed API
- **DB Tables / Models Used**: ai_recommendations
- **Compliance Notes**: AI-generated content; user-specific; RLS enforced
- **Event Triggers**: ai_feed_viewed, feed_item_clicked, screen_id:HOME-005
- **Dependencies**: AuthProvider, AI service
- **Notes**: Personalized AI-generated content feed; Screen ID D1-001-04

---

## COMM-001: Community Overview

- **CanonicalId**: COMM.00.001.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Community.tsx
- **Component Path**: src/pages/Community.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Feed, Events, Live Rooms, Media Hub, My Business, Meetups navigation cards
- **Status**: ✅ Implemented
- **Purpose**: Community hub dashboard; social interaction entry point
- **Primary APIs Used**: Community API, Events API, Live Rooms API
- **DB Tables / Models Used**: global_community_groups, global_community_events, community_live_streams
- **Compliance Notes**: User-generated content; moderation required; RLS enforced
- **Event Triggers**: community_viewed, community_card_clicked, screen_id:COMM-001
- **Dependencies**: AuthProvider, CommunityContext
- **Notes**: Community hub dashboard; Screen ID D1-002

---

## COMM-002: Events & Meetups

- **CanonicalId**: COMM.00.002.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/events`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/EventsAndMeetups.tsx
- **Component Path**: src/pages/community/EventsAndMeetups.tsx
- **UI Pattern**: card-grid with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Community Events tab, Meetups tab, Event details drawer, Create event popup
- **Status**: ✅ Implemented
- **Purpose**: Combined events and meetups discovery and management
- **Primary APIs Used**: Events API, Meetups API
- **DB Tables / Models Used**: global_community_events, event_attendees, event_recommendations
- **Compliance Notes**: User-generated content; moderation required; calendar permissions; RLS enforced
- **Event Triggers**: events_viewed, event_clicked, event_created, rsvp_submitted, screen_id:COMM-002
- **Dependencies**: AuthProvider, EventDialog, MeetupDetailsDrawer, ProfilePreviewDialog
- **Notes**: Combined events and meetups view; Screen ID D1-002-03 / D1-002-07

---

## COMM-003: Live Rooms

- **CanonicalId**: COMM.00.003.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/live-rooms`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/LiveRooms.tsx
- **Component Path**: src/pages/community/LiveRooms.tsx
- **UI Pattern**: card-grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Live room cards, Create live room popup, Join room action
- **Status**: ✅ Implemented
- **Notes**: Live audio/video rooms; Screen ID D1-002-04

---

## COMM-004: Media Hub

- **CanonicalId**: COMM.00.004.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/media-hub`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/MediaHub.tsx
- **Component Path**: src/pages/community/MediaHub.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community media library; Screen ID D1-002-05

---

## COMM-005: My Business

- **CanonicalId**: COMM.00.005.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/my-business`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/MyBusiness.tsx
- **Component Path**: src/pages/community/MyBusiness.tsx
- **UI Pattern**: split-screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Business profile setup, Services, Booking calendar
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Business profile management for professionals; Screen ID D1-002-06

---

## COMM-006: Group Detail

- **CanonicalId**: COMM.00.006.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/groups/:groupId`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/GroupDetail.tsx
- **Component Path**: src/pages/community/GroupDetail.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Group info, Members, Posts, Events
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Individual group page

---

## COMM-007: Feed

- **CanonicalId**: COMM.00.007.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/feed`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Feed.tsx
- **Component Path**: src/pages/community/Feed.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Post cards, Create post popup
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community social feed; Screen ID D1-002-02

---

## COMM-008: Challenges

- **CanonicalId**: COMM.00.008.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/challenges`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Challenges.tsx
- **Component Path**: src/pages/community/Challenges.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Wellness challenges and competitions

---

## COMM-009: Groups

- **CanonicalId**: COMM.00.009.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/groups`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Groups.tsx
- **Component Path**: src/pages/community/Groups.tsx
- **UI Pattern**: split-screen with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: My Groups tab, Recommended Groups tab, Create group popup
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community groups discovery and management; Screen ID D1-002-01

---

## COMM-010: My Groups

- **CanonicalId**: COMM.00.010.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/my-groups`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/MyGroups.tsx
- **Component Path**: src/pages/community/MyGroups.tsx
- **UI Pattern**: split-screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: My groups list, Group details
- **Status**: ✅ Implemented
- **Purpose**: User's joined groups management and overview
- **Primary APIs Used**: Groups API, Supabase API
- **DB Tables / Models Used**: global_community_groups, global_community_group_members
- **Compliance Notes**: User-specific group data; RLS enforced
- **Event Triggers**: my_groups_viewed, group_selected, screen_id:COMM-010
- **Dependencies**: AuthProvider, GroupContext
- **Notes**: User's personal group management

---

## COMM-011: Group Detail

- **CanonicalId**: COMM.00.011.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/groups/:groupId`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/GroupDetail.tsx
- **Component Path**: src/pages/community/GroupDetail.tsx
- **UI Pattern**: Detail page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Group info, Members, Posts, Events
- **Status**: ✅ Implemented
- **Purpose**: Detailed view of a specific community group
- **Primary APIs Used**: Groups API
- **DB Tables / Models Used**: global_community_groups, global_community_group_members
- **Compliance Notes**: Group visibility controlled by privacy settings
- **Event Triggers**: group_detail_viewed, member_action, screen_id:COMM-011
- **Dependencies**: AuthProvider, GroupContext
- **Notes**: Individual group detail and management

---

## COMM-012: Matchmaking

- **CanonicalId**: COMM.00.012.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/matchmaking`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Matchmaking.tsx
- **Component Path**: src/pages/community/Matchmaking.tsx
- **UI Pattern**: split-screen with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: People tab, Groups tab, Coaches tab, Events tab, Analysis tab, Match filters popup
- **Status**: ✅ Implemented
- **Purpose**: AI-powered matchmaking system for discovering compatible community members, groups, coaches, and events based on user interests, wellness goals, and activity patterns; provides compatibility analysis and personalized recommendations
- **Primary APIs Used**: Matches API, AI recommendations API, Supabase API
- **DB Tables / Models Used**: daily_matches, match_reasons, global_community_profiles, global_community_groups, global_community_events
- **Compliance Notes**: AI-generated match scores and recommendations; user-specific data with RLS enforcement; privacy-sensitive matching algorithms; opt-out available in user settings
- **Event Triggers**: matchmaking_viewed, match_tab_changed, match_filters_opened, match_card_clicked, screen_id:COMM-012
- **Dependencies**: AuthProvider, PeopleMatchCard, GroupMatchCard, CoachMatchCard, EventMatchCard, CompatibilityCard, MatchFiltersPopup, MatchNotificationBadge, SubNavigation, StandardHeader, SplitBar
- **Notes**: Premium feature providing AI-powered compatibility matching across multiple entity types; includes daily match notifications and advanced filtering options

---

## COMM-013: Live Interaction

- **CanonicalId**: COMM.00.013.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/live-interaction`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/LiveInteraction.tsx
- **Component Path**: src/pages/community/LiveInteraction.tsx
- **UI Pattern**: dashboard with live stream grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active live rooms grid, Go Live popup, Autopilot actions preview, Scheduled streams section
- **Status**: ✅ Implemented
- **Purpose**: Central hub for discovering, joining, and managing live audio/video streaming sessions; allows users to browse active streams, start their own broadcasts, and view scheduled upcoming sessions; integrates with autopilot for automated streaming recommendations
- **Primary APIs Used**: Live Streaming API, WebRTC API, Supabase Realtime, Autopilot API
- **DB Tables / Models Used**: community_live_streams, autopilot_actions
- **Compliance Notes**: Real-time video/audio streaming with HIPAA considerations for health discussions; content moderation required; age-restricted content filtering; recording consent must be obtained; compliance with COPPA for under-13 users
- **Event Triggers**: live_interaction_viewed, go_live_clicked, live_room_joined, autopilot_opened, scheduled_stream_viewed, screen_id:COMM-013
- **Dependencies**: AuthProvider, useAutopilot hook, GoLivePopup, AutopilotPopup, SubNavigation, StandardHeader, Avatar components, WebRTC infrastructure
- **Notes**: Premium interactive streaming feature with autopilot integration; supports both audio-only and video streams; displays real-time viewer counts and stream duration

---

## COMM-014: AI Insights

- **CanonicalId**: COMM.00.014.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/ai-insights`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/AIInsights.tsx
- **Component Path**: src/pages/community/AIInsights.tsx
- **UI Pattern**: dashboard with insight cards
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Recommended connections, Trending topics, Engagement insights, Growth opportunities, Community analytics, Autopilot popup
- **Status**: ✅ Implemented
- **Purpose**: AI-powered analytics and recommendations dashboard providing personalized insights on community engagement, connection opportunities, trending topics, and growth strategies; helps users optimize their social wellness journey through data-driven recommendations
- **Primary APIs Used**: AI Insights API, Analytics API, Recommendations API, Autopilot API
- **DB Tables / Models Used**: ai_recommendations, global_community_profiles, engagement_metrics, autopilot_actions
- **Compliance Notes**: AI-generated insights and recommendations; aggregated anonymized data for trending topics; user-specific analytics with RLS; no PHI exposed in community insights; transparent AI methodology disclosed to users
- **Event Triggers**: ai_insights_viewed, connection_recommended, topic_clicked, insight_dismissed, autopilot_triggered, screen_id:COMM-014
- **Dependencies**: AuthProvider, useAutopilot hook, AutopilotPopup, SubNavigation, StandardHeader, Avatar components, Chart/analytics visualization components
- **Notes**: Premium AI feature providing match scores (75-95%), activity level tracking, shared goals analysis, engagement trends, and personalized growth recommendations; integrates with autopilot for automated action suggestions

---

## COMM-015: Live Room Viewer

- **CanonicalId**: COMM.00.015.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/live-rooms/:roomId`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/LiveRoomViewer.tsx
- **Component Path**: src/pages/community/LiveRoomViewer.tsx
- **UI Pattern**: immersive-viewer with chat
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Live stream video/audio, Real-time chat, Participants list, Stream controls, Recording playback
- **Status**: ✅ Implemented
- **Purpose**: Immersive viewer for individual live audio/video streaming rooms; provides real-time participation with video/audio feeds, live chat, reactions, and participant management; supports both host and viewer modes with WebRTC-based streaming
- **Primary APIs Used**: WebRTC API, Supabase Realtime API, Live Streaming API, Chat API, Recording API
- **DB Tables / Models Used**: community_live_streams, live_chat_messages, stream_participants, stream_recordings
- **Compliance Notes**: Real-time video/audio streaming with HIPAA considerations; chat moderation required; recording consent enforcement; participant privacy controls; age verification for restricted content; COPPA compliance for under-13 users
- **Event Triggers**: live_room_entered, chat_message_sent, reaction_sent, participant_joined, recording_started, screen_id:COMM-015
- **Dependencies**: AuthProvider, useStreamLifecycle hook, useLiveChat hook, useStreamRecording hook, useWebRTC hook, LiveRoom component, StreamRecordingPlayer, ScrollArea, Avatar components, SubNavigation
- **Notes**: Full-featured live streaming viewer with WebRTC infrastructure; supports host/viewer roles, real-time chat with emoji reactions, participant list management, stream recording/playback, and dynamic room state synchronization via Supabase Realtime

---

## COMM-016: Meetups Standalone

- **CanonicalId**: COMM.00.016.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/meetups`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Meetups.tsx
- **Component Path**: src/pages/community/Meetups.tsx
- **UI Pattern**: split-screen with tabs and card grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Today tab, This Week tab, Later tab, Create meetup popup
- **Status**: ✅ Implemented
- **Purpose**: Dedicated meetups discovery and management page organized by time periods (Today, This Week, Later); provides categorized view of local wellness meetups including yoga, cooking workshops, hydration challenges, strength training, and sleep seminars; allows users to create new meetups tied to health pillars
- **Primary APIs Used**: Meetups API, Calendar API, Supabase API
- **DB Tables / Models Used**: global_community_events (filtered by event_type='meetup'), event_attendees
- **Compliance Notes**: Location data shared for meetups; age restrictions for certain activities; health disclaimer required for physical activities; liability waivers for in-person events; COPPA compliance for youth-focused meetups
- **Event Triggers**: meetups_viewed, meetup_tab_changed, meetup_card_clicked, create_meetup_opened, attendee_registered, screen_id:COMM-016
- **Dependencies**: AuthProvider, usePermissions hook, CreateMeetupPopup, NewsCard component, SplitBar, UtilityActionButton, ExpandableSearchButton, UniversalCalendarButton, SubNavigation, StandardHeader, Tooltip components
- **Notes**: Pillar-categorized meetups (Mental, Nutrition, Hydration, Movement, Sleep) with visual icons; displays attendee counts, timestamps, and locations; supports search and calendar integration; permission-gated create functionality for professional/staff roles

---

## COMM-017: Events Standalone

- **CanonicalId**: COMM.00.017.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/events-standalone`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Events.tsx
- **Component Path**: src/pages/community/Events.tsx
- **UI Pattern**: split-screen with tabs and card grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Today tab, This Week tab, This Month tab, Create event popup, Meetup details drawer, Social share dialog
- **Status**: ✅ Implemented
- **Purpose**: Dedicated events discovery page organized by time periods (Today, This Week, This Month); provides comprehensive view of wellness events including yoga, fitness classes, nutrition workshops, sleep seminars, and mental wellness activities; supports event creation and social sharing of events across platforms
- **Primary APIs Used**: Events API, Calendar API, Supabase API, Social Share API
- **DB Tables / Models Used**: global_community_events, event_attendees, event_co_creators
- **Compliance Notes**: Location data shared for events; age restrictions for certain activities; health disclaimer required for physical activities; liability waivers for in-person events; social share preview metadata; COPPA compliance for youth-focused events
- **Event Triggers**: events_standalone_viewed, event_tab_changed, event_card_clicked, create_event_opened, event_drawer_opened, event_shared, screen_id:COMM-017
- **Dependencies**: AuthProvider, useEventSelection context, EventSelectionProvider, CreateEventPopup, MeetupDetailsDrawer, NewsCard component, SocialShareButton, SplitBar, UtilityActionButton, ExpandableSearchButton, UniversalCalendarButton, SubNavigation, StandardHeader
- **Notes**: Pillar-categorized events (Exercise, Nutrition, Hydration, Sleep, Mental Wellness) with visual icons; displays attendee counts, time/location details; supports search, calendar integration, URL parameter-based drawer navigation (?meetupId=), and social sharing with Open Graph metadata

---

## COMM-018: Meetups Enhanced

- **CanonicalId**: COMM.00.018.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/meetups-enhanced`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/Meetups2.tsx
- **Component Path**: src/pages/community/Meetups2.tsx
- **UI Pattern**: split-screen with tabs and enhanced card grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Today tab, This Week tab, This Month tab, Create meetup popup, Edit meetup popup, Meetup details drawer
- **Status**: ✅ Implemented
- **Purpose**: Enhanced version of meetups page with full CRUD operations (create, read, update, delete); connects to live Supabase backend for real-time event management; supports event_type filtering, location-based meetups, and comprehensive event editing capabilities; integrates with screen_id tracking system (COMM-018)
- **Primary APIs Used**: Supabase API (global_community_events table), Calendar API, useCommunityEvents hook
- **DB Tables / Models Used**: global_community_events (event_type='meetup'), event_attendees, event_co_creators
- **Compliance Notes**: Real-time database sync; location data privacy; age restrictions enforced via database; health activity disclaimers; liability waivers stored; user authentication required for CRUD operations; RLS policies enforced; COPPA compliance
- **Event Triggers**: meetups_enhanced_viewed, meetup_tab_changed, meetup_created, meetup_edited, meetup_deleted, meetup_drawer_opened, attendee_count_updated, screen_id:COMM-018
- **Dependencies**: AuthProvider, useCommunityEvents hook, useMeetupSelection context, MeetupSelectionProvider, CreateMeetupPopup, EditMeetupPopup, MeetupDetailsDrawer, NewsCard component, SplitBar, UtilityActionButton, ExpandableSearchButton, UniversalCalendarButton, SubNavigation, StandardHeader, SCREEN_IDS constants, withScreenId HOC
- **Notes**: Production-ready enhanced meetups page with full backend integration; supports real-time event updates, edit/delete capabilities for event creators, time-based filtering (Today/This Week/This Month), URL parameter-based drawer navigation (?meetupId=), attendee count tracking, and comprehensive event metadata (title, description, location, time, category, image); includes fallback to static placeholder image if event image unavailable

---

## COMM-013: Media Hub

- **CanonicalId**: COMM.00.013.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/media`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/MediaHub.tsx
- **Component Path**: src/pages/community/MediaHub.tsx
- **UI Pattern**: Media gallery
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Photos tab, Videos tab, Audio tab
- **Status**: ✅ Implemented
- **Purpose**: Community media content hub and gallery
- **Primary APIs Used**: Media API, Supabase Storage
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: User-generated content; content moderation applies
- **Event Triggers**: media_hub_viewed, media_played, screen_id:COMM-013
- **Dependencies**: AuthProvider
- **Notes**: Community media content library

---

## COMM-014: AI Insights

- **CanonicalId**: COMM.00.014.A.ALL.CLI
- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/community/ai-insights`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/community/AIInsights.tsx
- **Component Path**: src/pages/community/AIInsights.tsx
- **UI Pattern**: Insights dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Trending topics, Recommended connections, Activity insights
- **Status**: ✅ Implemented
- **Purpose**: AI-powered community insights and analytics
- **Primary APIs Used**: AI Analytics API, Recommendations API
- **DB Tables / Models Used**: ai_recommendations, ai_situation_analyses
- **Compliance Notes**: AI-generated insights; user privacy maintained
- **Event Triggers**: ai_insights_viewed, insight_clicked, screen_id:COMM-014
- **Dependencies**: AuthProvider, AI service
- **Notes**: AI-driven community analytics and recommendations

---

## DISC-001: Discover Overview

- **CanonicalId**: DISC.00.001.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Discover.tsx
- **Component Path**: src/pages/Discover.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Wellness Services, Doctors/Coaches, Deals/Offers, Orders navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Discover marketplace hub; Screen ID D1-003

---

## DISC-002: Supplements

- **CanonicalId**: DISC.00.002.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/supplements`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/Supplements.tsx
- **Component Path**: src/pages/discover/Supplements.tsx
- **UI Pattern**: card-grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Product cards, Filter sidebar, Product detail page
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Supplement marketplace powered by CJ Dropshipping

---

## DISC-003: Wellness Services

- **CanonicalId**: DISC.00.003.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/wellness-services`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/WellnessServices.tsx
- **Component Path**: src/pages/discover/WellnessServices.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Wellness services discovery; Screen ID D1-003-01

---

## DISC-004: Doctors & Coaches

- **CanonicalId**: DISC.00.004.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/doctors-coaches`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/DoctorsCoaches.tsx
- **Component Path**: src/pages/discover/DoctorsCoaches.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Healthcare professional discovery; Screen ID D1-003-02

---

## DISC-005: Deals & Offers

- **CanonicalId**: DISC.00.005.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/deals-offers`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/DealsOffers.tsx
- **Component Path**: src/pages/discover/DealsOffers.tsx
- **UI Pattern**: split-screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Special deals and promotions; Screen ID D1-003-03

---

## DISC-006: Orders

- **CanonicalId**: DISC.00.006.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/orders`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/Orders.tsx
- **Component Path**: src/pages/discover/Orders.tsx
- **UI Pattern**: sub-page-header with data table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Order list, Order detail drawer, Tracking info
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: User order history; Screen ID D1-003-04

---

## DISC-007: Product Detail

- **CanonicalId**: DISC.00.007.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/product/:productId`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/ProductDetail.tsx
- **Component Path**: src/pages/discover/ProductDetail.tsx
- **UI Pattern**: Product detail page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Product images, Description, Reviews, Add to cart
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Individual product detail page for supplements

---

## DISC-008: Provider Profile

- **CanonicalId**: DISC.00.008.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/provider/:providerId`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/ProviderProfile.tsx
- **Component Path**: src/pages/discover/ProviderProfile.tsx
- **UI Pattern**: Profile page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Bio, Services, Reviews, Book appointment
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Healthcare provider profile page

---

## DISC-009: Cart

- **CanonicalId**: DISC.00.009.A.ALL.CLI
- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/discover/cart`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/Cart.tsx
- **Component Path**: src/pages/discover/Cart.tsx
- **UI Pattern**: Cart page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Cart items, Checkout button, Remove items
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Shopping cart for supplements

---

## DISC-010: Intent Router

- **CanonicalId**: DISC.00.010.A.COMM.PROD
- **Module**: Discover
- **Portal(s)**: Community Portal
- **Roles with access**: Community Member
- **External Route (client URL)**: `/discover` (embedded component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/discover/IntentRouter.tsx
- **Component Path**: src/pages/discover/IntentRouter.tsx
- **UI Pattern**: intent-detection-interface
- **Tenant Availability**: Maxina
- **Subscreens / Tabs / Modals**: Search Bar, Intent Chips (Doctors & Coaches, Wellness Services, Community Groups), Quick Stats
- **Status**: ✅ Implemented
- **Purpose**: Intelligent search interface that detects user intent and routes to appropriate discovery sections (providers, services, groups, or general browse) based on keyword matching; serves as the main entry point for discovery with visual intent chips and search functionality
- **Primary APIs Used**: Supabase Analytics API (analytics.trackClick for intent detection tracking and user behavior analysis)
- **DB Tables / Models Used**: N/A (client-side intent detection via keyword matching; no direct database queries)
- **Compliance Notes**: No sensitive data collected; analytics tracks search queries and chip clicks for UX optimization; search terms are logged for intent improvement but not linked to PHI
- **Event Triggers**: analytics.trackClick('discover-intent-router', '1.0', 'search'), analytics.trackClick('discover-intent-router', '1.0', 'intent-detected'), analytics.trackClick('discover-intent-router', '1.0', 'chip-click'), screen_id:DISC-010
- **Dependencies**: withCardId HOC (CT-DIS-001, C-001), analytics library, react-router-dom navigation, Input component, Button component, Card/CardContent components, Lucide icons (Search, UserCheck, Heart, Users)
- **Notes**: Uses keyword-based intent detection to route users to /discover/providers (for doctor/coach queries), /discover/categories (for wellness service queries), /community/groups (for community/social queries), or /discover/browse (default fallback); includes hardcoded stats display (150+ providers, 50+ categories, 1000+ members) for social proof

---

## HLTH-001: Health Overview

- **CanonicalId**: HLTH.00.001.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Health.tsx
- **Component Path**: src/pages/Health.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Services Hub, My Biology, Plans, Education, Pillars, Conditions navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Health hub dashboard; Screen ID D1-005

---

## HLTH-002: Services Hub

- **CanonicalId**: HLTH.00.002.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/services-hub`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/ServicesHub.tsx
- **Component Path**: src/pages/health/ServicesHub.tsx
- **UI Pattern**: split-screen
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Health services directory; Screen ID D1-005-01

---

## HLTH-003: My Biology (Biomarkers)

- **CanonicalId**: HLTH.00.003.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/biomarkers`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/Biomarkers.tsx
- **Component Path**: src/pages/health/Biomarkers.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Biomarker cards, Trend charts, Detail views
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Personal biomarker tracking; Screen ID D1-005-02

---

## HLTH-004: Plans

- **CanonicalId**: HLTH.00.004.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/plans`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/Plans.tsx
- **Component Path**: src/pages/health/Plans.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Personalized health plans; Screen ID D1-005-05

---

## HLTH-005: Education

- **CanonicalId**: HLTH.00.005.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/education`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/Education.tsx
- **Component Path**: src/pages/health/Education.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Health education content; Screen ID D1-005-04

---

## HLTH-006: Pillars

- **CanonicalId**: HLTH.00.006.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/pillars`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/Pillars.tsx
- **Component Path**: src/pages/health/Pillars.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Health pillar tracking (sleep, nutrition, fitness, etc.)

---

## HLTH-007: Conditions & Risks

- **CanonicalId**: HLTH.00.007.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/conditions`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/ConditionsRisks.tsx
- **Component Path**: src/pages/health/ConditionsRisks.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Risk assessments, Preventive action plans
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Health risk assessments and preventive planning

---

## HLTH-008: Biomarker Results

- **CanonicalId**: HLTH.00.008.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/biomarkers`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/BiomarkerResults.tsx
- **Component Path**: src/pages/health/BiomarkerResults.tsx
- **UI Pattern**: Data visualization dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Lab results, Trends, Insights
- **Status**: ✅ Implemented
- **Purpose**: Biomarker test results display and trend analysis
- **Primary APIs Used**: Biomarker API, Lab results API
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA sensitive; patient health data; strict RLS enforcement
- **Event Triggers**: biomarkers_viewed, result_detail_opened, screen_id:HLTH-008
- **Dependencies**: AuthProvider, HealthDataContext
- **Notes**: Lab results and biomarker trending

---

## HLTH-009: My Biology

- **CanonicalId**: HLTH.00.009.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/my-biology`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/MyBiology.tsx
- **Component Path**: src/pages/health/MyBiology.tsx
- **UI Pattern**: Profile page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Genetics, Biometrics, Medical history
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive user biological profile and genetic data
- **Primary APIs Used**: Genetics API, Biometric API
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Highly sensitive genetic data; HIPAA/GINA compliance required; strict access control
- **Event Triggers**: my_biology_viewed, genetic_data_accessed, screen_id:HLTH-009
- **Dependencies**: AuthProvider, HealthDataContext
- **Notes**: Personal biological and genetic profile

---

## HLTH-010: Plans

- **CanonicalId**: HLTH.00.010.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/plans`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/Plans.tsx
- **Component Path**: src/pages/health/Plans.tsx
- **UI Pattern**: Plan overview
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active plans, Completed plans, Plan details
- **Status**: ✅ Implemented
- **Purpose**: Health and wellness plan management
- **Primary APIs Used**: Plans API
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Health plan data; user-specific; RLS enforced
- **Event Triggers**: plans_viewed, plan_started, screen_id:HLTH-010
- **Dependencies**: AuthProvider, PlansContext
- **Notes**: Personalized health plans and programs

---

## HLTH-011: Education & Resources

- **CanonicalId**: HLTH.00.011.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/education`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/EducationResources.tsx
- **Component Path**: src/pages/health/EducationResources.tsx
- **UI Pattern**: Resource library
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Articles, Videos, Guides
- **Status**: ✅ Implemented
- **Purpose**: Health education content and learning resources
- **Primary APIs Used**: Content API, Education API
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Public health information; content moderation required
- **Event Triggers**: education_viewed, resource_accessed, screen_id:HLTH-011
- **Dependencies**: ContentProvider
- **Notes**: Educational content library for wellness

---

## HLTH-012: Wellness Services

- **CanonicalId**: HLTH.00.012.A.ALL.CLI
- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/health/services`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/health/WellnessServices.tsx
- **Component Path**: src/pages/health/WellnessServices.tsx
- **UI Pattern**: Service listing
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Service categories, Provider profiles, Booking
- **Status**: ✅ Implemented
- **Purpose**: Browse and book wellness services and appointments
- **Primary APIs Used**: Services API, Booking API
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Service provider information; booking data protected
- **Event Triggers**: wellness_services_viewed, service_booked, screen_id:HLTH-012
- **Dependencies**: AuthProvider, BookingContext
- **Notes**: Wellness service marketplace

---

## INBX-001: Inbox Overview

- **CanonicalId**: INBX.00.001.A.ALL.CLI
- **Module**: Inbox
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/inbox`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Inbox.tsx
- **Component Path**: src/pages/Inbox.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Reminder, Inspiration, Archived navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Inbox hub; Screen ID D1-004

---

## INBX-002: Reminder

- **CanonicalId**: INBX.00.002.A.ALL.CLI
- **Module**: Inbox
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/inbox/reminder`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/inbox/Reminder.tsx
- **Component Path**: src/pages/inbox/Reminder.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Reminder messages; Screen ID D1-004-01

---

## INBX-003: Inspiration

- **CanonicalId**: INBX.00.003.A.ALL.CLI
- **Module**: Inbox
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/inbox/inspiration`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/inbox/Inspiration.tsx
- **Component Path**: src/pages/inbox/Inspiration.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Inspirational content; Screen ID D1-004-02

---

## INBX-004: Archived

- **CanonicalId**: INBX.00.004.A.ALL.CLI
- **Module**: Inbox
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/inbox/archived`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/inbox/Archived.tsx
- **Component Path**: src/pages/inbox/Archived.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Archived messages

---

## AI-001: AI Overview

- **CanonicalId**: AI.00.001.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/AIOverview.tsx
- **Component Path**: src/pages/ai/AIOverview.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Insights, Recommendations, Daily Summary, Companion navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI hub dashboard

---

## AI-002: Insights

- **CanonicalId**: AI.00.002.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai/insights`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/Insights.tsx
- **Component Path**: src/pages/ai/Insights.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI-generated insights

---

## AI-003: Recommendations

- **CanonicalId**: AI.00.003.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai/recommendations`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/Recommendations.tsx
- **Component Path**: src/pages/ai/Recommendations.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI recommendations

---

## AI-004: Daily Summary

- **CanonicalId**: AI.00.004.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai/daily-summary`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/DailySummary.tsx
- **Component Path**: src/pages/ai/DailySummary.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Daily AI summary

---

## AI-005: Companion

- **CanonicalId**: AI.00.005.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai/companion`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/Companion.tsx
- **Component Path**: src/pages/ai/Companion.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI companion chat

---

## AI-006: Agent Prompt Center

- **CanonicalId**: AI.00.006.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai/agent-prompt-center`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/AgentPromptCenter.tsx
- **Component Path**: src/pages/ai/AgentPromptCenter.tsx
- **UI Pattern**: sub-page-header with dual-panel layout
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Agent Templates panel, Custom Prompt Editor panel, Test Agent dialog, Save Prompt confirmation
- **Status**: 🚧 Placeholder (Phase 5)
- **Purpose**: Customize AI agent behavior and system prompts for personalized wellness assistance; select from pre-built agent templates or create custom prompts; define agent focus areas (Health, Social, Productivity, Longevity); test and save agent configurations; optimize AI responses to match individual communication preferences and wellness goals
- **Primary APIs Used**: Supabase API for user_agent_prompts table; Vertex AI API for prompt testing and validation; Edge function for agent configuration management
- **DB Tables / Models Used**: user_agent_prompts (prompt_id, user_id, agent_name, system_prompt, focus_areas, template_id, is_active, created_at, updated_at), agent_templates (template_id, name, description, prompt_text, category, color), agent_test_logs (test_id, prompt_id, test_input, test_output, timestamp)
- **Compliance Notes**: User-specific AI customization data; prompts may contain sensitive health preferences; no PHI should be embedded in system prompts; prompt templates are public but user customizations are private; RLS enforced per user; audit trail for prompt changes recommended for AI transparency
- **Event Triggers**: agent_prompt_center_viewed, template_selected, custom_prompt_created, agent_tested, prompt_saved, focus_area_selected, screen_id:AI-006
- **Dependencies**: AppLayout, SEO, StandardHeader, Card components, Badge, Input, Textarea, Button components; Vertex AI integration for prompt testing; useUserAgentPrompts hook (future)
- **Notes**: Includes 4 pre-built templates (Health Optimization Agent, Longevity Lifestyle Coach, Community Connection Agent, Wellness Productivity Agent) with categories (Health, Lifestyle, Social, Productivity); supports custom prompt editing with focus area tags; Test Agent and Save Prompt buttons currently disabled (Phase 5 implementation pending); read-only placeholder with UI/UX preview

---

## AI-007: Personal AI Timeline

- **CanonicalId**: AI.00.007.A.ALL.CLI
- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/ai/personal-timeline`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ai/PersonalAITimeline.tsx
- **Component Path**: src/pages/ai/PersonalAITimeline.tsx
- **UI Pattern**: sub-page-header with activity feed
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: AI Activity Feed, Filter by type (success, insight, recommendation, automation), View details modal, Export timeline
- **Status**: 🚧 Placeholder (Phase 5)
- **Purpose**: Display chronological timeline of all AI assistant activities, insights, and recommendations; track autopilot executions and wellness actions; view detected health patterns and correlations; monitor AI-suggested community matches and events; review calendar optimizations and automated scheduling; provide transparency into AI decision-making and actions taken on user's behalf
- **Primary APIs Used**: Supabase API for ai_activity_timeline, autopilot_actions, ai_recommendations tables; Edge function for timeline aggregation and filtering
- **DB Tables / Models Used**: ai_activity_timeline (activity_id, user_id, timestamp, activity_type, title, description, icon, metadata, related_entity_id, related_entity_type), autopilot_actions (id, user_id, executed_at, action_type, status), ai_recommendations (id, user_id, created_at, recommendation_type, confidence_score), ai_insights (insight_id, user_id, detected_at, insight_type, pattern_data)
- **Compliance Notes**: Contains AI-generated health insights and activity logs; no direct PHI but may reference health patterns; user-specific data with RLS enforcement; activity timeline must be auditable for AI transparency and explainability; users must have ability to view and export all AI actions
- **Event Triggers**: ai_timeline_viewed, timeline_filtered, activity_detail_viewed, timeline_exported, insight_clicked, recommendation_acted_on, screen_id:AI-007
- **Dependencies**: AppLayout, SEO, StandardHeader, Card components, Badge, activity type icons (Bot, Calendar, TrendingUp, Zap); useAIActivityTimeline hook (future); color-coded activity types (success: green, insight: blue, recommendation: purple, automation: orange)
- **Notes**: Currently displays 4 sample timeline items with varied activity types; activity feed includes timestamp, title, description, type badge, and color-coded icon; supports filtering by activity type; read-only placeholder (Phase 5) with mock data demonstrating UI/UX; future implementation will connect to real AI activity logs, autopilot execution history, and recommendation engine; exportable timeline for personal records and transparency

---

## WLLT-001: Wallet Overview

- **CanonicalId**: WLLT.00.001.A.ALL.CLI
- **Module**: Wallet
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/wallet`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Wallet.tsx
- **Component Path**: src/pages/Wallet.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Balance, Subscriptions, Rewards navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Wallet hub; Screen ID D1-006

---

## WLLT-002: Balance

- **CanonicalId**: WLLT.00.002.A.ALL.CLI
- **Module**: Wallet
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/wallet/balance`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/wallet/Balance.tsx
- **Component Path**: src/pages/wallet/Balance.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Wallet balance view; Screen ID D1-006-01

---

## WLLT-003: Subscriptions

- **CanonicalId**: WLLT.00.003.A.ALL.CLI
- **Module**: Wallet
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/wallet/subscriptions`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/wallet/Subscriptions.tsx
- **Component Path**: src/pages/wallet/Subscriptions.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Active subscriptions; Screen ID D1-006-02

---

## WLLT-004: Rewards

- **CanonicalId**: WLLT.00.004.A.ALL.CLI
- **Module**: Wallet
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/wallet/rewards`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/wallet/Rewards.tsx
- **Component Path**: src/pages/wallet/Rewards.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Rewards program; Screen ID D1-006-03

---

## SHAR-001: Sharing Overview

- **CanonicalId**: SHAR.00.001.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Sharing.tsx
- **Component Path**: src/pages/Sharing.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Campaigns, Distribution, Data/Consent navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Content sharing hub; Screen ID D1-007

---

## SHAR-002: Campaigns

- **CanonicalId**: SHAR.00.002.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/campaigns`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/Campaigns.tsx
- **Component Path**: src/pages/sharing/Campaigns.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Campaign list, Create campaign button
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Content distribution campaigns; Screen ID D1-007-06

---

## SHAR-003: Campaign Detail

- **CanonicalId**: SHAR.00.003.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/campaigns/:campaignId`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/CampaignDetail.tsx
- **Component Path**: src/pages/sharing/CampaignDetail.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Campaign info, Posts, Analytics
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Individual campaign management; Screen ID D1-007-07

---

## SHAR-004: Distribution

- **CanonicalId**: SHAR.00.004.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/distribution`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/Distribution.tsx
- **Component Path**: src/pages/sharing/Distribution.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Content distribution management

---

## SHAR-005: Data & Consent

- **CanonicalId**: SHAR.00.005.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/data-consent`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/DataConsent.tsx
- **Component Path**: src/pages/sharing/DataConsent.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Data sharing consent management

---

## SHAR-006: Consent Dashboard

- **CanonicalId**: SHAR.00.006.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/consent`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/Consent.tsx
- **Component Path**: src/pages/sharing/Consent.tsx
- **UI Pattern**: sub-page-header with cards
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active Permissions, Pending Requests, Privacy Settings, Grant Access Dialog, Create Package Dialog, Privacy Settings Dialog
- **Status**: ✅ Implemented
- **Purpose**: Manage data sharing consents and permissions, view active access grants, review and approve/reject pending data sharing requests from organizations, configure privacy controls, create data packages for sharing with healthcare providers or research studies
- **Primary APIs Used**: Supabase API for consent_records, data_access_requests, organizations tables
- **DB Tables / Models Used**: consent_records, data_access_requests, organizations, data_types_shared, data_packages, privacy_settings
- **Compliance Notes**: HIPAA/GDPR sensitive - manages explicit user consent for data sharing with third parties; requires audit trail of all consent actions; must support consent revocation; data sharing must be granular and purpose-specific
- **Event Triggers**: consent_dashboard_viewed, consent_granted, consent_revoked, access_request_approved, access_request_rejected, privacy_settings_changed, data_package_created, screen_id:SHAR-006
- **Dependencies**: AppLayout, SubNavigation, sharingNavigation config, GrantAccessDialog, CreatePackageDialog, PrivacySettingsDialog, StandardCard, UtilityActionButton, SEO component
- **Notes**: Central hub for managing all data sharing activities; provides transparency into who has access to what data; supports granular consent management with time-limited and purpose-specific permissions

---

## SHAR-007: Logs & Revocation

- **CanonicalId**: SHAR.00.007.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/logs`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/Logs.tsx
- **Component Path**: src/pages/sharing/Logs.tsx
- **UI Pattern**: sub-page-header with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Activity Logs, Revoked Access, Analytics Dashboard, Export Logs, View Details Popup
- **Status**: ✅ Implemented
- **Purpose**: Monitor and audit all data sharing activities, view detailed access logs showing who accessed what data when, manage and review revoked permissions with rationale, export activity reports for personal records, track data sharing analytics and patterns
- **Primary APIs Used**: Supabase API for sharing_logs, revocation_records, audit_events tables; Edge function for log aggregation and analytics
- **DB Tables / Models Used**: sharing_logs (log_id, user_id, organization_id, data_type, access_timestamp, ip_address, action), revocation_records (revocation_id, consent_id, revoked_at, reason, user_id), audit_events
- **Compliance Notes**: HIPAA/GDPR audit trail requirement - all data access must be logged with timestamp, accessor identity, data type, and purpose; logs must be immutable and retained per regulatory requirements (typically 6+ years); users must have transparent access to view all activity; revocation must take effect immediately
- **Event Triggers**: logs_viewed, log_detail_expanded, access_revoked_from_logs, logs_exported, analytics_viewed, log_filtered, screen_id:SHAR-007
- **Dependencies**: AppLayout, SubNavigation, sharingNavigation config, ViewDetailsPopup, StandardCard, DataTable, ExportButton, SEO component, date range filters
- **Notes**: Provides full transparency and audit capability for data sharing; supports compliance with right-to-know regulations; includes real-time activity monitoring; revocation management allows users to retroactively revoke access with documented reasons

---

## SHAR-008: Integration Marketplace

- **CanonicalId**: SHAR.00.008.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/marketplace`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/Marketplace.tsx
- **Component Path**: src/pages/sharing/Marketplace.tsx
- **UI Pattern**: sub-page-header with grid cards
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Featured Integrations, Categories (Healthcare, Research, Wellness Apps, Insurance), My Connections, Browse Services Popup, Integration Detail Modal, Connect Authorization Flow
- **Status**: ✅ Implemented
- **Purpose**: Discover and connect with verified healthcare platforms, research studies, wellness apps, and insurance providers; browse available integrations by category; view integration benefits and data requirements; authorize and manage third-party connections; participate in approved research studies by sharing relevant health data
- **Primary APIs Used**: Supabase API for marketplace_integrations, user_connections, research_studies tables; OAuth 2.0 authorization flow for third-party integrations; Edge functions for integration status checks
- **DB Tables / Models Used**: marketplace_integrations (integration_id, name, category, description, logo_url, required_data_types, benefits, verification_status, privacy_policy_url), user_connections (connection_id, user_id, integration_id, connected_at, status, sync_frequency), research_studies (study_id, title, institution, required_data, compensation, duration)
- **Compliance Notes**: HIPAA-compliant integration vetting required - all marketplace partners must undergo security and privacy audits; users must provide explicit consent before data sharing; OAuth scopes must be granular and clearly disclosed; research studies must have IRB approval documentation; insurance integrations must comply with state regulations
- **Event Triggers**: marketplace_viewed, integration_browsed, integration_connected, connection_authorized, research_study_joined, category_filtered, integration_detail_viewed, screen_id:SHAR-008
- **Dependencies**: AppLayout, SubNavigation, sharingNavigation config, BrowseServicesPopup, MotivationalBanner, StandardCard, AuthorizationFlow component, CategoryFilter, SEO component, OAuth provider integration
- **Notes**: Curated marketplace of verified third-party integrations; includes featured partnerships with major health systems and insurance providers; supports research study recruitment with compensation tracking; OAuth-based secure authorization; real-time connection status monitoring

---

## SHAR-009: Data Packages

- **CanonicalId**: SHAR.00.009.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/packages`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/Packages.tsx
- **Component Path**: src/pages/sharing/Packages.tsx
- **UI Pattern**: sub-page-header with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: My Packages, Templates, Create Custom, Package Detail View, Share Package Dialog, Edit Package Modal, Create Package Popup
- **Status**: ✅ Implemented
- **Purpose**: Create, manage, and share customized health data packages with healthcare providers, insurance companies, or research institutions; use pre-built templates for common scenarios (specialist visit, insurance claim, second opinion); define custom data packages with specific biomarkers, conditions, medications, and time ranges; generate shareable links or PDFs with expiration dates and access controls
- **Primary APIs Used**: Supabase API for data_packages, package_templates, package_recipients, package_contents tables; Edge function for package generation and PDF export; File storage API for package attachments
- **DB Tables / Models Used**: data_packages (package_id, user_id, name, description, created_at, expires_at, access_code, status, shared_with), package_templates (template_id, name, category, included_data_types, description), package_recipients (recipient_id, package_id, recipient_email, recipient_name, accessed_at, access_count), package_contents (content_id, package_id, data_type, data_id, included_at)
- **Compliance Notes**: HIPAA-compliant package generation - packages must be encrypted at rest and in transit; access codes must be secure and time-limited; audit trail required for all package access; recipients must be authenticated before viewing; PDF exports must be watermarked with access tracking; packages containing sensitive data (genetic, mental health) require additional consent
- **Event Triggers**: packages_viewed, package_created, package_shared, package_accessed_by_recipient, package_expired, package_deleted, template_used, pdf_generated, screen_id:SHAR-009
- **Dependencies**: AppLayout, SubNavigation, sharingNavigation config, CreatePackagePopup, PackageTemplateSelector, StandardCard, DataTypeSelector, RecipientManager, PDFGenerator, ShareDialog, SEO component
- **Notes**: Supports both instant sharing and scheduled future sharing; includes package templates for common medical scenarios (lab results for endocrinologist, fitness data for trainer, complete health history for new PCP); generated packages include metadata summary, data visualizations, and exportable formats (PDF, HL7 FHIR); tracks recipient access with notifications to user

---

## SHAR-010: Smart Package Creator

- **CanonicalId**: SHAR.00.010.A.ALL.CLI
- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/sharing/smart-package`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/sharing/SmartPackage.tsx
- **Component Path**: src/pages/sharing/SmartPackage.tsx
- **UI Pattern**: sub-page-header with AI-driven interface
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: AI Recommendations, Custom Builder, Templates, Package Preview, Smart Package Popup, Recipient Selection, Export Options
- **Status**: ✅ Implemented
- **Purpose**: Use AI to intelligently create health data packages tailored to specific recipients and purposes; receive smart recommendations based on appointment type, provider specialty, or medical condition; automatically select relevant biomarkers, medications, conditions, and lifestyle data; optimize package contents for maximum clinical utility; suggest additional data that may be helpful; preview and refine AI-generated packages before sharing
- **Primary APIs Used**: Supabase API for smart_packages, ai_recommendations, package_templates tables; Vertex AI API for intelligent package composition; Edge function for AI-powered data relevance scoring and package optimization
- **DB Tables / Models Used**: smart_packages (smart_package_id, user_id, purpose, recipient_type, ai_recommendations, selected_data, created_at, optimization_score), ai_recommendations (recommendation_id, package_id, data_type, relevance_score, reasoning, confidence_level), package_templates, user_health_data (for context analysis)
- **Compliance Notes**: HIPAA/GDPR compliant AI processing - AI must not store or train on user health data; recommendations must be explainable with clear reasoning; user maintains full control over final package contents; AI suggestions must respect user privacy preferences; over-sharing warnings for sensitive data; audit trail of AI recommendations and user modifications
- **Event Triggers**: smart_package_viewed, ai_recommendations_generated, recommendation_accepted, recommendation_rejected, package_optimized, recipient_analyzed, smart_package_created, optimization_score_viewed, screen_id:SHAR-010
- **Dependencies**: AppLayout, SubNavigation, sharingNavigation config, SmartPackagePopup, MotivationalBanner, StandardCard, AIRecommendationCard, DataOptimizer component, RecipientAnalyzer, PackagePreview, SEO component, Vertex AI integration
- **Notes**: AI analyzes recipient type (cardiologist, endocrinologist, personal trainer, insurance) and suggests optimal data selection; provides relevance scores and reasoning for each recommendation; warns about potential over-sharing or missing critical data; supports iterative refinement with user feedback; integrates with existing package templates; includes confidence indicators and explainability features; can analyze appointment context from calendar integration to suggest timing-specific data

---

## MEMO-001: Memory Overview

- **CanonicalId**: MEMO.00.001.A.ALL.CLI
- **Module**: Memory
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/memory`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Memory.tsx
- **Component Path**: src/pages/Memory.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Timeline, Diary, Recall, Permissions navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Memory hub; Screen ID D1-008

---

## MEMO-002: Timeline

- **CanonicalId**: MEMO.00.002.A.ALL.CLI
- **Module**: Memory
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/memory/timeline`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/memory/Timeline.tsx
- **Component Path**: src/pages/memory/Timeline.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Life timeline view; Screen ID D1-008-01

---

## MEMO-003: Diary

- **CanonicalId**: MEMO.00.003.A.ALL.CLI
- **Module**: Memory
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/memory/diary`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/memory/Diary.tsx
- **Component Path**: src/pages/memory/Diary.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Diary entries, Create entry popup
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Personal diary/journal; Screen ID D1-008-02

---

## MEMO-004: Recall

- **CanonicalId**: MEMO.00.004.A.ALL.CLI
- **Module**: Memory
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/memory/recall`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/memory/Recall.tsx
- **Component Path**: src/pages/memory/Recall.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI-powered memory recall; Screen ID D1-008-03

---

## MEMO-005: Permissions

- **CanonicalId**: MEMO.00.005.A.ALL.CLI
- **Module**: Memory
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/memory/permissions`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/memory/Permissions.tsx
- **Component Path**: src/pages/memory/Permissions.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Memory sharing permissions; Screen ID D1-008-04

---

## SETT-001: Settings Overview

- **CanonicalId**: SETT.00.001.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Settings.tsx
- **Component Path**: src/pages/Settings.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Preferences, Privacy, Notifications, Connected Apps, Billing, Support navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Settings hub; Screen ID D1-009

---

## SETT-002: Preferences

- **CanonicalId**: SETT.00.002.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/preferences`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/Preferences.tsx
- **Component Path**: src/pages/settings/Preferences.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: User preferences; Screen ID D1-009-01

---

## SETT-003: Privacy

- **CanonicalId**: SETT.00.003.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/privacy`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/Privacy.tsx
- **Component Path**: src/pages/settings/Privacy.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Privacy settings; Screen ID D1-009-02

---

## SETT-004: Notifications

- **CanonicalId**: SETT.00.004.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/notifications`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/Notifications.tsx
- **Component Path**: src/pages/settings/Notifications.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Notification preferences

---

## SETT-005: Connected Apps

- **CanonicalId**: SETT.00.005.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/connected-apps`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/ConnectedApps.tsx
- **Component Path**: src/pages/settings/ConnectedApps.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Third-party app integrations; Screen ID D1-009-03

---

## SETT-006: Billing & Rewards

- **CanonicalId**: SETT.00.006.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/billing-rewards`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/BillingRewards.tsx
- **Component Path**: src/pages/settings/BillingRewards.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Billing and rewards; Screen ID D1-009-04

---

## SETT-007: Support

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/support`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/Support.tsx
- **Component Path**: src/pages/settings/Support.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Help and support

---

## SETT-008: Tenant & Role

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/tenant-role`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/TenantRole.tsx
- **Component Path**: src/pages/settings/TenantRole.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Role selector, Tenant info
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Tenant and role management for multi-role users

---

## SETT-009: Autopilot Settings

- **CanonicalId**: SETT.00.009.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/autopilot`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/AutopilotSettings.tsx
- **Component Path**: src/pages/settings/AutopilotSettings.tsx
- **UI Pattern**: sub-page-header with cards
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Master switch, Action categories, Frequency & timing controls
- **Status**: ✅ Implemented
- **Purpose**: Configure personal autopilot automation preferences including action categories, daily limits, quiet hours, and priority filters
- **Primary APIs Used**: Supabase API for user_preferences table read/update
- **DB Tables / Models Used**: user_preferences (autopilot_enabled, autopilot_categories, autopilot_max_actions_per_day, autopilot_quiet_hours_start, autopilot_quiet_hours_end, autopilot_priority_filter)
- **Compliance Notes**: User-specific automation preferences; all data is personal and non-medical; RLS enforced per user
- **Event Triggers**: autopilot_settings_viewed, autopilot_enabled_toggled, autopilot_category_changed, autopilot_frequency_changed, screen_id:SETT-009
- **Dependencies**: useUserPreferences hook, AuthProvider, settingsNavigation config, AppLayout, SubNavigation
- **Notes**: Manages autopilot action preferences including health, community, discovery, and memory categories; controls daily action limits (1-20 per day) and quiet hours scheduling

---

## SETT-010: Voice AI Settings

- **CanonicalId**: SETT.00.010.A.ALL.CLI
- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/settings/voice-ai`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/settings/VoiceAISettings.tsx
- **Component Path**: src/pages/settings/VoiceAISettings.tsx
- **UI Pattern**: sub-page-header with tabs (Voice, AI Models, Privacy)
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Voice tab (TTS/STT settings), AI Models tab (model selection), Privacy tab (data controls)
- **Status**: ✅ Implemented
- **Purpose**: Configure voice recognition (STT), text-to-speech (TTS), and AI assistant preferences including language, voice selection, speech parameters, AI model choices, and voice data retention settings
- **Primary APIs Used**: Supabase API for user_preferences, Google Cloud TTS edge function (google-cloud-tts), Browser Web Speech API (speechSynthesis), OpenAI API for models
- **DB Tables / Models Used**: user_preferences (stt_language, stt_enabled, tts_voice, tts_speed, tts_pitch, tts_volume, tts_enabled, ai_chat_model, ai_voice_model, ai_auto_transcribe, voice_data_retention_days, voice_analytics_enabled)
- **Compliance Notes**: Voice data privacy sensitive; includes retention controls (7/30/90 days/indefinitely); analytics opt-in; multilingual support requires proper language/voice matching; TTS preview uses browser and cloud APIs
- **Event Triggers**: voice_ai_settings_viewed, tts_voice_changed, stt_language_changed, ai_model_changed, voice_preview_played, privacy_setting_changed, screen_id:SETT-010
- **Dependencies**: useUserPreferences hook, AuthProvider, settingsNavigation config, Browser Web Speech API, Google Cloud TTS edge function, Voice matching algorithm for language/voice pairing
- **Notes**: Supports 9 languages (en-US, de-DE, sr-RS, es-ES, ar-XA, ru-RU, zh-CN, fr-FR, pt-PT); Auto-selects matching female voice when language changes; Includes browser and Google Cloud TTS voices with quality indicators; TTS controls for speed (0.5-2.0x), pitch (0.5-2.0), and volume (0-100%); AI model selection for chat (GPT-4, GPT-3.5) and voice (Whisper, Deepgram, Google); Privacy controls for data retention and analytics

---

## UTIL-001: AI Assistant (Persistent Chat)

- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Global sidebar component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: N/A (Removed - See VITANA Orb)
- **Component Path**: N/A (Removed - See VITANA Orb)
- **UI Pattern**: Fixed bottom chat bar
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Chat input, Voice mode, Camera mode, Screen share
- **Status**: ❌ Deprecated (Removed in favor of VITANA Orb)
- **Purpose**: Deprecated - AI assistant functionality now provided by VITANA Orb overlay
- **Primary APIs Used**: N/A (Deprecated)
- **DB Tables / Models Used**: N/A (Deprecated)
- **Compliance Notes**: N/A (Deprecated)
- **Event Triggers**: N/A (Deprecated)
- **Dependencies**: N/A (Deprecated)
- **Notes**: Deprecated communication bar; replaced by VITANA Orb overlay. File has been removed from codebase.

---

## UTIL-002: Calendar

- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/calendar`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Calendar.tsx
- **Component Path**: src/pages/Calendar.tsx
- **UI Pattern**: Calendar view
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Month view, Week view, Day view, Event creation
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Unified calendar for all events and appointments

---

## UTIL-003: Search

- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/search`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/Search.tsx
- **Component Path**: src/pages/Search.tsx
- **UI Pattern**: Search results page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Search filters, Result categories
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Global search

---

## UTIL-004: Profile Edit

- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: `/profile/edit`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/ProfileEdit.tsx
- **Component Path**: src/pages/ProfileEdit.tsx
- **UI Pattern**: Form wizard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Basic info, Bio, Roles, Privacy
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: User profile editing

---

## UTIL-005: Public Profile

- **Module**: Utility
- **Portal(s)**: All
- **Roles with access**: All (public if profile is public)
- **External Route (client URL)**: `/u/:handle`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/PublicProfile.tsx
- **Component Path**: src/pages/PublicProfile.tsx
- **UI Pattern**: Profile page
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Profile card, Bio, Activity, Follow button
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Public user profile pages

---

# PATIENT ROLE SCREENS

---

## PTNT-001: Patient Dashboard

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/Dashboard.tsx
- **Component Path**: src/pages/patient/Dashboard.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Health, Appointments, Test Results, Care Team navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient role dashboard

---

## PTNT-002: Health

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/health`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/Health.tsx
- **Component Path**: src/pages/patient/Health.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: N/A
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient health overview

---

## PTNT-003: Appointments

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/appointments`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/Appointments.tsx
- **Component Path**: src/pages/patient/Appointments.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Upcoming, Past, Book appointment
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient appointments management

---

## PTNT-004: Test Results

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/test-results`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/TestResults.tsx
- **Component Path**: src/pages/patient/TestResults.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Test results list, Detail views
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Lab and test results

---

## PTNT-005: Care Team

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/care-team`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/CareTeam.tsx
- **Component Path**: src/pages/patient/CareTeam.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Care team members, Contact info
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient's care team

---

## PTNT-006: Health Goals

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/health-goals`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/HealthGoals.tsx
- **Component Path**: src/pages/patient/HealthGoals.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Goal list, Add goal, Progress tracking
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient health goals

---

## PTNT-007: Insurance

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/insurance`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/Insurance.tsx
- **Component Path**: src/pages/patient/Insurance.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Insurance cards, Coverage info
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Insurance information

---

## PTNT-008: Notifications

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/notifications`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/Notifications.tsx
- **Component Path**: src/pages/patient/Notifications.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Notification list, Mark as read
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient notifications

---

## PTNT-009: Settings

- **Module**: Patient
- **Portal(s)**: All
- **Roles with access**: Patient
- **External Route (client URL)**: `/patient/settings`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/patient/Settings.tsx
- **Component Path**: src/pages/patient/Settings.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Preferences, Privacy
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient-specific settings

---

# PROFESSIONAL ROLE SCREENS

---

## PROF-001: Professional Dashboard

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Dashboard.tsx
- **Component Path**: src/pages/professional/Dashboard.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Patients, Schedule, Clinical Tools navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Professional role dashboard

---

## PROF-002: Patients

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/patients`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Patients.tsx
- **Component Path**: src/pages/professional/Patients.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Patient list, Patient detail, Add patient
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient management

---

## PROF-003: Schedule

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/schedule`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Schedule.tsx
- **Component Path**: src/pages/professional/Schedule.tsx
- **UI Pattern**: Calendar view
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Appointments, Availability settings
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Professional schedule management

---

## PROF-004: Clinical Tools

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/clinical-tools`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/ClinicalTools.tsx
- **Component Path**: src/pages/professional/ClinicalTools.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Assessment tools, Treatment plans
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Clinical assessment and treatment tools

---

## PROF-005: Referrals

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/referrals`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Referrals.tsx
- **Component Path**: src/pages/professional/Referrals.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Referral list, Create referral
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient referral management

---

## PROF-006: Billing

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/billing`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Billing.tsx
- **Component Path**: src/pages/professional/Billing.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Invoices, Payments, Reports
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Professional billing and payments

---

## PROF-007: Professional Profile

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/profile`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Profile.tsx
- **Component Path**: src/pages/professional/Profile.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Bio, Credentials, Services, Availability
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Professional public profile management

---

## PROF-008: Education

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/education`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Education.tsx
- **Component Path**: src/pages/professional/Education.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Courses, Certifications, Resources
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Continuing education resources

---

## PROF-009: Settings

- **Module**: Professional
- **Portal(s)**: All
- **Roles with access**: Professional
- **External Route (client URL)**: `/professional/settings`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/professional/Settings.tsx
- **Component Path**: src/pages/professional/Settings.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Preferences, Notifications, Integrations
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Professional-specific settings

---

# STAFF ROLE SCREENS

---

## STFF-001: Staff Dashboard

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/Dashboard.tsx
- **Component Path**: src/pages/staff/Dashboard.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Queue, Daily Tasks, Schedule navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff role dashboard

---

## STFF-002: Queue

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/queue`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/Queue.tsx
- **Component Path**: src/pages/staff/Queue.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Patient queue, Check-in, Assign
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient queue management

---

## STFF-003: Daily Tasks

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/daily-tasks`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/DailyTasks.tsx
- **Component Path**: src/pages/staff/DailyTasks.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Task list, Complete task, Add task
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Daily task management

---

## STFF-004: Schedule

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/schedule`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/Schedule.tsx
- **Component Path**: src/pages/staff/Schedule.tsx
- **UI Pattern**: Calendar view
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Shift schedule, Availability
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff schedule management

---

## STFF-005: Reports

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/reports`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/Reports.tsx
- **Component Path**: src/pages/staff/Reports.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Report list, Generate report
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff reporting

---

## STFF-006: Communications

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/communications`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/Communications.tsx
- **Component Path**: src/pages/staff/Communications.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Messages, Announcements
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff communications

---

## STFF-007: Staff Tools

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/tools`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/StaffTools.tsx
- **Component Path**: src/pages/staff/StaffTools.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Tool library
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff utility tools

---

## STFF-008: Time Tracking

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/time-tracking`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/TimeTracking.tsx
- **Component Path**: src/pages/staff/TimeTracking.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Clock in/out, Timesheet
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Time tracking for staff

---

## STFF-009: Settings

- **Module**: Staff
- **Portal(s)**: All
- **Roles with access**: Staff
- **External Route (client URL)**: `/staff/settings`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/staff/Settings.tsx
- **Component Path**: src/pages/staff/Settings.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Preferences, Notifications
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff-specific settings

---

# ADMIN ROLE SCREENS

---

## ADMN-001: Admin Dashboard

- **Module**: Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin`
- **Internal/Admin Route (if any)**: `/admin`
- **Dev Route (current project path)**: src/pages/admin/Dashboard.tsx
- **Component Path**: src/pages/admin/Dashboard.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: User Management, System Admin, Monitoring navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Admin role main dashboard; Screen ID D1-010

---

## ADMN-002: Overview

- **Module**: Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/overview`
- **Internal/Admin Route (if any)**: `/admin/overview`
- **Dev Route (current project path)**: src/pages/admin/Overview.tsx
- **Component Path**: src/pages/admin/Overview.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: System metrics, Quick actions
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: High-level system overview

---

## ADMN-010: User Management

- **Module**: Admin - User Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/user-management`
- **Internal/Admin Route (if any)**: `/admin/user-management`
- **Dev Route (current project path)**: src/pages/admin/UserManagement.tsx
- **Component Path**: src/pages/admin/UserManagement.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: User list, User detail, Role assignment
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: User account management

---

## ADMN-011: Roles & Permissions

- **Module**: Admin - User Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/roles-permissions`
- **Internal/Admin Route (if any)**: `/admin/roles-permissions`
- **Dev Route (current project path)**: src/pages/admin/RolesPermissions.tsx
- **Component Path**: src/pages/admin/RolesPermissions.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Role list, Permission matrix, Create role
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Role-based access control management

---

## ADMN-012: User Activity

- **Module**: Admin - User Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/user-activity`
- **Internal/Admin Route (if any)**: `/admin/user-activity`
- **Dev Route (current project path)**: src/pages/admin/UserActivity.tsx
- **Component Path**: src/pages/admin/UserActivity.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Activity log, Filters, Export
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: User activity monitoring

---

## ADMN-020: Tenant Management

- **Module**: Admin - Tenant Management
- **Portal(s)**: Exafy only
- **Roles with access**: Admin (Exafy)
- **External Route (client URL)**: `/admin/tenant-management`
- **Internal/Admin Route (if any)**: `/admin/tenant-management`
- **Dev Route (current project path)**: src/pages/admin/TenantManagement.tsx
- **Component Path**: src/pages/admin/TenantManagement.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Exafy
- **Subscreens / Tabs / Modals**: Tenant list, Switch tenant, Gemini API setup
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Multi-tenant organization management for Exafy admins

---

## ADMN-021: Tenant Config

- **Module**: Admin - Tenant Management
- **Portal(s)**: Exafy only
- **Roles with access**: Admin (Exafy)
- **External Route (client URL)**: `/admin/tenant-config`
- **Internal/Admin Route (if any)**: `/admin/tenant-config`
- **Dev Route (current project path)**: src/pages/admin/TenantConfig.tsx
- **Component Path**: src/pages/admin/TenantConfig.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Exafy
- **Subscreens / Tabs / Modals**: Configuration options, Save changes
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Tenant-specific configuration settings

---

## ADMN-022: Membership Management

- **Module**: Admin - Tenant Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/memberships`
- **Internal/Admin Route (if any)**: `/admin/memberships`
- **Dev Route (current project path)**: src/pages/admin/MembershipManagement.tsx
- **Component Path**: src/pages/admin/MembershipManagement.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Member list, Add member, Remove member, Role changes
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Tenant membership administration

---

## ADMN-030: System Config

- **Module**: Admin - System Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/system-config`
- **Internal/Admin Route (if any)**: `/admin/system-config`
- **Dev Route (current project path)**: src/pages/admin/SystemConfig.tsx
- **Component Path**: src/pages/admin/SystemConfig.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: System settings, Feature flags
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Global system configuration

---

## ADMN-031: Database Admin

- **Module**: Admin - System Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/database`
- **Internal/Admin Route (if any)**: `/admin/database`
- **Dev Route (current project path)**: src/pages/admin/DatabaseAdmin.tsx
- **Component Path**: src/pages/admin/DatabaseAdmin.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Table browser, Query console, Backups
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Database administration tools

---

## ADMN-032: API Management

- **Module**: Admin - System Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/api-management`
- **Internal/Admin Route (if any)**: `/admin/api-management`
- **Dev Route (current project path)**: src/pages/admin/ApiManagement.tsx
- **Component Path**: src/pages/admin/ApiManagement.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: API keys, Rate limits, Usage stats
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: API key and usage management

---

## ADMN-040: Queue & Check-In

- **Module**: Admin - Clinical Operations
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/queue-checkin`
- **Internal/Admin Route (if any)**: `/admin/queue-checkin`
- **Dev Route (current project path)**: src/pages/admin/QueueCheckin.tsx
- **Component Path**: src/pages/admin/QueueCheckin.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Patient queue, Check-in interface
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Clinical queue management; Screen ID D1-010-01

---

## ADMN-041: Patient Records

- **Module**: Admin - Clinical Operations
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/patient-records`
- **Internal/Admin Route (if any)**: `/admin/patient-records`
- **Dev Route (current project path)**: src/pages/admin/PatientRecords.tsx
- **Component Path**: src/pages/admin/PatientRecords.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Patient search, Record detail, Audit log
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Patient record administration; Screen ID D1-010-02

---

## ADMN-050: System Monitoring

- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/system-monitoring`
- **Internal/Admin Route (if any)**: `/admin/system-monitoring`
- **Dev Route (current project path)**: src/pages/admin/SystemMonitoring.tsx
- **Component Path**: src/pages/admin/SystemMonitoring.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Metrics, Alerts, Logs
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Real-time system monitoring

---

## ADMN-051: Notification Dashboard

- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/notification-dashboard`
- **Internal/Admin Route (if any)**: `/admin/notification-dashboard`
- **Dev Route (current project path)**: src/pages/admin/NotificationDashboard.tsx
- **Component Path**: src/pages/admin/NotificationDashboard.tsx
- **UI Pattern**: Dashboard with stats
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Notification stats, Cron health, Real-time monitor
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Notification system monitoring

---

## ADMN-052: Audit Logs

- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/audit-logs`
- **Internal/Admin Route (if any)**: `/admin/audit-logs`
- **Dev Route (current project path)**: src/pages/admin/AuditLogs.tsx
- **Component Path**: src/pages/admin/AuditLogs.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Log entries, Filters, Export
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System audit log viewer; Screen ID D1-010-06

---

## ADMN-053: Staff Directory

- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/staff-directory`
- **Internal/Admin Route (if any)**: `/admin/staff-directory`
- **Dev Route (current project path)**: src/pages/admin/StaffDirectory.tsx
- **Component Path**: src/pages/admin/StaffDirectory.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Staff list, Staff detail, Add staff
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Staff member directory; Screen ID D1-010-04

---

## ADMN-060: Stream Supervision

- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/stream-supervision`
- **Internal/Admin Route (if any)**: `/admin/stream-supervision`
- **Dev Route (current project path)**: src/pages/admin/StreamSupervision.tsx
- **Component Path**: src/pages/admin/StreamSupervision.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active streams, Monitor stream, End stream
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Live stream moderation; Screen ID D1-010-03

---

## ADMN-061: Content Moderation

- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/content-moderation`
- **Internal/Admin Route (if any)**: `/admin/content-moderation`
- **Dev Route (current project path)**: src/pages/admin/ContentModeration.tsx
- **Component Path**: src/pages/admin/ContentModeration.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Flagged content, Review queue, Take action
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community content moderation

---

## ADMN-062: User Reports

- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/user-reports`
- **Internal/Admin Route (if any)**: `/admin/user-reports`
- **Dev Route (current project path)**: src/pages/admin/UserReports.tsx
- **Component Path**: src/pages/admin/UserReports.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Report queue, Report detail, Take action
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: User-submitted reports

---

## ADMN-063: Community Analytics

- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/community-analytics`
- **Internal/Admin Route (if any)**: `/admin/community-analytics`
- **Dev Route (current project path)**: src/pages/admin/CommunityAnalytics.tsx
- **Component Path**: src/pages/admin/CommunityAnalytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Engagement metrics, Growth stats, Content trends
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community engagement analytics

---

## ADMN-070: Media Library

- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/media-library`
- **Internal/Admin Route (if any)**: `/admin/media-library`
- **Dev Route (current project path)**: src/pages/admin/MediaLibrary.tsx
- **Component Path**: src/pages/admin/MediaLibrary.tsx
- **UI Pattern**: card-grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Media files, Upload, Delete
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Central media asset library

---

## ADMN-071: Video Manager

- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/video-manager`
- **Internal/Admin Route (if any)**: `/admin/video-manager`
- **Dev Route (current project path)**: src/pages/admin/VideoManager.tsx
- **Component Path**: src/pages/admin/VideoManager.tsx
- **UI Pattern**: card-grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Video list, Upload video, Encoding status
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Video content management

---

## ADMN-072: Image Manager

- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/image-manager`
- **Internal/Admin Route (if any)**: `/admin/image-manager`
- **Dev Route (current project path)**: src/pages/admin/ImageManager.tsx
- **Component Path**: src/pages/admin/ImageManager.tsx
- **UI Pattern**: card-grid
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Image gallery, Upload, Edit
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Image asset management

---

## ADMN-073: Storage Analytics

- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/storage-analytics`
- **Internal/Admin Route (if any)**: `/admin/storage-analytics`
- **Dev Route (current project path)**: src/pages/admin/StorageAnalytics.tsx
- **Component Path**: src/pages/admin/StorageAnalytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Usage stats, Storage breakdown, Cost analysis
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Storage usage analytics

---

## ADMN-074: CDN Settings

- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/cdn-settings`
- **Internal/Admin Route (if any)**: `/admin/cdn-settings`
- **Dev Route (current project path)**: src/pages/admin/CdnSettings.tsx
- **Component Path**: src/pages/admin/CdnSettings.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: CDN config, Cache purge, Performance
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: CDN configuration

---

## ADMN-080: AI Proactive Admin

- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-proactive`
- **Internal/Admin Route (if any)**: `/admin/ai-proactive`
- **Dev Route (current project path)**: src/pages/admin/AIProactiveAdmin.tsx
- **Component Path**: src/pages/admin/AIProactiveAdmin.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: AI suggestions, Recommendations, Approval queue
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI-driven proactive admin features

---

## ADMN-081: AI Situations

- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-situations`
- **Internal/Admin Route (if any)**: `/admin/ai-situations`
- **Dev Route (current project path)**: src/pages/admin/AISituations.tsx
- **Component Path**: src/pages/admin/AISituations.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Situation list, Analyze situation, Deploy recommendation
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI situation analysis

---

## ADMN-082: AI Recommendations

- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-recommendations`
- **Internal/Admin Route (if any)**: `/admin/ai-recommendations`
- **Dev Route (current project path)**: src/pages/admin/AIRecommendations.tsx
- **Component Path**: src/pages/admin/AIRecommendations.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Recommendation list, Review, Deploy
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI-generated recommendations

---

## ADMN-083: AI Analytics

- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-analytics`
- **Internal/Admin Route (if any)**: `/admin/ai-analytics`
- **Dev Route (current project path)**: src/pages/admin/AIAnalytics.tsx
- **Component Path**: src/pages/admin/AIAnalytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: AI performance, Usage stats, Impact metrics
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI system analytics

---

## ADMN-084: AI Training

- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-training`
- **Internal/Admin Route (if any)**: `/admin/ai-training`
- **Dev Route (current project path)**: src/pages/admin/AITraining.tsx
- **Component Path**: src/pages/admin/AITraining.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Training data, Model updates, Fine-tuning
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI model training and tuning

---

## ADMN-090: Automation Rules

- **Module**: Admin - Automation
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/automation-rules`
- **Internal/Admin Route (if any)**: `/admin/automation-rules`
- **Dev Route (current project path)**: src/pages/admin/AutomationRules.tsx
- **Component Path**: src/pages/admin/AutomationRules.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Rule list, Create rule, Edit rule, Test rule
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Automation rule builder and management

---

## ADMN-091: Automation Executions

- **Module**: Admin - Automation
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/automation-executions`
- **Internal/Admin Route (if any)**: `/admin/automation-executions`
- **Dev Route (current project path)**: src/pages/admin/AutomationExecutions.tsx
- **Component Path**: src/pages/admin/AutomationExecutions.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Execution log, Execution detail, Retry
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Automation execution history and monitoring

---

## ADMN-100: Live Stream Control

- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/live-stream-control`
- **Internal/Admin Route (if any)**: `/admin/live-stream-control`
- **Dev Route (current project path)**: src/pages/admin/LiveStreamControl.tsx
- **Component Path**: src/pages/admin/LiveStreamControl.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active streams, Stream controls, End stream
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Live stream management console

---

## ADMN-101: Stream Analytics

- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/stream-analytics`
- **Internal/Admin Route (if any)**: `/admin/stream-analytics`
- **Dev Route (current project path)**: src/pages/admin/StreamAnalytics.tsx
- **Component Path**: src/pages/admin/StreamAnalytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Viewership, Engagement, Performance
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Live stream analytics

---

## ADMN-102: Stream Quality Monitoring

- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/stream-quality`
- **Internal/Admin Route (if any)**: `/admin/stream-quality`
- **Dev Route (current project path)**: src/pages/admin/StreamQuality.tsx
- **Component Path**: src/pages/admin/StreamQuality.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Quality metrics, Bitrate, Latency
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Stream quality monitoring

---

## ADMN-103: Recording Manager

- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/recording-manager`
- **Internal/Admin Route (if any)**: `/admin/recording-manager`
- **Dev Route (current project path)**: src/pages/admin/RecordingManager.tsx
- **Component Path**: src/pages/admin/RecordingManager.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Recording list, Download, Delete
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Stream recording management

---

## ADMN-104: Broadcast Settings

- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/broadcast-settings`
- **Internal/Admin Route (if any)**: `/admin/broadcast-settings`
- **Dev Route (current project path)**: src/pages/admin/BroadcastSettings.tsx
- **Component Path**: src/pages/admin/BroadcastSettings.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Stream settings, Quality presets, RTMP config
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Broadcast configuration

---

## ADMN-105: AI Assistant Overview

- **CanonicalId**: ADMN.00.105.A.ADM.PROD
- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-assistant`
- **Internal/Admin Route (if any)**: `/admin/ai-assistant`
- **Dev Route (current project path)**: src/pages/admin/AIAssistant.tsx
- **Component Path**: src/pages/admin/AIAssistant.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active automations stats, AI recommendations, Pattern discoveries, System health
- **Status**: ✅ Implemented
- **Purpose**: Central dashboard for AI-powered automation and proactive engagement features; provides overview of active automations, AI-generated recommendations, pattern discoveries, and intelligent system management capabilities
- **Primary APIs Used**: AI Recommendations API, Automation API, Analytics API
- **DB Tables / Models Used**: ai_recommendations, automation_rules, ai_situation_analyses, autopilot_actions
- **Compliance Notes**: AI-generated insights and recommendations; system-level access only; no PHI exposed; transparent AI methodology
- **Event Triggers**: ai_assistant_viewed, automation_clicked, recommendation_reviewed, screen_id:ADMN-105
- **Dependencies**: AuthProvider, AdminHeader, AdminStatsCard, SubNavigation, adminAIAssistantNavigation
- **Notes**: Main AI Assistant overview page providing metrics on active automations (0, ready to scale to 5000+), AI recommendations (0, waiting for deployment), pattern discoveries, and execution stats; serves as entry point to AI-powered admin tools including proactive settings, situation analyzer, and pattern discovery

---

## ADMN-106: API Monitoring

- **CanonicalId**: ADMN.00.106.A.ADM.PROD
- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/api-monitoring`
- **Internal/Admin Route (if any)**: `/admin/api-monitoring`
- **Dev Route (current project path)**: src/pages/admin/APIMonitoring.tsx
- **Component Path**: src/pages/admin/APIMonitoring.tsx
- **UI Pattern**: Dashboard with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Overview tab, Integrations tab, Performance tab, Logs tab, Test logs tab, Recent activity feed
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive API integration monitoring and management dashboard; tracks API health status, performance metrics (response times, throughput, error rates), connection status, and test execution results; provides real-time monitoring of third-party API integrations including auth status, endpoints, and test history
- **Primary APIs Used**: Supabase API (api_integrations, api_performance_metrics, api_test_logs, api_test_notifications tables), Real-time subscriptions
- **DB Tables / Models Used**: api_integrations, api_performance_metrics, api_test_logs, api_test_notifications
- **Compliance Notes**: System-level API credentials storage; secure auth token handling; audit logging of API test executions; compliance with third-party API TOS
- **Event Triggers**: api_monitoring_viewed, integration_tested, integration_toggled, test_log_viewed, screen_id:ADMN-106
- **Dependencies**: AuthProvider, useRealtimeAPIMonitoring hook, AdminHeader, SubNavigation, Tabs component, Badge component, date-fns formatting, Recharts for performance graphs
- **Notes**: Production-ready API monitoring with real-time subscriptions to api_integrations, api_performance_metrics, and api_test_logs tables; displays integration status (healthy, warning, error), last test timestamps, auth types (api_key, oauth, bearer, basic), connection status, success/error rates, throughput, latency metrics (avg, p95, p99), and recent activity feed; supports manual API testing, status toggling, and external dashboard links

---

## ADMN-107: Audit

- **CanonicalId**: ADMN.00.107.A.ADM.PROD
- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/audit`
- **Internal/Admin Route (if any)**: `/admin/audit`
- **Dev Route (current project path)**: src/pages/admin/Audit.tsx
- **Component Path**: src/pages/admin/Audit.tsx
- **UI Pattern**: data-table with filters
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Audit log entries, Event filters, User filters, Export options
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive audit trail viewer for tracking all system events, user actions, and administrative operations; provides filterable log of security-relevant events for compliance and troubleshooting
- **Primary APIs Used**: Supabase API (audit_events table)
- **DB Tables / Models Used**: audit_events
- **Compliance Notes**: HIPAA audit trail requirement; SOC 2 compliance logging; immutable event records; data retention policies enforced; user privacy considerations in log details
- **Event Triggers**: audit_log_viewed, audit_event_filtered, audit_log_exported, screen_id:ADMN-107
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, DataTable component, audit_events table
- **Notes**: System-wide audit logging; tracks user authentication, data access, configuration changes, and administrative actions

---

## ADMN-108: Automation Overview

- **CanonicalId**: ADMN.00.108.A.ADM.PROD
- **Module**: Admin - Automation
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/automation`
- **Internal/Admin Route (if any)**: `/admin/automation`
- **Dev Route (current project path)**: src/pages/admin/Automation.tsx
- **Component Path**: src/pages/admin/Automation.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active automations stats, Executions today, Success rate, Pending review
- **Status**: ✅ Implemented
- **Purpose**: Central dashboard for automation workflow management; provides overview of active automations, execution statistics, success rates, and automated workflow health across the platform
- **Primary APIs Used**: Automation API, Analytics API
- **DB Tables / Models Used**: automation_rules, automation_executions
- **Compliance Notes**: Automation audit trail; user consent for automated actions; transparent automation disclosure; compliance with automated decision-making regulations
- **Event Triggers**: automation_overview_viewed, automation_builder_accessed, rules_manager_accessed, executions_viewed, screen_id:ADMN-108
- **Dependencies**: AuthProvider, AdminHeader, AdminStatsCard, SubNavigation, adminAutomationNavigation
- **Notes**: Main Automation overview providing metrics on active automations (0 currently running), executions today (0 total runs), success rate (0%), and pending review (0 awaiting approval); serves as entry point to automation builder, rules manager, and execution logs

---

## ADMN-109: Bootstrap

- **CanonicalId**: ADMN.00.109.A.ADM.PROD
- **Module**: Admin - System Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/bootstrap`
- **Internal/Admin Route (if any)**: `/admin/bootstrap`
- **Dev Route (current project path)**: src/pages/admin/Bootstrap.tsx
- **Component Path**: src/pages/admin/Bootstrap.tsx
- **UI Pattern**: Utility interface
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: System initialization options, Data seeding controls, Configuration setup
- **Status**: ✅ Implemented
- **Purpose**: System bootstrapping utility for initial setup, data seeding, and configuration initialization; used during system deployment and major updates to prepare the database and seed initial data
- **Primary APIs Used**: Supabase API (multiple tables), Bootstrap edge functions
- **DB Tables / Models Used**: Multiple tables (tenants, profiles, system config)
- **Compliance Notes**: Destructive operations warning; requires super admin access; audit logging of bootstrap actions; backup verification before execution
- **Event Triggers**: bootstrap_accessed, bootstrap_executed, data_seeded, screen_id:ADMN-109
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, Bootstrap edge functions
- **Notes**: Critical system utility for initial setup and data initialization; typically accessed only during deployment or major system updates

---

## ADMN-110: Community Rooms Admin

- **CanonicalId**: ADMN.00.110.A.ADM.PROD
- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/community-rooms`
- **Internal/Admin Route (if any)**: `/admin/community-rooms`
- **Dev Route (current project path)**: src/pages/admin/CommunityRoomsAdmin.tsx
- **Component Path**: src/pages/admin/CommunityRoomsAdmin.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active rooms list, Room details, Moderation actions, User management
- **Status**: ✅ Implemented
- **Purpose**: Administrative oversight of community live rooms and chat spaces; enables admins to monitor active rooms, view participant lists, review chat history, and take moderation actions (warnings, kicks, bans, room closure)
- **Primary APIs Used**: Live Rooms API, Supabase Realtime, Moderation API
- **DB Tables / Models Used**: community_live_streams, live_chat_messages, stream_participants, content_reports
- **Compliance Notes**: Real-time content moderation; chat history retention policies; user privacy in moderation logs; COPPA compliance for youth rooms; harmful content reporting and removal
- **Event Triggers**: community_rooms_admin_viewed, room_moderated, participant_actioned, chat_reviewed, screen_id:ADMN-110
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, DataTable component, real-time subscriptions
- **Notes**: Real-time monitoring and moderation of community live rooms including audio/video streams and text chat; supports instant moderation actions

---

## ADMN-111: Community Supervision

- **CanonicalId**: ADMN.00.111.A.ADM.PROD
- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/community-supervision`
- **Internal/Admin Route (if any)**: `/admin/community-supervision`
- **Dev Route (current project path)**: src/pages/admin/CommunitySupervision.tsx
- **Component Path**: src/pages/admin/CommunitySupervision.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Content moderation queue, Flagged posts, User reports, Group oversight
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive community content moderation dashboard; provides centralized view of flagged content, user reports, group activities, and community health metrics; enables proactive content moderation and user safety management
- **Primary APIs Used**: Moderation API, Reports API, Community API, Supabase Realtime
- **DB Tables / Models Used**: content_reports, global_community_groups, global_community_profiles, distribution_posts
- **Compliance Notes**: Content moderation policies enforcement; DMCA takedown handling; harmful content removal; age-restricted content verification; user privacy in moderation decisions; appeal process
- **Event Triggers**: community_supervision_viewed, content_moderated, report_reviewed, group_actioned, screen_id:ADMN-111
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, content_reports table, real-time subscriptions
- **Notes**: Central hub for all community moderation activities including posts, comments, live streams, groups, and events

---

## ADMN-112: Init Events

- **CanonicalId**: ADMN.00.112.A.ADM.PROD
- **Module**: Admin - System Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/init-events`
- **Internal/Admin Route (if any)**: `/admin/init-events`
- **Dev Route (current project path)**: src/pages/admin/InitEvents.tsx
- **Component Path**: src/pages/admin/InitEvents.tsx
- **UI Pattern**: Utility interface
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Event initialization controls, Sample data generation, Event seeding options
- **Status**: ✅ Implemented
- **Purpose**: Utility for initializing and seeding event data in the system; used during development, testing, and initial system setup to populate the database with sample events, meetups, and community gatherings
- **Primary APIs Used**: Supabase API (global_community_events table), Event seeding edge functions
- **DB Tables / Models Used**: global_community_events, event_attendees, event_co_creators
- **Compliance Notes**: Development/testing tool; audit logging of data seeding; data cleanup procedures; should not be accessible in production without proper authorization
- **Event Triggers**: init_events_accessed, events_seeded, sample_data_generated, screen_id:ADMN-112
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, Event seeding utilities
- **Notes**: Development and testing utility for populating event data; typically used in non-production environments

---

## ADMN-113: Live Stream Overview

- **CanonicalId**: ADMN.00.113.A.ADM.PROD
- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/live-stream-overview`
- **Internal/Admin Route (if any)**: `/admin/live-stream-overview`
- **Dev Route (current project path)**: src/pages/admin/LiveStreamOverview.tsx
- **Component Path**: src/pages/admin/LiveStreamOverview.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active streams grid, Stream statistics, Quality metrics, Viewer analytics
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive live streaming dashboard providing real-time overview of all active streams, viewer statistics, stream health metrics, and quality monitoring; enables quick assessment of platform-wide streaming activity and performance
- **Primary APIs Used**: Live Streaming API, WebRTC metrics API, Supabase Realtime
- **DB Tables / Models Used**: community_live_streams, stream_participants, stream_recordings
- **Compliance Notes**: Real-time stream monitoring; content moderation integration; viewer privacy; recording consent; age-restricted content enforcement; COPPA compliance
- **Event Triggers**: live_stream_overview_viewed, stream_selected, emergency_stop_triggered, screen_id:ADMN-113
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, real-time stream metrics, WebRTC monitoring
- **Notes**: High-level dashboard for monitoring all live streams across the platform; provides at-a-glance view of streaming health and activity

---

## ADMN-114: Media Management

- **CanonicalId**: ADMN.00.114.A.ADM.PROD
- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/media-management`
- **Internal/Admin Route (if any)**: `/admin/media-management`
- **Dev Route (current project path)**: src/pages/admin/MediaManagement.tsx
- **Component Path**: src/pages/admin/MediaManagement.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Media library overview, Storage usage, Content types, Recent uploads
- **Status**: ✅ Implemented
- **Purpose**: Central media asset management dashboard; provides overview of all media content including videos, music, podcasts, images, and documents; tracks storage usage, content organization, and media library health
- **Primary APIs Used**: Storage API, Supabase Storage, Media processing APIs
- **DB Tables / Models Used**: Supabase Storage buckets, media metadata tables
- **Compliance Notes**: DMCA compliance; copyright verification; content licensing tracking; age-restricted media flagging; storage quota management; data retention policies
- **Event Triggers**: media_management_viewed, media_uploaded, media_deleted, storage_analyzed, screen_id:ADMN-114
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, Supabase Storage, media processing pipelines
- **Notes**: Main entry point for media management tools including videos, music, podcasts, and analytics

---

## ADMN-115: Queue Management

- **CanonicalId**: ADMN.00.115.A.ADM.PROD
- **Module**: Admin - Clinical Operations
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/queue`
- **Internal/Admin Route (if any)**: `/admin/queue`
- **Dev Route (current project path)**: src/pages/admin/Queue.tsx
- **Component Path**: src/pages/admin/Queue.tsx
- **UI Pattern**: data-table with real-time updates
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Patient queue list, Check-in interface, Queue status, Wait time analytics
- **Status**: ✅ Implemented
- **Purpose**: Real-time patient queue and check-in management system; enables staff to manage patient flow, track check-in status, monitor wait times, and optimize clinical operations; provides live updates on queue status and patient arrivals
- **Primary APIs Used**: Queue API, Check-in API, Supabase Realtime, Notifications API
- **DB Tables / Models Used**: patient_queue, check_ins, appointments
- **Compliance Notes**: HIPAA-compliant queue management; PHI access controls; patient privacy in waiting area; consent for notifications; audit trail of check-ins
- **Event Triggers**: queue_viewed, patient_checked_in, queue_updated, wait_time_alert, screen_id:ADMN-115
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, real-time subscriptions, Queue management edge functions
- **Notes**: Clinical operations tool for managing patient flow and check-ins; integrates with appointment system and notifications

---

## ADMN-116: Reports

- **CanonicalId**: ADMN.00.116.A.ADM.PROD
- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/reports`
- **Internal/Admin Route (if any)**: `/admin/reports`
- **Dev Route (current project path)**: src/pages/admin/Reports.tsx
- **Component Path**: src/pages/admin/Reports.tsx
- **UI Pattern**: Dashboard with report builder
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Report templates, Custom report builder, Scheduled reports, Export options
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive reporting dashboard for generating system-wide analytics reports, operational insights, compliance reports, and custom data exports; supports scheduled report generation and automated distribution
- **Primary APIs Used**: Analytics API, Reporting API, Export API
- **DB Tables / Models Used**: Multiple tables depending on report type
- **Compliance Notes**: Data export regulations; PHI handling in reports; user consent for data aggregation; secure report storage; audit trail of report generation
- **Event Triggers**: reports_viewed, report_generated, report_scheduled, report_exported, screen_id:ADMN-116
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, Report generation engine, PDF/Excel export utilities
- **Notes**: Flexible reporting system supporting operational, clinical, financial, and compliance reports; includes pre-built templates and custom report builder

---

## ADMN-117: Staff Management

- **CanonicalId**: ADMN.00.117.A.ADM.PROD
- **Module**: Admin - User Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/staff`
- **Internal/Admin Route (if any)**: `/admin/staff`
- **Dev Route (current project path)**: src/pages/admin/Staff.tsx
- **Component Path**: src/pages/admin/Staff.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Staff directory, Add staff, Edit roles, Deactivate staff
- **Status**: ✅ Implemented
- **Purpose**: Staff member management and directory; enables admin to view all staff accounts, manage roles and permissions, add new staff members, and maintain staff directory information; tracks staff status and access levels
- **Primary APIs Used**: User Management API, Roles API, Supabase Auth
- **DB Tables / Models Used**: profiles (role='staff'), user_roles, staff_metadata
- **Compliance Notes**: Staff access control; role-based permissions; background check tracking; credential verification; employment status management; audit trail of role changes
- **Event Triggers**: staff_directory_viewed, staff_added, staff_role_changed, staff_deactivated, screen_id:ADMN-117
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, DataTable component, user management utilities
- **Notes**: Comprehensive staff management including directory, roles, permissions, and status tracking

---

## ADMN-118: Stream Settings

- **CanonicalId**: ADMN.00.118.A.ADM.PROD
- **Module**: Admin - Live & Stream
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/stream-settings`
- **Internal/Admin Route (if any)**: `/admin/stream-settings`
- **Dev Route (current project path)**: src/pages/admin/StreamSettings.tsx
- **Component Path**: src/pages/admin/StreamSettings.tsx
- **UI Pattern**: Settings form
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Quality settings, Bitrate configuration, RTMP settings, Recording options, CDN configuration
- **Status**: ✅ Implemented
- **Purpose**: Global streaming configuration management; allows admins to configure platform-wide streaming settings including video quality presets, bitrate limits, RTMP server settings, recording defaults, and CDN optimization options
- **Primary APIs Used**: Streaming API, WebRTC configuration API, CDN API
- **DB Tables / Models Used**: system_config (streaming settings), stream_quality_presets
- **Compliance Notes**: Bandwidth usage policies; recording consent defaults; data retention for recordings; CDN compliance; streaming quality standards
- **Event Triggers**: stream_settings_viewed, settings_updated, quality_preset_changed, screen_id:ADMN-118
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, streaming infrastructure, CDN integration
- **Notes**: Platform-wide streaming configuration affecting all live streams; includes quality presets, technical settings, and performance optimization

---

## ADMN-119: System Health

- **CanonicalId**: ADMN.00.119.A.ADM.PROD
- **Module**: Admin - Monitoring
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/system-health`
- **Internal/Admin Route (if any)**: `/admin/system-health`
- **Dev Route (current project path)**: src/pages/admin/SystemHealth.tsx
- **Component Path**: src/pages/admin/SystemHealth.tsx
- **UI Pattern**: Dashboard with real-time metrics
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: System status, Database health, API health, Service uptime, Resource usage
- **Status**: ✅ Implemented
- **Purpose**: Real-time system health monitoring dashboard; provides comprehensive view of system infrastructure health including database performance, API availability, service uptime, resource utilization, and error rates; enables proactive issue detection and response
- **Primary APIs Used**: System monitoring APIs, Database health checks, Service health endpoints
- **DB Tables / Models Used**: system_health_metrics, service_status, performance_logs
- **Compliance Notes**: Uptime SLA tracking; incident response protocols; system status transparency; data center compliance
- **Event Triggers**: system_health_viewed, health_check_triggered, alert_threshold_breached, screen_id:ADMN-119
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, real-time metrics, health check services
- **Notes**: Critical operations dashboard for monitoring system health and performance; includes real-time status indicators and historical metrics

---

## ADMN-120: System Security

- **CanonicalId**: ADMN.00.120.A.ADM.PROD
- **Module**: Admin - System Admin
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/system-security`
- **Internal/Admin Route (if any)**: `/admin/system-security`
- **Dev Route (current project path)**: src/pages/admin/SystemSecurity.tsx
- **Component Path**: src/pages/admin/SystemSecurity.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Security overview, Threat detection, Access logs, Security policies, Vulnerability scanning
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive security monitoring and management dashboard; provides visibility into security threats, unauthorized access attempts, policy violations, and vulnerability status; enables security policy configuration and incident response
- **Primary APIs Used**: Security monitoring APIs, Threat detection APIs, Audit APIs
- **DB Tables / Models Used**: security_events, audit_events, failed_login_attempts, security_policies
- **Compliance Notes**: SOC 2 security controls; HIPAA security requirements; penetration testing results; incident response procedures; vulnerability disclosure
- **Event Triggers**: system_security_viewed, security_event_detected, policy_updated, vulnerability_scanned, screen_id:ADMN-120
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, security monitoring services, threat detection systems
- **Notes**: Critical security operations dashboard for monitoring threats, managing security policies, and responding to incidents

---

## ADMN-121: Telemedicine Sessions

- **CanonicalId**: ADMN.00.121.A.ADM.PROD
- **Module**: Admin - Clinical Operations
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/telemedicine-sessions`
- **Internal/Admin Route (if any)**: `/admin/telemedicine-sessions`
- **Dev Route (current project path)**: src/pages/admin/TelemedicineSessions.tsx
- **Component Path**: src/pages/admin/TelemedicineSessions.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active sessions, Session history, Quality monitoring, Participant management
- **Status**: ✅ Implemented
- **Purpose**: Administrative oversight of telemedicine video consultation sessions; enables monitoring of active consultations, quality metrics, technical issues, and compliance requirements; provides session history and audit trail for clinical documentation
- **Primary APIs Used**: Telemedicine API, WebRTC monitoring, Session recording APIs
- **DB Tables / Models Used**: telemedicine_sessions, session_participants, session_recordings, clinical_notes
- **Compliance Notes**: HIPAA-compliant video sessions; patient consent for telehealth; recording consent; session encryption; PHI protection in recordings; state licensing verification for providers
- **Event Triggers**: telemedicine_sessions_viewed, session_monitored, quality_issue_detected, session_ended, screen_id:ADMN-121
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, WebRTC monitoring, telemedicine infrastructure
- **Notes**: Clinical operations tool for monitoring telemedicine consultations; ensures quality and compliance of remote healthcare delivery

---

## ADMN-122: Tenant Audit

- **CanonicalId**: ADMN.00.122.A.ADM.PROD
- **Module**: Admin - Tenant Management
- **Portal(s)**: Exafy only
- **Roles with access**: Admin (Exafy)
- **External Route (client URL)**: `/admin/tenant-audit`
- **Internal/Admin Route (if any)**: `/admin/tenant-audit`
- **Dev Route (current project path)**: src/pages/admin/TenantAudit.tsx
- **Component Path**: src/pages/admin/TenantAudit.tsx
- **UI Pattern**: data-table with filters
- **Tenant Availability**: Exafy
- **Subscreens / Tabs / Modals**: Tenant-specific audit logs, Event filters, User actions, Configuration changes
- **Status**: ✅ Implemented
- **Purpose**: Tenant-level audit trail viewer for multi-tenant environments; enables Exafy admins to view audit logs scoped to specific tenants, track tenant-specific events, configuration changes, and user activities within tenant boundaries
- **Primary APIs Used**: Audit API (tenant-filtered), Supabase API
- **DB Tables / Models Used**: audit_events (filtered by tenant_id), tenant_activity_logs
- **Compliance Notes**: Multi-tenant data isolation; tenant-specific audit requirements; SOC 2 multi-tenancy controls; data residency compliance; audit log retention per tenant
- **Event Triggers**: tenant_audit_viewed, tenant_events_filtered, tenant_log_exported, screen_id:ADMN-122
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, tenant context, audit_events table
- **Notes**: Exafy-specific tool for tenant-scoped audit logging in multi-tenant deployments

---

## ADMN-123: User Audit

- **CanonicalId**: ADMN.00.123.A.ADM.PROD
- **Module**: Admin - User Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/user-audit`
- **Internal/Admin Route (if any)**: `/admin/user-audit`
- **Dev Route (current project path)**: src/pages/admin/UserAudit.tsx
- **Component Path**: src/pages/admin/UserAudit.tsx
- **UI Pattern**: data-table with user search
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: User-specific audit logs, Activity timeline, Data access history, Security events
- **Status**: ✅ Implemented
- **Purpose**: User-level audit trail viewer; enables admins to investigate specific user activities, track data access patterns, review security events, and analyze user behavior for compliance, security investigations, or support purposes
- **Primary APIs Used**: Audit API (user-filtered), User API, Supabase API
- **DB Tables / Models Used**: audit_events (filtered by user_id), user_activity_logs, data_access_logs
- **Compliance Notes**: User privacy in audit reviews; legitimate business purpose for access; audit of audit access; GDPR subject access request support; user notification of access reviews
- **Event Triggers**: user_audit_viewed, user_activity_reviewed, user_logs_exported, screen_id:ADMN-123
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, user search, audit_events table
- **Notes**: User-scoped audit logging for compliance investigations, security reviews, and user support

---

## ADMN-124: Vertex Testing

- **CanonicalId**: ADMN.00.124.A.ADM.PROD
- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/vertex-testing`
- **Internal/Admin Route (if any)**: `/admin/vertex-testing`
- **Dev Route (current project path)**: src/pages/admin/VertexTesting.tsx
- **Component Path**: src/pages/admin/VertexTesting.tsx
- **UI Pattern**: Testing interface
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: API test console, Request/response viewer, Model testing, Configuration options
- **Status**: ✅ Implemented
- **Purpose**: Development and testing interface for Google Vertex AI integration; enables admins to test AI model responses, validate API configurations, debug prompts, and verify AI assistant functionality before deploying to production
- **Primary APIs Used**: Vertex AI API, Google Cloud APIs, Testing edge functions
- **DB Tables / Models Used**: ai_test_logs, vertex_api_config
- **Compliance Notes**: API key security; test data privacy; AI model testing ethics; cost monitoring for API calls; non-production data usage
- **Event Triggers**: vertex_testing_viewed, api_test_executed, model_response_reviewed, screen_id:ADMN-124
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation, Vertex AI API integration, AI testing utilities
- **Notes**: Development tool for testing and validating Vertex AI integration; includes prompt testing, response validation, and configuration verification

---

## ADMN-125: AI Situation Analyzer

- **CanonicalId**: ADMN.00.125.A.ADM.PROD
- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-assistant/situation-analyzer`
- **Internal/Admin Route (if any)**: `/admin/ai-assistant/situation-analyzer`
- **Dev Route (current project path)**: src/pages/admin/ai-assistant/AISituationAnalyzer.tsx
- **Component Path**: src/pages/admin/ai-assistant/AISituationAnalyzer.tsx
- **UI Pattern**: Interactive form with results viewer
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Situation input form, Analysis results, Suggested triggers, Suggested conditions, Suggested actions, Deploy to automation builder
- **Status**: ✅ Implemented
- **Purpose**: AI-powered situation analysis tool that converts natural language descriptions of scenarios into structured automation rules; analyzes admin-described situations, identifies patterns, suggests triggers/conditions/actions, and generates deployable automation configurations
- **Primary APIs Used**: Vertex AI API (via analyze-situation edge function), Automation API, Supabase API
- **DB Tables / Models Used**: ai_situation_analyses, automation_rules, ai_recommendations
- **Compliance Notes**: AI-generated automation suggestions; admin review required before deployment; transparent AI reasoning; cost monitoring for Vertex AI calls; rate limiting
- **Event Triggers**: situation_analyzer_viewed, situation_analyzed, analysis_deployed, automation_created, screen_id:ADMN-125
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminAIAssistantNavigation), SituationForm, AnalysisResults, analyze-situation edge function, useAutomationRules hook
- **Notes**: Converts descriptions like "When a user views 3+ products without buying, send them a discount code" into structured automation rules with confidence scores and rationale

---

## ADMN-126: AI Assistant Analytics

- **CanonicalId**: ADMN.00.126.A.ADM.PROD
- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-assistant/analytics`
- **Internal/Admin Route (if any)**: `/admin/ai-assistant/analytics`
- **Dev Route (current project path)**: src/pages/admin/ai-assistant/Analytics.tsx
- **Component Path**: src/pages/admin/ai-assistant/Analytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Key metrics cards, Conversation trends chart, Memory creation chart, Automation performance, User engagement metrics
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive analytics dashboard for AI Assistant performance metrics; tracks conversation volumes, memory creation rates, automation effectiveness, user engagement, and AI system health; provides insights into AI assistant usage patterns and impact
- **Primary APIs Used**: Analytics API, AI Conversations API, AI Memory API, Automation API
- **DB Tables / Models Used**: ai_conversations, ai_memory, automation_rules, automation_executions, ai_recommendations
- **Compliance Notes**: Aggregated analytics only; no individual conversation content exposure; AI performance transparency; usage cost tracking
- **Event Triggers**: ai_analytics_viewed, metrics_exported, trend_analyzed, screen_id:ADMN-126
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminAIAssistantNavigation), AdminStatsCard, useAIAssistantAnalytics hook, Recharts (LineChart, CartesianGrid, Tooltip, Legend)
- **Notes**: Key metrics include total conversations, memories created, avg confidence scores, active automations, execution success rates, and user engagement trends over time

---

## ADMN-127: Pattern Discovery

- **CanonicalId**: ADMN.00.127.A.ADM.PROD
- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-assistant/pattern-discovery`
- **Internal/Admin Route (if any)**: `/admin/ai-assistant/pattern-discovery`
- **Dev Route (current project path)**: src/pages/admin/ai-assistant/PatternDiscovery.tsx
- **Component Path**: src/pages/admin/ai-assistant/PatternDiscovery.tsx
- **UI Pattern**: Grid with modal details
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Pattern cards grid, Pattern type filter, Pattern status filter, Pattern details modal, Create automation action, Review/Dismiss actions
- **Status**: ✅ Implemented
- **Purpose**: AI-powered pattern discovery interface that automatically identifies behavioral patterns, usage trends, and automation opportunities from user data; surfaces discovered patterns for admin review, enables pattern-to-automation conversion, and tracks pattern implementation status
- **Primary APIs Used**: Pattern Discovery API, AI Recommendations API, Automation API
- **DB Tables / Models Used**: pattern_discoveries, ai_recommendations, automation_rules, user_behavior_logs
- **Compliance Notes**: User behavior pattern detection; privacy-preserving aggregation; pattern implementation consent; transparent pattern disclosure to affected users
- **Event Triggers**: pattern_discovery_viewed, pattern_reviewed, pattern_implemented, pattern_dismissed, automation_created_from_pattern, screen_id:ADMN-127
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminAIAssistantNavigation), usePatternDiscovery hook, PatternCard, PatternDetails components, Filter selects
- **Notes**: Discovers patterns like "Users who complete fitness assessment are 3x more likely to book consultations" or "Payment failures peak on Sundays"; enables quick automation creation from patterns

---

## ADMN-128: Proactive Settings

- **CanonicalId**: ADMN.00.128.A.ADM.PROD
- **Module**: Admin - AI Assistant
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/ai-assistant/proactive-settings`
- **Internal/Admin Route (if any)**: `/admin/ai-assistant/proactive-settings`
- **Dev Route (current project path)**: src/pages/admin/ai-assistant/ProactiveSettings.tsx
- **Component Path**: src/pages/admin/ai-assistant/ProactiveSettings.tsx
- **UI Pattern**: Settings form
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Global AI settings, Proactive engagement controls, Automation thresholds, Notification preferences, AI behavior configuration
- **Status**: ✅ Implemented
- **Purpose**: Configuration interface for AI Assistant proactive engagement settings; controls when and how the AI proactively suggests actions, sets confidence thresholds for automated vs. manual review, configures notification preferences, and manages AI behavior policies
- **Primary APIs Used**: Settings API, Supabase API (admin_proactive_settings table)
- **DB Tables / Models Used**: admin_proactive_settings, system_config
- **Compliance Notes**: AI automation governance; human-in-the-loop controls; automated decision-making transparency; opt-out mechanisms
- **Event Triggers**: proactive_settings_viewed, settings_updated, thresholds_changed, screen_id:ADMN-128
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminAIAssistantNavigation), Settings form components, admin_proactive_settings table
- **Notes**: Controls settings like minimum confidence score for auto-deployment (e.g., 0.85), maximum automations per day, notification channels, and AI suggestion frequency

---

## ADMN-129: Automation Builder

- **CanonicalId**: ADMN.00.129.A.ADM.PROD
- **Module**: Admin - Automation
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/automation/builder`
- **Internal/Admin Route (if any)**: `/admin/automation/builder`
- **Dev Route (current project path)**: src/pages/admin/automation/AutomationBuilder.tsx
- **Component Path**: src/pages/admin/automation/AutomationBuilder.tsx
- **UI Pattern**: Multi-step form builder
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Name/description form, Trigger selector, Condition builder, Action configurator, Enable/disable toggle, Save/deploy actions
- **Status**: ✅ Implemented
- **Purpose**: Interactive automation workflow builder; enables admins to create complex automation rules by selecting triggers, defining conditions, and configuring actions; supports loading from AI-discovered patterns or manual creation; validates rule configuration before deployment
- **Primary APIs Used**: Automation API, Supabase API (automation_rules table)
- **DB Tables / Models Used**: automation_rules, pattern_discoveries (for pre-fill), automation_executions
- **Compliance Notes**: Automation rule governance; impact assessment before deployment; rollback capabilities; audit trail of rule changes
- **Event Triggers**: automation_builder_viewed, rule_created, rule_saved, trigger_selected, condition_added, action_configured, screen_id:ADMN-129
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminAutomationNavigation), TriggerSelector, ConditionBuilder, ActionConfigurator components, useAutomationRules hook
- **Notes**: Supports pattern pre-fill via ?patternId query param; allows manual trigger/condition/action selection; validates rule logic before save

---

## ADMN-130: Community Events Moderation

- **CanonicalId**: ADMN.00.130.A.ADM.PROD
- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/community/events`
- **Internal/Admin Route (if any)**: `/admin/community/events`
- **Dev Route (current project path)**: src/pages/admin/community/Events.tsx
- **Component Path**: src/pages/admin/community/Events.tsx
- **UI Pattern**: data-table with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Pending events tab, Approved events tab, Flagged events tab, Event details, Approve/reject actions, Moderation notes
- **Status**: ✅ Implemented
- **Purpose**: Community event moderation dashboard; enables admins to review, approve, reject, and flag user-created events for content policy violations; tracks event status, moderation history, and provides real-time updates on new submissions
- **Primary APIs Used**: Community Events API, Moderation API, Supabase Realtime
- **DB Tables / Models Used**: global_community_events, event_attendees, content_reports, moderation_logs
- **Compliance Notes**: Content moderation policies; event safety verification; age-restricted event flagging; legal compliance (permits, insurance); user appeals process
- **Event Triggers**: events_moderation_viewed, event_approved, event_rejected, event_flagged, moderation_note_added, screen_id:ADMN-130
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminCommunityNavigation), Tabs, Table components, real-time subscriptions to global_community_events
- **Notes**: Real-time event moderation with tabs for pending, approved, and flagged events; supports bulk moderation actions

---

## ADMN-131: Community Groups Admin

- **CanonicalId**: ADMN.00.131.A.ADM.PROD
- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/community/groups`
- **Internal/Admin Route (if any)**: `/admin/community/groups`
- **Dev Route (current project path)**: src/pages/admin/community/Groups.tsx
- **Component Path**: src/pages/admin/community/Groups.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Groups list, Group details, Member management, Moderation actions, Group settings
- **Status**: ✅ Implemented
- **Purpose**: Community group oversight and management; enables admins to monitor all groups, review group activities, manage problematic groups, oversee group moderators, and take enforcement actions (warnings, suspensions, deletions) for policy violations
- **Primary APIs Used**: Groups API, Moderation API, Supabase Realtime
- **DB Tables / Models Used**: global_community_groups, group_members, group_posts, content_reports
- **Compliance Notes**: Group content moderation; hate speech monitoring; private group privacy; minor protection in groups; data retention for deleted groups
- **Event Triggers**: groups_admin_viewed, group_moderated, group_suspended, group_deleted, moderator_actioned, screen_id:ADMN-131
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminCommunityNavigation), DataTable, global_community_groups table
- **Notes**: Comprehensive group management including member counts, activity metrics, and moderation status

---

## ADMN-132: Reported Content

- **CanonicalId**: ADMN.00.132.A.ADM.PROD
- **Module**: Admin - Community Supervision
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/community/reported-content`
- **Internal/Admin Route (if any)**: `/admin/community/reported-content`
- **Dev Route (current project path)**: src/pages/admin/community/ReportedContent.tsx
- **Component Path**: src/pages/admin/community/ReportedContent.tsx
- **UI Pattern**: data-table with tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Pending reports tab, Reviewed reports tab, Report details, Content preview, Moderation actions (remove, warn, ban), Reporter info, Resolution notes
- **Status**: ✅ Implemented
- **Purpose**: Centralized user-generated content report management; enables admins to review flagged posts, comments, profiles, and media; take appropriate moderation actions; track report resolution; and manage appeals; provides quick access to reported content context and user history
- **Primary APIs Used**: Reports API, Moderation API, Content API, Supabase Realtime
- **DB Tables / Models Used**: content_reports, distribution_posts, live_chat_messages, profiles, moderation_actions
- **Compliance Notes**: Content moderation response times; user privacy in reports; reporter anonymity; appeal rights; DMCA takedown procedures; harmful content documentation
- **Event Triggers**: reported_content_viewed, report_reviewed, content_removed, user_warned, user_banned, appeal_submitted, screen_id:ADMN-132
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminCommunityNavigation), Tabs, Table components, content_reports table, real-time subscriptions
- **Notes**: Handles reports across all content types (posts, comments, profiles, live streams, events, groups); supports bulk moderation and priority flagging

---

## ADMN-133: Media Analytics

- **CanonicalId**: ADMN.00.133.A.ADM.PROD
- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/media/analytics`
- **Internal/Admin Route (if any)**: `/admin/media/analytics`
- **Dev Route (current project path)**: src/pages/admin/media/Analytics.tsx
- **Component Path**: src/pages/admin/media/Analytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Storage usage metrics, Content type breakdown, Upload trends, Popular content, Engagement analytics, Cost analysis
- **Status**: ✅ Implemented
- **Purpose**: Comprehensive media library analytics dashboard; provides insights into storage usage, content distribution, upload patterns, popular content, user engagement with media, and storage costs; enables data-driven decisions for media management and CDN optimization
- **Primary APIs Used**: Storage API, Analytics API, Supabase Storage API
- **DB Tables / Models Used**: Supabase Storage buckets, media_uploads, media_views, media_engagement
- **Compliance Notes**: Storage quota monitoring; cost optimization; content distribution policies; bandwidth usage tracking
- **Event Triggers**: media_analytics_viewed, storage_analyzed, usage_report_generated, screen_id:ADMN-133
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminMediaNavigation), Recharts, Supabase Storage API
- **Notes**: Tracks metrics like total storage used, uploads per day, top content by views, media type distribution (video/audio/image), and storage costs

---

## ADMN-134: Music Management

- **CanonicalId**: ADMN.00.134.A.ADM.PROD
- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/media/music`
- **Internal/Admin Route (if any)**: `/admin/media/music`
- **Dev Route (current project path)**: src/pages/admin/media/Music.tsx
- **Component Path**: src/pages/admin/media/Music.tsx
- **UI Pattern**: data-table with player
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Music library list, Upload music, Edit metadata, Audio player, Moderation status, License verification
- **Status**: ✅ Implemented
- **Purpose**: Music content library management; enables admins to manage music uploads, verify licensing, edit metadata (title, artist, album, genre), moderate content for copyright violations, and organize music for platform use (meditation, workout playlists, ambient soundscapes)
- **Primary APIs Used**: Storage API, Media processing APIs, Licensing verification APIs
- **DB Tables / Models Used**: media_uploads (media_type='audio'), audio_metadata, music_licenses
- **Compliance Notes**: Music licensing compliance; DMCA takedown process; copyright verification; royalty tracking; content ID matching
- **Event Triggers**: music_management_viewed, music_uploaded, music_moderated, license_verified, music_deleted, screen_id:ADMN-134
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminMediaNavigation), DataTable, Audio player, Supabase Storage
- **Notes**: Manages platform music library including user uploads and licensed content; supports metadata editing, quality checks, and copyright verification

---

## ADMN-135: Podcasts Management

- **CanonicalId**: ADMN.00.135.A.ADM.PROD
- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/media/podcasts`
- **Internal/Admin Route (if any)**: `/admin/media/podcasts`
- **Dev Route (current project path)**: src/pages/admin/media/Podcasts.tsx
- **Component Path**: src/pages/admin/media/Podcasts.tsx
- **UI Pattern**: data-table with player
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Podcast list, Episode management, Upload podcast, Edit metadata, Audio player, Show notes editor, Moderation status
- **Status**: ✅ Implemented
- **Purpose**: Podcast content library management; enables admins to manage podcast shows, episodes, edit metadata (title, description, show notes, categories), moderate content, organize episodes into seasons, and distribute to podcast platforms (RSS feed generation)
- **Primary APIs Used**: Storage API, Media processing APIs, RSS generation APIs
- **DB Tables / Models Used**: media_uploads (media_type='podcast'), podcast_metadata, podcast_episodes, podcast_shows
- **Compliance Notes**: Podcast content moderation; copyright for intro music; show notes accuracy; RSS feed compliance; content warnings
- **Event Triggers**: podcasts_management_viewed, podcast_uploaded, episode_published, metadata_updated, podcast_deleted, screen_id:ADMN-135
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminMediaNavigation), DataTable, Audio player, Rich text editor for show notes
- **Notes**: Manages platform podcast library including wellness podcasts, health talks, and meditation guides; supports episode organization and RSS feed generation

---

## ADMN-136: Videos Management

- **CanonicalId**: ADMN.00.136.A.ADM.PROD
- **Module**: Admin - Media Management
- **Portal(s)**: All
- **Roles with access**: Admin
- **External Route (client URL)**: `/admin/media/videos`
- **Internal/Admin Route (if any)**: `/admin/media/videos`
- **Dev Route (current project path)**: src/pages/admin/media/Videos.tsx
- **Component Path**: src/pages/admin/media/Videos.tsx
- **UI Pattern**: data-table with video player
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Video library list, Upload video, Edit metadata, Video player, Thumbnail editor, Moderation status, Transcoding status, Quality presets
- **Status**: ✅ Implemented
- **Purpose**: Video content library management; enables admins to manage video uploads, moderate content, edit metadata (title, description, tags, thumbnails), monitor transcoding status, organize into playlists, and configure quality/streaming settings
- **Primary APIs Used**: Storage API, Video transcoding APIs, CDN APIs, Supabase Storage
- **DB Tables / Models Used**: media_uploads (media_type='video'), video_metadata, video_processing_jobs
- **Compliance Notes**: Video content moderation; copyright verification; age-restricted content flagging; DMCA compliance; transcoding privacy; storage quotas
- **Event Triggers**: videos_management_viewed, video_uploaded, video_moderated, video_approved, video_deleted, transcoding_completed, screen_id:ADMN-136
- **Dependencies**: AuthProvider, AdminHeader, SubNavigation (adminMediaNavigation), DataTable, Video player, useQuery for fetching videos and profiles, Supabase Storage
- **Notes**: Manages platform video library including fitness classes, meditation videos, health education content; supports status filtering (pending, approved, rejected, processing), search, and bulk actions; displays uploader info, views, likes, duration, and processing status

---

# DEV HUB SCREENS

---

## DEV-001: Dev Hub Dashboard

- **Module**: Dev Hub
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev`
- **Internal/Admin Route (if any)**: `/dev`
- **Dev Route (current project path)**: src/routes/dev/index.tsx
- **Component Path**: src/routes/dev/index.tsx
- **UI Pattern**: 3-card-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Command, Agents, Pipelines navigation cards
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev Hub main dashboard

---

## DEV-002: Dev Login

- **Module**: Dev Hub
- **Portal(s)**: Dev Hub only
- **Roles with access**: Public (dev credentials)
- **External Route (client URL)**: `/dev/login`
- **Internal/Admin Route (if any)**: `/dev/login`
- **Dev Route (current project path)**: src/routes/dev/login.tsx
- **Component Path**: src/routes/dev/login.tsx
- **UI Pattern**: Auth screen
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Login form
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev Hub authentication

---

## DEV-003: Dev Dashboard (Overview)

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard`
- **Internal/Admin Route (if any)**: `/dev/dashboard`
- **Dev Route (current project path)**: src/routes/dev/dashboard/index.tsx
- **Component Path**: src/routes/dev/dashboard/index.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: System metrics, Quick links
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev overview dashboard

---

## DEV-004: Dev Analytics

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard/analytics`
- **Internal/Admin Route (if any)**: `/dev/dashboard/analytics`
- **Dev Route (current project path)**: src/routes/dev/dashboard/analytics.tsx
- **Component Path**: src/routes/dev/dashboard/analytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Performance metrics, Usage stats
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev analytics dashboard

---

## DEV-005: Dev Health

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard/health`
- **Internal/Admin Route (if any)**: `/dev/dashboard/health`
- **Dev Route (current project path)**: src/routes/dev/dashboard/health.tsx
- **Component Path**: src/routes/dev/dashboard/health.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Health checks, Status indicators
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System health monitoring

---

## DEV-006: Dev Logs

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard/logs`
- **Internal/Admin Route (if any)**: `/dev/dashboard/logs`
- **Dev Route (current project path)**: src/routes/dev/dashboard/logs.tsx
- **Component Path**: src/routes/dev/dashboard/logs.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Log entries, Filters
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System log viewer

---

## DEV-010: Command Center

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command`
- **Internal/Admin Route (if any)**: `/dev/command`
- **Dev Route (current project path)**: src/routes/dev/command/index.tsx
- **Component Path**: src/routes/dev/command/index.tsx
- **UI Pattern**: Command interface
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Command input, Output console
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev command center

---

## DEV-011: Terminal

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/terminal`
- **Internal/Admin Route (if any)**: `/dev/command/terminal`
- **Dev Route (current project path)**: src/routes/dev/command/terminal.tsx
- **Component Path**: src/routes/dev/command/terminal.tsx
- **UI Pattern**: Terminal interface
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Terminal emulator
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev terminal

---

## DEV-012: Scripts

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/scripts`
- **Internal/Admin Route (if any)**: `/dev/command/scripts`
- **Dev Route (current project path)**: src/routes/dev/command/scripts.tsx
- **Component Path**: src/routes/dev/command/scripts.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Script list, Run script, Edit script
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Script management

---

## DEV-013: Cron Jobs

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/cron`
- **Internal/Admin Route (if any)**: `/dev/command/cron`
- **Dev Route (current project path)**: src/routes/dev/command/cron.tsx
- **Component Path**: src/routes/dev/command/cron.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Cron list, Create job, Edit schedule
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Cron job management

---

## DEV-014: Webhooks

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/webhooks`
- **Internal/Admin Route (if any)**: `/dev/command/webhooks`
- **Dev Route (current project path)**: src/routes/dev/command/webhooks.tsx
- **Component Path**: src/routes/dev/command/webhooks.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Webhook list, Create webhook, Test
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Webhook configuration

---

## DEV-015: Tasks

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/tasks`
- **Internal/Admin Route (if any)**: `/dev/command/tasks`
- **Dev Route (current project path)**: src/routes/dev/command/tasks.tsx
- **Component Path**: src/routes/dev/command/tasks.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Task queue, Task detail, Retry
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Background task management

---

## DEV-020: Agents

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents`
- **Internal/Admin Route (if any)**: `/dev/agents`
- **Dev Route (current project path)**: src/routes/dev/agents/index.tsx
- **Component Path**: src/routes/dev/agents/index.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Agent list, Agent detail
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI agent management

---

## DEV-021: Agent Monitor

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/monitor`
- **Internal/Admin Route (if any)**: `/dev/agents/monitor`
- **Dev Route (current project path)**: src/routes/dev/agents/monitor.tsx
- **Component Path**: src/routes/dev/agents/monitor.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Real-time agent activity
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Agent monitoring dashboard

---

## DEV-022: Agent Logs

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/logs`
- **Internal/Admin Route (if any)**: `/dev/agents/logs`
- **Dev Route (current project path)**: src/routes/dev/agents/logs.tsx
- **Component Path**: src/routes/dev/agents/logs.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Log entries, Filters
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Agent execution logs

---

## DEV-023: Agent Config

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/config`
- **Internal/Admin Route (if any)**: `/dev/agents/config`
- **Dev Route (current project path)**: src/routes/dev/agents/config.tsx
- **Component Path**: src/routes/dev/agents/config.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Configuration editor
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Agent configuration

---

## DEV-024: Agent Crew

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/crew`
- **Internal/Admin Route (if any)**: `/dev/agents/crew`
- **Dev Route (current project path)**: src/routes/dev/agents/crew.tsx
- **Component Path**: src/routes/dev/agents/crew.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Crew list, Create crew, Agent assignment
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: CrewAI crew management

---

## DEV-030: Pipelines

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines`
- **Internal/Admin Route (if any)**: `/dev/pipelines`
- **Dev Route (current project path)**: src/routes/dev/pipelines/index.tsx
- **Component Path**: src/routes/dev/pipelines/index.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Pipeline list, Create pipeline
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Data pipeline management

---

## DEV-031: Pipeline Builder

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines/builder`
- **Internal/Admin Route (if any)**: `/dev/pipelines/builder`
- **Dev Route (current project path)**: src/routes/dev/pipelines/builder.tsx
- **Component Path**: src/routes/dev/pipelines/builder.tsx
- **UI Pattern**: Visual builder
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Drag-and-drop interface, Node config
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Visual pipeline builder

---

## DEV-032: Pipeline Runs

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines/runs`
- **Internal/Admin Route (if any)**: `/dev/pipelines/runs`
- **Dev Route (current project path)**: src/routes/dev/pipelines/runs.tsx
- **Component Path**: src/routes/dev/pipelines/runs.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Run history, Run detail, Retry
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Pipeline execution history

---

## DEV-033: Pipeline Monitor

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines/monitor`
- **Internal/Admin Route (if any)**: `/dev/pipelines/monitor`
- **Dev Route (current project path)**: src/routes/dev/pipelines/monitor.tsx
- **Component Path**: src/routes/dev/pipelines/monitor.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Active pipelines, Performance metrics
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Pipeline monitoring

---

## DEV-040: OASIS

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis`
- **Internal/Admin Route (if any)**: `/dev/oasis`
- **Dev Route (current project path)**: src/routes/dev/oasis/index.tsx
- **Component Path**: src/routes/dev/oasis/index.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: OASIS overview
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: OASIS system overview

---

## DEV-041: OASIS Events

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis/events`
- **Internal/Admin Route (if any)**: `/dev/oasis/events`
- **Dev Route (current project path)**: src/routes/dev/oasis/events.tsx
- **Component Path**: src/routes/dev/oasis/events.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Event list, Event detail, Filters
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: OASIS event log

---

## DEV-042: OASIS Projections

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis/projections`
- **Internal/Admin Route (if any)**: `/dev/oasis/projections`
- **Dev Route (current project path)**: src/routes/dev/oasis/projections.tsx
- **Component Path**: src/routes/dev/oasis/projections.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Projection list, Rebuild projection
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: OASIS projection management

---

## DEV-043: OASIS Config

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis/config`
- **Internal/Admin Route (if any)**: `/dev/oasis/config`
- **Dev Route (current project path)**: src/routes/dev/oasis/config.tsx
- **Component Path**: src/routes/dev/oasis/config.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Configuration editor
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: OASIS configuration

---

## DEV-050: VTID

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid`
- **Internal/Admin Route (if any)**: `/dev/vtid`
- **Dev Route (current project path)**: src/routes/dev/vtid/index.tsx
- **Component Path**: src/routes/dev/vtid/index.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: VTID overview
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VTID system overview

---

## DEV-051: VTID Explorer

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid/explorer`
- **Internal/Admin Route (if any)**: `/dev/vtid/explorer`
- **Dev Route (current project path)**: src/routes/dev/vtid/explorer.tsx
- **Component Path**: src/routes/dev/vtid/explorer.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: VTID search, VTID detail
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VTID exploration tool

---

## DEV-052: VTID Graph

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid/graph`
- **Internal/Admin Route (if any)**: `/dev/vtid/graph`
- **Dev Route (current project path)**: src/routes/dev/vtid/graph.tsx
- **Component Path**: src/routes/dev/vtid/graph.tsx
- **UI Pattern**: Graph visualization
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Relationship graph, Filters
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VTID relationship graph

---

## DEV-053: VTID Analytics

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid/analytics`
- **Internal/Admin Route (if any)**: `/dev/vtid/analytics`
- **Dev Route (current project path)**: src/routes/dev/vtid/analytics.tsx
- **Component Path**: src/routes/dev/vtid/analytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Usage metrics, Patterns
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VTID analytics

---

## DEV-060: Gateway

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway`
- **Internal/Admin Route (if any)**: `/dev/gateway`
- **Dev Route (current project path)**: src/routes/dev/gateway/index.tsx
- **Component Path**: src/routes/dev/gateway/index.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Gateway overview
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: API gateway management

---

## DEV-061: Gateway Routes

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway/routes`
- **Internal/Admin Route (if any)**: `/dev/gateway/routes`
- **Dev Route (current project path)**: src/routes/dev/gateway/routes.tsx
- **Component Path**: src/routes/dev/gateway/routes.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Route list, Create route, Edit route
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: API route configuration

---

## DEV-062: Gateway Monitor

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway/monitor`
- **Internal/Admin Route (if any)**: `/dev/gateway/monitor`
- **Dev Route (current project path)**: src/routes/dev/gateway/monitor.tsx
- **Component Path**: src/routes/dev/gateway/monitor.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Real-time traffic, Performance
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Gateway traffic monitoring

---

## DEV-063: Gateway Analytics

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway/analytics`
- **Internal/Admin Route (if any)**: `/dev/gateway/analytics`
- **Dev Route (current project path)**: src/routes/dev/gateway/analytics.tsx
- **Component Path**: src/routes/dev/gateway/analytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Usage stats, Performance metrics
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Gateway analytics

---

## DEV-070: CI/CD

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd`
- **Internal/Admin Route (if any)**: `/dev/cicd`
- **Dev Route (current project path)**: src/routes/dev/cicd/index.tsx
- **Component Path**: src/routes/dev/cicd/index.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: CI/CD overview
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: CI/CD pipeline overview

---

## DEV-071: CI/CD Pipelines

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd/pipelines`
- **Internal/Admin Route (if any)**: `/dev/cicd/pipelines`
- **Dev Route (current project path)**: src/routes/dev/cicd/pipelines.tsx
- **Component Path**: src/routes/dev/cicd/pipelines.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Pipeline list, Run pipeline
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: CI/CD pipeline management

---

## DEV-072: CI/CD Deployments

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd/deployments`
- **Internal/Admin Route (if any)**: `/dev/cicd/deployments`
- **Dev Route (current project path)**: src/routes/dev/cicd/deployments.tsx
- **Component Path**: src/routes/dev/cicd/deployments.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Deployment history, Rollback
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Deployment history

---

## DEV-073: CI/CD Config

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd/config`
- **Internal/Admin Route (if any)**: `/dev/cicd/config`
- **Dev Route (current project path)**: src/routes/dev/cicd/config.tsx
- **Component Path**: src/routes/dev/cicd/config.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Configuration editor
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: CI/CD configuration

---

## DEV-080: Observability

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability`
- **Internal/Admin Route (if any)**: `/dev/observability`
- **Dev Route (current project path)**: src/routes/dev/observability/index.tsx
- **Component Path**: src/routes/dev/observability/index.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Observability overview
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System observability dashboard

---

## DEV-081: Metrics

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability/metrics`
- **Internal/Admin Route (if any)**: `/dev/observability/metrics`
- **Dev Route (current project path)**: src/routes/dev/observability/metrics.tsx
- **Component Path**: src/routes/dev/observability/metrics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Custom metrics, Filters
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System metrics

---

## DEV-082: Traces

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability/traces`
- **Internal/Admin Route (if any)**: `/dev/observability/traces`
- **Dev Route (current project path)**: src/routes/dev/observability/traces.tsx
- **Component Path**: src/routes/dev/observability/traces.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Trace list, Trace detail, Spans
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Distributed tracing

---

## DEV-083: Alerts

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability/alerts`
- **Internal/Admin Route (if any)**: `/dev/observability/alerts`
- **Dev Route (current project path)**: src/routes/dev/observability/alerts.tsx
- **Component Path**: src/routes/dev/observability/alerts.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Alert rules, Alert history, Create alert
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Alert management

---

## DEV-090: Dev Settings

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings`
- **Internal/Admin Route (if any)**: `/dev/settings`
- **Dev Route (current project path)**: src/routes/dev/settings/index.tsx
- **Component Path**: src/routes/dev/settings/index.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Settings overview
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev Hub settings

---

## DEV-091: Feature Flags

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings/feature-flags`
- **Internal/Admin Route (if any)**: `/dev/settings/feature-flags`
- **Dev Route (current project path)**: src/routes/dev/settings/feature-flags.tsx
- **Component Path**: src/routes/dev/settings/feature-flags.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Flag list, Create flag, Toggle state
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Feature flag management

---

## DEV-092: Environment Variables

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings/env-vars`
- **Internal/Admin Route (if any)**: `/dev/settings/env-vars`
- **Dev Route (current project path)**: src/routes/dev/settings/env-vars.tsx
- **Component Path**: src/routes/dev/settings/env-vars.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Variable list, Add variable, Edit
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Environment variable management

---

## DEV-093: Secrets

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings/secrets`
- **Internal/Admin Route (if any)**: `/dev/settings/secrets`
- **Dev Route (current project path)**: src/routes/dev/settings/secrets.tsx
- **Component Path**: src/routes/dev/settings/secrets.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Secret list, Add secret, Rotate
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Secret management

---

## DEV-100: Documentation

- **Module**: Dev Hub - Docs
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/docs`
- **Internal/Admin Route (if any)**: `/dev/docs`
- **Dev Route (current project path)**: src/routes/dev/docs/index.tsx
- **Component Path**: src/routes/dev/docs/index.tsx
- **UI Pattern**: Documentation viewer
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Docs navigation, Search
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Dev documentation hub

---

## DEV-101: API Docs

- **Module**: Dev Hub - Docs
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/docs/api`
- **Internal/Admin Route (if any)**: `/dev/docs/api`
- **Dev Route (current project path)**: src/routes/dev/docs/api.tsx
- **Component Path**: src/routes/dev/docs/api.tsx
- **UI Pattern**: API documentation
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Endpoint list, Examples, Try it
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: API documentation

---

## DEV-102: Schema Docs

- **Module**: Dev Hub - Docs
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/docs/schema`
- **Internal/Admin Route (if any)**: `/dev/docs/schema`
- **Dev Route (current project path)**: src/routes/dev/docs/schema.tsx
- **Component Path**: src/routes/dev/docs/schema.tsx
- **UI Pattern**: Schema viewer
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Table list, Field details, Relationships
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Database schema documentation

---

## DEV-103: Architecture Docs

- **Module**: Dev Hub - Docs
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/docs/architecture`
- **Internal/Admin Route (if any)**: `/dev/docs/architecture`
- **Dev Route (current project path)**: src/routes/dev/docs/architecture.tsx
- **Component Path**: src/routes/dev/docs/architecture.tsx
- **UI Pattern**: Documentation viewer
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Architecture diagrams, Design docs
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System architecture documentation

---

## DEV-104: Changelog

- **Module**: Dev Hub - Docs
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/docs/changelog`
- **Internal/Admin Route (if any)**: `/dev/docs/changelog`
- **Dev Route (current project path)**: src/routes/dev/docs/changelog.tsx
- **Component Path**: src/routes/dev/docs/changelog.tsx
- **UI Pattern**: Documentation viewer
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Version list, Change details
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: System changelog

---

## DEV-105: Dev Login

- **Module**: Dev Hub - Authentication
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/login`
- **Internal/Admin Route (if any)**: `/dev/login`
- **Dev Route (current project path)**: src/pages/dev/DevLogin.tsx
- **Component Path**: src/pages/dev/DevLogin.tsx
- **UI Pattern**: Authentication form
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Login form, Auth providers
- **Status**: ✅ Implemented
- **Purpose**: Dev Hub authentication and access control
- **Primary APIs Used**: Supabase Auth
- **DB Tables / Models Used**: auth.users
- **Compliance Notes**: Dev-only access, admin role required
- **Event Triggers**: dev_login_attempt, dev_login_success, dev_login_failure
- **Dependencies**: AuthProvider, DevAuthGuard
- **Notes**: Secure authentication gateway for Dev Hub

---

## DEV-106: Crew Template

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/crew-template`
- **Internal/Admin Route (if any)**: `/dev/agents/crew-template`
- **Dev Route (current project path)**: src/pages/dev/agents/CrewTemplate.tsx
- **Component Path**: src/pages/dev/agents/CrewTemplate.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Template editor, Agent assignment
- **Status**: ✅ Implemented
- **Purpose**: CrewAI template management for multi-agent workflows
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: crew_memory
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Template configuration for CrewAI agent crews

---

## DEV-107: QA Test

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/qa-test`
- **Internal/Admin Route (if any)**: `/dev/agents/qa-test`
- **Dev Route (current project path)**: src/pages/dev/agents/QATest.tsx
- **Component Path**: src/pages/dev/agents/QATest.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Test runner, Test results
- **Status**: ✅ Implemented
- **Purpose**: QA testing interface for agent workflows
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: crewai_test
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Quality assurance testing for AI agents

---

## DEV-108: Agent Validator

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/validator`
- **Internal/Admin Route (if any)**: `/dev/agents/validator`
- **Dev Route (current project path)**: src/pages/dev/agents/Validator.tsx
- **Component Path**: src/pages/dev/agents/Validator.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Validation rules, Test results
- **Status**: ✅ Implemented
- **Purpose**: Agent output validation and quality assurance
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Validates agent responses and behavior

---

## DEV-109: Agent Worker

- **Module**: Dev Hub - Agents
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/agents/worker`
- **Internal/Admin Route (if any)**: `/dev/agents/worker`
- **Dev Route (current project path)**: src/pages/dev/agents/Worker.tsx
- **Component Path**: src/pages/dev/agents/Worker.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Worker status, Task queue
- **Status**: ✅ Implemented
- **Purpose**: Background worker management for agent tasks
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Manages background agent task execution

---

## DEV-110: CI/CD Artifacts

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd/artifacts`
- **Internal/Admin Route (if any)**: `/dev/cicd/artifacts`
- **Dev Route (current project path)**: src/pages/dev/cicd/Artifacts.tsx
- **Component Path**: src/pages/dev/cicd/Artifacts.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Artifact list, Download, Version history
- **Status**: ✅ Implemented
- **Purpose**: Build artifact management and version tracking
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: CI/CD build artifact storage and retrieval

---

## DEV-111: CI/CD Matrix

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd/matrix`
- **Internal/Admin Route (if any)**: `/dev/cicd/matrix`
- **Dev Route (current project path)**: src/pages/dev/cicd/Matrix.tsx
- **Component Path**: src/pages/dev/cicd/Matrix.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Test matrix, Configuration
- **Status**: ✅ Implemented
- **Purpose**: Multi-environment test matrix configuration
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Test matrix for cross-platform builds

---

## DEV-112: CI/CD Runs

- **Module**: Dev Hub - CI/CD
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/cicd/runs`
- **Internal/Admin Route (if any)**: `/dev/cicd/runs`
- **Dev Route (current project path)**: src/pages/dev/cicd/Runs.tsx
- **Component Path**: src/pages/dev/cicd/Runs.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Run history, Run details, Logs
- **Status**: ✅ Implemented
- **Purpose**: CI/CD pipeline run history and execution tracking
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Pipeline execution history and status

---

## DEV-113: Command Approvals

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/approvals`
- **Internal/Admin Route (if any)**: `/dev/command/approvals`
- **Dev Route (current project path)**: src/pages/dev/command/Approvals.tsx
- **Component Path**: src/pages/dev/command/Approvals.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Pending approvals, Approve/Reject
- **Status**: ✅ Implemented
- **Purpose**: Command approval workflow for sensitive operations
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Approval system for high-risk commands

---

## DEV-114: Command Composer

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/compose`
- **Internal/Admin Route (if any)**: `/dev/command/compose`
- **Dev Route (current project path)**: src/pages/dev/command/Compose.tsx
- **Component Path**: src/pages/dev/command/Compose.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Command builder, Parameter editor
- **Status**: ✅ Implemented
- **Purpose**: Visual command composition and parameter configuration
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Interactive command builder interface

---

## DEV-115: Command History

- **Module**: Dev Hub - Command
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/command/history`
- **Internal/Admin Route (if any)**: `/dev/command/history`
- **Dev Route (current project path)**: src/pages/dev/command/History.tsx
- **Component Path**: src/pages/dev/command/History.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Command log, Replay, Filters
- **Status**: ✅ Implemented
- **Purpose**: Command execution history and audit trail
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: audit_events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Historical command log with replay capability

---

## DEV-116: Dashboard AI Feed

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard/ai-feed`
- **Internal/Admin Route (if any)**: `/dev/dashboard/ai-feed`
- **Dev Route (current project path)**: src/pages/dev/dashboard/AIFeed.tsx
- **Component Path**: src/pages/dev/dashboard/AIFeed.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: AI activity stream, Insights
- **Status**: ✅ Implemented
- **Purpose**: Real-time AI system activity feed and insights
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: ai_conversations, ai_messages
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Live feed of AI system activities

---

## DEV-117: Dashboard Alerts

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard/alerts`
- **Internal/Admin Route (if any)**: `/dev/dashboard/alerts`
- **Dev Route (current project path)**: src/pages/dev/dashboard/Alerts.tsx
- **Component Path**: src/pages/dev/dashboard/Alerts.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Alert list, Alert rules, Configuration
- **Status**: ✅ Implemented
- **Purpose**: System alert monitoring and management dashboard
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Central alert management interface

---

## DEV-118: Dashboard System Health

- **Module**: Dev Hub - Dashboard
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/dashboard/system-health`
- **Internal/Admin Route (if any)**: `/dev/dashboard/system-health`
- **Dev Route (current project path)**: src/pages/dev/dashboard/SystemHealth.tsx
- **Component Path**: src/pages/dev/dashboard/SystemHealth.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Health metrics, Service status
- **Status**: ✅ Implemented
- **Purpose**: Real-time system health monitoring and status dashboard
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Comprehensive system health overview

---

## DEV-119: Gateway Mobile Links

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway/mobile-links`
- **Internal/Admin Route (if any)**: `/dev/gateway/mobile-links`
- **Dev Route (current project path)**: src/pages/dev/gateway/MobileLinks.tsx
- **Component Path**: src/pages/dev/gateway/MobileLinks.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Deep link config, Test links
- **Status**: ✅ Implemented
- **Purpose**: Mobile deep linking configuration and testing
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Universal and deep link management

---

## DEV-120: Gateway Requests

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway/requests`
- **Internal/Admin Route (if any)**: `/dev/gateway/requests`
- **Dev Route (current project path)**: src/pages/dev/gateway/Requests.tsx
- **Component Path**: src/pages/dev/gateway/Requests.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Request log, Filters, Details
- **Status**: ✅ Implemented
- **Purpose**: API gateway request monitoring and debugging
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Live request tracking and analysis

---

## DEV-121: Gateway Webhooks

- **Module**: Dev Hub - Gateway
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/gateway/webhooks`
- **Internal/Admin Route (if any)**: `/dev/gateway/webhooks`
- **Dev Route (current project path)**: src/pages/dev/gateway/Webhooks.tsx
- **Component Path**: src/pages/dev/gateway/Webhooks.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Webhook config, Test, Logs
- **Status**: ✅ Implemented
- **Purpose**: Webhook management and monitoring
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Webhook configuration and testing

---

## DEV-122: OASIS Ledger

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis/ledger`
- **Internal/Admin Route (if any)**: `/dev/oasis/ledger`
- **Dev Route (current project path)**: src/pages/dev/oasis/Ledger.tsx
- **Component Path**: src/pages/dev/oasis/Ledger.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Event ledger, Filters, Export
- **Status**: ✅ Implemented
- **Purpose**: OASIS event ledger and transaction log
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Complete OASIS event sourcing ledger

---

## DEV-123: OASIS Policies

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis/policies`
- **Internal/Admin Route (if any)**: `/dev/oasis/policies`
- **Dev Route (current project path)**: src/pages/dev/oasis/Policies.tsx
- **Component Path**: src/pages/dev/oasis/Policies.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Policy list, Create policy, Edit
- **Status**: ✅ Implemented
- **Purpose**: OASIS event handling policy configuration
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Event processing policy management

---

## DEV-124: OASIS State

- **Module**: Dev Hub - OASIS
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/oasis/state`
- **Internal/Admin Route (if any)**: `/dev/oasis/state`
- **Dev Route (current project path)**: src/pages/dev/oasis/State.tsx
- **Component Path**: src/pages/dev/oasis/State.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: State viewer, State history
- **Status**: ✅ Implemented
- **Purpose**: OASIS system state inspection and time-travel debugging
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Current and historical state viewer

---

## DEV-125: Observability Costs

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability/costs`
- **Internal/Admin Route (if any)**: `/dev/observability/costs`
- **Dev Route (current project path)**: src/pages/dev/observability/Costs.tsx
- **Component Path**: src/pages/dev/observability/Costs.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Cost analysis, Budget alerts
- **Status**: ✅ Implemented
- **Purpose**: Infrastructure cost monitoring and optimization
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Real-time cost tracking and analysis

---

## DEV-126: Observability Metrics

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability/metrics`
- **Internal/Admin Route (if any)**: `/dev/observability/metrics`
- **Dev Route (current project path)**: src/pages/dev/observability/Metrics.tsx
- **Component Path**: src/pages/dev/observability/Metrics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Metric graphs, Custom queries
- **Status**: ✅ Implemented
- **Purpose**: System metrics visualization and analysis
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Custom metric dashboards

---

## DEV-127: Observability Traces

- **Module**: Dev Hub - Observability
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/observability/traces`
- **Internal/Admin Route (if any)**: `/dev/observability/traces`
- **Dev Route (current project path)**: src/pages/dev/observability/Traces.tsx
- **Component Path**: src/pages/dev/observability/Traces.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Trace timeline, Span details
- **Status**: ✅ Implemented
- **Purpose**: Distributed tracing and request flow visualization
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Request tracing across services

---

## DEV-128: Pipelines Canary

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines/canary`
- **Internal/Admin Route (if any)**: `/dev/pipelines/canary`
- **Dev Route (current project path)**: src/pages/dev/pipelines/Canary.tsx
- **Component Path**: src/pages/dev/pipelines/Canary.tsx
- **UI Pattern**: Dashboard
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Canary status, Rollout config
- **Status**: ✅ Implemented
- **Purpose**: Canary deployment monitoring and control
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Progressive canary deployment management

---

## DEV-129: Pipelines Rollbacks

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines/rollbacks`
- **Internal/Admin Route (if any)**: `/dev/pipelines/rollbacks`
- **Dev Route (current project path)**: src/pages/dev/pipelines/Rollbacks.tsx
- **Component Path**: src/pages/dev/pipelines/Rollbacks.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Rollback history, Rollback trigger
- **Status**: ✅ Implemented
- **Purpose**: Deployment rollback management and history
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Emergency rollback capabilities

---

## DEV-130: Pipelines Tests

- **Module**: Dev Hub - Pipelines
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/pipelines/tests`
- **Internal/Admin Route (if any)**: `/dev/pipelines/tests`
- **Dev Route (current project path)**: src/pages/dev/pipelines/Tests.tsx
- **Component Path**: src/pages/dev/pipelines/Tests.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Test results, Coverage, Failures
- **Status**: ✅ Implemented
- **Purpose**: Pipeline test execution and results tracking
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Automated test suite monitoring

---

## DEV-131: Settings Auth

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings/auth`
- **Internal/Admin Route (if any)**: `/dev/settings/auth`
- **Dev Route (current project path)**: src/pages/dev/settings/Auth.tsx
- **Component Path**: src/pages/dev/settings/Auth.tsx
- **UI Pattern**: sub-page-header
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Auth config, Providers, Keys
- **Status**: ✅ Implemented
- **Purpose**: Authentication system configuration and provider management
- **Primary APIs Used**: Supabase Auth
- **DB Tables / Models Used**: auth.users, agent_keys
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Auth provider and key management

---

## DEV-132: Settings Flags

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings/flags`
- **Internal/Admin Route (if any)**: `/dev/settings/flags`
- **Dev Route (current project path)**: src/pages/dev/settings/Flags.tsx
- **Component Path**: src/pages/dev/settings/Flags.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Flag list, Toggle, Conditions
- **Status**: ✅ Implemented
- **Purpose**: Feature flag management and A/B testing configuration
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Feature flag control panel

---

## DEV-133: Settings Tenants

- **Module**: Dev Hub - Settings
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/settings/tenants`
- **Internal/Admin Route (if any)**: `/dev/settings/tenants`
- **Dev Route (current project path)**: src/pages/dev/settings/Tenants.tsx
- **Component Path**: src/pages/dev/settings/Tenants.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Tenant list, Create tenant, Config
- **Status**: ✅ Implemented
- **Purpose**: Multi-tenant configuration and management
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: tenants
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Tenant isolation and configuration

---

## DEV-134: VTID Analytics

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid/analytics`
- **Internal/Admin Route (if any)**: `/dev/vtid/analytics`
- **Dev Route (current project path)**: src/pages/dev/vtid/Analytics.tsx
- **Component Path**: src/pages/dev/vtid/Analytics.tsx
- **UI Pattern**: Dashboard with charts
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Usage metrics, Patterns, Trends
- **Status**: ✅ Implemented
- **Purpose**: VTID usage analytics and pattern analysis
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VTID system analytics dashboard

---

## DEV-135: VTID Issue Tracker

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid/issue`
- **Internal/Admin Route (if any)**: `/dev/vtid/issue`
- **Dev Route (current project path)**: src/pages/dev/vtid/Issue.tsx
- **Component Path**: src/pages/dev/vtid/Issue.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Issue list, Issue detail, Resolution
- **Status**: ✅ Implemented
- **Purpose**: VTID-related issue tracking and debugging
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VTID issue management system

---

## DEV-136: VTID Search

- **Module**: Dev Hub - VTID
- **Portal(s)**: Dev Hub only
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: `/dev/vtid/search`
- **Internal/Admin Route (if any)**: `/dev/vtid/search`
- **Dev Route (current project path)**: src/pages/dev/vtid/Search.tsx
- **Component Path**: src/pages/dev/vtid/Search.tsx
- **UI Pattern**: data-table
- **Tenant Availability**: Global (Dev)
- **Subscreens / Tabs / Modals**: Search interface, Filters, Results
- **Status**: ✅ Implemented
- **Purpose**: Advanced VTID search and query interface
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Powerful VTID search capabilities

---

# GLOBAL OVERLAYS & COMPONENTS

---

## OVRL-001: VITANA Orb Overlay

- **Module**: Global - VITANA
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/vitanaland/VitanaAudioOverlay.tsx
- **Component Path**: src/components/vitanaland/VitanaAudioOverlay.tsx
- **UI Pattern**: orb-overlay (Full-screen voice interface)
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Voice listening, Voice output, Command suggestions, Text input (hidden by default)
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: VITANA voice-first AI assistant overlay; activated via Cmd/Ctrl+K or clicking mini orb in sidebar

---

## OVRL-002: Profile Preview Dialog

- **Module**: Global - Profiles
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/profile/ProfilePreviewDialog.tsx
- **Component Path**: src/components/profile/ProfilePreviewDialog.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Profile card preview, View full profile link
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Quick profile preview without losing context; triggered by clicking avatars with onPreview prop

---

## OVRL-003: Meetup Details Drawer

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/meetups/MeetupDetailsDrawer.tsx
- **Component Path**: src/components/meetups/MeetupDetailsDrawer.tsx
- **UI Pattern**: drawer
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Event details, RSVP, Share, Host info
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Meetup event details overlay

---

## OVRL-004: Event Details Drawer

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/events/EventDetailsDrawer.tsx (if exists)
- **Component Path**: src/components/events/EventDetailsDrawer.tsx
- **UI Pattern**: drawer
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Event info, Attendees, Register
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community event details overlay

---

## OVRL-005: Master Action Popup

- **Module**: Global - Actions
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/MasterActionPopup.tsx (if exists)
- **Component Path**: src/components/MasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Quick action selector
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Global quick action menu

---

## OVRL-006: Calendar Popup

- **Module**: Global - Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CalendarPopup.tsx (if exists)
- **Component Path**: src/components/CalendarPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Calendar view, Add event
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Quick calendar access popup

---

## OVRL-007: Wallet Popup

- **Module**: Global - Wallet
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/WalletPopup.tsx (if exists)
- **Component Path**: src/components/WalletPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Balance, Quick transfer
- **Status**: 🚧 Placeholder
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Quick wallet access popup

---

## OVRL-008: Presence Debug Panel

- **Module**: Dev - Utility
- **Portal(s)**: All (Dev mode only)
- **Roles with access**: Admin (Dev access)
- **External Route (client URL)**: N/A (Fixed component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/debug/PresenceDebugPanel.tsx
- **Component Path**: src/components/debug/PresenceDebugPanel.tsx
- **UI Pattern**: Fixed debug panel
- **Tenant Availability**: Global (Dev mode)
- **Subscreens / Tabs / Modals**: Presence info, Dismiss button
- **Status**: ✅ Implemented
- **Purpose**: TBD (pending functional review)
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: TBD (pending functional review)
- **Dependencies**: TBD (pending functional review)
- **Notes**: Real-time presence debugging; only visible in dev mode; can be dismissed

---

## OVRL-009: Call Manager

- **Module**: Global - Communication
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Global component)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CallManager.tsx
- **Component Path**: src/components/CallManager.tsx
- **UI Pattern**: Global call orchestration
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active call management, Call routing
- **Status**: ✅ Implemented
- **Purpose**: Central call management and routing system
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA compliance for medical calls
- **Event Triggers**: call_started, call_ended, call_transferred
- **Dependencies**: CallingScreen, IncomingCallModal
- **Notes**: Global call orchestration layer

---

## OVRL-010: Calling Screen

- **Module**: Global - Communication
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CallingScreen.tsx
- **Component Path**: src/components/CallingScreen.tsx
- **UI Pattern**: Full-screen overlay
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active call UI, Controls, Video grid
- **Status**: ✅ Implemented
- **Purpose**: Full-screen active call interface
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA compliance, recording consent
- **Event Triggers**: call_muted, call_video_toggled, call_ended
- **Dependencies**: CallManager
- **Notes**: Main call UI overlay

---

## OVRL-011: Incoming Call Modal

- **Module**: Global - Communication
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Modal)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/IncomingCallModal.tsx
- **Component Path**: src/components/IncomingCallModal.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Caller info, Accept/Decline
- **Status**: ✅ Implemented
- **Purpose**: Incoming call notification and response
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: call_accepted, call_declined, call_missed
- **Dependencies**: CallManager
- **Notes**: Call notification modal

---

## OVRL-012: Global Search

- **Module**: Global - Search
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/GlobalSearch.tsx
- **Component Path**: src/components/GlobalSearch.tsx
- **UI Pattern**: Command palette overlay
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Search input, Results, Quick actions
- **Status**: ✅ Implemented
- **Purpose**: Universal search and command palette
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: Multiple (searches across all entities)
- **Compliance Notes**: RLS enforcement on search results
- **Event Triggers**: search_performed, search_result_clicked
- **Dependencies**: TBD (pending functional review)
- **Notes**: Cmd/Ctrl+K triggered universal search

---

## OVRL-013: Notification Bell

- **Module**: Global - Notifications
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Popover)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/NotificationBell.tsx
- **Component Path**: src/components/NotificationBell.tsx
- **UI Pattern**: Popover dropdown
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Notification list, Mark read, Settings
- **Status**: ✅ Implemented
- **Purpose**: Real-time notification center
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: notification_viewed, notification_dismissed
- **Dependencies**: TBD (pending functional review)
- **Notes**: Global notification dropdown

---

## OVRL-014: Error Notification Stack

- **Module**: Global - Error Handling
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Fixed overlay)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ErrorNotificationStack.tsx
- **Component Path**: src/components/ErrorNotificationStack.tsx
- **UI Pattern**: Toast stack
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Error toasts
- **Status**: ✅ Implemented
- **Purpose**: Global error notification system
- **Primary APIs Used**: N/A
- **DB Tables / Models Used**: N/A
- **Compliance Notes**: No PII in error messages
- **Event Triggers**: error_displayed, error_dismissed
- **Dependencies**: TBD (pending functional review)
- **Notes**: Stacked error notifications

---

## OVRL-015: Onboarding Overlay

- **Module**: Global - Onboarding
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Overlay)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/OnboardingOverlay.tsx
- **Component Path**: src/components/OnboardingOverlay.tsx
- **UI Pattern**: Full-screen wizard
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Multi-step onboarding flow
- **Status**: ✅ Implemented
- **Purpose**: First-time user onboarding experience
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: profiles, user_preferences
- **Compliance Notes**: Consent collection, data privacy
- **Event Triggers**: onboarding_started, onboarding_completed, onboarding_skipped
- **Dependencies**: TBD (pending functional review)
- **Notes**: Multi-tenant onboarding wizard

---

## OVRL-016: Create Event Popup

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateEventPopup.tsx
- **Component Path**: src/components/CreateEventPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Event form, Date/time, Location
- **Status**: ✅ Implemented
- **Purpose**: Quick event creation dialog
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: global_community_events, event_attendees
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: event_created, event_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community event creation

---

## OVRL-017: Create Meetup Popup

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateMeetupPopup.tsx
- **Component Path**: src/components/CreateMeetupPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Meetup form, Settings, Privacy
- **Status**: ✅ Implemented
- **Purpose**: Quick meetup creation dialog
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: global_community_events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: meetup_created, meetup_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Meetup-specific event creation

---

## OVRL-018: Edit Meetup Popup

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/EditMeetupPopup.tsx
- **Component Path**: src/components/EditMeetupPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Edit form, Update settings
- **Status**: ✅ Implemented
- **Purpose**: Meetup editing interface
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: global_community_events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: meetup_updated, meetup_update_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Edit existing meetup details

---

## OVRL-019: Create Group Popup

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateGroupPopup.tsx
- **Component Path**: src/components/CreateGroupPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Group form, Privacy, Invites
- **Status**: ✅ Implemented
- **Purpose**: Community group creation dialog
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: group_created, group_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Create new community group

---

## OVRL-020: Create Live Room Dialog

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateLiveRoomDialog.tsx
- **Component Path**: src/components/CreateLiveRoomDialog.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Room settings, Privacy, Schedule
- **Status**: ✅ Implemented
- **Purpose**: Live room creation interface
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: community_live_streams
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: live_room_created, live_room_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Create live streaming room

---

## OVRL-021: Go Live Popup

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/GoLivePopup.tsx
- **Component Path**: src/components/GoLivePopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Stream setup, Preview, Go live
- **Status**: ✅ Implemented
- **Purpose**: Quick go-live interface
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: community_live_streams
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: stream_started, stream_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Instant live streaming launch

---

## OVRL-022: Create Content Popup

- **Module**: Sharing
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateContentPopup.tsx
- **Component Path**: src/components/CreateContentPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Content editor, Media, Tags
- **Status**: ✅ Implemented
- **Purpose**: Content creation and distribution dialog
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: distribution_posts
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: content_created, content_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Multi-channel content creation

---

## OVRL-023: Media Upload Popup

- **Module**: Global - Media
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/MediaUploadPopup.tsx
- **Component Path**: src/components/MediaUploadPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Upload interface, Progress, Preview
- **Status**: ✅ Implemented
- **Purpose**: Universal media upload interface
- **Primary APIs Used**: Supabase Storage
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: File size limits, virus scanning
- **Event Triggers**: media_uploaded, upload_failed
- **Dependencies**: TBD (pending functional review)
- **Notes**: Global media upload dialog

---

## OVRL-024: New Conversation Popup

- **Module**: Inbox
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/NewConversationPopup.tsx
- **Component Path**: src/components/NewConversationPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: User search, Message composer
- **Status**: ✅ Implemented
- **Purpose**: Start new message conversation
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: conversation_started, conversation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: New message dialog

---

## OVRL-025: New Ticket Popup

- **Module**: Staff
- **Portal(s)**: Staff, Admin
- **Roles with access**: Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/NewTicketPopup.tsx
- **Component Path**: src/components/NewTicketPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Ticket form, Priority, Assignment
- **Status**: ✅ Implemented
- **Purpose**: Support ticket creation
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: ticket_created, ticket_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Create support ticket

---

## OVRL-026: Master Action Popup

- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/MasterActionPopup.tsx
- **Component Path**: src/components/MasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Action selector, Quick actions
- **Status**: ✅ Implemented
- **Purpose**: Unified master action selector
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: action_selected, action_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Central action launcher

---

## OVRL-027: Health Master Action Popup

- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/HealthMasterActionPopup.tsx
- **Component Path**: src/components/HealthMasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Health actions, Quick log
- **Status**: ✅ Implemented
- **Purpose**: Health-specific master actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA compliance
- **Event Triggers**: health_action_selected
- **Dependencies**: MasterActionPopup
- **Notes**: Health module actions

---

## OVRL-028: Health Tracker Master Action Popup

- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/HealthTrackerMasterActionPopup.tsx
- **Component Path**: src/components/HealthTrackerMasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Tracker selection, Quick entry
- **Status**: ✅ Implemented
- **Purpose**: Health tracker-specific actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA compliance
- **Event Triggers**: tracker_action_selected
- **Dependencies**: MasterActionPopup
- **Notes**: Health tracker actions

---

## OVRL-029: Biomarkers Master Action Popup

- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/BiomarkersMasterActionPopup.tsx
- **Component Path**: src/components/BiomarkersMasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Biomarker actions, Quick log
- **Status**: ✅ Implemented
- **Purpose**: Biomarker-specific master actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA compliance, lab result handling
- **Event Triggers**: biomarker_action_selected
- **Dependencies**: MasterActionPopup
- **Notes**: Biomarker module actions

---

## OVRL-030: Education Master Action Popup

- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/EducationMasterActionPopup.tsx
- **Component Path**: src/components/EducationMasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Education actions, Content access
- **Status**: ✅ Implemented
- **Purpose**: Education-specific master actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: education_action_selected
- **Dependencies**: MasterActionPopup
- **Notes**: Education module actions

---

## OVRL-031: Services Master Action Popup

- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ServicesMasterActionPopup.tsx
- **Component Path**: src/components/ServicesMasterActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Service actions, Book/Browse
- **Status**: ✅ Implemented
- **Purpose**: Services-specific master actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: service_action_selected
- **Dependencies**: MasterActionPopup
- **Notes**: Services module actions

---

## OVRL-032: Manage My Actions Popup

- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ManageMyActionsPopup.tsx
- **Component Path**: src/components/ManageMyActionsPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Action list, Edit, Remove
- **Status**: ✅ Implemented
- **Purpose**: Manage user's custom actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: actions_managed, action_removed
- **Dependencies**: TBD (pending functional review)
- **Notes**: User action management

---

## OVRL-033: Autopilot Popup

- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/AutopilotPopup.tsx
- **Component Path**: src/components/AutopilotPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Autopilot config, Start/Stop
- **Status**: ✅ Implemented
- **Purpose**: AI autopilot configuration and control
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: autopilot_actions, automation_rules
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: autopilot_started, autopilot_stopped
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI autopilot launcher

---

## OVRL-034: Add to AI Feed Popup

- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/AddToAIFeedPopup.tsx
- **Component Path**: src/components/AddToAIFeedPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Item selection, Context notes
- **Status**: ✅ Implemented
- **Purpose**: Add items to AI feed for context
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: item_added_to_ai_feed
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI context enrichment

---

## OVRL-035: Enrich Context Popup

- **Module**: AI
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/EnrichContextPopup.tsx
- **Component Path**: src/components/EnrichContextPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Context editor, Data sources
- **Status**: ✅ Implemented
- **Purpose**: Enrich AI context with additional information
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: ai_memory
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: context_enriched
- **Dependencies**: TBD (pending functional review)
- **Notes**: AI context enhancement

---

## OVRL-036: Lab Test Order Popup

- **Module**: Health
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/LabTestOrderPopup.tsx
- **Component Path**: src/components/LabTestOrderPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Test selection, Order form, Payment
- **Status**: ✅ Implemented
- **Purpose**: Lab test ordering interface
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: HIPAA compliance, medical consent
- **Event Triggers**: lab_test_ordered, order_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Lab test ordering flow

---

## OVRL-037: Billing Action Popup

- **Module**: Wallet
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/BillingActionPopup.tsx
- **Component Path**: src/components/BillingActionPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Payment method, Amount, Confirm
- **Status**: ✅ Implemented
- **Purpose**: Billing and payment actions
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: PCI compliance
- **Event Triggers**: payment_initiated, payment_completed
- **Dependencies**: TBD (pending functional review)
- **Notes**: Payment processing dialog

---

## OVRL-038: Browse Services Popup

- **Module**: Discover
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/BrowseServicesPopup.tsx
- **Component Path**: src/components/BrowseServicesPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Service catalog, Filters, Details
- **Status**: ✅ Implemented
- **Purpose**: Service browsing and discovery
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: service_viewed, service_selected
- **Dependencies**: TBD (pending functional review)
- **Notes**: Service catalog browser

---

## OVRL-039: Create Service Popup

- **Module**: Professional
- **Portal(s)**: Professional, Staff, Admin
- **Roles with access**: Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateServicePopup.tsx
- **Component Path**: src/components/CreateServicePopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Service form, Pricing, Availability
- **Status**: ✅ Implemented
- **Purpose**: Professional service creation
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: service_created, service_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Create professional service

---

## OVRL-040: Create Package Popup

- **Module**: Professional
- **Portal(s)**: Professional, Staff, Admin
- **Roles with access**: Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreatePackagePopup.tsx
- **Component Path**: src/components/CreatePackagePopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Package builder, Services, Pricing
- **Status**: ✅ Implemented
- **Purpose**: Service package creation
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: package_created, package_creation_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Bundle services into packages

---

## OVRL-041: Smart Package Popup

- **Module**: Professional
- **Portal(s)**: Professional, Staff, Admin
- **Roles with access**: Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/SmartPackagePopup.tsx
- **Component Path**: src/components/SmartPackagePopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: AI suggestions, Package config
- **Status**: ✅ Implemented
- **Purpose**: AI-powered package creation
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: smart_package_created
- **Dependencies**: CreatePackagePopup
- **Notes**: AI-assisted package builder

---

## OVRL-042: Create Business Event Popup

- **Module**: Professional
- **Portal(s)**: Professional, Staff, Admin
- **Roles with access**: Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateBusinessEventPopup.tsx
- **Component Path**: src/components/CreateBusinessEventPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Event form, Business settings
- **Status**: ✅ Implemented
- **Purpose**: Business-oriented event creation
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: global_community_events
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: business_event_created
- **Dependencies**: CreateEventPopup
- **Notes**: Professional event creation

---

## OVRL-043: Consent Package Popup

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ConsentPackagePopup.tsx
- **Component Path**: src/components/ConsentPackagePopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Consent viewer, Agree/Decline
- **Status**: ✅ Implemented
- **Purpose**: Display and collect user consent
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: Legal consent tracking, GDPR/HIPAA
- **Event Triggers**: consent_given, consent_declined
- **Dependencies**: TBD (pending functional review)
- **Notes**: Consent management dialog

---

## OVRL-044: Manage Consent Popup

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ManageConsentPopup.tsx
- **Component Path**: src/components/ManageConsentPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Consent list, Revoke, History
- **Status**: ✅ Implemented
- **Purpose**: Manage user consent preferences
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: TBD (pending functional review)
- **Compliance Notes**: GDPR right to withdraw consent
- **Event Triggers**: consent_revoked, consent_history_viewed
- **Dependencies**: TBD (pending functional review)
- **Notes**: User consent management

---

## OVRL-045: Privacy Audit Popup

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/PrivacyAuditPopup.tsx
- **Component Path**: src/components/PrivacyAuditPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Privacy audit, Data access log
- **Status**: ✅ Implemented
- **Purpose**: Privacy audit and data access review
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: audit_events
- **Compliance Notes**: GDPR right to access
- **Event Triggers**: privacy_audit_viewed
- **Dependencies**: TBD (pending functional review)
- **Notes**: User privacy audit tool

---

## OVRL-046: Quick Setup Popup

- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/QuickSetupPopup.tsx
- **Component Path**: src/components/QuickSetupPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Setup wizard, Quick actions
- **Status**: ✅ Implemented
- **Purpose**: Quick account setup and configuration
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: profiles, user_preferences
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: setup_completed, setup_skipped
- **Dependencies**: TBD (pending functional review)
- **Notes**: Fast-track setup wizard

---

## OVRL-047: Reset Defaults Popup

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ResetDefaultsPopup.tsx
- **Component Path**: src/components/ResetDefaultsPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Confirmation, Reset options
- **Status**: ✅ Implemented
- **Purpose**: Reset settings to default values
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: user_preferences
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: settings_reset, reset_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Settings reset dialog

---

## OVRL-048: Connect App Popup

- **Module**: Settings
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ConnectAppPopup.tsx
- **Component Path**: src/components/ConnectAppPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: App list, OAuth flow
- **Status**: ✅ Implemented
- **Purpose**: Third-party app integration
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: api_integrations
- **Compliance Notes**: OAuth security, data sharing consent
- **Event Triggers**: app_connected, app_connection_cancelled
- **Dependencies**: TBD (pending functional review)
- **Notes**: Third-party app connector

---

## OVRL-049: View Details Popup

- **Module**: Global - Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/ViewDetailsPopup.tsx
- **Component Path**: src/components/ViewDetailsPopup.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Detail view, Actions
- **Status**: ✅ Implemented
- **Purpose**: Generic detail viewer for various entities
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: Multiple (context-dependent)
- **Compliance Notes**: RLS enforcement
- **Event Triggers**: details_viewed
- **Dependencies**: TBD (pending functional review)
- **Notes**: Universal detail viewer

---

## OVRL-050: Community Filters Popup

- **Module**: Community
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Popover)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CommunityFiltersPopup.tsx
- **Component Path**: src/components/CommunityFiltersPopup.tsx
- **UI Pattern**: Popover dropdown
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Filter options, Apply
- **Status**: ✅ Implemented
- **Purpose**: Community content filtering
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: N/A (client-side filtering)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: filters_applied
- **Dependencies**: TBD (pending functional review)
- **Notes**: Community filter controls

---

## OVRL-051: Business Filters Popup

- **Module**: Professional
- **Portal(s)**: Professional, Staff, Admin
- **Roles with access**: Professional, Staff, Admin
- **External Route (client URL)**: N/A (Popover)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/BusinessFiltersPopup.tsx
- **Component Path**: src/components/BusinessFiltersPopup.tsx
- **UI Pattern**: Popover dropdown
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Filter options, Apply
- **Status**: ✅ Implemented
- **Purpose**: Business/professional content filtering
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: N/A (client-side filtering)
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: filters_applied
- **Dependencies**: TBD (pending functional review)
- **Notes**: Professional filter controls

---

## OVRL-052: Match Filters Popup

- **Module**: Home
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Popover)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/MatchFiltersPopup.tsx
- **Component Path**: src/components/MatchFiltersPopup.tsx
- **UI Pattern**: Popover dropdown
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Filter options, Preferences
- **Status**: ✅ Implemented
- **Purpose**: Match filtering and preferences
- **Primary APIs Used**: TBD (pending functional review)
- **DB Tables / Models Used**: user_preferences
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: match_filters_applied
- **Dependencies**: TBD (pending functional review)
- **Notes**: Match filter controls

---

## OVRL-053: Create Selection Dialog

- **Module**: Global - Utility
- **Portal(s)**: All
- **Roles with access**: Community, Patient, Professional, Staff, Admin
- **External Route (client URL)**: N/A (Dialog)
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/CreateSelectionDialog.tsx
- **Component Path**: src/components/CreateSelectionDialog.tsx
- **UI Pattern**: dialog
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Creation type selector
- **Status**: ✅ Implemented
- **Purpose**: Universal creation type selection
- **Primary APIs Used**: N/A
- **DB Tables / Models Used**: N/A
- **Compliance Notes**: TBD (pending functional review)
- **Event Triggers**: creation_type_selected
- **Dependencies**: Various create dialogs
- **Notes**: Master creation type selector

---

# Cross-Reference Tables

---

## Route to Screen ID Quick Reference

| Route | Screen ID | Screen Name |
|-------|-----------|-------------|
| `/` | AUTH-001 | Landing Page |
| `/auth` | AUTH-002 | Generic Auth |
| `/maxina` | AUTH-003 | Maxina Portal Login |
| `/alkalma` | AUTH-004 | Alkalma Portal Login |
| `/earthlinks` | AUTH-005 | Earthlinks Portal Login |
| `/community` | AUTH-006 | Community Portal Login |
| `/exafy-admin` | AUTH-007 | Exafy Admin Portal Login |
| `/_intro/:tenantSlug` | AUTH-008 | Intro Experience |
| `/home` | HOME-001 | Home Overview |
| `/home/context` | HOME-002 | Context |
| `/home/actions` | HOME-003 | Actions |
| `/home/matches` | HOME-004 | Matches |
| `/home/aifeed` | HOME-005 | AI Feed |
| `/community` | COMM-001 | Community Overview |
| `/community/events` | COMM-002 | Events & Meetups |
| `/community/live-rooms` | COMM-003 | Live Rooms |
| `/community/media-hub` | COMM-004 | Media Hub |
| `/community/my-business` | COMM-005 | My Business |
| `/discover` | DISC-001 | Discover Overview |
| `/discover/supplements` | DISC-002 | Supplements |
| `/health` | HLTH-001 | Health Overview |
| `/health/biomarkers` | HLTH-003 | My Biology |
| `/inbox` | INBX-001 | Inbox Overview |
| `/ai` | AI-001 | AI Overview |
| `/wallet` | WLLT-001 | Wallet Overview |
| `/sharing` | SHAR-001 | Sharing Overview |
| `/sharing/campaigns` | SHAR-002 | Campaigns |
| `/memory` | MEMO-001 | Memory Overview |
| `/memory/diary` | MEMO-003 | Diary |
| `/settings` | SETT-001 | Settings Overview |
| `/patient` | PTNT-001 | Patient Dashboard |
| `/professional` | PROF-001 | Professional Dashboard |
| `/staff` | STFF-001 | Staff Dashboard |
| `/admin` | ADMN-001 | Admin Dashboard |
| `/admin/tenant-management` | ADMN-020 | Tenant Management |
| `/admin/notification-dashboard` | ADMN-051 | Notification Dashboard |
| `/dev` | DEV-001 | Dev Hub Dashboard |
| `/dev/login` | DEV-002 | Dev Login |

---

# BUSINESS HUB SCREENS

The Business Hub is a first-class sidebar category providing unified business performance, earnings, services management, and reseller capabilities.

**Screen Count**: 5 parent screens (tabs are subroutes, not separate screens per VITANA registry policy)

---

## BIZ-001: Business Hub Overview

- **CanonicalId**: BIZ.00.001.A.COMM.CLI
- **Module**: Business Hub
- **Portal(s)**: All
- **Roles with access**: Community, Professional, Staff, Admin
- **External Route (client URL)**: `/business`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/pages/BusinessHub.tsx
- **Component Path**: src/pages/BusinessHub.tsx
- **UI Pattern**: sub-page-header with split-bar tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Snapshot (`?tab=snapshot`), History (`?tab=history`)
- **Status**: ✅ Implemented
- **Purpose**: Unified business performance dashboard consolidating earnings, KPIs, and transaction history
- **Primary APIs Used**: useUnifiedEarnings, wallet APIs
- **DB Tables / Models Used**: wallet_transactions, reseller_attributions, reseller_payouts
- **Compliance Notes**: Financial data display; earnings must reconcile with wallet
- **Event Triggers**: business_hub_viewed, kpi_card_clicked, tab_changed
- **Dependencies**: UnifiedEarningsKPIStrip, BusinessAcceleratorCenterCTA, EarningsHistoryLedger
- **Autopilot Eligibility**: Yes (A1-A2)
- **Notes**: Primary entry point; Snapshot shows KPIs, History shows transaction ledger

---

## BIZ-002: Business Services

- **CanonicalId**: BIZ.00.002.A.COMM.CLI
- **Module**: Business Hub
- **Portal(s)**: All
- **Roles with access**: Community, Professional, Staff, Admin
- **External Route (client URL)**: `/business/services`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/business/ServicesSubTabs.tsx
- **Component Path**: src/components/business/ServicesSubTabs.tsx
- **UI Pattern**: sub-page-header with split-bar tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: My Services (`?tab=services`), My Events (`?tab=events`), Packages (`?tab=packages`)
- **Status**: ✅ Implemented
- **Purpose**: Manage business services, events, and packages
- **Primary APIs Used**: useBusinessPackages, useUserEvents
- **DB Tables / Models Used**: business_packages, package_items, global_community_events
- **Compliance Notes**: Service creation subject to tenant policies
- **Event Triggers**: services_tab_viewed, service_created, package_created
- **Dependencies**: CreatePackageDialog, EditPackageDialog, PackageCard, OrganizerEventsSection
- **Autopilot Eligibility**: Yes (A2-A3)
- **Notes**: Primary service/package management interface

---

## BIZ-003: Business Clients

- **CanonicalId**: BIZ.00.003.A.COMM.CLI
- **Module**: Business Hub
- **Portal(s)**: All
- **Roles with access**: Community, Professional, Staff, Admin
- **External Route (client URL)**: `/business/clients`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/business/ClientsSubTabs.tsx
- **Component Path**: src/components/business/ClientsSubTabs.tsx
- **UI Pattern**: sub-page-header with split-bar tabs
- **Tenant Availability**: Global
- **Subscreens / Tabs / Modals**: Active (`?tab=active`), Prospects (`?tab=prospects`), History (`?tab=history`)
- **Status**: 🚧 Placeholder
- **Purpose**: Manage business clients and prospects
- **Primary APIs Used**: TBD (client management APIs pending)
- **DB Tables / Models Used**: TBD (client relationships pending)
- **Compliance Notes**: Client PII requires proper handling
- **Event Triggers**: clients_tab_viewed
- **Dependencies**: N/A
- **Autopilot Eligibility**: Yes (A1-A2)
- **Notes**: Currently shows placeholder content; client entity integration pending

---

## BIZ-004: Sell & Earn

- **CanonicalId**: BIZ.00.004.A.COMM.CLI
- **Module**: Business Hub
- **Portal(s)**: All
- **Roles with access**: Community, Professional, Staff, Admin
- **External Route (client URL)**: `/business/sell-earn`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/business/SellAndEarnSubTabs.tsx
- **Component Path**: src/components/business/SellAndEarnSubTabs.tsx
- **UI Pattern**: sub-page-header with split-bar tabs
- **Tenant Availability**: Maxina, Exafy (restricted for AlKalma, Earthlinks)
- **Subscreens / Tabs / Modals**: Inventory (`?tab=inventory`), Promotions (`?tab=promotions`)
- **Status**: ✅ Implemented
- **Purpose**: Reseller hub for browsing resellable events and managing promotions
- **Primary APIs Used**: useIsReseller, useActivateReseller, useResellableEvents, useCampaigns
- **DB Tables / Models Used**: reseller_profiles, reseller_attributions, global_community_events, campaigns
- **Compliance Notes**: Reseller activation requires acceptance of terms
- **Event Triggers**: sell_earn_viewed, reseller_activated
- **Dependencies**: ResellerAvailableEventsTab, ResellerCampaignsTab
- **Autopilot Eligibility**: Yes (A2-A3)
- **Notes**: Requires reseller mode activation; shows activation prompt if not reseller

---

## BIZ-005: Business Analytics

- **CanonicalId**: BIZ.00.005.A.COMM.CLI
- **Module**: Business Hub
- **Portal(s)**: All
- **Roles with access**: Community, Professional, Staff, Admin
- **External Route (client URL)**: `/business/analytics`
- **Internal/Admin Route (if any)**: N/A
- **Dev Route (current project path)**: src/components/business/AnalyticsSubTabs.tsx
- **Component Path**: src/components/business/AnalyticsSubTabs.tsx
- **UI Pattern**: sub-page-header with split-bar tabs
- **Tenant Availability**: Maxina, Exafy (restricted for AlKalma, Earthlinks)
- **Subscreens / Tabs / Modals**: Performance (`?tab=performance`), Earnings (`?tab=earnings`), Growth (`?tab=growth`)
- **Status**: ✅ Implemented
- **Purpose**: Business performance analytics and metrics
- **Primary APIs Used**: useResellerSales
- **DB Tables / Models Used**: reseller_attributions, wallet_transactions
- **Compliance Notes**: Financial analytics; data aggregation only
- **Event Triggers**: analytics_viewed, tab_changed
- **Dependencies**: N/A
- **Autopilot Eligibility**: Yes (A1)
- **Notes**: Displays performance metrics, earnings breakdown, and growth indicators

---

## Implementation Status Summary

| Status | Count |
|--------|-------|
| ✅ Implemented | 78 |
| 🚧 Placeholder | 129 |
| ❌ Missing | 8 |
| **TOTAL** | **215** |

---

## Role Access Matrix

| Role | Screen Count | Key Modules |
|------|-------------|-------------|
| Public (unauthenticated) | 15 | Auth, Landing, Portals |
| Community | 55 | Home, Community, Discover, Health, Inbox, AI, Wallet, Sharing, Memory, Settings, Business Hub |
| Patient | 9 | Patient Dashboard, Health, Appointments, Care Team |
| Professional | 9 | Professional Dashboard, Patients, Schedule, Clinical Tools |
| Staff | 9 | Staff Dashboard, Queue, Tasks, Schedule |
| Admin | 47 | Admin Dashboard, User Management, Tenant Management, System Admin, Monitoring, Community Supervision, Media, AI, Automation, Live Stream |
| Dev (Admin) | 63 | Dev Hub, Command, Agents, Pipelines, OASIS, VTID, Gateway, CI/CD, Observability, Settings, Docs |

---

## Module Summary

| Module | Screen Count | Status |
|--------|-------------|--------|
| Public/Auth | 15 | 100% Implemented |
| Home | 5 | 20% Implemented |
| Community | 9 | 56% Implemented |
| Discover | 9 | 56% Implemented |
| Health | 7 | 43% Implemented |
| Inbox | 4 | 25% Implemented |
| AI | 5 | 20% Implemented |
| Wallet | 4 | 25% Implemented |
| Sharing | 5 | 60% Implemented |
| Memory | 5 | 40% Implemented |
| Settings | 8 | 25% Implemented |
| Business Hub | 5 | 60% Implemented |
| Patient | 9 | 11% Implemented |
| Professional | 9 | 11% Implemented |
| Staff | 9 | 11% Implemented |
| Admin | 47 | 40% Implemented |
| Dev Hub | 63 | 100% Implemented |
| Global Overlays | 8 | 38% Implemented |

---

**End of VITANA Screen Registry v1.0**
