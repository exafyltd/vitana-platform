# Role-Based Access

> VITANA implements a hierarchical role-based access system across 551 screens, with five primary roles (Community, Patient, Professional, Staff, Admin) that determine which screens and features each user can access.

## Role Definitions

| Role | Description | Screen Count |
|------|-------------|--------------|
| **Community** | Base authenticated user; social, wellness, business, and core platform features | 286 |
| **Patient** | Community + patient health management and clinical tools | 295 |
| **Professional** | Community + professional practice and business tools | 300 |
| **Staff** | Community + staff operational and clinical support tools | 300 |
| **Admin** | Community + full platform administration + Dev Hub access | 551 |

All role assignments are explicitly mapped -- no inheritance shortcuts. Every screen is listed for each role that can access it.

## Community Role (286 Screens)

The base authenticated role includes:
- **Home** (5 screens): Overview, Context, Actions, Matches, AI Feed
- **Community** (12+ screens): Overview, Events & Meetups, Live Rooms, Media Hub, My Business, Groups, Feed, Challenges, Matchmaking
- **Discover** (10 screens): Overview, Supplements, Providers, Categories, Browse, Services, Cart
- **Health** (12 screens): Overview, Services Hub, Biomarkers, Plans, Education, Pillars, Conditions & Risks, Wellness Services
- **Inbox** (6 screens): Overview, Reminder, Inspiration, Archived, Messages, Scheduled
- **AI** (7 screens): Overview, Vitana, Autopilot, History, Chat, Prompts, Memory
- **Wallet** (7 screens): Overview, Rewards, Billing, Transactions, Vitana Coin, Exchange
- **Sharing** (7 screens): Overview, Campaigns, Distribution, Analytics, Channels, Posts, Schedule
- **Memory** (5 screens): Overview, Life Events, Diary, Recall, Permissions
- **Settings** (10 screens): Overview, Preferences, Privacy, Notifications, Connected Apps, Billing, Support, Tenant & Role, Autopilot, Voice AI
- **Utility** (8 screens): Calendar, Search, Profile Edit, Public Profile, Chat, Notifications
- **Global Overlays** (50+ screens): ORB, drawers, popups, dialogs
- **Business Hub** (5 screens): BIZ-001 through BIZ-005 (Overview, Services, Clients, Sell & Earn, Analytics)

## Patient Role (295 Screens)

All 286 Community screens **plus** 9 patient-specific screens:
- PTNT-001: Patient Dashboard
- PTNT-002 to PTNT-009: Appointments, Records, Care Team, Prescriptions, Lab Results, Messaging, Portal, Settings

## Professional Role (300 Screens)

All 286 Community screens **plus** 14 professional-specific screens:
- PROF-001: Professional Dashboard
- PROF-002 to PROF-009: Patients, Schedule, Clinical Tools, Billing, Analytics, Resources, Messaging, Settings
- Professional-only overlays: Create Service, Create Package, Smart Package, Create Business Event, Business Filters popups

## Staff Role (300 Screens)

All 286 Community screens **plus** 14 staff-specific screens:
- STFF-001: Staff Dashboard
- STFF-002 to STFF-009: Queue, Tasks, Schedule, Patients, Messaging, Reports, Time Tracking, Settings
- Staff-only overlays: New Ticket, plus shared professional overlays (Create Service, Create Package, Smart Package, Create Business Event, Business Filters)

## Admin Role (551 Screens)

All 286 Community screens **plus**:
- 117 Admin management screens (Dashboard, User Management, Tenant Management, System Config, AI management, Content Moderation, Live Stream Control, etc.)
- 136 Dev Hub screens (Dashboard, Analytics, Health, CI/CD, Pipelines, Agents, Gateway, Observability, etc.)
- 12 admin-specific overlays

## Navigation Flows by Role

| Role | Primary Entry | Key Hubs |
|------|--------------|----------|
| Community | HOME-001 (Home Dashboard) | COMM-001, DISC-001, HLTH-001 |
| Patient | PTNT-001 (Patient Dashboard) | Health, Appointments, Care Team |
| Professional | PROF-001 (Professional Dashboard) | Patients, Schedule, Clinical Tools |
| Staff | STFF-001 (Staff Dashboard) | Queue, Tasks, Schedule |
| Admin | ADMN-001 (Admin Dashboard) | All admin modules (ADMN-002 through ADMN-011) |

## Cross-Role Overlays

The VITANA Orb (OVRL-001) is available globally across all roles for voice navigation. Profile Preview (OVRL-008) is accessible from numerous screens. The Universal Calendar aggregates events, appointments, and scheduled actions across roles.

## Related Pages

- [[screen-registry]] -- Full registry of all 551 screens
- [[multi-tenancy]] -- Tenant-specific screen availability
- [[business-hub]] -- Business Hub screens accessible to all roles
- [[mobile-pwa-architecture]] -- Mobile-specific navigation flows
- [[maxina-orb]] -- ORB overlay accessible across all roles

## Sources

- `raw/screen-registry/ROLE_SCREEN_MATRIX.md`
- `raw/screen-registry/NAVIGATION_MAP.md`
- `raw/screen-registry/SCREEN_REGISTRY.md`

## Last Updated

2026-04-12
