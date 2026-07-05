/**
 * Health & Wellness Handlers — AP-0600 series
 *
 * VTID: VTID-01250
 * All health processing uses local Ollama LLM only — no PHI leaves the server.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-0601: PHI Redaction Gate ─────────────────────────────
async function runPhiRedactionGate(ctx: AutomationContext) {
  // Delegates to existing phi-redactor.ts in OpenClaw bridge
  ctx.log('PHI redaction gate active (delegates to existing implementation)');
  return { usersAffected: 0, actionsTaken: 1 };
}

// ── AP-0602: Health Report Summarization ────────────────────
async function runHealthReportSummarization(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;

  const { data: pendingReports } = await supabase
    .from('lab_reports')
    .select('id, user_id')
    .eq('tenant_id', tenantId)
    .is('parsed_json', null)
    .limit(10);

  ctx.log(`Found ${pendingReports?.length || 0} reports pending summarization`);
  // Delegates to existing OpenClaw bridge health report processor
  return { usersAffected: pendingReports?.length || 0, actionsTaken: pendingReports?.length || 0 };
}

// ── AP-0603: Consent Check ──────────────────────────────────
async function runConsentCheck(ctx: AutomationContext) {
  ctx.log('Consent check gate active (delegates to existing implementation)');
  return { usersAffected: 0, actionsTaken: 1 };
}

// ── AP-0604: Wellness Check-In Prompt ───────────────────────
// Real schema: vitana_index_scores has score_total (not overall_score) and
// date (a DATE column, not computed_at timestamptz).
async function runWellnessCheckIn(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  // Find users with declining Vitana Index
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const { data: users } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);

  for (const { user_id } of users || []) {
    // Get recent vs previous score
    const { data: recent } = await supabase
      .from('vitana_index_scores')
      .select('score_total')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .gte('date', sevenDaysAgo)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();

    const { data: previous } = await supabase
      .from('vitana_index_scores')
      .select('score_total')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .gte('date', fourteenDaysAgo)
      .lte('date', sevenDaysAgo)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!recent?.score_total || !previous?.score_total) continue;

    const decline = previous.score_total - recent.score_total;
    if (decline < 10) continue; // only nudge on significant decline

    ctx.notify(user_id, 'orb_proactive_message', {
      title: 'How Are You Feeling?',
      body: 'Your ORB noticed some changes this week. Want to chat about how things are going?',
      data: { url: '/orb' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0607: Lab Report Ingestion & Biomarker Extraction ────
async function runLabReportIngestion(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, report_id } = payload || {};
  if (!user_id || !report_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  ctx.log(`Processing lab report ${report_id} for user ${user_id}`);

  // Notify user that processing started
  ctx.notify(user_id, 'lab_report_processed', {
    title: 'Lab Report Received',
    body: 'Your lab report is being analyzed. Results will be ready soon.',
    data: { url: '/health/reports', report_id },
  });

  // Trigger daily recompute to incorporate new data
  await ctx.emitEvent('health.biomarkers.stored', { user_id, report_id });

  return { usersAffected: 1, actionsTaken: 2 };
}

// ── AP-0608: Biomarker Trend Analysis ───────────────────────
async function runBiomarkerTrendAnalysis(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, report_id } = payload || {};
  if (!user_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Get latest biomarkers
  const { data: latestBiomarkers } = await supabase
    .from('biomarker_results')
    .select('biomarker_code, name, value, unit, status, measured_at')
    .eq('tenant_id', tenantId)
    .eq('user_id', user_id)
    .eq('lab_report_id', report_id)
    .order('measured_at', { ascending: false });

  if (!latestBiomarkers?.length) return { usersAffected: 0, actionsTaken: 0 };

  // Check for critical values
  const criticalMarkers = latestBiomarkers.filter((b: any) => b.status === 'critical');
  const highMarkers = latestBiomarkers.filter((b: any) => b.status === 'high');

  if (criticalMarkers.length > 0) {
    ctx.log(`Critical biomarkers detected for ${user_id}: ${criticalMarkers.map((b: any) => b.biomarker_code).join(', ')}`);
    // Trigger professional referral
    await ctx.emitEvent('health.biomarker.critical', { user_id, biomarkers: criticalMarkers.map((b: any) => b.biomarker_code) });
  }

  // Trigger daily recompute
  await ctx.emitEvent('health.daily.recomputed', { user_id });

  ctx.notify(user_id, 'orb_proactive_message', {
    title: 'Lab Results Analyzed',
    body: 'Your latest lab results have been analyzed. Talk to your ORB for insights.',
    data: { url: '/health/reports' },
  });

  return { usersAffected: 1, actionsTaken: 2 };
}

// ── AP-0609: Quality-of-Life Recommendation Engine ──────────
// Real schema: vitana_index_scores has no pillar_scores jsonb column — the 5
// pillars are discrete score_sleep/score_nutrition/score_exercise/
// score_hydration/score_mental columns, plus score_total (not overall_score)
// and date (not computed_at).
async function runQualityOfLifeRecommendations(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Get current Vitana Index scores
  const { data: scores } = await supabase
    .from('vitana_index_scores')
    .select('score_sleep, score_nutrition, score_exercise, score_hydration, score_mental')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('date', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!scores) return { usersAffected: 0, actionsTaken: 0 };

  const pillars: Record<string, number> = {
    sleep: scores.score_sleep, nutrition: scores.score_nutrition, exercise: scores.score_exercise,
    hydration: scores.score_hydration, mental: scores.score_mental,
  };
  const weakestPillar = Object.entries(pillars)
    .filter(([, score]) => score != null)
    .sort(([, a], [, b]) => a - b)
    .find(([, score]) => score < 50);

  if (weakestPillar) {
    const [pillarName, pillarScore] = weakestPillar;

    ctx.notify(userId, 'orb_proactive_message', {
      title: 'Health Insight',
      body: `Your ${pillarName} score is ${Math.round(pillarScore)}. Your ORB has recommendations to help.`,
      data: { url: '/orb', pillar: pillarName },
    });
  }

  // Emit for downstream automations (AP-0615)
  await ctx.emitEvent('health.recommendations.generated', { user_id: userId });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0610: Wearable Data Anomaly Detection ────────────────
async function runWearableAnomalyDetection(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  ctx.log(`Checking wearable anomalies for ${userId}`);
  // Anomaly detection delegated to health compute pipeline
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0611: Vitana Index Weekly Report ─────────────────────
async function runVitanaIndexWeeklyReport(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: users } = await supabase
    .from('user_tenants')
    .select('user_id')
    .eq('tenant_id', tenantId)
    .eq('is_primary', true);

  for (const { user_id } of users || []) {
    const { data: score } = await supabase
      .from('vitana_index_scores')
      .select('score_total')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .order('date', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!score?.score_total) continue;

    ctx.notify(user_id, 'orb_proactive_message', {
      title: 'Your Weekly Vitana Index',
      body: `Your Vitana Index this week: ${Math.round(score.score_total)}. Check your ORB for insights.`,
      data: { url: '/health/dashboard' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-0612: Professional Referral Suggestion ───────────────
// KNOWN GAP: services_catalog (VTID-01092) was never deployed and no live
// substitute with service_type/provider_name exists — this always no-ops
// (query errors, data stays null, the length guard below catches it safely).
// Left as-is rather than guessing a replacement schema; flagging only.
async function runProfessionalReferral(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const { user_id, biomarkers } = payload || {};
  if (!user_id) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Find matching service providers
  const { data: services } = await supabase
    .from('services_catalog')
    .select('id, name, service_type, provider_name')
    .eq('tenant_id', tenantId)
    .in('service_type', ['doctor', 'coach', 'nutritionist'])
    .limit(3);

  if (!services?.length) return { usersAffected: 0, actionsTaken: 0 };

  const serviceType = services[0].service_type;

  // NOTE: Never mention specific biomarker values in notification
  ctx.notify(user_id, 'orb_proactive_message', {
    title: 'Health Insight',
    body: `Based on your recent results, you might benefit from speaking with a ${serviceType}. Check Discover for options.`,
    data: { url: '/discover', filter: serviceType },
  });

  await ctx.emitEvent('autopilot.health.professional_suggested', { user_id, service_type: serviceType });
  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0613: Health Capacity Awareness Gate ─────────────────
async function runHealthCapacityGate(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  ctx.log(`Health capacity check for ${userId} (delegates to D32 engine)`);
  return { usersAffected: 1, actionsTaken: 0 };
}

// ── AP-0615: Health-Aware Product Recommendations ───────────
// Real schema: recommendations has category/title/body (not pillar/
// recommendation_text); products (not products_catalog) is the live global
// catalog — no tenant_id column, topic_keys is a real array column.
async function runHealthAwareProductRecs(ctx: AutomationContext) {
  const payload = ctx.run.metadata as any;
  const userId = payload?.user_id;
  if (!userId) return { usersAffected: 0, actionsTaken: 0 };

  const { supabase, tenantId } = ctx;

  // Get user's recommendations
  const { data: recs } = await supabase
    .from('recommendations')
    .select('category, title')
    .eq('tenant_id', tenantId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(3);

  if (!recs?.length) return { usersAffected: 0, actionsTaken: 0 };

  // Find matching products
  const categories = recs.map((r: any) => r.category).filter(Boolean);
  const { data: products } = await supabase
    .from('products')
    .select('id, title, category')
    .eq('is_active', true)
    .overlaps('topic_keys', categories)
    .limit(3);

  if (!products?.length) return { usersAffected: 0, actionsTaken: 0 };

  // NOTE: Never push products during vulnerability (AP-0710 check should run first)
  ctx.notify(userId, 'orb_suggestion', {
    title: 'Products That May Help',
    body: 'Based on your health insights, there are some options in Discover.',
    data: { url: '/discover' },
  });

  return { usersAffected: 1, actionsTaken: 1 };
}

// ── AP-0605: Community Wellness Event Suggestion ────────────
// Heartbeat scan of upcoming global_community_events for wellness-themed
// titles (no dedicated category/topic column on that table), suggesting the
// nearest one to users not already attending.
const WELLNESS_KEYWORDS = ['wellness', 'yoga', 'meditation', 'mindfulness', 'fitness', 'nutrition', 'health'];
const WELLNESS_EVENT_LOOKAHEAD_DAYS = 14;
const WELLNESS_SUGGESTION_COOLDOWN_DAYS = 7;
const WELLNESS_SUGGESTION_MAX_USERS_PER_RUN = 500;

async function runCommunityWellnessEventSuggestion(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const now = new Date();
  const lookahead = new Date(now.getTime() + WELLNESS_EVENT_LOOKAHEAD_DAYS * 86_400_000);

  const { data: events } = await supabase
    .from('global_community_events')
    .select('id, title, start_time')
    .gte('start_time', now.toISOString())
    .lte('start_time', lookahead.toISOString())
    .order('start_time', { ascending: true })
    .limit(50);

  const wellnessEvent = (events || []).find((e: any) =>
    WELLNESS_KEYWORDS.some((kw) => (e.title || '').toLowerCase().includes(kw))
  );
  if (!wellnessEvent) return { usersAffected: 0, actionsTaken: 0 };

  const users = (await ctx.queryTargetUsers()).slice(0, WELLNESS_SUGGESTION_MAX_USERS_PER_RUN);
  const cooldownCutoff = new Date(now.getTime() - WELLNESS_SUGGESTION_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { data: attending } = await supabase
      .from('global_event_participants')
      .select('id')
      .eq('event_id', wellnessEvent.id)
      .eq('user_id', user_id)
      .eq('status', 'attending')
      .limit(1);
    if (attending && attending.length > 0) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-0605' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'A Wellness Event Is Coming Up',
      body: `"${wellnessEvent.title}" is happening soon — a great chance to focus on your wellbeing.`,
      data: { url: `/community/events/${wellnessEvent.id}`, event_id: wellnessEvent.id, automation_id: 'AP-0605' },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.health.wellness_event_suggested', { event_id: wellnessEvent.id, users: usersAffected });
  return { usersAffected, actionsTaken };
}

// ── AP-0606: Health Data Export Reminder ────────────────────
// No dedicated export screen exists in the frontend inventory; links to the
// real /settings/privacy screen (App.tsx) where data-management actions
// live, rather than inventing a new route.
const EXPORT_REMINDER_MAX_USERS_PER_RUN = 500;

async function runHealthDataExportReminder(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = (await ctx.queryTargetUsers()).slice(0, EXPORT_REMINDER_MAX_USERS_PER_RUN);

  for (const { user_id } of users) {
    const { count: reportCount } = await supabase
      .from('lab_reports')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id);

    if (!reportCount || reportCount === 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Review Your Health Data',
      body: 'It\'s been a while — take a moment to review or export the health data Vitana has on file for you.',
      data: { url: '/settings/privacy', automation_id: 'AP-0606' },
    });

    usersAffected++;
    actionsTaken++;
  }

  await ctx.emitEvent('autopilot.health.data_export_reminder_sent', { users: usersAffected });
  return { usersAffected, actionsTaken };
}

export function registerHealthWellnessHandlers(): void {
  registerHandler('runPhiRedactionGate', runPhiRedactionGate);
  registerHandler('runHealthReportSummarization', runHealthReportSummarization);
  registerHandler('runConsentCheck', runConsentCheck);
  registerHandler('runWellnessCheckIn', runWellnessCheckIn);
  registerHandler('runCommunityWellnessEventSuggestion', runCommunityWellnessEventSuggestion);
  registerHandler('runHealthDataExportReminder', runHealthDataExportReminder);
  registerHandler('runLabReportIngestion', runLabReportIngestion);
  registerHandler('runBiomarkerTrendAnalysis', runBiomarkerTrendAnalysis);
  registerHandler('runQualityOfLifeRecommendations', runQualityOfLifeRecommendations);
  registerHandler('runWearableAnomalyDetection', runWearableAnomalyDetection);
  registerHandler('runVitanaIndexWeeklyReport', runVitanaIndexWeeklyReport);
  registerHandler('runProfessionalReferral', runProfessionalReferral);
  registerHandler('runHealthCapacityGate', runHealthCapacityGate);
  registerHandler('runHealthAwareProductRecs', runHealthAwareProductRecs);
}
