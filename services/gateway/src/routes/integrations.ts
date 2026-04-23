/**
 * Integrations — per-user integration management + data ingestion.
 *
 * Mounted at /api/v1/integrations.
 *
 * Endpoints:
 *   GET  /                      — list the authenticated user's integrations + their state
 *   POST /:integration_id/connect    — mark an integration as connected
 *   POST /:integration_id/disconnect — mark disconnected
 *   POST /manual/log            — write a health data point (Manual Entry)
 *                                 Body: { pillar, feature_key, value, unit?, date? }
 *                                 After write, runs pillar agents for the user
 *                                 so the connected_data sub-score reflects the
 *                                 new signal within ~1s on the UI.
 *
 * RLS on user_integrations is owner-only (via auth.uid()); service-role
 * admin client is used here so we can compose multi-step operations
 * (write feature_row + run agents) in a single request.
 */

import { Router, Response } from 'express';
import { requireAuth, AuthenticatedRequest } from '../middleware/auth-supabase-jwt';
import { getSupabase } from '../lib/supabase';
import { runPillarAgentsForUser } from '../services/pillar-agents/orchestrator';

const router = Router();

// Every user automatically has the manual-entry integration available.
const BUILTIN_MANUAL = {
  integration_id: 'manual-entry',
  status: 'connected',
  display_name: 'Manual Data Entry',
  description:
    'Log data points directly from the Index Detail screen — water, exercise, sleep, meditation, meals.',
};

const VALID_PILLARS = ['nutrition', 'hydration', 'exercise', 'sleep', 'mental'] as const;
type Pillar = typeof VALID_PILLARS[number];

// Per-pillar allowed feature keys (matches base-agent.ts / compute RPC).
const PILLAR_FEATURE_KEYS: Record<Pillar, string[]> = {
  nutrition: ['biomarker_glucose', 'biomarker_hba1c', 'meal_log', 'macro_balance'],
  hydration: ['water_intake', 'hydration_log'],
  exercise:  ['wearable_heart_rate', 'wearable_steps', 'wearable_workout', 'vo2_max'],
  sleep:     ['wearable_sleep_duration', 'wearable_sleep_efficiency', 'wearable_hrv', 'wearable_sleep_stages'],
  mental:    ['wearable_stress', 'mood_entry', 'meditation_minutes', 'journal_entry'],
};

router.get('/', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const admin = getSupabase();
  if (!admin) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  try {
    const { data, error } = await admin
      .from('user_integrations')
      .select('integration_id, status, connected_at, disconnected_at, last_sync_at, last_error, metadata')
      .eq('user_id', userId)
      .order('integration_id', { ascending: true });
    if (error) return res.status(400).json({ ok: false, error: error.message });

    const rows = data ?? [];
    const hasManual = rows.some(r => r.integration_id === 'manual-entry');
    const integrations = hasManual
      ? rows
      : [
          {
            integration_id: BUILTIN_MANUAL.integration_id,
            status: BUILTIN_MANUAL.status,
            connected_at: new Date().toISOString(),
            disconnected_at: null,
            last_sync_at: null,
            last_error: null,
            metadata: { implicit: true, display_name: BUILTIN_MANUAL.display_name },
          },
          ...rows,
        ];

    return res.status(200).json({
      ok: true,
      user_id: userId,
      integrations,
      catalog: [
        BUILTIN_MANUAL,
        { integration_id: 'apple-health',  status: 'unavailable', display_name: 'Apple Health',  description: 'Requires a native mobile app (HealthKit). Roadmap.' },
        { integration_id: 'oura',          status: 'unavailable', display_name: 'Oura Ring',     description: 'Requires native app or third-party aggregator. Roadmap.' },
        { integration_id: 'whoop',         status: 'unavailable', display_name: 'Whoop',         description: 'Requires OAuth + aggregator. Roadmap.' },
        { integration_id: 'myfitnesspal',  status: 'unavailable', display_name: 'MyFitnessPal',  description: 'Requires OAuth + export sync. Roadmap.' },
        { integration_id: 'cronometer',    status: 'unavailable', display_name: 'Cronometer',    description: 'Requires OAuth + export sync. Roadmap.' },
        { integration_id: 'calm',          status: 'unavailable', display_name: 'Calm',          description: 'Requires OAuth. Roadmap.' },
        { integration_id: 'headspace',     status: 'unavailable', display_name: 'Headspace',     description: 'Requires OAuth. Roadmap.' },
      ],
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:integration_id/connect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const admin = getSupabase();
  if (!admin) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const integrationId = req.params.integration_id;

  try {
    const { data, error } = await admin
      .from('user_integrations')
      .upsert(
        {
          user_id: userId,
          integration_id: integrationId,
          status: 'connected',
          connected_at: new Date().toISOString(),
          disconnected_at: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,integration_id' }
      )
      .select()
      .single();
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, integration: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/:integration_id/disconnect', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const admin = getSupabase();
  if (!admin) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });
  const integrationId = req.params.integration_id;

  try {
    const { data, error } = await admin
      .from('user_integrations')
      .upsert(
        {
          user_id: userId,
          integration_id: integrationId,
          status: 'disconnected',
          disconnected_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id,integration_id' }
      )
      .select()
      .single();
    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.status(200).json({ ok: true, integration: data });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.post('/manual/log', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const admin = getSupabase();
  if (!admin) return res.status(503).json({ ok: false, error: 'DB_UNAVAILABLE' });
  const userId = req.identity?.user_id;
  if (!userId) return res.status(401).json({ ok: false, error: 'UNAUTHENTICATED' });

  const body = req.body ?? {};
  const pillar = (body.pillar as string | undefined)?.trim() as Pillar | undefined;
  const featureKey = (body.feature_key as string | undefined)?.trim();
  const value = Number(body.value);
  const unit = (body.unit as string | undefined)?.trim() ?? null;
  const date = (body.date as string | undefined)?.trim() || new Date().toISOString().slice(0, 10);

  if (!pillar || !VALID_PILLARS.includes(pillar)) {
    return res.status(400).json({ ok: false, error: 'INVALID_PILLAR', message: `pillar must be one of ${VALID_PILLARS.join(', ')}` });
  }
  if (!featureKey || !PILLAR_FEATURE_KEYS[pillar].includes(featureKey)) {
    return res.status(400).json({
      ok: false,
      error: 'INVALID_FEATURE_KEY',
      message: `feature_key for ${pillar} must be one of ${PILLAR_FEATURE_KEYS[pillar].join(', ')}`,
    });
  }
  if (!Number.isFinite(value)) {
    return res.status(400).json({ ok: false, error: 'INVALID_VALUE' });
  }

  try {
    // Resolve tenant via user_tenants fallback (same pattern as baseline survey).
    let tenantId: string | null = null;
    const { data: tenantRow } = await admin
      .from('user_tenants')
      .select('tenant_id')
      .eq('user_id', userId)
      .limit(1)
      .maybeSingle();
    tenantId = (tenantRow?.tenant_id as string | undefined) ?? null;
    const effectiveTenantId = tenantId ?? '00000000-0000-0000-0000-000000000000';

    // Upsert the feature row.
    const { error: featErr } = await admin
      .from('health_features_daily')
      .upsert({
        tenant_id: effectiveTenantId,
        user_id: userId,
        date,
        feature_key: featureKey,
        feature_value: value,
        feature_unit: unit,
        sample_count: 1,
        confidence: 0.8,
      }, { onConflict: 'tenant_id,user_id,date,feature_key' });
    if (featErr) {
      return res.status(400).json({ ok: false, error: 'FEATURE_WRITE_FAILED', detail: featErr.message });
    }

    // Mark the manual-entry integration as connected + bump last_sync_at.
    await admin
      .from('user_integrations')
      .upsert({
        user_id: userId,
        integration_id: 'manual-entry',
        status: 'connected',
        connected_at: new Date().toISOString(),
        last_sync_at: new Date().toISOString(),
        metadata: { source: 'manual_log' },
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id,integration_id' });

    // Re-run pillar agents so the connected_data sub-score reflects the new signal.
    const orchestratorResult = await runPillarAgentsForUser(admin, userId, date);

    return res.status(200).json({
      ok: true,
      pillar,
      feature_key: featureKey,
      date,
      orchestrator: {
        agents_run: orchestratorResult.agents_run,
        agents_failed: orchestratorResult.agents_failed,
        per_pillar_subscores: Object.fromEntries(
          Object.entries(orchestratorResult.per_pillar).map(([k, v]) => [k, v?.subscores])
        ),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

router.get('/health', (_req, res: Response) => {
  res.status(200).json({
    ok: true,
    service: 'integrations',
    endpoints: [
      'GET    /api/v1/integrations',
      'POST   /api/v1/integrations/:integration_id/connect',
      'POST   /api/v1/integrations/:integration_id/disconnect',
      'POST   /api/v1/integrations/manual/log',
    ],
  });
});

export default router;
