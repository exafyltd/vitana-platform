/**
 * Automation Registry — Static definitions of all AP-XXXX automations
 *
 * VTID: VTID-01250 (Autopilot Automations Engine)
 *
 * This is the code-level registry. The canonical documentation lives in
 * docs/autopilot-automations/. Each entry maps an AP-XXXX ID to its
 * trigger configuration and handler function name.
 *
 * Only automations with status IMPLEMENTED or LIVE have handlers.
 * PLANNED automations are registered for tracking but skip execution.
 */

import { AutomationDefinition } from '../types/automations';

// =============================================================================
// Role targeting constants for readability
// =============================================================================
/**
 * Role model:
 *   community   — Primary user. Socializes, creates businesses/shops/services, buys, books.
 *                  This is the default onboarding role for the first 6 months.
 *   patient     — Person receiving medical care from a professional (doctor).
 *   professional— Medical doctor in hospital/clinic. Uploads reports, manages clinical relationships.
 *                  Regulated role — ONLY appears in health/medical automation contexts.
 *   staff       — Back-office employees at hospital, lab, enterprise. Operational role.
 *   admin       — Platform administrator.
 *   developer   — Internal platform developer.
 */

/** Community-facing: all member-facing roles (community, patient, professional) */
const MEMBER_ROLES = ['community', 'patient', 'professional'] as const;
/** Patient-only: health intelligence automations requiring health data */
const PATIENT_ROLES = ['patient'] as const;
/** Medical professional: doctor/clinician — ONLY for medical/health contexts */
const MEDICAL_ROLES = ['professional'] as const;
/** Creator roles: community users who create businesses, shops, services, live rooms */
const CREATOR_ROLES = ['community'] as const;
/** Consumer roles: patient + community (buy, book, discover) */
const CONSUMER_ROLES = ['community', 'patient'] as const;
/** Clinical: both sides of the medical relationship */
const CLINICAL_ROLES = ['patient', 'professional'] as const;
/** Operations: staff + admin for platform ops */
const OPS_ROLES = ['staff', 'admin'] as const;
/** Everyone: runs for all roles without filtering */
const ALL_ROLES = 'all' as const;

// =============================================================================
// AP-0100: Connect People
// =============================================================================
const CONNECT_PEOPLE: AutomationDefinition[] = [
  {
    id: 'AP-0101', name: 'Daily Match Delivery', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 * * *' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runDailyMatchDelivery',
  },
  {
    id: 'AP-0102', name: '"Someone Shares Your Interest" Nudge', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 }, // every 6h
    targetRoles: [...MEMBER_ROLES],
    handler: 'runSharedInterestNudge',
  },
  {
    id: 'AP-0103', name: 'Mutual Accept Auto-Introduction', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.state.accepted' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runMutualAcceptIntroduction',
    requires: ['AP-0101'],
  },
  {
    id: 'AP-0104', name: 'First Conversation Starter', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 120 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runFirstConversationStarter',
    requires: ['AP-0103'],
  },
  {
    id: 'AP-0105', name: 'Group Recommendation Push', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' }, // Monday 10am
    targetRoles: [...MEMBER_ROLES],
    handler: 'runGroupRecommendationPush',
  },
  {
    id: 'AP-0106', name: '"People You Know Are Here" Social Proof', domain: 'connect-people',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.group.viewed' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0107', name: 'Proactive Social Alignment Suggestions', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 9 * * 1' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runSocialAlignmentSuggestions',
  },
  {
    id: 'AP-0108', name: 'Match Quality Learning Loop', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.feedback.submitted' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runMatchQualityLoop',
  },
  {
    id: 'AP-0109', name: 'Proactive Match Batch Delivery', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 60 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runProactiveMatchBatch',
  },
  {
    id: 'AP-0110', name: 'Opportunity Surfacing with Social Layer', domain: 'connect-people',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'opportunity.detected' },
    targetRoles: [...MEMBER_ROLES],
  },
];

// =============================================================================
// AP-0200: Community & Groups
// =============================================================================
const COMMUNITY_GROUPS: AutomationDefinition[] = [
  {
    id: 'AP-0201', name: 'Auto-Create Group from Interest Cluster', domain: 'community-groups',
    status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0202', name: 'Group Invite Follow-Up', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runGroupInviteFollowUp',
  },
  {
    id: 'AP-0203', name: 'New Member Welcome in Group', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'community.member.joined' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runNewMemberWelcome',
  },
  {
    id: 'AP-0204', name: 'Auto-Suggest Meetup from Group Activity', domain: 'community-groups',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'community.chat.activity_spike' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0205', name: 'Group Health Monitor', domain: 'community-groups',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    targetRoles: [...OPS_ROLES],
  },
  {
    id: 'AP-0206', name: 'Cross-Group Introduction', domain: 'community-groups',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 10080 }, // weekly
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0207', name: 'Meetup RSVP Encouragement', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 60 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runMeetupRsvpEncouragement',
  },
  {
    id: 'AP-0208', name: 'Post-Meetup Connection Prompt', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.ended' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runPostMeetupConnect',
  },
  {
    id: 'AP-0209', name: 'Group Creation from Match Cluster', domain: 'community-groups',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0210', name: 'Community Digest for Group Creators', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 18 * * 0' }, // Sunday 6pm
    targetRoles: [...MEMBER_ROLES],
    handler: 'runCommunityCreatorDigest',
  },
];

// =============================================================================
// AP-0300: Events & Live Rooms
// =============================================================================
const EVENTS_LIVE_ROOMS: AutomationDefinition[] = [
  {
    id: 'AP-0301', name: 'Auto-Schedule Daily.co Room', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.created.online' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runAutoScheduleDailyRoom',
  },
  {
    id: 'AP-0302', name: 'Graduated Meetup Reminders', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 15 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runGraduatedReminders',
  },
  {
    id: 'AP-0303', name: '"Go Together" Event Match', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.daily.event' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runGoTogetherMatch',
  },
  {
    id: 'AP-0304', name: 'Post-Event Feedback & Connect', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.ended' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runPostEventFeedback',
  },
  {
    id: 'AP-0305', name: 'Trending Events Weekly Digest', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 18 * * 0' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runTrendingEventsDigest',
  },
  {
    id: 'AP-0306', name: 'Event Series Auto-Suggestion', domain: 'events-live-rooms',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-0307', name: 'Live Room from Trending Chat Topic', domain: 'events-live-rooms',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 240 },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0308', name: 'No-Show Follow-Up', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.ended' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runNoShowFollowUp',
  },
];

// =============================================================================
// AP-0400: Sharing & Growth
// =============================================================================
const SHARING_GROWTH: AutomationDefinition[] = [
  {
    id: 'AP-0401', name: 'WhatsApp Event Share Link', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'manual',
    targetRoles: [...MEMBER_ROLES],
    handler: 'generateWhatsAppEventLink',
  },
  {
    id: 'AP-0402', name: 'WhatsApp Group Invite', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'manual',
    targetRoles: [...MEMBER_ROLES],
    handler: 'generateWhatsAppGroupInvite',
  },
  {
    id: 'AP-0403', name: 'Social Media Event Card Generator', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.created' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0404', name: '"Invite a Friend" After Positive Experience', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.feedback.like' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runInviteAfterPositive',
  },
  {
    id: 'AP-0405', name: 'Referral Tracking & Reward', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.referral' },
    targetRoles: ALL_ROLES,
    handler: 'runReferralReward',
  },
  {
    id: 'AP-0406', name: 'Auto-Post Community Highlights', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 14 * * 5' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0407', name: 'User Profile Share Card', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P2', triggerType: 'manual',
    targetRoles: [...MEMBER_ROLES, 'professional'],
  },
  {
    id: 'AP-0408', name: 'Event Countdown Share Prompt', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runEventCountdownSharePrompt',
  },
  {
    id: 'AP-0409', name: '"Your Week on Vitana" Shareable Recap', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 9 * * 0' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-0410', name: 'Viral Loop: Shared Event → New User Onboarding', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.shared_link' },
    targetRoles: ALL_ROLES,
    handler: 'runViralLoopOnboarding',
  },
];

// =============================================================================
// AP-0500: Engagement Loops
// =============================================================================
const ENGAGEMENT_LOOPS: AutomationDefinition[] = [
  {
    id: 'AP-0501', name: 'Morning Briefing with Social Context', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 7 * * *' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runMorningBriefing',
  },
  {
    id: 'AP-0502', name: 'Weekly Community Digest', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 18 * * 0' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runWeeklyCommunityDigest',
  },
  {
    id: 'AP-0503', name: 'Re-Engagement for Dormant Users', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runDormantUserReEngagement',
  },
  {
    id: 'AP-0504', name: 'Milestone Celebrations', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.milestone.reached' },
    targetRoles: ALL_ROLES,
    handler: 'runMilestoneCelebration',
  },
  {
    id: 'AP-0505', name: 'Diary Reminder with Social Twist', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 21 * * *' },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runDiaryReminderSocial',
  },
  {
    id: 'AP-0506', name: 'Weekly Reflection with Connection Insights', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 20 * * 5' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runWeeklyReflection',
  },
  {
    id: 'AP-0507', name: 'Conversation Continuity Nudge', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runConversationContinuityNudge',
  },
  {
    id: 'AP-0508', name: '"Someone Viewed Your Profile" Notification', domain: 'engagement-loops',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'profile.viewed' },
    targetRoles: [...MEMBER_ROLES, 'professional'],
  },
  {
    id: 'AP-0509', name: 'Milestone Detection Scanner', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 }, // every 6h
    targetRoles: [...MEMBER_ROLES],
    handler: 'runMilestoneScanner',
  },
  {
    // BOOTSTRAP-NOTIF-SYSTEM-EVENTS: pairs with `upcoming_event_today`
    // (channel='push' in TYPE_META). Fires once per user per day for their
    // first calendar_events entry of the day.
    id: 'AP-0510', name: 'Upcoming Events Today Push', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 * * *' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runUpcomingEventsToday',
  },
];

// =============================================================================
// AP-0600: Health & Wellness
// =============================================================================
const HEALTH_WELLNESS: AutomationDefinition[] = [
  {
    id: 'AP-0601', name: 'PHI Redaction Gate', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.data.incoming' },
    targetRoles: [...CLINICAL_ROLES],
    handler: 'runPhiRedactionGate',
  },
  {
    id: 'AP-0602', name: 'Health Report Summarization', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 15 },
    targetRoles: [...CLINICAL_ROLES],
    handler: 'runHealthReportSummarization',
  },
  {
    id: 'AP-0603', name: 'Consent Check Before Health Operations', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.operation.requested' },
    targetRoles: [...CLINICAL_ROLES],
    handler: 'runConsentCheck',
  },
  {
    id: 'AP-0604', name: 'Wellness Check-In Prompt', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 3' }, // Wednesday 10am
    targetRoles: [...MEMBER_ROLES],
    handler: 'runWellnessCheckIn',
  },
  {
    id: 'AP-0605', name: 'Community Wellness Event Suggestion', domain: 'health-wellness',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 10080 },
    targetRoles: [...CONSUMER_ROLES],
  },
  {
    id: 'AP-0606', name: 'Health Data Export Reminder', domain: 'health-wellness',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 */3 *' }, // quarterly
    targetRoles: [...PATIENT_ROLES],
  },
  {
    id: 'AP-0607', name: 'Lab Report Ingestion & Biomarker Extraction', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.lab_report.uploaded' },
    targetRoles: [...CLINICAL_ROLES],
    handler: 'runLabReportIngestion',
  },
  {
    id: 'AP-0608', name: 'Biomarker Trend Analysis', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.biomarkers.stored' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runBiomarkerTrendAnalysis',
    requires: ['AP-0607'],
  },
  {
    id: 'AP-0609', name: 'Quality-of-Life Recommendation Engine', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.daily.recomputed' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runQualityOfLifeRecommendations',
  },
  {
    id: 'AP-0610', name: 'Wearable Data Anomaly Detection', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.wearable.ingested' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runWearableAnomalyDetection',
  },
  {
    id: 'AP-0611', name: 'Vitana Index Weekly Report', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 * * 1' }, // Monday 8am
    targetRoles: [...PATIENT_ROLES],
    handler: 'runVitanaIndexWeeklyReport',
  },
  {
    id: 'AP-0612', name: 'Professional Referral Suggestion', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.biomarker.critical' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runProfessionalReferral',
    requires: ['AP-0608'],
  },
  {
    id: 'AP-0613', name: 'Health Capacity Awareness for Autopilot', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'automation.pre_execute' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runHealthCapacityGate',
  },
  {
    id: 'AP-0614', name: 'Health Goal Setting Assistant', domain: 'health-wellness',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.lab_report.first' },
    targetRoles: [...PATIENT_ROLES],
  },
  {
    id: 'AP-0615', name: 'Health-Aware Product Recommendations', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.recommendations.generated' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runHealthAwareProductRecs',
    requires: ['AP-0609'],
  },
];

// =============================================================================
// AP-0700: Payments, Wallet & VTN
// =============================================================================
const PAYMENTS_WALLET: AutomationDefinition[] = [
  {
    id: 'AP-0701', name: 'Payment Failure Detection & Retry', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 15 },
    targetRoles: ALL_ROLES,
    handler: 'runPaymentFailureRetry',
  },
  {
    id: 'AP-0702', name: 'Subscription Created Audit', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'stripe.subscription.created' },
    targetRoles: ALL_ROLES,
    handler: 'runSubscriptionAudit',
  },
  {
    id: 'AP-0703', name: 'Plan Upgrade Suggestion', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.plan_limit.approaching' },
    targetRoles: [...CONSUMER_ROLES, 'professional'],
  },
  {
    id: 'AP-0704', name: 'Subscription Expiry Warning', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: ALL_ROLES,
  },
  {
    id: 'AP-0705', name: 'Payment Method Update Reminder', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'stripe.payment.failed' },
    targetRoles: ALL_ROLES,
    handler: 'runPaymentMethodReminder',
  },
  {
    id: 'AP-0706', name: 'Creator Stripe Connect Onboarding', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.listing.first' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runCreatorStripeOnboarding',
  },
  {
    id: 'AP-0707', name: 'Creator Payout Monitoring', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'stripe.connect.payout' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runCreatorPayoutMonitor',
  },
  {
    id: 'AP-0708', name: 'Wallet Credit Rewards for Engagement', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.reward_eligible' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runWalletCreditReward',
  },
  {
    id: 'AP-0709', name: 'Vitana Token (VTN) Launch Automation', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P0', triggerType: 'manual',
    targetRoles: ALL_ROLES,
  },
  {
    id: 'AP-0710', name: 'Monetization Readiness Scoring', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'automation.monetization.check' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runMonetizationReadinessCheck',
  },
  {
    id: 'AP-0711', name: 'Weekly Earnings Report for Creators', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runCreatorWeeklyEarnings',
  },
  {
    id: 'AP-0712', name: 'Spending Insights for Users', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 * *' },
    targetRoles: [...CONSUMER_ROLES],
  },
];

// =============================================================================
// AP-0800: Personalization Engines
// =============================================================================
const PERSONALIZATION: AutomationDefinition[] = [
  { id: 'AP-0801', name: 'Social Comfort-Aware Suggestions', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: [...MEMBER_ROLES] },
  { id: 'AP-0802', name: 'Taste-Aligned Event Recommendations', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: [...MEMBER_ROLES] },
  { id: 'AP-0803', name: 'Opportunity Surfacing Automation', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat', targetRoles: [...MEMBER_ROLES] },
  { id: 'AP-0804', name: 'Life-Stage Aware Communication', domain: 'personalization-engines', status: 'PLANNED', priority: 'P2', triggerType: 'event', targetRoles: [...MEMBER_ROLES] },
  { id: 'AP-0805', name: 'Overload Detection & Throttle', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: ALL_ROLES },
];

// =============================================================================
// AP-0900: Memory & Intelligence
// =============================================================================
const MEMORY_INTEL: AutomationDefinition[] = [
  { id: 'AP-0901', name: 'Memory-Informed Matching', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: [...MEMBER_ROLES] },
  { id: 'AP-0902', name: 'Fact Extraction from Conversations', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: ALL_ROLES },
  { id: 'AP-0903', name: 'Relationship Graph Maintenance', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P2', triggerType: 'cron', targetRoles: [...MEMBER_ROLES] },
  { id: 'AP-0904', name: 'Semantic Memory Search for Autopilot Context', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: ALL_ROLES },
  { id: 'AP-0905', name: 'Knowledge Base Context for Suggestions', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P2', triggerType: 'event', targetRoles: ALL_ROLES },
];

// =============================================================================
// AP-1000: Platform Operations
// =============================================================================
const PLATFORM_OPS: AutomationDefinition[] = [
  {
    id: 'AP-1001', name: 'VTID Lifecycle Automation', domain: 'platform-operations',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'vtid.state.changed' },
    targetRoles: [...OPS_ROLES, 'developer'],
    handler: 'runVtidLifecycle',
  },
  {
    id: 'AP-1002', name: 'Governance Flag Monitoring', domain: 'platform-operations',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'governance.flag.changed' },
    targetRoles: [...OPS_ROLES],
    handler: 'runGovernanceFlagCheck',
  },
  { id: 'AP-1003', name: 'Post-Deploy Health Check', domain: 'platform-operations', status: 'PLANNED', priority: 'P1', triggerType: 'event', targetRoles: [...OPS_ROLES, 'developer'] },
  { id: 'AP-1004', name: 'Service Error Rate Alert', domain: 'platform-operations', status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat', targetRoles: [...OPS_ROLES, 'developer'] },
  { id: 'AP-1005', name: 'Database Migration Verification', domain: 'platform-operations', status: 'PLANNED', priority: 'P2', triggerType: 'event', targetRoles: [...OPS_ROLES, 'developer'] },
];

// =============================================================================
// AP-1100: Business Hub & Marketplace
// =============================================================================
const BUSINESS_MARKETPLACE: AutomationDefinition[] = [
  {
    id: 'AP-1101', name: 'Service Listing Publication & Distribution', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.service.created' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runServiceListingDistribution',
  },
  {
    id: 'AP-1102', name: 'Product Listing & AI-Picks Matching', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.product.created' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runProductAiPicksMatching',
  },
  {
    id: 'AP-1103', name: 'Discover Section Personalization', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runDiscoverPersonalization',
  },
  {
    id: 'AP-1104', name: 'Client-Service Matching', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.service.search' },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runClientServiceMatching',
  },
  {
    id: 'AP-1105', name: 'Post-Service Outcome Tracking', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES, 'professional'],
    handler: 'runPostServiceOutcomeTracking',
  },
  {
    id: 'AP-1106', name: 'Shop Setup Wizard', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.business.started' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runShopSetupWizard',
  },
  {
    id: 'AP-1107', name: 'Product Review Follow-Up', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runProductReviewFollowUp',
  },
  {
    id: 'AP-1108', name: 'Creator Analytics & Growth Tips', domain: 'business-hub-marketplace',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1109', name: 'Seasonal & Trending Recommendations for Creators', domain: 'business-hub-marketplace',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 * *' },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1110', name: 'Cross-Sell Service to Product Buyers', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.product.purchased' },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runCrossSellServiceToProductBuyers',
  },
];

// =============================================================================
// AP-1200: Live Rooms Commerce
// =============================================================================
const LIVE_ROOMS_COMMERCE: AutomationDefinition[] = [
  {
    id: 'AP-1201', name: 'Paid Live Room Setup', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.service.live_room' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runPaidLiveRoomSetup',
  },
  {
    id: 'AP-1202', name: 'Live Room Booking & Payment Flow', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'live_room.booking.requested' },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runLiveRoomBookingPayment',
  },
  {
    id: 'AP-1203', name: 'Live Room Upsell from Free Content', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runLiveRoomFreeToUpSell',
  },
  {
    id: 'AP-1204', name: 'Group Session Auto-Fill', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    targetRoles: [...CONSUMER_ROLES],
    handler: 'runGroupSessionAutoFill',
  },
  {
    id: 'AP-1205', name: 'Post-Session Revenue Report', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'live_room.session.ended' },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runPostSessionRevenueReport',
  },
  {
    id: 'AP-1206', name: 'Session Highlight Clips for Marketing', domain: 'live-rooms-commerce',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'live_room.highlights.ready' },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1207', name: 'Recurring Session Auto-Scheduling', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runRecurringSessionAutoSchedule',
  },
  {
    id: 'AP-1208', name: 'Consultation Matching', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.professional_referral' },
    targetRoles: [...PATIENT_ROLES],
    handler: 'runConsultationMatching',
  },
  {
    id: 'AP-1209', name: 'Free Trial Session for New Creators', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CREATOR_ROLES],
    handler: 'runFreeTrialSessionSuggestion',
  },
  {
    id: 'AP-1210', name: 'Live Room Revenue Optimization Tips', domain: 'live-rooms-commerce',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 * *' },
    targetRoles: [...CREATOR_ROLES],
  },
];

// =============================================================================
// AP-1300: Onboarding & Viral Growth
// =============================================================================
const ONBOARDING_GROWTH: AutomationDefinition[] = [
  {
    id: 'AP-1301', name: 'ORB-Guided Conversational Onboarding', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.completed' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runOrbGuidedOnboarding',
  },
  {
    id: 'AP-1302', name: 'Starter Pack Delivery', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.completed' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runStarterPackDelivery',
    requires: ['AP-1301'],
  },
  {
    id: 'AP-1303', name: 'Contact Book Sync & Bulk Invite', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'manual',
    targetRoles: [...MEMBER_ROLES],
    handler: 'runContactBookSyncAndInvite',
  },
  {
    id: 'AP-1304', name: '"X Joined Vitana!" Social Proof Notifications', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.completed' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runSocialProofNotification',
  },
  {
    id: 'AP-1305', name: 'Social Account Connect', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'manual',
    targetRoles: [...MEMBER_ROLES],
    handler: 'runSocialAccountConnect',
  },
  {
    id: 'AP-1306', name: 'Auto-Share to Social Accounts', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.milestone.reached' },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runAutoShareToSocial',
  },
  {
    id: 'AP-1307', name: 'Contact Activity Feed Digest', domain: 'onboarding-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    targetRoles: [...MEMBER_ROLES],
    handler: 'runContactActivityDigest',
  },
];

// =============================================================================
// AP-1400: Event & Meetup Initiative
// =============================================================================
const EVENT_MEETUP_INITIATIVE: AutomationDefinition[] = [
  {
    id: 'AP-1401', name: 'Smart Event Creation', domain: 'event-meetup-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-1402', name: 'Calendar Availability Check', domain: 'event-meetup-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'event.suggestion.created' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-1403', name: 'Auto-Invitation Sender', domain: 'event-meetup-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'event.created' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-1404', name: 'Event Discovery Recommendation', domain: 'event-meetup-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 9 * * *' },
    targetRoles: [...MEMBER_ROLES],
  },
  {
    id: 'AP-1405', name: 'Social Meetup Organizer', domain: 'event-meetup-initiative',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...MEMBER_ROLES],
  },
];

// =============================================================================
// AP-1500: Business Opportunity
// =============================================================================
const BUSINESS_OPPORTUNITY: AutomationDefinition[] = [
  {
    id: 'AP-1501', name: 'Marketplace Gap Detection', domain: 'business-opportunity',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1502', name: 'Revenue Opportunity Alert', domain: 'business-opportunity',
    status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1503', name: 'Service Demand Matching', domain: 'business-opportunity',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 11 * * 3' },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1504', name: 'Business Setup Coach', domain: 'business-opportunity',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.business.started' },
    targetRoles: [...CREATOR_ROLES],
  },
  {
    id: 'AP-1505', name: 'Income Growth Tips', domain: 'business-opportunity',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    targetRoles: [...CREATOR_ROLES],
  },
];

// =============================================================================
// AP-1600: Health Action Initiative
// =============================================================================
const HEALTH_ACTION_INITIATIVE: AutomationDefinition[] = [
  {
    id: 'AP-1601', name: 'Lab Test Kit Ordering', domain: 'health-action-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES],
  },
  {
    id: 'AP-1602', name: 'Health Screening Scheduler', domain: 'health-action-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 1 * *' },
    targetRoles: [...CONSUMER_ROLES],
  },
  {
    id: 'AP-1603', name: 'Motivational Health Nudge', domain: 'health-action-initiative',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 * * *' },
    targetRoles: [...CONSUMER_ROLES],
  },
  {
    id: 'AP-1604', name: 'Exercise Initiation', domain: 'health-action-initiative',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES],
  },
  {
    id: 'AP-1605', name: 'Supplement Reorder Reminder', domain: 'health-action-initiative',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    targetRoles: [...CONSUMER_ROLES],
  },
];

// =============================================================================
// Full Registry
// =============================================================================
export const AUTOMATION_REGISTRY: AutomationDefinition[] = [
  ...CONNECT_PEOPLE,
  ...COMMUNITY_GROUPS,
  ...EVENTS_LIVE_ROOMS,
  ...SHARING_GROWTH,
  ...ENGAGEMENT_LOOPS,
  ...HEALTH_WELLNESS,
  ...PAYMENTS_WALLET,
  ...PERSONALIZATION,
  ...MEMORY_INTEL,
  ...PLATFORM_OPS,
  ...BUSINESS_MARKETPLACE,
  ...LIVE_ROOMS_COMMERCE,
  ...ONBOARDING_GROWTH,
  ...EVENT_MEETUP_INITIATIVE,
  ...BUSINESS_OPPORTUNITY,
  ...HEALTH_ACTION_INITIATIVE,
];

// ── Lookup helpers ──────────────────────────────────────────

export function getAutomation(id: string): AutomationDefinition | undefined {
  return AUTOMATION_REGISTRY.find(a => a.id === id);
}

export function getAutomationsByDomain(domain: string): AutomationDefinition[] {
  return AUTOMATION_REGISTRY.filter(a => a.domain === domain);
}

export function getExecutableAutomations(): AutomationDefinition[] {
  return AUTOMATION_REGISTRY.filter(a => a.handler && (a.status === 'IMPLEMENTED' || a.status === 'LIVE'));
}

export function getCronAutomations(): AutomationDefinition[] {
  return getExecutableAutomations().filter(a => a.triggerType === 'cron');
}

export function getHeartbeatAutomations(): AutomationDefinition[] {
  return getExecutableAutomations().filter(a => a.triggerType === 'heartbeat');
}

export function getEventAutomations(eventTopic: string): AutomationDefinition[] {
  return getExecutableAutomations().filter(
    a => a.triggerType === 'event' && a.triggerConfig?.eventTopic === eventTopic
  );
}

/**
 * Check if an automation targets a specific role.
 * Returns true if targetRoles is 'all' or the role array includes the given role.
 */
export function automationTargetsRole(def: AutomationDefinition, role: string): boolean {
  if (def.targetRoles === 'all') return true;
  return def.targetRoles.includes(role as any);
}

/**
 * Get all automations that target a specific user role.
 */
export function getAutomationsByRole(role: string): AutomationDefinition[] {
  return AUTOMATION_REGISTRY.filter(a => automationTargetsRole(a, role));
}

/**
 * Get executable automations filtered by role.
 */
export function getExecutableAutomationsForRole(role: string): AutomationDefinition[] {
  return getExecutableAutomations().filter(a => automationTargetsRole(a, role));
}

export function getRegistrySummary() {
  const byDomain: Record<string, { total: number; executable: number; planned: number }> = {};
  const byRole: Record<string, number> = {};

  for (const a of AUTOMATION_REGISTRY) {
    if (!byDomain[a.domain]) byDomain[a.domain] = { total: 0, executable: 0, planned: 0 };
    byDomain[a.domain].total++;
    if (a.handler) byDomain[a.domain].executable++;
    if (a.status === 'PLANNED') byDomain[a.domain].planned++;

    // Count per-role targeting
    if (a.targetRoles === 'all') {
      for (const r of ['patient', 'professional', 'staff', 'admin', 'developer', 'community']) {
        byRole[r] = (byRole[r] || 0) + 1;
      }
    } else {
      for (const r of a.targetRoles) {
        byRole[r] = (byRole[r] || 0) + 1;
      }
    }
  }

  return {
    total: AUTOMATION_REGISTRY.length,
    executable: getExecutableAutomations().length,
    planned: AUTOMATION_REGISTRY.filter(a => a.status === 'PLANNED').length,
    domains: byDomain,
    roles: byRole,
  };
}
