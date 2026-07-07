/**
 * Health Action Initiative Handlers — AP-1600 series
 *
 * VTID: VTID-01250
 * Automations nudging users toward concrete health actions: lab tests,
 * screenings, daily motivation, exercise, and supplement reorders. Uses the
 * live lab_test_orders/lab_tests/provider_appointments/wearable_workouts/
 * product_orders/products tables.
 */

import { AutomationContext } from '../../types/automations';
import { registerHandler } from '../automation-executor';

// ── AP-1601: Lab Test Kit Ordering ──────────────────────────
// Suggests an active lab test to users who have never ordered one.
const LAB_KIT_COOLDOWN_DAYS = 30;
const LAB_KIT_MAX_USERS_PER_RUN = 500;

async function runLabTestKitOrdering(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const { data: recommendedTest } = await supabase
    .from('lab_tests')
    .select('id, name')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!recommendedTest) return { usersAffected: 0, actionsTaken: 0 };

  const users = (await ctx.queryTargetUsers()).slice(0, LAB_KIT_MAX_USERS_PER_RUN);
  const cooldownCutoff = new Date(Date.now() - LAB_KIT_COOLDOWN_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { count: orderCount } = await supabase
      .from('lab_test_orders')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id);
    if (orderCount && orderCount > 0) continue;

    const { data: recentSuggestion } = await supabase
      .from('user_notifications')
      .select('id')
      .eq('user_id', user_id)
      .contains('data', { automation_id: 'AP-1601' })
      .gte('created_at', cooldownCutoff)
      .limit(1);
    if (recentSuggestion && recentSuggestion.length > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Know Your Numbers',
      body: `A "${recommendedTest.name}" lab test can give you real data on your health — want to order one?`,
      data: { url: '/health/lab-tests', lab_test_id: recommendedTest.id, automation_id: 'AP-1601' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1602: Health Screening Scheduler ──────────────────────
// Monthly cron: reminds users with no provider_appointments in the last 12
// months (or ever) to book a routine health screening.
const SCREENING_LOOKBACK_MONTHS_DAYS = 365;

async function runHealthScreeningScheduler(ctx: AutomationContext) {
  const { supabase } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = await ctx.queryTargetUsers();
  const lookbackCutoff = new Date(Date.now() - SCREENING_LOOKBACK_MONTHS_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { count: recentAppointments } = await supabase
      .from('provider_appointments')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user_id)
      .gte('start_time', lookbackCutoff);
    if (recentAppointments && recentAppointments > 0) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Time for a Check-Up?',
      body: 'It\'s been a while since your last screening — booking a routine check-up is a great way to stay ahead of your health.',
      data: { url: '/discover', filter: 'health_screening' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1603: Motivational Health Nudge ───────────────────────
// Daily cron: positive reinforcement based on the day-over-day Vitana Index
// trend, distinct from AP-0604 (which only fires on a significant decline).
async function runMotivationalHealthNudge(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = await ctx.queryTargetUsers();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  for (const { user_id } of users) {
    const { data: todayScore } = await supabase
      .from('vitana_index_scores')
      .select('score_total')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('date', today)
      .maybeSingle();
    if (!todayScore?.score_total) continue;

    const { data: yesterdayScore } = await supabase
      .from('vitana_index_scores')
      .select('score_total')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('date', yesterday)
      .maybeSingle();

    const improved = yesterdayScore?.score_total != null && todayScore.score_total > yesterdayScore.score_total;

    ctx.notify(user_id, 'orb_suggestion', {
      title: improved ? 'Great Momentum!' : 'Keep Going',
      body: improved
        ? `Your Vitana Index ticked up to ${Math.round(todayScore.score_total)} today — whatever you did, it's working.`
        : `Your Vitana Index is at ${Math.round(todayScore.score_total)} today. Small consistent steps add up.`,
      data: { url: '/health/dashboard' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1604: Exercise Initiation ─────────────────────────────
// Heartbeat scan: nudges users with no wearable_workouts logged in 5+ days.
const EXERCISE_GAP_DAYS = 5;
const EXERCISE_MAX_USERS_PER_RUN = 500;

async function runExerciseInitiation(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = (await ctx.queryTargetUsers()).slice(0, EXERCISE_MAX_USERS_PER_RUN);
  const gapCutoff = new Date(Date.now() - EXERCISE_GAP_DAYS * 86_400_000).toISOString();

  for (const { user_id } of users) {
    const { count: recentWorkouts } = await supabase
      .from('wearable_workouts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .gte('started_at', gapCutoff);
    if (recentWorkouts && recentWorkouts > 0) continue;

    // Only nudge users who have ever connected a wearable (have any workout history at all)
    const { count: everWorkedOut } = await supabase
      .from('wearable_workouts')
      .select('id', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id);
    if (!everWorkedOut) continue;

    ctx.notify(user_id, 'orb_suggestion', {
      title: 'Time to Move?',
      body: `It's been ${EXERCISE_GAP_DAYS}+ days since your last logged workout — even a short walk counts.`,
      data: { url: '/health/dashboard' },
    });

    usersAffected++;
    actionsTaken++;
  }

  return { usersAffected, actionsTaken };
}

// ── AP-1605: Supplement Reorder Reminder ─────────────────────
// Heartbeat scan: assumes a 30-day reorder cadence for products.category
// containing 'supplement', matched against product_orders history.
const REORDER_WINDOW_DAYS = 30;
const REORDER_TOLERANCE_DAYS = 3;
const REORDER_MAX_USERS_PER_RUN = 500;

async function runSupplementReorderReminder(ctx: AutomationContext) {
  const { supabase, tenantId } = ctx;
  let usersAffected = 0;
  let actionsTaken = 0;

  const users = (await ctx.queryTargetUsers()).slice(0, REORDER_MAX_USERS_PER_RUN);

  for (const { user_id } of users) {
    const { data: orders } = await supabase
      .from('product_orders')
      .select('id, product_id, purchased_at')
      .eq('tenant_id', tenantId)
      .eq('user_id', user_id)
      .eq('state', 'completed')
      .order('purchased_at', { ascending: false })
      .limit(10);
    if (!orders?.length) continue;

    let reminded = false;
    for (const order of orders) {
      if (reminded || !order.purchased_at) continue;
      const daysSince = Math.floor((Date.now() - new Date(order.purchased_at).getTime()) / 86_400_000);
      if (Math.abs(daysSince - REORDER_WINDOW_DAYS) > REORDER_TOLERANCE_DAYS) continue;

      const { data: product } = await supabase
        .from('products')
        .select('title, category')
        .eq('id', order.product_id)
        .maybeSingle();
      if (!product || !(product.category || '').toLowerCase().includes('supplement')) continue;

      ctx.notify(user_id, 'orb_suggestion', {
        title: 'Running Low?',
        body: `It's been about a month since you ordered "${product.title}" — time to reorder?`,
        data: { url: '/discover', product_id: order.product_id },
      });

      usersAffected++;
      actionsTaken++;
      reminded = true;
    }
  }

  return { usersAffected, actionsTaken };
}

export function registerHealthActionInitiativeHandlers(): void {
  registerHandler('runLabTestKitOrdering', runLabTestKitOrdering);
  registerHandler('runHealthScreeningScheduler', runHealthScreeningScheduler);
  registerHandler('runMotivationalHealthNudge', runMotivationalHealthNudge);
  registerHandler('runExerciseInitiation', runExerciseInitiation);
  registerHandler('runSupplementReorderReminder', runSupplementReorderReminder);
}
