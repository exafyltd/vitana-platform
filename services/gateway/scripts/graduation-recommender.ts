/**
 * Graduation recommender — Phase 1 W1 (VTID-03179 FINETUNES).
 *
 * Daily cron at 09:00 CET (CRON-GRADUATION-RECOMMENDER.yml). Scans the
 * staging metrics for each fine-tune feature; for any feature that has been
 * at 100% of staging traffic for >=5 days with thresholds met, emits an
 * `auto_promote.proposed` event with action='graduate_to_prod' AND fires
 * an FCM digest to the operator(s) saying "X is ready to PUBLISH".
 *
 * The recommender ONLY recommends. Promotion to prod is a human canary
 * PUBLISH from the prod Command Hub (operator clicks PUBLISH, watches
 * metrics for 48h, then clicks Promote).
 *
 * Run: `npx tsx services/gateway/scripts/graduation-recommender.ts`
 * Env:
 *   STAGING_SUPABASE_URL / STAGING_SUPABASE_SERVICE_ROLE_KEY
 *   PROD_SUPABASE_URL / PROD_SUPABASE_SERVICE_ROLE_KEY (for the FCM emit)
 *   FCM_RECIPIENT_EMAIL (default d.stevanovic@exafy.io)
 *   GRADUATION_DRY_RUN=1 to skip FCM
 */

const STAGING_URL = process.env.STAGING_SUPABASE_URL;
const STAGING_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
const PROD_URL = process.env.SUPABASE_URL;
const PROD_KEY = process.env.SUPABASE_SERVICE_ROLE;
const FCM_RECIPIENT = process.env.FCM_RECIPIENT_EMAIL || 'd.stevanovic@exafy.io';
const DRY_RUN = process.env.GRADUATION_DRY_RUN === '1';
const FEATURES = ['voice-tool-router', 'intent-kind', 'pillar-classifier'] as const;
const SOAK_DAYS_REQUIRED = 5;

interface PromoteEvent {
  id: string;
  created_at: string;
  metadata: {
    action?: string;
    reason?: string;
    feature?: string;
    rollup?: Record<string, unknown>;
  };
}

async function fetchRecentPromoteEvents(): Promise<PromoteEvent[]> {
  if (!STAGING_URL || !STAGING_KEY) return [];
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const url = `${STAGING_URL}/rest/v1/oasis_events?topic=in.(auto_promote.proposed,auto_promote.rejected)&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=5000&select=id,created_at,metadata`;
  const resp = await fetch(url, {
    headers: { apikey: STAGING_KEY, Authorization: `Bearer ${STAGING_KEY}` },
  });
  if (!resp.ok) {
    console.error(`[graduation-recommender] fetch failed: ${resp.status}`);
    return [];
  }
  return (await resp.json()) as PromoteEvent[];
}

interface Candidate {
  feature: string;
  consecutive_proposed_days: number;
  most_recent_rollup: Record<string, unknown> | null;
  ready: boolean;
}

function evaluate(events: PromoteEvent[]): Candidate[] {
  const out: Candidate[] = [];
  for (const feature of FEATURES) {
    const featureEvents = events.filter((e) => e.metadata.feature === feature);

    // Walk back in time. Count contiguous days where the MOST RECENT decision
    // of the day was action='promote'. If we hit a rejected before the soak
    // is satisfied, the streak resets.
    const dayBuckets = new Map<string, PromoteEvent>(); // day -> most recent event for that day
    for (const e of featureEvents) {
      const day = e.created_at.slice(0, 10);
      if (!dayBuckets.has(day)) dayBuckets.set(day, e);
    }

    const days = [...dayBuckets.keys()].sort().reverse();
    let consecutive = 0;
    let mostRecent: Record<string, unknown> | null = null;
    for (const day of days) {
      const e = dayBuckets.get(day)!;
      if (e.metadata.action === 'promote') {
        consecutive++;
        if (mostRecent === null) mostRecent = e.metadata.rollup ?? null;
      } else {
        break;
      }
    }

    out.push({
      feature,
      consecutive_proposed_days: consecutive,
      most_recent_rollup: mostRecent,
      ready: consecutive >= SOAK_DAYS_REQUIRED,
    });
  }
  return out;
}

async function fcmDigest(candidates: Candidate[]): Promise<void> {
  const ready = candidates.filter((c) => c.ready);
  if (DRY_RUN || !PROD_URL || !PROD_KEY) {
    console.log('[graduation-recommender] DRY/UNCONFIGURED — skipping FCM:', JSON.stringify(ready, null, 2));
    return;
  }
  const body = {
    vtid: 'VTID-03179',
    topic: 'auto_promote.proposed',
    service: 'gateway/graduation-recommender',
    role: 'CICD',
    model: 'graduation-recommender',
    status: ready.length > 0 ? 'success' : 'info',
    message: ready.length > 0
      ? `${ready.length} feature(s) ready to PUBLISH: ${ready.map((c) => c.feature).join(', ')}`
      : 'no graduation candidates today',
    metadata: {
      env: 'production',
      action: 'graduate_to_prod',
      candidates,
      fcm_recipient: FCM_RECIPIENT,
      soak_days_required: SOAK_DAYS_REQUIRED,
    },
  };
  try {
    await fetch(`${PROD_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: PROD_KEY,
        Authorization: `Bearer ${PROD_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
    console.log(`[graduation-recommender] FCM digest emitted (${ready.length} ready)`);
  } catch (err) {
    console.error('[graduation-recommender] emit failed:', err);
  }
}

async function main(): Promise<void> {
  const events = await fetchRecentPromoteEvents();
  const candidates = evaluate(events);
  console.log(JSON.stringify({ dry_run: DRY_RUN, candidates }, null, 2));
  await fcmDigest(candidates);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[graduation-recommender] FAILED:', err);
    process.exit(1);
  });
}
