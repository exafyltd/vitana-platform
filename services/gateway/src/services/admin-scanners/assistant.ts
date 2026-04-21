/**
 * BOOTSTRAP-ADMIN-BB-FINAL: assistant scanner.
 *
 * Produces insights for the assistant domain:
 *   - personality_override_stale     — override hasn't been updated in 90 days
 *                                      (content drifts under a frozen persona)
 *   - no_assistant_surfaces          — tenant has zero tenant_assistant_config
 *                                      rows (never configured)
 *   - orb_stall_rate_high            — OASIS orb.live.stall_detected events
 *                                      > 5 % of session starts in last 24h
 *
 * Reads tenant_assistant_config + oasis_events.
 */
import { getSupabase } from '../../lib/supabase';
import type { AdminScanner, InsightDraft } from './types';

const LOG_PREFIX = '[admin-scanner:assistant]';
const ORB_STALL_RATE_THRESHOLD_PCT = 5;

export const assistantScanner: AdminScanner = {
  id: 'assistant',
  domain: 'assistant',
  label: 'Assistant & Voice',

  async scan(tenantId: string): Promise<InsightDraft[]> {
    const supabase = getSupabase();
    if (!supabase) return [];

    const insights: InsightDraft[] = [];
    const now = Date.now();
    const d1 = new Date(now - 86400_000).toISOString();
    const d90 = new Date(now - 90 * 86400_000).toISOString();

    // 1. Assistant config never set up
    try {
      const { count } = await supabase
        .from('tenant_assistant_config')
        .select('id', { count: 'exact', head: true })
        .eq('tenant_id', tenantId);
      if (count !== null && count === 0) {
        insights.push({
          natural_key: 'assistant_no_config',
          domain: 'assistant',
          title: 'Assistant never configured for this tenant',
          description:
            `No tenant_assistant_config rows. Vitana is running on the default persona ` +
            `and default voice. You can customise system prompt, voice, and per-surface ` +
            `tools — worth at least picking a voice and confirming the persona fits the brand.`,
          severity: 'info',
          actionable: true,
          recommended_action: {
            type: 'configure_assistant',
            endpoint: `/api/v1/admin/tenants/${tenantId}/assistant`,
          },
          context: { config_rows: 0 },
          confidence_score: 0.8,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} no_config failed: ${err?.message}`);
    }

    // 2. Stale persona — override hasn't been touched in 90 days
    try {
      const { data: overrides } = await supabase
        .from('tenant_assistant_config')
        .select('surface_key, updated_at, system_prompt_override')
        .eq('tenant_id', tenantId)
        .not('system_prompt_override', 'is', null)
        .lt('updated_at', d90);
      if (overrides && overrides.length > 0) {
        insights.push({
          natural_key: 'assistant_persona_stale_90d',
          domain: 'assistant',
          title: `${overrides.length} assistant persona${overrides.length > 1 ? 's' : ''} unchanged for 90+ days`,
          description:
            `System-prompt overrides frozen for a quarter usually drift away from ` +
            `current product reality (new features, new copy, new tone). Review ` +
            `and refresh so the voice matches what users see on screen.`,
          severity: 'info',
          actionable: true,
          recommended_action: {
            type: 'review_assistant_overrides',
            surfaces: overrides.map((o: { surface_key: string }) => o.surface_key),
          },
          context: {
            stale_count: overrides.length,
            surfaces: overrides.map((o: { surface_key: string; updated_at: string }) => ({
              surface: o.surface_key,
              updated_at: o.updated_at,
            })),
          },
          confidence_score: 0.7,
          autonomy_level: 'observe_only',
        });
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} persona_stale failed: ${err?.message}`);
    }

    // 3. Orb stall-rate — stall events / session starts in last 24h.
    // oasis_events has no tenant_id so this is global, tagged accordingly.
    try {
      const [{ count: stalls }, { count: starts }] = await Promise.all([
        supabase
          .from('oasis_events')
          .select('id', { count: 'exact', head: true })
          .eq('topic', 'orb.live.stall_detected')
          .gte('occurred_at', d1),
        supabase
          .from('oasis_events')
          .select('id', { count: 'exact', head: true })
          .in('topic', ['vtid.live.session.start', 'voice.live.session.start'])
          .gte('occurred_at', d1),
      ]);
      const stallCount = stalls ?? 0;
      const startCount = starts ?? 0;
      if (startCount >= 20) {
        const rate = (stallCount / startCount) * 100;
        if (rate > ORB_STALL_RATE_THRESHOLD_PCT) {
          insights.push({
            natural_key: 'assistant_orb_stall_rate_24h',
            domain: 'assistant',
            title: `Orb stall rate ${rate.toFixed(1)}% in last 24h`,
            description:
              `${stallCount} stalls across ${startCount} voice sessions. Above ` +
              `${ORB_STALL_RATE_THRESHOLD_PCT}% means users are hitting mid-conversation ` +
              `disconnects noticeably often. Check Voice Lab for the dominant stall reason.`,
            severity: rate > 15 ? 'action_needed' : 'warning',
            actionable: true,
            recommended_action: {
              type: 'inspect_voice_lab',
              endpoint: '/command-hub/diagnostics/voice-lab/',
            },
            context: {
              stall_count: stallCount,
              session_starts: startCount,
              stall_rate_pct: Number(rate.toFixed(2)),
              threshold_pct: ORB_STALL_RATE_THRESHOLD_PCT,
              tenant_scope: 'global',
              scanned_tenant: tenantId,
            },
            confidence_score: 0.85,
            autonomy_level: 'observe_only',
          });
        }
      }
    } catch (err: any) {
      console.warn(`${LOG_PREFIX} orb_stall_rate failed: ${err?.message}`);
    }

    return insights;
  },
};
