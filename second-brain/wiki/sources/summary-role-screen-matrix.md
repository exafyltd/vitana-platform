# Summary: Role-Screen Matrix

> A structured overview of the VITANA Role-Based Screen Access Matrix, which explicitly maps every screen to the user roles that can access it across all 551 platform screens.

## Content

### Role Hierarchy and Screen Counts
The platform defines five roles with cumulative access:

| Role | Total Screens | Base | Additional |
|------|--------------|------|------------|
| Community | 286 | 286 base screens | Includes 5 Business Hub screens |
| Patient | 295 | 286 Community | +9 patient-specific |
| Professional | 300 | 286 Community | +14 professional-specific (9 screens + 5 overlays) |
| Staff | 300 | 286 Community | +14 staff-specific (9 screens + 5 overlays) |
| Admin | 551 | 286 Community | +117 admin + 136 Dev Hub + 12 admin overlays |

### Community Base (286 Screens)
Includes Home (5), Community (12+), Discover (10), Health (12), Inbox (6), AI (7), Wallet (7), Sharing (7), Memory (5), Settings (10), Utility (8), Global Overlays (50+), and Business Hub (5).

### Patient-Specific (9 Screens)
Dashboard, Appointments, Records, Care Team, Prescriptions, Lab Results, Messaging, Portal, Settings. All under `/patient/*` routes.

### Professional-Specific (14 Screens)
Dashboard, Patients, Schedule, Clinical Tools, Billing, Analytics, Resources, Messaging, Settings. Plus overlays: Create Service, Create Package, Smart Package, Create Business Event, Business Filters.

### Staff-Specific (14 Screens)
Dashboard, Queue, Tasks, Schedule, Patients, Messaging, Reports, Time Tracking, Settings. Plus overlays: New Ticket, and shared professional overlays.

### Admin Access (All 551)
Full access to everything including 117 admin management screens and 136 Dev Hub screens.

### Explicit Mapping
No inheritance shortcuts are used. Every screen is explicitly listed for each role. This ensures precise access control without ambiguity.

## Related Pages

- [[role-based-access]]
- [[screen-registry]]
- [[multi-tenancy]]

## Sources

- `raw/screen-registry/ROLE_SCREEN_MATRIX.md`

## Last Updated

2026-04-12
