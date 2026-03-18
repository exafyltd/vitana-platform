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
// AP-0100: Connect People
// =============================================================================
const CONNECT_PEOPLE: AutomationDefinition[] = [
  {
    id: 'AP-0101', name: 'Daily Match Delivery', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 * * *' },
    handler: 'runDailyMatchDelivery',
  },
  {
    id: 'AP-0102', name: '"Someone Shares Your Interest" Nudge', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 }, // every 6h
    handler: 'runSharedInterestNudge',
  },
  {
    id: 'AP-0103', name: 'Mutual Accept Auto-Introduction', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.state.accepted' },
    handler: 'runMutualAcceptIntroduction',
    requires: ['AP-0101'],
  },
  {
    id: 'AP-0104', name: 'First Conversation Starter', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 120 },
    handler: 'runFirstConversationStarter',
    requires: ['AP-0103'],
  },
  {
    id: 'AP-0105', name: 'Group Recommendation Push', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' }, // Monday 10am
    handler: 'runGroupRecommendationPush',
  },
  {
    id: 'AP-0106', name: '"People You Know Are Here" Social Proof', domain: 'connect-people',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.group.viewed' },
  },
  {
    id: 'AP-0107', name: 'Proactive Social Alignment Suggestions', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 9 * * 1' },
    handler: 'runSocialAlignmentSuggestions',
  },
  {
    id: 'AP-0108', name: 'Match Quality Learning Loop', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.feedback.submitted' },
    handler: 'runMatchQualityLoop',
  },
  {
    id: 'AP-0109', name: 'Proactive Match Batch Delivery', domain: 'connect-people',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 60 },
    handler: 'runProactiveMatchBatch',
  },
  {
    id: 'AP-0110', name: 'Opportunity Surfacing with Social Layer', domain: 'connect-people',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'opportunity.detected' },
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
  },
  {
    id: 'AP-0202', name: 'Group Invite Follow-Up', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    handler: 'runGroupInviteFollowUp',
  },
  {
    id: 'AP-0203', name: 'New Member Welcome in Group', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'community.member.joined' },
    handler: 'runNewMemberWelcome',
  },
  {
    id: 'AP-0204', name: 'Auto-Suggest Meetup from Group Activity', domain: 'community-groups',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'community.chat.activity_spike' },
  },
  {
    id: 'AP-0205', name: 'Group Health Monitor', domain: 'community-groups',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
  },
  {
    id: 'AP-0206', name: 'Cross-Group Introduction', domain: 'community-groups',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 10080 }, // weekly
  },
  {
    id: 'AP-0207', name: 'Meetup RSVP Encouragement', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 60 },
    handler: 'runMeetupRsvpEncouragement',
  },
  {
    id: 'AP-0208', name: 'Post-Meetup Connection Prompt', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.ended' },
    handler: 'runPostMeetupConnect',
  },
  {
    id: 'AP-0209', name: 'Group Creation from Match Cluster', domain: 'community-groups',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
  },
  {
    id: 'AP-0210', name: 'Community Digest for Group Creators', domain: 'community-groups',
    status: 'IMPLEMENTED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 18 * * 0' }, // Sunday 6pm
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
    handler: 'runAutoScheduleDailyRoom',
  },
  {
    id: 'AP-0302', name: 'Graduated Meetup Reminders', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 15 },
    handler: 'runGraduatedReminders',
  },
  {
    id: 'AP-0303', name: '"Go Together" Event Match', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.daily.event' },
    handler: 'runGoTogetherMatch',
  },
  {
    id: 'AP-0304', name: 'Post-Event Feedback & Connect', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.ended' },
    handler: 'runPostEventFeedback',
  },
  {
    id: 'AP-0305', name: 'Trending Events Weekly Digest', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 18 * * 0' },
    handler: 'runTrendingEventsDigest',
  },
  {
    id: 'AP-0306', name: 'Event Series Auto-Suggestion', domain: 'events-live-rooms',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
  },
  {
    id: 'AP-0307', name: 'Live Room from Trending Chat Topic', domain: 'events-live-rooms',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 240 },
  },
  {
    id: 'AP-0308', name: 'No-Show Follow-Up', domain: 'events-live-rooms',
    status: 'IMPLEMENTED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.ended' },
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
    handler: 'generateWhatsAppEventLink',
  },
  {
    id: 'AP-0402', name: 'WhatsApp Group Invite', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'manual',
    handler: 'generateWhatsAppGroupInvite',
  },
  {
    id: 'AP-0403', name: 'Social Media Event Card Generator', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'meetup.created' },
  },
  {
    id: 'AP-0404', name: '"Invite a Friend" After Positive Experience', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'match.feedback.like' },
    handler: 'runInviteAfterPositive',
  },
  {
    id: 'AP-0405', name: 'Referral Tracking & Reward', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.referral' },
    handler: 'runReferralReward',
  },
  {
    id: 'AP-0406', name: 'Auto-Post Community Highlights', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 14 * * 5' },
  },
  {
    id: 'AP-0407', name: 'User Profile Share Card', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P2', triggerType: 'manual',
  },
  {
    id: 'AP-0408', name: 'Event Countdown Share Prompt', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    handler: 'runEventCountdownSharePrompt',
  },
  {
    id: 'AP-0409', name: '"Your Week on Vitana" Shareable Recap', domain: 'sharing-growth',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 9 * * 0' },
  },
  {
    id: 'AP-0410', name: 'Viral Loop: Shared Event → New User Onboarding', domain: 'sharing-growth',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.signup.shared_link' },
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
    handler: 'runMorningBriefing',
  },
  {
    id: 'AP-0502', name: 'Weekly Community Digest', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 18 * * 0' },
    handler: 'runWeeklyCommunityDigest',
  },
  {
    id: 'AP-0503', name: 'Re-Engagement for Dormant Users', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runDormantUserReEngagement',
  },
  {
    id: 'AP-0504', name: 'Milestone Celebrations', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.milestone.reached' },
    handler: 'runMilestoneCelebration',
  },
  {
    id: 'AP-0505', name: 'Diary Reminder with Social Twist', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 21 * * *' },
    handler: 'runDiaryReminderSocial',
  },
  {
    id: 'AP-0506', name: 'Weekly Reflection with Connection Insights', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 20 * * 5' },
    handler: 'runWeeklyReflection',
  },
  {
    id: 'AP-0507', name: 'Conversation Continuity Nudge', domain: 'engagement-loops',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runConversationContinuityNudge',
  },
  {
    id: 'AP-0508', name: '"Someone Viewed Your Profile" Notification', domain: 'engagement-loops',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'profile.viewed' },
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
    handler: 'runPhiRedactionGate',
  },
  {
    id: 'AP-0602', name: 'Health Report Summarization', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 15 },
    handler: 'runHealthReportSummarization',
  },
  {
    id: 'AP-0603', name: 'Consent Check Before Health Operations', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.operation.requested' },
    handler: 'runConsentCheck',
  },
  {
    id: 'AP-0604', name: 'Wellness Check-In Prompt', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 3' }, // Wednesday 10am
    handler: 'runWellnessCheckIn',
  },
  {
    id: 'AP-0605', name: 'Community Wellness Event Suggestion', domain: 'health-wellness',
    status: 'PLANNED', priority: 'P2', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 10080 },
  },
  {
    id: 'AP-0606', name: 'Health Data Export Reminder', domain: 'health-wellness',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 */3 *' }, // quarterly
  },
  {
    id: 'AP-0607', name: 'Lab Report Ingestion & Biomarker Extraction', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.lab_report.uploaded' },
    handler: 'runLabReportIngestion',
  },
  {
    id: 'AP-0608', name: 'Biomarker Trend Analysis', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.biomarkers.stored' },
    handler: 'runBiomarkerTrendAnalysis',
    requires: ['AP-0607'],
  },
  {
    id: 'AP-0609', name: 'Quality-of-Life Recommendation Engine', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.daily.recomputed' },
    handler: 'runQualityOfLifeRecommendations',
  },
  {
    id: 'AP-0610', name: 'Wearable Data Anomaly Detection', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.wearable.ingested' },
    handler: 'runWearableAnomalyDetection',
  },
  {
    id: 'AP-0611', name: 'Vitana Index Weekly Report', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 8 * * 1' }, // Monday 8am
    handler: 'runVitanaIndexWeeklyReport',
  },
  {
    id: 'AP-0612', name: 'Professional Referral Suggestion', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.biomarker.critical' },
    handler: 'runProfessionalReferral',
    requires: ['AP-0608'],
  },
  {
    id: 'AP-0613', name: 'Health Capacity Awareness for Autopilot', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'automation.pre_execute' },
    handler: 'runHealthCapacityGate',
  },
  {
    id: 'AP-0614', name: 'Health Goal Setting Assistant', domain: 'health-wellness',
    status: 'PLANNED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.lab_report.first' },
  },
  {
    id: 'AP-0615', name: 'Health-Aware Product Recommendations', domain: 'health-wellness',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.recommendations.generated' },
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
    handler: 'runPaymentFailureRetry',
  },
  {
    id: 'AP-0702', name: 'Subscription Created Audit', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'stripe.subscription.created' },
    handler: 'runSubscriptionAudit',
  },
  {
    id: 'AP-0703', name: 'Plan Upgrade Suggestion', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.plan_limit.approaching' },
  },
  {
    id: 'AP-0704', name: 'Subscription Expiry Warning', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
  },
  {
    id: 'AP-0705', name: 'Payment Method Update Reminder', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'stripe.payment.failed' },
    handler: 'runPaymentMethodReminder',
  },
  {
    id: 'AP-0706', name: 'Creator Stripe Connect Onboarding', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.listing.first' },
    handler: 'runCreatorStripeOnboarding',
  },
  {
    id: 'AP-0707', name: 'Creator Payout Monitoring', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'stripe.connect.payout' },
    handler: 'runCreatorPayoutMonitor',
  },
  {
    id: 'AP-0708', name: 'Wallet Credit Rewards for Engagement', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.reward_eligible' },
    handler: 'runWalletCreditReward',
  },
  {
    id: 'AP-0709', name: 'Vitana Token (VTN) Launch Automation', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P0', triggerType: 'manual',
  },
  {
    id: 'AP-0710', name: 'Monetization Readiness Scoring', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'automation.monetization.check' },
    handler: 'runMonetizationReadinessCheck',
  },
  {
    id: 'AP-0711', name: 'Weekly Earnings Report for Creators', domain: 'payments-wallet-vtn',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
    handler: 'runCreatorWeeklyEarnings',
  },
  {
    id: 'AP-0712', name: 'Spending Insights for Users', domain: 'payments-wallet-vtn',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 * *' },
  },
];

// =============================================================================
// AP-0800: Personalization Engines
// =============================================================================
const PERSONALIZATION: AutomationDefinition[] = [
  { id: 'AP-0801', name: 'Social Comfort-Aware Suggestions', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
  { id: 'AP-0802', name: 'Taste-Aligned Event Recommendations', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
  { id: 'AP-0803', name: 'Opportunity Surfacing Automation', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat' },
  { id: 'AP-0804', name: 'Life-Stage Aware Communication', domain: 'personalization-engines', status: 'PLANNED', priority: 'P2', triggerType: 'event' },
  { id: 'AP-0805', name: 'Overload Detection & Throttle', domain: 'personalization-engines', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
];

// =============================================================================
// AP-0900: Memory & Intelligence
// =============================================================================
const MEMORY_INTEL: AutomationDefinition[] = [
  { id: 'AP-0901', name: 'Memory-Informed Matching', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
  { id: 'AP-0902', name: 'Fact Extraction from Conversations', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
  { id: 'AP-0903', name: 'Relationship Graph Maintenance', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P2', triggerType: 'cron' },
  { id: 'AP-0904', name: 'Semantic Memory Search for Autopilot Context', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
  { id: 'AP-0905', name: 'Knowledge Base Context for Suggestions', domain: 'memory-intelligence', status: 'PLANNED', priority: 'P2', triggerType: 'event' },
];

// =============================================================================
// AP-1000: Platform Operations
// =============================================================================
const PLATFORM_OPS: AutomationDefinition[] = [
  {
    id: 'AP-1001', name: 'VTID Lifecycle Automation', domain: 'platform-operations',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'vtid.state.changed' },
    handler: 'runVtidLifecycle',
  },
  {
    id: 'AP-1002', name: 'Governance Flag Monitoring', domain: 'platform-operations',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'governance.flag.changed' },
    handler: 'runGovernanceFlagCheck',
  },
  { id: 'AP-1003', name: 'Post-Deploy Health Check', domain: 'platform-operations', status: 'PLANNED', priority: 'P1', triggerType: 'event' },
  { id: 'AP-1004', name: 'Service Error Rate Alert', domain: 'platform-operations', status: 'PLANNED', priority: 'P1', triggerType: 'heartbeat' },
  { id: 'AP-1005', name: 'Database Migration Verification', domain: 'platform-operations', status: 'PLANNED', priority: 'P2', triggerType: 'event' },
];

// =============================================================================
// AP-1100: Business Hub & Marketplace
// =============================================================================
const BUSINESS_MARKETPLACE: AutomationDefinition[] = [
  {
    id: 'AP-1101', name: 'Service Listing Publication & Distribution', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.service.created' },
    handler: 'runServiceListingDistribution',
  },
  {
    id: 'AP-1102', name: 'Product Listing & AI-Picks Matching', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'catalog.product.created' },
    handler: 'runProductAiPicksMatching',
  },
  {
    id: 'AP-1103', name: 'Discover Section Personalization', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runDiscoverPersonalization',
  },
  {
    id: 'AP-1104', name: 'Client-Service Matching', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.service.search' },
    handler: 'runClientServiceMatching',
  },
  {
    id: 'AP-1105', name: 'Post-Service Outcome Tracking', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runPostServiceOutcomeTracking',
  },
  {
    id: 'AP-1106', name: 'Shop Setup Wizard', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.business.started' },
    handler: 'runShopSetupWizard',
  },
  {
    id: 'AP-1107', name: 'Product Review Follow-Up', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runProductReviewFollowUp',
  },
  {
    id: 'AP-1108', name: 'Creator Analytics & Growth Tips', domain: 'business-hub-marketplace',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 * * 1' },
  },
  {
    id: 'AP-1109', name: 'Seasonal & Trending Recommendations for Creators', domain: 'business-hub-marketplace',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 * *' },
  },
  {
    id: 'AP-1110', name: 'Cross-Sell Service to Product Buyers', domain: 'business-hub-marketplace',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'user.product.purchased' },
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
    handler: 'runPaidLiveRoomSetup',
  },
  {
    id: 'AP-1202', name: 'Live Room Booking & Payment Flow', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'live_room.booking.requested' },
    handler: 'runLiveRoomBookingPayment',
  },
  {
    id: 'AP-1203', name: 'Live Room Upsell from Free Content', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runLiveRoomFreeToUpSell',
  },
  {
    id: 'AP-1204', name: 'Group Session Auto-Fill', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 360 },
    handler: 'runGroupSessionAutoFill',
  },
  {
    id: 'AP-1205', name: 'Post-Session Revenue Report', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'event',
    triggerConfig: { eventTopic: 'live_room.session.ended' },
    handler: 'runPostSessionRevenueReport',
  },
  {
    id: 'AP-1206', name: 'Session Highlight Clips for Marketing', domain: 'live-rooms-commerce',
    status: 'PLANNED', priority: 'P2', triggerType: 'event',
    triggerConfig: { eventTopic: 'live_room.highlights.ready' },
  },
  {
    id: 'AP-1207', name: 'Recurring Session Auto-Scheduling', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runRecurringSessionAutoSchedule',
  },
  {
    id: 'AP-1208', name: 'Consultation Matching', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P0', triggerType: 'event',
    triggerConfig: { eventTopic: 'health.professional_referral' },
    handler: 'runConsultationMatching',
  },
  {
    id: 'AP-1209', name: 'Free Trial Session for New Creators', domain: 'live-rooms-commerce',
    status: 'IMPLEMENTED', priority: 'P1', triggerType: 'heartbeat',
    triggerConfig: { intervalMinutes: 1440 },
    handler: 'runFreeTrialSessionSuggestion',
  },
  {
    id: 'AP-1210', name: 'Live Room Revenue Optimization Tips', domain: 'live-rooms-commerce',
    status: 'PLANNED', priority: 'P2', triggerType: 'cron',
    triggerConfig: { cronExpression: '0 10 1 * *' },
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

export function getRegistrySummary() {
  const byDomain: Record<string, { total: number; executable: number; planned: number }> = {};
  for (const a of AUTOMATION_REGISTRY) {
    if (!byDomain[a.domain]) byDomain[a.domain] = { total: 0, executable: 0, planned: 0 };
    byDomain[a.domain].total++;
    if (a.handler) byDomain[a.domain].executable++;
    if (a.status === 'PLANNED') byDomain[a.domain].planned++;
  }
  return {
    total: AUTOMATION_REGISTRY.length,
    executable: getExecutableAutomations().length,
    planned: AUTOMATION_REGISTRY.filter(a => a.status === 'PLANNED').length,
    domains: byDomain,
  };
}
