# VITANA Tenant Screen Availability Map

**Version**: 1.2  
**Last Updated**: 2025-12-16  
**Source**: SCREEN_REGISTRY.md (551 screens)

---

## Table of Contents

1. [Overview](#overview)
2. [Tenant Summary](#tenant-summary)
3. [Global Screens](#global-screens)
4. [Maxina Screens](#maxina-screens)
5. [Alkalma Screens](#alkalma-screens)
6. [Earthlinks Screens](#earthlinks-screens)
7. [Exafy Screens](#exafy-screens)

---

## Overview

This document maps which screens are available to each tenant portal based on the "Tenant Availability" field in the Screen Registry. A screen appears under a tenant if:
- The registry explicitly lists that tenant, OR
- The registry lists "Global" (available to all tenants)

**Tenant Types:**
- **Global**: Screens accessible across all tenant portals
- **Maxina**: Maxina-specific screens
- **Alkalma**: Alkalma-specific screens
- **Earthlinks**: Earthlinks-specific screens
- **Exafy**: Internal Exafy admin screens only

---

## Tenant Summary

| Tenant | Total Screens | Business Hub | Notes |
|--------|--------------|--------------|-------|
| Global | 299 | +5 → 304 | Base screens + 100 module screens + 5 BIZ screens |
| Maxina | 302 | +5 → 307 | Full Business Hub access |
| Alkalma | 302 | +4 → 306 | No Sell & Earn (BIZ-004 restricted) |
| Earthlinks | 302 | +3 → 305 | No Sell & Earn or Analytics (BIZ-004, BIZ-005 restricted) |
| Exafy | 306 | +5 → 311 | Full Business Hub access |

---

# Global Screens

Available to all tenants (304 screens including 100 module screens + 5 Business Hub screens)

| Screen ID | Screen Name | Module | External Route | Dev Component Path | Roles with Access | Status |
|-----------|-------------|--------|----------------|-------------------|-------------------|--------|
| AUTH-001 | Landing Page | Public | `/` | src/pages/Landing.tsx | Public | ✅ |
| AUTH-002 | Generic Auth | Authentication | `/auth` | src/pages/Auth.tsx | Public | ✅ |
| AUTH-006 | Community Portal Login | Authentication | `/community` | src/pages/portals/CommunityPortal.tsx | Public | 🚧 |
| AUTH-012 | Email Confirmation (Community) | Authentication | `/community/confirmed` | src/pages/portals/CommunityConfirmed.tsx | Public | ✅ |
| AUTH-014 | Not Found (404) | Error | `*` | src/pages/NotFound.tsx | All | ✅ |
| AUTH-015 | Legacy Profile Redirect | Utility | `/profile/:id` | src/components/LegacyProfileRedirect.tsx | All | ✅ |
| HOME-001 | Home Overview | Home | `/home` | src/pages/Home.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| HOME-002 | Context | Home | `/home/context` | src/pages/home/Context.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HOME-003 | Actions | Home | `/home/actions` | src/pages/home/Actions.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HOME-004 | Matches | Home | `/home/matches` | src/pages/home/Matches.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HOME-005 | AI Feed | Home | `/home/aifeed` | src/pages/home/AIFeed.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| COMM-001 | Community Overview | Community | `/community` | src/pages/Community.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| COMM-002 | Events & Meetups | Community | `/community/events` | src/pages/community/EventsAndMeetups.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| COMM-003 | Live Rooms | Community | `/community/live-rooms` | src/pages/community/LiveRooms.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| COMM-004 | Media Hub | Community | `/community/media-hub` | src/pages/community/MediaHub.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| COMM-005 | My Business | Community | `/community/my-business` | src/pages/community/MyBusiness.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| COMM-006 | Group Detail | Community | `/community/groups/:groupId` | src/pages/community/GroupDetail.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| COMM-007 | Feed | Community | `/community/feed` | src/pages/community/Feed.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| COMM-008 | Challenges | Community | `/community/challenges` | src/pages/community/Challenges.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| COMM-009 | Groups | Community | `/community/groups` | src/pages/community/Groups.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| DISC-001 | Discover Overview | Discover | `/discover` | src/pages/Discover.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| DISC-002 | Supplements | Discover | `/discover/supplements` | src/pages/discover/Supplements.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| DISC-003 | Wellness Services | Discover | `/discover/wellness-services` | src/pages/discover/WellnessServices.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| DISC-004 | Doctors & Coaches | Discover | `/discover/doctors-coaches` | src/pages/discover/DoctorsCoaches.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| DISC-005 | Deals & Offers | Discover | `/discover/deals-offers` | src/pages/discover/DealsOffers.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| DISC-006 | Orders | Discover | `/discover/orders` | src/pages/discover/Orders.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| DISC-007 | Product Detail | Discover | `/discover/product/:productId` | src/pages/discover/ProductDetail.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| DISC-008 | Provider Profile | Discover | `/discover/provider/:providerId` | src/pages/discover/ProviderProfile.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| DISC-009 | Cart | Discover | `/discover/cart` | src/pages/discover/Cart.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| HLTH-001 | Health Overview | Health | `/health` | src/pages/Health.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| HLTH-002 | Services Hub | Health | `/health/services-hub` | src/pages/health/ServicesHub.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HLTH-003 | My Biology (Biomarkers) | Health | `/health/biomarkers` | src/pages/health/Biomarkers.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| HLTH-004 | Plans | Health | `/health/plans` | src/pages/health/Plans.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HLTH-005 | Education | Health | `/health/education` | src/pages/health/Education.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HLTH-006 | Pillars | Health | `/health/pillars` | src/pages/health/Pillars.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| HLTH-007 | Conditions & Risks | Health | `/health/conditions` | src/pages/health/ConditionsRisks.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| INBX-001 | Inbox Overview | Inbox | `/inbox` | src/pages/Inbox.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| INBX-002 | Reminder | Inbox | `/inbox/reminder` | src/pages/inbox/Reminder.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| INBX-003 | Inspiration | Inbox | `/inbox/inspiration` | src/pages/inbox/Inspiration.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| INBX-004 | Archived | Inbox | `/inbox/archived` | src/pages/inbox/Archived.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| AI-001 | AI Overview | AI | `/ai` | src/pages/ai/AIOverview.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| AI-002 | Insights | AI | `/ai/insights` | src/pages/ai/Insights.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| AI-003 | Recommendations | AI | `/ai/recommendations` | src/pages/ai/Recommendations.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| AI-004 | Daily Summary | AI | `/ai/daily-summary` | src/pages/ai/DailySummary.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| AI-005 | Companion | AI | `/ai/companion` | src/pages/ai/Companion.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| WLLT-001 | Wallet Overview | Wallet | `/wallet` | src/pages/Wallet.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| WLLT-002 | Wallet Balance | Wallet | `/wallet/balance` | src/pages/wallet/Balance.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| WLLT-003 | Transactions | Wallet | `/wallet/transactions` | src/pages/wallet/Transactions.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| WLLT-004 | Send Money | Wallet | `/wallet/send` | src/pages/wallet/Send.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| WLLT-005 | Receive Money | Wallet | `/wallet/receive` | src/pages/wallet/Receive.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| WLLT-006 | Payment Methods | Wallet | `/wallet/payment-methods` | src/pages/wallet/PaymentMethods.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| WLLT-007 | Currency Exchange | Wallet | `/wallet/exchange` | src/pages/wallet/Exchange.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| SHAR-001 | Sharing Overview | Sharing | `/sharing` | src/pages/Sharing.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| SHAR-002 | Distribution | Sharing | `/sharing/distribution` | src/pages/sharing/Distribution.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| SHAR-003 | Posts | Sharing | `/sharing/posts` | src/pages/sharing/Posts.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| SHAR-004 | Campaigns | Sharing | `/sharing/campaigns` | src/pages/sharing/Campaigns.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| SHAR-005 | Channels | Sharing | `/sharing/channels` | src/pages/sharing/Channels.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| SHAR-006 | Analytics | Sharing | `/sharing/analytics` | src/pages/sharing/Analytics.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| SHAR-007 | Planner | Sharing | `/sharing/planner` | src/pages/sharing/Planner.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| MEMR-001 | Memory Overview | Memory | `/memory` | src/pages/Memory.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| MEMR-002 | Diary | Memory | `/memory/diary` | src/pages/memory/Diary.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| MEMR-003 | Photos | Memory | `/memory/photos` | src/pages/memory/Photos.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| MEMR-004 | Journal | Memory | `/memory/journal` | src/pages/memory/Journal.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| MEMR-005 | Milestones | Memory | `/memory/milestones` | src/pages/memory/Milestones.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| MEMR-006 | Archive | Memory | `/memory/archive` | src/pages/memory/Archive.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| STNG-001 | Settings Overview | Settings | `/settings` | src/pages/Settings.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-002 | Profile | Settings | `/settings/profile` | src/pages/settings/Profile.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-003 | Account | Settings | `/settings/account` | src/pages/settings/Account.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-004 | Privacy | Settings | `/settings/privacy` | src/pages/settings/Privacy.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-005 | Security | Settings | `/settings/security` | src/pages/settings/Security.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-006 | Notifications | Settings | `/settings/notifications` | src/pages/settings/Notifications.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-007 | Preferences | Settings | `/settings/preferences` | src/pages/settings/Preferences.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-008 | Connections | Settings | `/settings/connections` | src/pages/settings/Connections.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| STNG-009 | Subscription | Settings | `/settings/subscription` | src/pages/settings/Subscription.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| UTIL-001 | User Profile | Utility | `/u/:handle` | src/pages/UserProfile.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| UTIL-002 | Calendar | Utility | `/calendar` | src/pages/Calendar.tsx | Community, Patient, Professional, Staff, Admin | ✅ |
| UTIL-003 | Search | Utility | `/search` | src/pages/Search.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| UTIL-004 | Notifications | Utility | `/notifications` | src/pages/Notifications.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| UTIL-005 | Help Center | Utility | `/help` | src/pages/Help.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| UTIL-006 | Feedback | Utility | `/feedback` | src/pages/Feedback.tsx | Community, Patient, Professional, Staff, Admin | 🚧 |
| PTNT-001 | Patient Portal | Patient | `/patient` | src/pages/patient/Dashboard.tsx | Patient | ✅ |
| PTNT-002 | Medical Records | Patient | `/patient/medical-records` | src/pages/patient/MedicalRecords.tsx | Patient | 🚧 |
| PTNT-003 | Appointments | Patient | `/patient/appointments` | src/pages/patient/Appointments.tsx | Patient | 🚧 |
| PTNT-004 | Test Results | Patient | `/patient/test-results` | src/pages/patient/TestResults.tsx | Patient | 🚧 |
| PTNT-005 | Care Team | Patient | `/patient/care-team` | src/pages/patient/CareTeam.tsx | Patient | 🚧 |
| PTNT-006 | Health Goals | Patient | `/patient/health-goals` | src/pages/patient/HealthGoals.tsx | Patient | 🚧 |
| PTNT-007 | Insurance | Patient | `/patient/insurance` | src/pages/patient/Insurance.tsx | Patient | 🚧 |
| PTNT-008 | Notifications | Patient | `/patient/notifications` | src/pages/patient/Notifications.tsx | Patient | 🚧 |
| PTNT-009 | Settings | Patient | `/patient/settings` | src/pages/patient/Settings.tsx | Patient | 🚧 |
| PROF-001 | Professional Dashboard | Professional | `/professional` | src/pages/professional/Dashboard.tsx | Professional | ✅ |
| PROF-002 | Patients | Professional | `/professional/patients` | src/pages/professional/Patients.tsx | Professional | 🚧 |
| PROF-003 | Schedule | Professional | `/professional/schedule` | src/pages/professional/Schedule.tsx | Professional | 🚧 |
| PROF-004 | Clinical Tools | Professional | `/professional/clinical-tools` | src/pages/professional/ClinicalTools.tsx | Professional | 🚧 |
| PROF-005 | Referrals | Professional | `/professional/referrals` | src/pages/professional/Referrals.tsx | Professional | 🚧 |
| PROF-006 | Billing | Professional | `/professional/billing` | src/pages/professional/Billing.tsx | Professional | 🚧 |
| PROF-007 | Professional Profile | Professional | `/professional/profile` | src/pages/professional/Profile.tsx | Professional | 🚧 |
| PROF-008 | Education | Professional | `/professional/education` | src/pages/professional/Education.tsx | Professional | 🚧 |
| PROF-009 | Settings | Professional | `/professional/settings` | src/pages/professional/Settings.tsx | Professional | 🚧 |
| STFF-001 | Staff Dashboard | Staff | `/staff` | src/pages/staff/Dashboard.tsx | Staff | ✅ |
| STFF-002 | Queue | Staff | `/staff/queue` | src/pages/staff/Queue.tsx | Staff | 🚧 |
| STFF-003 | Daily Tasks | Staff | `/staff/daily-tasks` | src/pages/staff/DailyTasks.tsx | Staff | 🚧 |
| STFF-004 | Schedule | Staff | `/staff/schedule` | src/pages/staff/Schedule.tsx | Staff | 🚧 |
| STFF-005 | Reports | Staff | `/staff/reports` | src/pages/staff/Reports.tsx | Staff | 🚧 |
| STFF-006 | Communications | Staff | `/staff/communications` | src/pages/staff/Communications.tsx | Staff | 🚧 |
| STFF-007 | Staff Tools | Staff | `/staff/tools` | src/pages/staff/StaffTools.tsx | Staff | 🚧 |
| STFF-008 | Time Tracking | Staff | `/staff/time-tracking` | src/pages/staff/TimeTracking.tsx | Staff | 🚧 |
| STFF-009 | Settings | Staff | `/staff/settings` | src/pages/staff/Settings.tsx | Staff | 🚧 |
| ADMN-001 | Admin Dashboard | Admin | `/admin` | src/pages/admin/Dashboard.tsx | Admin | ✅ |
| ADMN-002 | Overview | Admin | `/admin/overview` | src/pages/admin/Overview.tsx | Admin | ✅ |
| ADMN-010 | User Management | Admin | `/admin/user-management` | src/pages/admin/UserManagement.tsx | Admin | ✅ |
| ADMN-011 | Roles & Permissions | Admin | `/admin/roles-permissions` | src/pages/admin/RolesPermissions.tsx | Admin | 🚧 |
| ADMN-012 | User Activity | Admin | `/admin/user-activity` | src/pages/admin/UserActivity.tsx | Admin | 🚧 |
| ADMN-030 | Content Moderation | Admin | `/admin/content-moderation` | src/pages/admin/ContentModeration.tsx | Admin | ✅ |
| ADMN-031 | Event Moderation | Admin | `/admin/event-moderation` | src/pages/admin/EventModeration.tsx | Admin | ✅ |
| ADMN-032 | Reports Management | Admin | `/admin/reports-management` | src/pages/admin/ReportsManagement.tsx | Admin | 🚧 |
| ADMN-033 | Community Guidelines | Admin | `/admin/community-guidelines` | src/pages/admin/CommunityGuidelines.tsx | Admin | 🚧 |
| ADMN-040 | Analytics Dashboard | Admin | `/admin/analytics` | src/pages/admin/Analytics.tsx | Admin | 🚧 |
| ADMN-041 | User Metrics | Admin | `/admin/user-metrics` | src/pages/admin/UserMetrics.tsx | Admin | 🚧 |
| ADMN-042 | Engagement Metrics | Admin | `/admin/engagement-metrics` | src/pages/admin/EngagementMetrics.tsx | Admin | 🚧 |
| ADMN-043 | Revenue Reports | Admin | `/admin/revenue-reports` | src/pages/admin/RevenueReports.tsx | Admin | 🚧 |
| ADMN-050 | System Configuration | Admin | `/admin/system-config` | src/pages/admin/SystemConfig.tsx | Admin | ✅ |
| ADMN-051 | Feature Flags | Admin | `/admin/feature-flags` | src/pages/admin/FeatureFlags.tsx | Admin | 🚧 |
| ADMN-052 | API Keys | Admin | `/admin/api-keys` | src/pages/admin/ApiKeys.tsx | Admin | 🚧 |
| ADMN-053 | Database Management | Admin | `/admin/database-management` | src/pages/admin/DatabaseManagement.tsx | Admin | 🚧 |
| ADMN-060 | Notifications Admin | Admin | `/admin/notifications` | src/pages/admin/NotificationsAdmin.tsx | Admin | 🚧 |
| ADMN-061 | Email Templates | Admin | `/admin/email-templates` | src/pages/admin/EmailTemplates.tsx | Admin | 🚧 |
| ADMN-062 | Push Notifications | Admin | `/admin/push-notifications` | src/pages/admin/PushNotifications.tsx | Admin | 🚧 |
| ADMN-063 | SMS Management | Admin | `/admin/sms-management` | src/pages/admin/SmsManagement.tsx | Admin | 🚧 |
| ADMN-070 | Agent Management | Admin | `/admin/agent-management` | src/pages/admin/AgentManagement.tsx | Admin | ✅ |
| ADMN-071 | Autopilot Dashboard | Admin | `/admin/autopilot` | src/pages/admin/AutopilotDashboard.tsx | Admin | ✅ |
| ADMN-072 | Autopilot Actions | Admin | `/admin/autopilot/actions` | src/pages/admin/AutopilotActions.tsx | Admin | ✅ |
| ADMN-073 | Autopilot Templates | Admin | `/admin/autopilot/templates` | src/pages/admin/AutopilotTemplates.tsx | Admin | ✅ |
| ADMN-074 | Autopilot Feedback | Admin | `/admin/autopilot/feedback` | src/pages/admin/AutopilotFeedback.tsx | Admin | ✅ |
| ADMN-075 | Rule Builder | Admin | `/admin/rule-builder` | src/pages/admin/RuleBuilder.tsx | Admin | ✅ |
| ADMN-076 | Rule Editor | Admin | `/admin/rule-builder/:ruleId` | src/pages/admin/RuleEditor.tsx | Admin | ✅ |
| ADMN-077 | Rule Testing | Admin | `/admin/rule-builder/:ruleId/test` | src/pages/admin/RuleTesting.tsx | Admin | ✅ |
| ADMN-078 | Execution Logs | Admin | `/admin/execution-logs` | src/pages/admin/ExecutionLogs.tsx | Admin | ✅ |
| ADMN-079 | Proactive AI | Admin | `/admin/proactive-ai` | src/pages/admin/ProactiveAI.tsx | Admin | ✅ |
| ADMN-080 | API Integrations | Admin | `/admin/api-integrations` | src/pages/admin/ApiIntegrations.tsx | Admin | ✅ |
| ADMN-081 | Integration Config | Admin | `/admin/api-integrations/:integrationId` | src/pages/admin/IntegrationConfig.tsx | Admin | ✅ |
| ADMN-082 | Integration Testing | Admin | `/admin/api-integrations/:integrationId/test` | src/pages/admin/IntegrationTesting.tsx | Admin | ✅ |
| ADMN-090 | Audit Logs | Admin | `/admin/audit-logs` | src/pages/admin/AuditLogs.tsx | Admin | 🚧 |
| ADMN-091 | System Logs | Admin | `/admin/system-logs` | src/pages/admin/SystemLogs.tsx | Admin | 🚧 |
| ADMN-092 | Error Tracking | Admin | `/admin/error-tracking` | src/pages/admin/ErrorTracking.tsx | Admin | 🚧 |
| ADMN-093 | Performance Monitoring | Admin | `/admin/performance-monitoring` | src/pages/admin/PerformanceMonitoring.tsx | Admin | 🚧 |
| ADMN-100 | Live Stream Control | Admin | `/admin/live-stream-control` | src/pages/admin/LiveStreamControl.tsx | Admin | ✅ |
| ADMN-101 | Stream Analytics | Admin | `/admin/stream-analytics` | src/pages/admin/StreamAnalytics.tsx | Admin | 🚧 |
| ADMN-102 | Stream Quality Monitoring | Admin | `/admin/stream-quality` | src/pages/admin/StreamQuality.tsx | Admin | 🚧 |
| ADMN-103 | Recording Manager | Admin | `/admin/recording-manager` | src/pages/admin/RecordingManager.tsx | Admin | 🚧 |
| ADMN-104 | Broadcast Settings | Admin | `/admin/broadcast-settings` | src/pages/admin/BroadcastSettings.tsx | Admin | 🚧 |
| DEV-001 | Dev Hub Dashboard | Dev Hub | `/dev` | src/routes/dev/index.tsx | Admin (Dev) | ✅ |
| DEV-002 | Dev Login | Dev Hub | `/dev/login` | src/routes/dev/login.tsx | Public | ✅ |
| DEV-003 | Dev Dashboard | Dev Hub | `/dev/dashboard` | src/routes/dev/dashboard/index.tsx | Admin (Dev) | ✅ |
| DEV-004 | Dev Analytics | Dev Hub | `/dev/dashboard/analytics` | src/routes/dev/dashboard/analytics.tsx | Admin (Dev) | ✅ |
| DEV-005 | Dev Health | Dev Hub | `/dev/dashboard/health` | src/routes/dev/dashboard/health.tsx | Admin (Dev) | ✅ |
| DEV-006 | Dev Logs | Dev Hub | `/dev/dashboard/logs` | src/routes/dev/dashboard/logs.tsx | Admin (Dev) | ✅ |
| DEV-010 | Command Center | Dev Hub | `/dev/command` | src/routes/dev/command/index.tsx | Admin (Dev) | ✅ |
| DEV-011 | Terminal | Dev Hub | `/dev/command/terminal` | src/routes/dev/command/terminal.tsx | Admin (Dev) | ✅ |
| DEV-012 | Scripts | Dev Hub | `/dev/command/scripts` | src/routes/dev/command/scripts.tsx | Admin (Dev) | ✅ |
| DEV-013 | Cron Jobs | Dev Hub | `/dev/command/cron` | src/routes/dev/command/cron.tsx | Admin (Dev) | ✅ |
| DEV-014 | Webhooks | Dev Hub | `/dev/command/webhooks` | src/routes/dev/command/webhooks.tsx | Admin (Dev) | ✅ |
| DEV-015 | Tasks | Dev Hub | `/dev/command/tasks` | src/routes/dev/command/tasks.tsx | Admin (Dev) | ✅ |
| DEV-020 | Agents | Dev Hub | `/dev/agents` | src/routes/dev/agents/index.tsx | Admin (Dev) | ✅ |
| DEV-021 | Agent Monitor | Dev Hub | `/dev/agents/monitor` | src/routes/dev/agents/monitor.tsx | Admin (Dev) | ✅ |
| DEV-022 | Agent Logs | Dev Hub | `/dev/agents/logs` | src/routes/dev/agents/logs.tsx | Admin (Dev) | ✅ |
| DEV-023 | Agent Config | Dev Hub | `/dev/agents/config` | src/routes/dev/agents/config.tsx | Admin (Dev) | ✅ |
| DEV-024 | Agent Crew | Dev Hub | `/dev/agents/crew` | src/routes/dev/agents/crew.tsx | Admin (Dev) | ✅ |
| DEV-030 | Pipelines | Dev Hub | `/dev/pipelines` | src/routes/dev/pipelines/index.tsx | Admin (Dev) | ✅ |
| DEV-031 | Pipeline Builder | Dev Hub | `/dev/pipelines/builder` | src/routes/dev/pipelines/builder.tsx | Admin (Dev) | ✅ |
| DEV-032 | Pipeline Runs | Dev Hub | `/dev/pipelines/runs` | src/routes/dev/pipelines/runs.tsx | Admin (Dev) | ✅ |
| DEV-033 | Pipeline Monitor | Dev Hub | `/dev/pipelines/monitor` | src/routes/dev/pipelines/monitor.tsx | Admin (Dev) | ✅ |
| DEV-040 | OASIS | Dev Hub | `/dev/oasis` | src/routes/dev/oasis/index.tsx | Admin (Dev) | ✅ |
| DEV-041 | OASIS Events | Dev Hub | `/dev/oasis/events` | src/routes/dev/oasis/events.tsx | Admin (Dev) | ✅ |
| DEV-042 | OASIS Projections | Dev Hub | `/dev/oasis/projections` | src/routes/dev/oasis/projections.tsx | Admin (Dev) | ✅ |
| DEV-043 | OASIS Config | Dev Hub | `/dev/oasis/config` | src/routes/dev/oasis/config.tsx | Admin (Dev) | ✅ |
| DEV-044 | OASIS Debugging | Dev Hub | `/dev/oasis/debug` | src/routes/dev/oasis/debug.tsx | Admin (Dev) | ✅ |
| DEV-050 | Proactive Lab | Dev Hub | `/dev/proactive` | src/routes/dev/proactive/index.tsx | Admin (Dev) | ✅ |
| DEV-051 | Situation Analysis | Dev Hub | `/dev/proactive/analysis` | src/routes/dev/proactive/analysis.tsx | Admin (Dev) | ✅ |
| DEV-052 | Recommendation Review | Dev Hub | `/dev/proactive/recommendations` | src/routes/dev/proactive/recommendations.tsx | Admin (Dev) | ✅ |
| DEV-053 | Training Data | Dev Hub | `/dev/proactive/training` | src/routes/dev/proactive/training.tsx | Admin (Dev) | ✅ |
| DEV-054 | Playground | Dev Hub | `/dev/proactive/playground` | src/routes/dev/proactive/playground.tsx | Admin (Dev) | ✅ |
| DEV-060 | Governance Lab | Dev Hub | `/dev/governance` | src/routes/dev/governance/index.tsx | Admin (Dev) | ✅ |
| DEV-061 | Rule Designer | Dev Hub | `/dev/governance/designer` | src/routes/dev/governance/designer.tsx | Admin (Dev) | ✅ |
| DEV-062 | Evaluation Logs | Dev Hub | `/dev/governance/evaluations` | src/routes/dev/governance/evaluations.tsx | Admin (Dev) | ✅ |
| DEV-063 | Category Manager | Dev Hub | `/dev/governance/categories` | src/routes/dev/governance/categories.tsx | Admin (Dev) | ✅ |
| DEV-064 | Enforcement History | Dev Hub | `/dev/governance/enforcement` | src/routes/dev/governance/enforcement.tsx | Admin (Dev) | ✅ |
| DEV-070 | Data Tools | Dev Hub | `/dev/data` | src/routes/dev/data/index.tsx | Admin (Dev) | ✅ |
| DEV-071 | Database Explorer | Dev Hub | `/dev/data/explorer` | src/routes/dev/data/explorer.tsx | Admin (Dev) | ✅ |
| DEV-072 | Query Builder | Dev Hub | `/dev/data/query` | src/routes/dev/data/query.tsx | Admin (Dev) | ✅ |
| DEV-073 | Migrations | Dev Hub | `/dev/data/migrations` | src/routes/dev/data/migrations.tsx | Admin (Dev) | ✅ |
| DEV-074 | Backups | Dev Hub | `/dev/data/backups` | src/routes/dev/data/backups.tsx | Admin (Dev) | ✅ |
| DEV-080 | API Studio | Dev Hub | `/dev/api` | src/routes/dev/api/index.tsx | Admin (Dev) | ✅ |
| DEV-081 | Endpoint Tester | Dev Hub | `/dev/api/tester` | src/routes/dev/api/tester.tsx | Admin (Dev) | ✅ |
| DEV-082 | API Documentation | Dev Hub | `/dev/api/docs` | src/routes/dev/api/docs.tsx | Admin (Dev) | ✅ |
| DEV-083 | Rate Limits | Dev Hub | `/dev/api/rate-limits` | src/routes/dev/api/rate-limits.tsx | Admin (Dev) | ✅ |
| DEV-084 | API Keys Manager | Dev Hub | `/dev/api/keys` | src/routes/dev/api/keys.tsx | Admin (Dev) | ✅ |
| DEV-090 | Security Center | Dev Hub | `/dev/security` | src/routes/dev/security/index.tsx | Admin (Dev) | ✅ |
| DEV-091 | Vulnerability Scan | Dev Hub | `/dev/security/vulnerabilities` | src/routes/dev/security/vulnerabilities.tsx | Admin (Dev) | ✅ |
| DEV-092 | Access Logs | Dev Hub | `/dev/security/access-logs` | src/routes/dev/security/access-logs.tsx | Admin (Dev) | ✅ |
| DEV-093 | Permissions Audit | Dev Hub | `/dev/security/permissions` | src/routes/dev/security/permissions.tsx | Admin (Dev) | ✅ |
| DEV-094 | Secrets Manager | Dev Hub | `/dev/security/secrets` | src/routes/dev/security/secrets.tsx | Admin (Dev) | ✅ |
| GLBL-001 | VITANALAND World Layer | Global Overlays | N/A | src/components/vitanaland/VitanalandWorldLayer.tsx | All | ✅ |
| GLBL-002 | VITANA Orb | Global Overlays | N/A | src/components/vitanaland/VitanaOrbButton.tsx | All | ✅ |
| GLBL-003 | Profile Quick Preview | Global Overlays | N/A | src/components/profile/ProfilePreviewDialog.tsx | All | ✅ |
| GLBL-004 | Meetup Details Drawer | Global Overlays | N/A | src/components/meetups/MeetupDetailsDrawer.tsx | All | ✅ |
| GLBL-005 | Live Room Drawer | Global Overlays | N/A | src/components/liverooms/LiveRoomDrawer.tsx | All | ✅ |
| GLBL-006 | Event Details Drawer | Global Overlays | N/A | src/components/community/EventDetailsDrawer.tsx | All | ✅ |
| GLBL-007 | Group Details Drawer | Global Overlays | N/A | src/components/community/GroupDetailsDrawer.tsx | All | ✅ |
| GLBL-008 | Product Quick View | Global Overlays | N/A | src/components/discover/ProductQuickView.tsx | All | ✅ |

---

# Maxina Screens

Available to Maxina tenant (202 screens = 199 Global + 3 Maxina-specific)

**Includes all Global screens plus:**

| Screen ID | Screen Name | Module | External Route | Dev Component Path | Roles with Access | Status |
|-----------|-------------|--------|----------------|-------------------|-------------------|--------|
| AUTH-003 | Maxina Portal Login | Authentication | `/maxina` | src/pages/portals/MaxinaPortal.tsx | Public | ✅ |
| AUTH-008 | Intro Experience | Onboarding | `/_intro/:tenantSlug` | src/pages/intro/IntroExperience.tsx | Public | ✅ |
| AUTH-009 | Email Confirmation (Maxina) | Authentication | `/maxina/confirmed` | src/pages/portals/MaxinaConfirmed.tsx | Public | ✅ |

---

# Alkalma Screens

Available to Alkalma tenant (202 screens = 199 Global + 3 Alkalma-specific)

**Includes all Global screens plus:**

| Screen ID | Screen Name | Module | External Route | Dev Component Path | Roles with Access | Status |
|-----------|-------------|--------|----------------|-------------------|-------------------|--------|
| AUTH-004 | Alkalma Portal Login | Authentication | `/alkalma` | src/pages/portals/AlkalmaPortal.tsx | Public | 🚧 |
| AUTH-008 | Intro Experience | Onboarding | `/_intro/:tenantSlug` | src/pages/intro/IntroExperience.tsx | Public | ✅ |
| AUTH-010 | Email Confirmation (Alkalma) | Authentication | `/alkalma/confirmed` | src/pages/portals/AlkalmaConfirmed.tsx | Public | ✅ |

---

# Earthlinks Screens

Available to Earthlinks tenant (202 screens = 199 Global + 3 Earthlinks-specific)

**Includes all Global screens plus:**

| Screen ID | Screen Name | Module | External Route | Dev Component Path | Roles with Access | Status |
|-----------|-------------|--------|----------------|-------------------|-------------------|--------|
| AUTH-005 | Earthlinks Portal Login | Authentication | `/earthlinks` | src/pages/portals/EarthlinksPortal.tsx | Public | 🚧 |
| AUTH-008 | Intro Experience | Onboarding | `/_intro/:tenantSlug` | src/pages/intro/IntroExperience.tsx | Public | ✅ |
| AUTH-011 | Email Confirmation (Earthlinks) | Authentication | `/earthlinks/confirmed` | src/pages/portals/EarthlinksConfirmed.tsx | Public | ✅ |

---

# Exafy Screens

Available to Exafy (internal only) tenant (206 screens = 199 Global + 7 Exafy-specific)

**Includes all Global screens plus:**

| Screen ID | Screen Name | Module | External Route | Internal/Admin Route | Dev Component Path | Roles with Access | Status |
|-----------|-------------|--------|----------------|---------------------|-------------------|-------------------|--------|
| AUTH-007 | Exafy Admin Portal Login | Authentication | `/exafy-admin` | N/A | src/pages/portals/ExafyAdminPortal.tsx | Admin (Exafy) | 🚧 |
| AUTH-008 | Intro Experience | Onboarding | `/_intro/:tenantSlug` | N/A | src/pages/intro/IntroExperience.tsx | Public | ✅ |
| AUTH-013 | Email Confirmation (Exafy) | Authentication | `/exafy-admin/confirmed` | N/A | src/pages/portals/ExafyAdminConfirmed.tsx | Admin (Exafy) | ✅ |
| ADMN-020 | Tenant Management | Admin | `/admin/tenant-management` | `/admin/tenant-management` | src/pages/admin/TenantManagement.tsx | Admin (Exafy) | ✅ |
| ADMN-021 | Tenant Details | Admin | `/admin/tenant-management/:tenantId` | `/admin/tenant-management/:tenantId` | src/pages/admin/TenantDetails.tsx | Admin (Exafy) | ✅ |
| ADMN-022 | Create Tenant | Admin | `/admin/tenant-management/create` | `/admin/tenant-management/create` | src/pages/admin/CreateTenant.tsx | Admin (Exafy) | ✅ |
| ADMN-023 | Tenant Analytics | Admin | `/admin/tenant-analytics` | `/admin/tenant-analytics` | src/pages/admin/TenantAnalytics.tsx | Admin (Exafy) | ✅ |

---

# Business Hub Screens by Tenant

The Business Hub is available across all tenants with the following restrictions:

## Exafy (Full Access)

| Screen ID | Screen Name | Route | Status |
|-----------|-------------|-------|--------|
| BIZ-001 | Business Hub Overview | `/business` | ✅ |
| BIZ-002 | Business Services | `/business/services` | ✅ |
| BIZ-003 | Business Clients | `/business/clients` | 🚧 |
| BIZ-004 | Sell & Earn | `/business/sell-earn` | ✅ |
| BIZ-005 | Business Analytics | `/business/analytics` | ✅ |

**Exafy Business Hub Total: 5 screens**

## Maxina (Full Access - Monetization Focus)

| Screen ID | Screen Name | Route | Status |
|-----------|-------------|-------|--------|
| BIZ-001 | Business Hub Overview | `/business` | ✅ |
| BIZ-002 | Business Services | `/business/services` | ✅ |
| BIZ-003 | Business Clients | `/business/clients` | 🚧 |
| BIZ-004 | Sell & Earn | `/business/sell-earn` | ✅ |
| BIZ-005 | Business Analytics | `/business/analytics` | ✅ |

**Maxina Business Hub Total: 5 screens**


## AlKalma (Limited - Clinical Constraints)

| Screen ID | Screen Name | Route | Status | Notes |
|-----------|-------------|-------|--------|-------|
| BIZ-001 | Business Hub Overview | `/business` | ✅ | Full access |
| BIZ-002 | Business Services | `/business/services` | ✅ | Full access |
| BIZ-003 | Business Clients | `/business/clients` | 🚧 | Full access |
| BIZ-004 | Sell & Earn | `/business/sell-earn` | ❌ | Clinical constraints - not available |
| BIZ-005 | Business Analytics | `/business/analytics` | ✅ | Limited to Performance tab only |

**AlKalma Business Hub Total: 4 screens** (Sell & Earn restricted)

## Earthlinks (Selective - Community-Based)

| Screen ID | Screen Name | Route | Status | Notes |
|-----------|-------------|-------|--------|-------|
| BIZ-001 | Business Hub Overview | `/business` | ✅ | Full access |
| BIZ-002 | Business Services | `/business/services` | ✅ | Full access |
| BIZ-003 | Business Clients | `/business/clients` | 🚧 | Full access |
| BIZ-004 | Sell & Earn | `/business/sell-earn` | ❌ | Community-based - not available |
| BIZ-005 | Business Analytics | `/business/analytics` | ❌ | Community-based - not available |

**Earthlinks Business Hub Total: 3 screens** (Sell & Earn and Analytics restricted)

---

## Business Hub Tenant Summary

| Tenant | Business Hub Screens | Restrictions |
|--------|---------------------|--------------|
| Exafy | 5 (full) | None |
| Maxina | 5 (full) | None |
| AlKalma | 4 | No Sell & Earn |
| Earthlinks | 3 | No Sell & Earn, no Analytics |

---

## Notes

- **Global screens** are the base set available to all tenants
- Each tenant-specific screen is **additive** to the Global set
- **Dev Hub screens** (DEV-* prefix) are considered "Global (Dev)" but only accessible to users with dev credentials
- **Exafy tenant** has the most screens as it includes tenant management capabilities
- **Business Hub**: Tabs within screens are subroutes, not separate screens per VITANA registry policy
- **Implementation progress**:
  - Global: 49% implemented
  - Maxina: 49% implemented
  - Alkalma: 49% implemented
  - Earthlinks: 49% implemented
  - Exafy: 49% implemented

---

**End of Document**
