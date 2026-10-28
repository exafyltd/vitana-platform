# Summary: Navigation Map

> A structured overview of the VITANA Navigation Map, which documents primary navigation flows across all roles using screen IDs from the Screen Registry.

## Content

### Scope
The navigation map covers flows for all five roles (Community, Patient, Professional, Staff, Admin) plus cross-role overlays and the Business Hub. It uses mermaid diagrams to visualize screen-to-screen transitions.

### Global Entry Points
All users enter via AUTH-001 (Landing) which branches to portal-specific logins (Maxina AUTH-003, Alkalma AUTH-004, Earthlinks AUTH-005). After authentication, users reach HOME-001 (Home Dashboard), which connects to all major hubs: Community (COMM-001), Discover (DISC-001), Health (HLTH-001), Inbox (INBX-001), AI (AI-001), Wallet (WLLT-001), Sharing (SHAR-001), Memory (MEMR-001), and Settings (STGS-001).

### Community Role Flows
- Main Hub: HOME-001 branches to Community, Discover, Health hubs
- Community Content: Feed (COMM-002) to Create Content, Post Detail, Event Drawer
- Groups: COMM-003 to Group Detail, Group Feed, Members, Settings
- Health Tracking: HLTH-001 through Dashboard, Biomarkers, Activities, Nutrition with sub-trackers (Hydration, Sleep, Mood, Energy)
- Discover & Matchmaking: People, Content, Coaches, Events with profile previews and booking
- Communication: Inbox to Messages, Notifications, Invites
- AI & Automation: Chat, Autopilot, Memory with Conversation History
- Wallet & Commerce: Balance, Transactions, Marketplace with Cart and Checkout

### Patient Role Flows
Patient Dashboard (PTNT-001) connects to My Health, Appointments, Test Results, Care Team, Health Goals. Includes Insurance and Billing sub-flows with Claims and Coverage Details.

### Professional Role Flows
Professional Dashboard (PROF-100) connects to My Patients, Schedule, Clinical Tools, Referrals, Billing. Clinical Tools include Assessment Tools, Treatment Protocols, Reference Library, Prescription Pad.

### Staff Role Flows
Staff Dashboard (STAF-001) connects to Patient Queue, Daily Tasks, Schedule, Reports, Communications (Team Chat, Announcements, Handoff Notes).

### Admin Flows
Admin Dashboard (ADMN-001) connects to 10 major areas: User Management, Community Supervision, Media Management, AI Assistant, Automation, Live & Stream, Tenant Management, System Admin, Clinical Ops, Monitoring.

### Business Hub Flows
BIZ-001 (Overview) connects to Services, Clients, Sell & Earn, Analytics. Cross-links to Wallet, Sharing Hub, and Campaigns.

### Most Connected Screens
1. HOME-001 (Home Dashboard) - universal entry point
2. OVRL-001 (VITANA Orb) - global voice navigation
3. OVRL-008 (Profile Preview) - accessible from numerous screens
4. INBX-005 (Conversation Detail) - multiple communication flows
5. COMM-002 (Feed) - central community hub
6. HLTH-002 (Health Dashboard) - central health hub

### Cross-Role Overlays
- VITANA Orb: Global voice navigation to any screen
- Profile Preview: Quick preview from avatars across all modules
- Event Drawer: Slide-in detail view from event cards
- Universal Calendar: Aggregates events, appointments, scheduled actions

## Related Pages

- [[screen-registry]]
- [[role-based-access]]
- [[maxina-orb]]
- [[business-hub]]

## Sources

- `raw/screen-registry/NAVIGATION_MAP.md`

## Last Updated

2026-04-12
