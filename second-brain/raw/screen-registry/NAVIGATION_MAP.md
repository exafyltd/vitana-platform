# VITANA Navigation Map

**Version**: 1.0  
**Last Updated**: 2025-11-26  
**Based on**: SCREEN_REGISTRY.md (546 screens)

---

## Table of Contents

1. [Overview](#overview)
2. [Global Overview](#global-overview)
3. [Community Role Flows](#community-role-flows)
4. [Patient Role Flows](#patient-role-flows)
5. [Professional Role Flows](#professional-role-flows)
6. [Staff Role Flows](#staff-role-flows)
7. [Admin Flows](#admin-flows)
8. [Cross-Role Overlays](#cross-role-overlays)

---

## Overview

This document maps the primary navigation flows across the VITANA platform. Each diagram uses Screen IDs from `SCREEN_REGISTRY.md` to show how users move between screens.

**Notation**:
- `XXXX-###(Name)` = Screen ID and short name
- `→` = Navigation action (tap, click)
- `⇄` = Bidirectional navigation
- Overlays shown with dashed lines

---

## Global Overview

**Description**: High-level entry points and authentication flow across all portals.

```mermaid
graph TB
    AUTH-001(Landing) --> AUTH-002(Public Portal)
    AUTH-001 --> AUTH-003(Maxina Portal)
    AUTH-001 --> AUTH-004(Alkalma Portal)
    AUTH-001 --> AUTH-005(Earthlinks Portal)
    
    AUTH-003 --> AUTH-007(Maxina Login)
    AUTH-004 --> AUTH-008(Alkalma Login)
    AUTH-005 --> AUTH-009(Earthlinks Login)
    
    AUTH-007 --> HOME-001(Home Dashboard)
    AUTH-008 --> HOME-001
    AUTH-009 --> HOME-001
    
    HOME-001 --> COMM-001(Community Hub)
    HOME-001 --> DISC-001(Discover Hub)
    HOME-001 --> HLTH-001(Health Hub)
    HOME-001 --> INBX-001(Inbox)
    HOME-001 --> AI-001(AI Assistant)
    HOME-001 --> WLLT-001(Wallet)
    HOME-001 --> SHAR-001(Sharing Hub)
    HOME-001 --> MEMR-001(Memory)
    HOME-001 --> STGS-001(Settings)
    
    HOME-001 -.-> OVRL-001(VITANA Orb)
    HOME-001 -.-> OVRL-008(Profile Preview)
```

---

## Community Role Flows

**Description**: Navigation paths for users in the Community role, focused on social features, content discovery, and wellness engagement.

### Main Hub Navigation

```mermaid
graph LR
    HOME-001(Home) --> COMM-001(Community Hub)
    HOME-001 --> DISC-001(Discover Hub)
    HOME-001 --> HLTH-001(Health Hub)
    
    COMM-001 --> COMM-002(Feed)
    COMM-001 --> COMM-003(Groups)
    COMM-001 --> COMM-004(Events & Meetups)
    COMM-001 --> COMM-005(Matchmaking)
    
    DISC-001 --> DISC-002(People)
    DISC-001 --> DISC-003(Content)
    DISC-001 --> DISC-004(Coaches)
    DISC-001 --> DISC-005(Events)
    
    HLTH-001 --> HLTH-002(Dashboard)
    HLTH-001 --> HLTH-003(Biomarkers)
    HLTH-001 --> HLTH-004(Activities)
```

### Community Content Flow

```mermaid
graph TB
    COMM-002(Feed) --> OVRL-002(Create Content)
    COMM-002 --> OVRL-003(Post Detail)
    COMM-002 --> OVRL-004(Event Drawer)
    
    COMM-003(Groups) --> OVRL-005(Create Group)
    COMM-003 --> COMM-006(Group Detail)
    COMM-006 --> COMM-007(Group Feed)
    COMM-006 --> COMM-008(Group Members)
    COMM-006 --> COMM-009(Group Settings)
    
    COMM-004(Events & Meetups) --> OVRL-004(Event Drawer)
    OVRL-004 --> OVRL-008(Profile Preview)
    OVRL-004 --> OVRL-006(Event RSVP)
    
    COMM-005(Matchmaking) --> DISC-002(People)
    COMM-005 --> OVRL-007(Match Filters)
```

### Health & Tracking Flow

```mermaid
graph TB
    HLTH-001(Health Hub) --> HLTH-002(Dashboard)
    HLTH-002 --> HLTH-003(Biomarkers)
    HLTH-002 --> HLTH-004(Activities)
    HLTH-002 --> HLTH-005(Nutrition)
    
    HLTH-003 --> HLTH-006(Hydration Tracker)
    HLTH-003 --> HLTH-007(Sleep Tracker)
    HLTH-003 --> HLTH-008(Mood Tracker)
    HLTH-003 --> HLTH-009(Energy Tracker)
    
    HLTH-004 --> HLTH-010(Activity Log)
    HLTH-004 --> HLTH-011(Workout Plans)
    
    HLTH-005 --> HLTH-012(Meal Log)
    HLTH-005 --> HLTH-013(Nutrition Insights)
```

### Discover & Matchmaking Flow

```mermaid
graph TB
    DISC-001(Discover Hub) --> DISC-002(People)
    DISC-001 --> DISC-003(Content)
    DISC-001 --> DISC-004(Coaches)
    DISC-001 --> DISC-005(Events)
    
    DISC-002 --> OVRL-008(Profile Preview)
    DISC-002 --> PROF-001(User Profile)
    DISC-002 --> OVRL-009(Connect Request)
    
    DISC-004 --> DISC-006(Coach Profile)
    DISC-006 --> OVRL-010(Book Consultation)
    
    DISC-005 --> OVRL-004(Event Drawer)
    DISC-005 --> COMM-004(Events & Meetups)
```

### Communication Flow

```mermaid
graph LR
    INBX-001(Inbox) --> INBX-002(Messages)
    INBX-001 --> INBX-003(Notifications)
    INBX-001 --> INBX-004(Invites)
    
    INBX-002 --> INBX-005(Conversation Detail)
    INBX-005 --> OVRL-008(Profile Preview)
    
    INBX-003 --> COMM-002(Feed)
    INBX-003 --> COMM-004(Events & Meetups)
    INBX-003 --> HLTH-002(Health Dashboard)
    
    INBX-004 --> COMM-003(Groups)
    INBX-004 --> COMM-004(Events & Meetups)
```

### AI & Automation Flow

```mermaid
graph TB
    AI-001(AI Assistant) --> AI-002(Chat)
    AI-001 --> AI-003(Autopilot)
    AI-001 --> AI-004(Memory)
    
    AI-002 --> AI-005(Conversation History)
    AI-002 -.-> OVRL-001(VITANA Orb)
    
    AI-003 --> AI-006(Action Queue)
    AI-003 --> AI-007(Automation Rules)
    
    AI-004 --> MEMR-001(Memory Hub)
```

### Wallet & Commerce Flow

```mermaid
graph TB
    WLLT-001(Wallet) --> WLLT-002(Balance)
    WLLT-001 --> WLLT-003(Transactions)
    WLLT-001 --> WLLT-004(Marketplace)
    
    WLLT-004 --> WLLT-005(Product Detail)
    WLLT-005 --> WLLT-006(Cart)
    WLLT-006 --> WLLT-007(Checkout)
    
    WLLT-003 --> WLLT-008(Transaction Detail)
```

### Settings & Profile Flow

```mermaid
graph TB
    STGS-001(Settings) --> STGS-002(Account)
    STGS-001 --> STGS-003(Privacy)
    STGS-001 --> STGS-004(Notifications)
    STGS-001 --> STGS-005(Preferences)
    
    PROF-001(Profile) --> PROF-002(Edit Profile)
    PROF-001 --> PROF-003(Profile Tabs)
    PROF-003 --> PROF-004(Posts Tab)
    PROF-003 --> PROF-005(Media Tab)
    PROF-003 --> PROF-006(Groups Tab)
    PROF-003 --> PROF-007(Events Tab)
    PROF-003 --> PROF-008(Health Tab)
```

---

## Patient Role Flows

**Description**: Navigation paths for users in the Patient role, focused on healthcare management, appointments, and clinical data.

### Patient Dashboard & Health Management

```mermaid
graph TB
    HOME-001(Home) --> PTNT-001(Patient Dashboard)
    
    PTNT-001 --> PTNT-002(My Health)
    PTNT-001 --> PTNT-003(Appointments)
    PTNT-001 --> PTNT-004(Test Results)
    PTNT-001 --> PTNT-005(Care Team)
    PTNT-001 --> PTNT-006(Health Goals)
    
    PTNT-002 --> HLTH-002(Health Dashboard)
    PTNT-002 --> HLTH-003(Biomarkers)
    
    PTNT-003 --> PTNT-007(Appointment Detail)
    PTNT-003 --> OVRL-011(Book Appointment)
    
    PTNT-004 --> PTNT-008(Result Detail)
    PTNT-004 --> OVRL-012(Share Results)
    
    PTNT-005 --> OVRL-008(Profile Preview)
    PTNT-005 --> PROF-001(Provider Profile)
    
    PTNT-006 --> HLTH-014(Goal Detail)
    PTNT-006 --> OVRL-013(Create Goal)
```

### Patient Appointments & Clinical Flow

```mermaid
graph LR
    PTNT-003(Appointments) --> PTNT-007(Appointment Detail)
    PTNT-007 --> OVRL-014(Reschedule)
    PTNT-007 --> OVRL-015(Cancel)
    PTNT-007 --> INBX-005(Message Provider)
    
    PTNT-003 --> OVRL-011(Book Appointment)
    OVRL-011 --> PTNT-005(Select Provider)
    OVRL-011 --> PTNT-009(Select Time)
```

### Patient Insurance & Billing

```mermaid
graph TB
    PTNT-001(Patient Dashboard) --> PTNT-010(Insurance)
    PTNT-010 --> PTNT-011(Insurance Cards)
    PTNT-010 --> PTNT-012(Claims)
    PTNT-010 --> PTNT-013(Coverage Details)
    
    PTNT-012 --> PTNT-014(Claim Detail)
    PTNT-012 --> OVRL-016(Submit Claim)
```

---

## Professional Role Flows

**Description**: Navigation paths for healthcare professionals, focused on patient management, clinical tools, and scheduling.

### Professional Dashboard & Patient Management

```mermaid
graph TB
    HOME-001(Home) --> PROF-100(Professional Dashboard)
    
    PROF-100 --> PROF-101(My Patients)
    PROF-100 --> PROF-102(Schedule)
    PROF-100 --> PROF-103(Clinical Tools)
    PROF-100 --> PROF-104(Referrals)
    PROF-100 --> PROF-105(Billing)
    
    PROF-101 --> PROF-106(Patient List)
    PROF-106 --> PROF-107(Patient Detail)
    PROF-107 --> PROF-108(Health Records)
    PROF-107 --> PROF-109(Treatment Plan)
    PROF-107 --> PROF-110(Notes)
    
    PROF-102 --> PROF-111(Calendar View)
    PROF-102 --> PROF-112(Appointment Detail)
    PROF-112 --> OVRL-017(Start Consultation)
```

### Professional Clinical Tools

```mermaid
graph TB
    PROF-103(Clinical Tools) --> PROF-113(Assessment Tools)
    PROF-103 --> PROF-114(Treatment Protocols)
    PROF-103 --> PROF-115(Reference Library)
    PROF-103 --> PROF-116(Prescription Pad)
    
    PROF-113 --> PROF-117(Assessment Detail)
    PROF-114 --> PROF-118(Protocol Detail)
    PROF-116 --> OVRL-018(Create Prescription)
```

### Professional Referrals & Collaboration

```mermaid
graph LR
    PROF-104(Referrals) --> PROF-119(Outgoing Referrals)
    PROF-104 --> PROF-120(Incoming Referrals)
    
    PROF-119 --> OVRL-019(Create Referral)
    PROF-119 --> PROF-121(Referral Detail)
    
    PROF-120 --> PROF-122(Accept Referral)
    PROF-120 --> PROF-121(Referral Detail)
```

---

## Staff Role Flows

**Description**: Navigation paths for healthcare staff, focused on operational tasks, patient queues, and administrative support.

### Staff Dashboard & Operations

```mermaid
graph TB
    HOME-001(Home) --> STAF-001(Staff Dashboard)
    
    STAF-001 --> STAF-002(Patient Queue)
    STAF-001 --> STAF-003(Daily Tasks)
    STAF-001 --> STAF-004(Schedule)
    STAF-001 --> STAF-005(Reports)
    
    STAF-002 --> STAF-006(Queue Detail)
    STAF-006 --> STAF-007(Check-in Patient)
    STAF-006 --> STAF-008(Update Status)
    
    STAF-003 --> STAF-009(Task Detail)
    STAF-003 --> OVRL-020(Create Task)
    
    STAF-004 --> STAF-010(Staff Schedule)
    STAF-004 --> STAF-011(Time Tracking)
```

### Staff Communication & Coordination

```mermaid
graph TB
    STAF-001(Staff Dashboard) --> STAF-012(Communications)
    STAF-012 --> STAF-013(Team Chat)
    STAF-012 --> STAF-014(Announcements)
    STAF-012 --> STAF-015(Handoff Notes)
    
    STAF-013 --> INBX-005(Conversation)
    STAF-015 --> STAF-016(Create Handoff)
```

---

## Admin Flows

**Description**: Navigation paths for administrators, covering system management, user administration, community moderation, and platform operations.

### Admin Dashboard & Overview

```mermaid
graph TB
    HOME-001(Home) --> ADMN-001(Admin Dashboard)
    
    ADMN-001 --> ADMN-002(User Management)
    ADMN-001 --> ADMN-003(Community Supervision)
    ADMN-001 --> ADMN-004(Media Management)
    ADMN-001 --> ADMN-005(AI Assistant)
    ADMN-001 --> ADMN-006(Automation)
    ADMN-001 --> ADMN-007(Live & Stream)
    ADMN-001 --> ADMN-008(Tenant Management)
    ADMN-001 --> ADMN-009(System Admin)
    ADMN-001 --> ADMN-010(Clinical Ops)
    ADMN-001 --> ADMN-011(Monitoring)
```

### Admin User Management Flow

```mermaid
graph TB
    ADMN-002(User Management) --> ADMN-012(User Directory)
    ADMN-002 --> ADMN-013(Role Management)
    ADMN-002 --> ADMN-014(Access Control)
    ADMN-002 --> ADMN-015(User Activity)
    
    ADMN-012 --> ADMN-016(User Detail)
    ADMN-016 --> ADMN-017(Edit User)
    ADMN-016 --> ADMN-018(User Permissions)
    ADMN-016 --> ADMN-019(User Audit Log)
    
    ADMN-013 --> ADMN-020(Role Detail)
    ADMN-013 --> OVRL-021(Create Role)
```

### Admin Community Supervision Flow

```mermaid
graph TB
    ADMN-003(Community Supervision) --> ADMN-021(Content Moderation)
    ADMN-003 --> ADMN-022(Reported Content)
    ADMN-003 --> ADMN-023(User Reports)
    ADMN-003 --> ADMN-024(Community Analytics)
    
    ADMN-021 --> ADMN-025(Content Queue)
    ADMN-025 --> ADMN-026(Review Content)
    ADMN-026 --> OVRL-022(Approve/Reject)
    
    ADMN-022 --> ADMN-027(Report Detail)
    ADMN-027 --> ADMN-028(Take Action)
    
    ADMN-024 --> ADMN-029(Engagement Metrics)
    ADMN-024 --> ADMN-030(Trend Analysis)
```

### Admin Automation & AI Flow

```mermaid
graph TB
    ADMN-006(Automation) --> ADMN-031(Automation Rules)
    ADMN-006 --> ADMN-032(AI Recommendations)
    ADMN-006 --> ADMN-033(Situation Analysis)
    ADMN-006 --> ADMN-034(Proactive Settings)
    
    ADMN-031 --> ADMN-035(Rule Builder)
    ADMN-031 --> ADMN-036(Execution Log)
    
    ADMN-032 --> ADMN-037(Recommendation Detail)
    ADMN-037 --> ADMN-038(Deploy Rule)
    ADMN-037 --> ADMN-039(Provide Feedback)
    
    ADMN-033 --> ADMN-040(Create Analysis)
    ADMN-033 --> ADMN-041(Analysis Results)
```

### Admin Tenant Management Flow

```mermaid
graph TB
    ADMN-008(Tenant Management) --> ADMN-042(Tenant Directory)
    ADMN-008 --> ADMN-043(Tenant Analytics)
    ADMN-008 --> ADMN-044(Subscription Plans)
    ADMN-008 --> ADMN-045(Billing)
    
    ADMN-042 --> ADMN-046(Tenant Detail)
    ADMN-046 --> ADMN-047(Tenant Settings)
    ADMN-046 --> ADMN-048(Tenant Users)
    ADMN-046 --> ADMN-049(Tenant Activity)
    
    ADMN-043 --> ADMN-050(Usage Metrics)
    ADMN-043 --> ADMN-051(Health Scores)
```

### Admin System & Monitoring Flow

```mermaid
graph TB
    ADMN-009(System Admin) --> ADMN-052(System Settings)
    ADMN-009 --> ADMN-053(Feature Flags)
    ADMN-009 --> ADMN-054(API Management)
    ADMN-009 --> ADMN-055(Database Admin)
    
    ADMN-011(Monitoring) --> ADMN-056(Performance Dashboard)
    ADMN-011 --> ADMN-057(Error Logs)
    ADMN-011 --> ADMN-058(Audit Trail)
    ADMN-011 --> ADMN-059(Alerts)
    
    ADMN-056 --> ADMN-060(System Health)
    ADMN-056 --> ADMN-061(Resource Usage)
    
    ADMN-057 --> ADMN-062(Error Detail)
    ADMN-058 --> ADMN-063(Event Detail)
```

### Admin Clinical Operations Flow

```mermaid
graph TB
    ADMN-010(Clinical Ops) --> ADMN-064(Patient Records)
    ADMN-010 --> ADMN-065(Provider Management)
    ADMN-010 --> ADMN-066(Appointment System)
    ADMN-010 --> ADMN-067(Compliance)
    
    ADMN-064 --> ADMN-068(Record Search)
    ADMN-064 --> ADMN-069(Data Export)
    
    ADMN-065 --> ADMN-070(Provider Directory)
    ADMN-065 --> ADMN-071(Credentialing)
    
    ADMN-067 --> ADMN-072(Compliance Dashboard)
    ADMN-067 --> ADMN-073(Audit Reports)
```

---

## Cross-Role Overlays

**Description**: Global overlays and components accessible across multiple roles and contexts.

### VITANA Orb & Voice Navigation

```mermaid
graph TB
    OVRL-001(VITANA Orb) --> OVRL-023(Voice Command)
    OVRL-023 --> HOME-001(Navigate: Home)
    OVRL-023 --> COMM-001(Navigate: Community)
    OVRL-023 --> HLTH-001(Navigate: Health)
    OVRL-023 --> INBX-001(Navigate: Inbox)
    
    OVRL-001 --> OVRL-024(Glass Mode)
    OVRL-001 --> OVRL-025(Camera Mode)
    OVRL-001 --> OVRL-026(Screen Share)
    OVRL-001 --> OVRL-027(Diary Entry)
    OVRL-001 --> OVRL-028(Autopilot)
```

### Profile & User Overlays

```mermaid
graph TB
    OVRL-008(Profile Preview) --> PROF-001(Full Profile)
    OVRL-008 --> OVRL-009(Connect Request)
    OVRL-008 --> INBX-005(Send Message)
    OVRL-008 --> OVRL-029(Share Profile)
    
    PROF-001 --> PROF-002(Edit Profile)
    PROF-001 --> PROF-003(Profile Tabs)
```

### Event & Group Overlays

```mermaid
graph TB
    OVRL-004(Event Drawer) --> OVRL-006(RSVP)
    OVRL-004 --> OVRL-008(Host Profile)
    OVRL-004 --> OVRL-030(Share Event)
    OVRL-004 --> COMM-010(Event Detail Page)
    
    OVRL-005(Create Group) --> COMM-003(Groups)
    OVRL-002(Create Content) --> COMM-002(Feed)
```

### Calendar & Scheduling Overlays

```mermaid
graph TB
    OVRL-031(Universal Calendar) --> COMM-004(Events)
    OVRL-031 --> PTNT-003(Appointments)
    OVRL-031 --> AI-003(Autopilot Actions)
    OVRL-031 --> INBX-004(Invites)
    
    OVRL-031 --> OVRL-032(Create Event)
    OVRL-031 --> OVRL-033(Event Detail)
```

### Marketplace & Commerce Overlays

```mermaid
graph TB
    WLLT-005(Product Detail) --> WLLT-006(Add to Cart)
    WLLT-006 --> WLLT-007(Checkout)
    WLLT-007 --> OVRL-034(Payment)
    OVRL-034 --> WLLT-008(Order Confirmation)
    
    WLLT-004(Marketplace) --> OVRL-035(Product Quick View)
    OVRL-035 --> WLLT-005(Full Product Detail)
```

### Health Tracking Overlays

```mermaid
graph TB
    HLTH-003(Biomarkers) --> OVRL-036(Quick Log)
    OVRL-036 --> HLTH-006(Hydration)
    OVRL-036 --> HLTH-007(Sleep)
    OVRL-036 --> HLTH-008(Mood)
    OVRL-036 --> HLTH-009(Energy)
    
    HLTH-002(Dashboard) --> OVRL-037(Goal Progress)
    OVRL-037 --> HLTH-014(Goal Detail)
```

---

## Navigation Patterns Summary

### Entry Points by Role

| Role | Primary Entry | Secondary Hubs |
|------|--------------|----------------|
| Community | HOME-001 | COMM-001, DISC-001, HLTH-001 |
| Patient | PTNT-001 | PTNT-002, PTNT-003, PTNT-005 |
| Professional | PROF-100 | PROF-101, PROF-102, PROF-103 |
| Staff | STAF-001 | STAF-002, STAF-003, STAF-004 |
| Admin | ADMN-001 | All ADMN-002 through ADMN-011 |

### Most Connected Screens

Based on the navigation flows above, the most highly connected screens are:

1. **HOME-001** (Home Dashboard) - Universal entry point for all authenticated users
2. **OVRL-001** (VITANA Orb) - Global voice navigation available everywhere
3. **OVRL-008** (Profile Preview) - Accessible from numerous screens
4. **INBX-005** (Conversation Detail) - Connected from multiple communication flows
5. **COMM-002** (Feed) - Central hub for community content
6. **HLTH-002** (Health Dashboard) - Central hub for health tracking

### Overlay Usage Patterns

- **OVRL-001** (VITANA Orb): Available globally, provides voice navigation to any screen
- **OVRL-008** (Profile Preview): Quick preview from avatars across all modules
- **OVRL-004** (Event Drawer): Slide-in detail view from event cards
- **OVRL-031** (Universal Calendar): Aggregates events, appointments, and scheduled actions

---

## Business Hub Flows

**Description**: Navigation paths for Business Hub, the unified business performance dashboard.

### Business Hub Overview

```mermaid
graph TB
    HOME-001(Home) --> BIZ-001(Business Hub Overview)
    
    BIZ-001 --> BIZ-002(Services)
    BIZ-001 --> BIZ-003(Clients)
    BIZ-001 --> BIZ-004(Sell & Earn)
    BIZ-001 --> BIZ-005(Analytics)
```

### Business Hub Internal Navigation

```mermaid
graph TB
    subgraph "Business Hub Overview (BIZ-001)"
        BIZ-001-Snapshot[Snapshot Tab]
        BIZ-001-History[History Tab]
    end
    
    subgraph "Services (BIZ-002)"
        BIZ-002-Services[My Services Tab]
        BIZ-002-Events[My Events Tab]
        BIZ-002-Packages[Packages Tab]
    end
    
    subgraph "Clients (BIZ-003)"
        BIZ-003-Active[Active Tab]
        BIZ-003-Prospects[Prospects Tab]
        BIZ-003-History[History Tab]
    end
    
    subgraph "Sell & Earn (BIZ-004)"
        BIZ-004-Inventory[Inventory Tab]
        BIZ-004-Promotions[Promotions Tab]
    end
    
    subgraph "Analytics (BIZ-005)"
        BIZ-005-Performance[Performance Tab]
        BIZ-005-Earnings[Earnings Tab]
        BIZ-005-Growth[Growth Tab]
    end
```

### Business Hub Cross-Module Navigation

```mermaid
graph TB
    BIZ-001(Overview) --> WLLT-001(Wallet)
    
    BIZ-002(Services) --> OVRL-040(Create Package Dialog)
    BIZ-002 --> OVRL-017(Create Event Dialog)
    
    BIZ-003(Clients) --> SHAR-001(Sharing Hub)
    
    BIZ-004(Sell & Earn) --> SHAR-002(Campaigns)
    
    BIZ-005(Analytics) --> WLLT-001(Wallet)
    BIZ-005 --> SHAR-001(Sharing Hub)
```

### Business Hub Sidebar Position

```mermaid
graph TB
    subgraph "Sidebar Hierarchy"
        HOME(Home)
        COMM(Community)
        DISC(Discover)
        HLTH(Health)
        BIZ(Business Hub)
        WLLT(Wallet)
        SHAR(Sharing)
        MEMO(Memory)
        SETT(Settings)
    end
    
    HOME --> COMM
    COMM --> DISC
    DISC --> HLTH
    HLTH --> BIZ
    BIZ --> WLLT
    WLLT --> SHAR
    SHAR --> MEMO
    MEMO --> SETT
```

---

**End of Navigation Map**
