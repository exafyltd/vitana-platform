# Summary: Screen Registry

> A structured overview of the VITANA Screen Registry, which catalogs all 551 screens with their routing, access control, implementation status, and D1 compliance documentation.

## Content

### Scale and Structure
The registry tracks 551 screens across 18 categories: Public/Auth (24), Community (89), Patient (9), Professional (9), Staff (9), Admin (117), Dev Hub (136), Global Overlays (53), Home (20), Discover (10), Health (12), Inbox (8), AI (6), Wallet (8), Sharing (6), Memory (10), Settings (20), and Business Hub (5).

### Implementation Status
- 78 screens (14.2%) are fully complete
- 129 screens (23.6%) are placeholder (route exists, minimal content)
- 8 screens (1.5%) are missing (planned but not created)
- 331 screens (60.6%) are implemented but have TBD D1 fields (APIs, DB tables, compliance notes, event triggers)

### D1 Documentation Standard
Each screen entry includes: CanonicalId, Module, Portal(s), Roles with access, External/Internal/Dev routes, Component Path, UI Pattern, Tenant Availability, Subscreens/Tabs/Modals, Status, Purpose, Primary APIs Used, DB Tables/Models Used, Compliance Notes, Event Triggers, and Dependencies.

### Critical Gaps
- Dev Hub: All 136 screens implemented but 100% lack D1 documentation
- Patient/Professional/Staff: 100% incomplete (healthcare critical)
- Business Hub: All 5 screens lack D1 documentation
- Global Overlays: 51/53 incomplete

### UI Pattern Classification
Screens are classified by pattern: 3-card-header, split-screen, horizontal-list, card-grid, orb-overlay, sub-page-header, data-table, wizard, drawer, dialog.

### Screen ID Prefixes
AUTH, HOME, COMM, DISC, HLTH, INBX, AI, WLLT, SHAR, MEMO/MEMR, SETT/STNG, PTNT, PROF, STFF, ADMN, DEV, OVRL, BIZ, UTIL.

## Related Pages

- [[screen-registry]]
- [[role-based-access]]
- [[multi-tenancy]]
- [[design-system]]

## Sources

- `raw/screen-registry/SCREEN_REGISTRY.md`
- `raw/screen-registry/INCOMPLETE_SCREENS.md`
- `raw/screen-registry/UNIVERSAL_SCREEN_PATTERN.md`

## Last Updated

2026-04-12
