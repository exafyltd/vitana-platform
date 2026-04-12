# Screen Registry

> The VITANA Screen Registry catalogs all 551 screens, views, and major UI components across the platform, with routing, access control, implementation status, and D1 compliance documentation for each.

## Overview

The screen registry is the canonical source for precise communication about features, planning, and implementation across the entire VITANA team. Every entry includes:
- CanonicalId, Module, Portal(s)
- Roles with access
- External/Internal/Dev routes and component paths
- UI Pattern classification
- Tenant Availability
- Subscreens, Tabs, Modals
- Implementation Status
- Purpose, Primary APIs, DB Tables, Compliance Notes, Event Triggers, Dependencies

## Statistics (551 Total)

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

## Status Classification

- **Implemented** (78 screens, 14.2%): Fully functional
- **Placeholder** (129 screens, 23.6%): Route exists, minimal content
- **Missing** (8 screens, 1.5%): Planned but not yet created
- **Implemented but D1 fields TBD** (331 screens, 60.6%): Functional but missing documentation for APIs, DB tables, compliance notes, and event triggers

## D1 Compliance

"D1" refers to the complete documentation standard for each screen. A D1-compliant screen has all fields populated: Purpose, Primary APIs Used, DB Tables/Models Used, Compliance Notes, Event Triggers, and Dependencies.

**Incompleteness by module (most affected):**
- Dev Hub: 136/136 (100%) -- all implemented but lacking D1 documentation
- Patient, Professional, Staff: 100% incomplete
- Business Hub: 5/5 (100%) incomplete
- Global Overlays: 51/53 (96.2%) incomplete
- Home, Settings: 90% incomplete

**Priority recommendations:**
1. Patient/Professional/Staff role screens (critical healthcare functionality)
2. Dev Hub D1 documentation (136 implemented screens)
3. Community Module (33 incomplete, core social features)
4. Home and Settings modules (first impressions, user experience)

## Universal Screen Pattern

All screens must follow the CTO-approved universal pattern with 10 mandatory components (SEO, AppLayout, SubNavigation, StandardHeader, UtilityActionButton, SplitBar, withScreenId, background gradient, Plus icon, size="sm"). See [[design-system]] for full details.

## UI Pattern Types

| Pattern | Description |
|---------|-------------|
| 3-card-header | Dashboard with 3 card navigation options |
| split-screen | Left list + right detail panel |
| horizontal-list | Scrollable card carousel |
| card-grid | Responsive grid of cards |
| orb-overlay | Full-screen VITANA Orb experience |
| sub-page-header | Standard header with navigation tabs |
| data-table | Tabular data with filters/search |
| wizard | Multi-step form flow |
| drawer | Slide-in panel overlay |
| dialog | Modal popup |

## Screen ID Conventions

Screen IDs follow the pattern `PREFIX-NNN` where:
- AUTH: Public/Authentication
- HOME: Home module
- COMM: Community
- DISC: Discover
- HLTH: Health
- INBX: Inbox
- AI: AI module
- WLLT: Wallet
- SHAR: Sharing
- MEMO/MEMR: Memory
- SETT/STNG: Settings
- PTNT: Patient
- PROF: Professional
- STFF: Staff
- ADMN: Admin
- DEV: Dev Hub
- OVRL: Global Overlays
- BIZ: Business Hub
- UTIL: Utility

## Related Pages

- [[role-based-access]] -- Role-screen access matrix
- [[multi-tenancy]] -- Tenant-specific screen availability
- [[design-system]] -- Universal screen pattern and UI components
- [[mobile-pwa-architecture]] -- Mobile-specific screen inventory
- [[business-hub]] -- Business Hub screens (BIZ-001 to BIZ-005)

## Sources

- `raw/screen-registry/SCREEN_REGISTRY.md`
- `raw/screen-registry/INCOMPLETE_SCREENS.md`
- `raw/screen-registry/UNIVERSAL_SCREEN_PATTERN.md`

## Last Updated

2026-04-12
