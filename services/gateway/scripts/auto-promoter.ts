/**
 * Auto-promoter — Phase 1 W1 (VTID-03179 FINETUNES).
 *
 * Hourly cron (CRON-AUTO-PROMOTER.yml). Reads rolling 24h
 * `eval.shadow.compared` events from STAGING oasis_events, computes
 * agreement / latency / error rate per feature, and decides whether the
 * staging traffic flip should be advanced (5% -> 50% -> 100%) for that
 * feature.
 *
 * Promotion happens by emitting `auto_promote.proposed` and (in W2+, once
 * the auto-promoter is allowed to act) opening a PR that flips
 * FEATURE_<NAME>_ENV in the STAGE-DEPLOY env block. In W1 the promoter
 * runs in DRY mode — it emits the event but does NOT open a PR yet.
 *
 * Promotion to PROD never happens here. Graduation to prod is a human
 * canary PUBLISH triggered by `graduation-recommender.ts`.
 *
 * Run: `npx tsx services/gateway/scripts/auto-promoter.ts`
 * Env: STAGING_SUPABASE_URL, STAGING_SUPABASE_SERVICE_ROLE_KEY,
 *      AUTO_PROMOTER_DRY_RUN=0 in W2+ to actually open PRs.
 */

const STAGING_URL = process.env.STAGING_SUPABASE_URL;
const STAGING_KEY = process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = process.env.AUTO_PROMOTER_DRY_RUN !== '0';
const FEATURES = ['voice-tool-router', 'intent-kind', 'pillar-classifier'] as const;

const PROMOTION_THRESHOLDS = {
  min_samples_per_feature: 200,
  min_agreement: 0.92,
  max_candidate_p95_ms: 800,
  max_candidate_error_rate: 0.02,
} as const;

interface ShadowEvent {
  id: string;
  created_at: string;
  metadata: {
    feature?: string;
    agreement?: boolean | null;
    candidate_ms?: number;
    candidate_error?: string | null;
    [k: string]: unknown;
  };
}

interface FeatureRollup {
  feature: string;
  samples: number;
  agreement_rate: number;
  candidate_p95_ms: number;
  candidate_error_rate: number;
}

async function fetchShadowEvents(feature: string): Promise<ShadowEvent[]> {
  if (!STAGING_URL || !STAGING_KEY) return [];
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const url = `${STAGING_URL}/rest/v1/oasis_events?topic=eq.eval.shadow.compared&created_at=gte.${encodeURIComponent(since)}&order=created_at.desc&limit=10000&select=id,created_at,metadata`;
  const resp = await fetch(url, {
    headers: {
      apikey: STAGING_KEY,
      Authorization: `Bearer ${STAGING_KEY}`,
    },
  });
  if (!resp.ok) {
    console.error(`[auto-promoter] fetch failed: ${resp.status}`);
    return [];
  }
  const rows = (await resp.json()) as ShadowEvent[];
  return rows.filter((r) => r.metadata?.feature === feature);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))];
}

function rollup(feature: string, events: ShadowEvent[]): FeatureRollup {
  const samples = events.length;
  const agreed = events.filter((e) => e.metadata.agreement === true).length;
  const errored = events.filter((e) => Boolean(e.metadata.candidate_error)).length;
  const latencies = events
    .map((e) => e.metadata.candidate_ms)
    .filter((m): m is number => typeof m === 'number')
    .sort((a, b) => a - b);
  return {
    feature,
    samples,
    agreement_rate: samples > 0 ? agreed / samples : 0,
    candidate_p95_ms: percentile(latencies, 95),
    candidate_error_rate: samples > 0 ? errored / samples : 0,
  };
}

interface Decision {
  feature: string;
  action: 'promote' | 'reject' | 'none';
  reason: string;
  rollup: FeatureRollup;
}

function decide(r: FeatureRollup): Decision {
  if (r.samples < PROMOTION_THRESHOLDS.min_samples_per_feature) {
    return { feature: r.feature, action: 'none', reason: `insufficient_samples (${r.samples})`, rollup: r };
  }
  if (r.agreement_rate < PROMOTION_THRESHOLDS.min_agreement) {
    return { feature: r.feature, action: 'reject', reason: `low_agreement (${r.agreement_rate.toFixed(3)})`, rollup: r };
  }
  if (r.candidate_p95_ms > PROMOTION_THRESHOLDS.max_candidate_p95_ms) {
    return { feature: r.feature, action: 'reject', reason: `slow_candidate_p95 (${r.candidate_p95_ms}ms)`, rollup: r };
  }
  if (r.candidate_error_rate > PROMOTION_THRESHOLDS.max_candidate_error_rate) {
    return { feature: r.feature, action: 'reject', reason: `high_error_rate (${r.candidate_error_rate.toFixed(3)})`, rollup: r };
  }
  return { feature: r.feature, action: 'promote', reason: 'thresholds_met', rollup: r };
}

async function emitDecision(d: Decision): Promise<void> {
  if (!STAGING_URL || !STAGING_KEY) return;
  const topic = d.action === 'promote' ? 'auto_promote.proposed' : 'auto_promote.rejected';
  const body = {
    vtid: 'VTID-03179',
    topic,
    service: 'gateway/auto-promoter',
    role: 'CICD',
    model: 'auto-promoter',
    status: d.action === 'promote' ? 'success' : 'warning',
    message: `${d.action} ${d.feature}: ${d.reason}`,
    metadata: {
      env: 'staging',
      action: d.action,
      reason: d.reason,
      rollup: d.rollup,
      dry_run: DRY_RUN,
    },
  };
  try {
    await fetch(`${STAGING_URL}/rest/v1/oasis_events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: STAGING_KEY,
        Authorization: `Bearer ${STAGING_KEY}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error('[auto-promoter] event emit failed:', err);
  }
}

async function main(): Promise<void> {
  const results: Decision[] = [];
  for (const feature of FEATURES) {
    const events = await fetchShadowEvents(feature);
    const r = rollup(feature, events);
    const d = decide(r);
    console.log(`[auto-promoter] ${feature}: action=${d.action} reason=${d.reason} samples=${r.samples} agreement=${r.agreement_rate.toFixed(3)} p95=${r.candidate_p95_ms}ms`);
    await emitDecision(d);
    results.push(d);
  }
  console.log(JSON.stringify({ dry_run: DRY_RUN, results }, null, 2));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[auto-promoter] FAILED:', err);
    process.exit(1);
  });
}
