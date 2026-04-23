import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAgent, PillarAgentOutput } from '../types';
import { computeAllSubscoresForPillar } from '../base-agent';

/**
 * Hydration pillar agent (v1).
 *
 * v1: mirrors the compute RPC math for Hydration.
 * v2+: HidrateSpark bottles, Apple Health (Water), Google Fit (Hydration),
 *      climate-adjusted daily targets via OpenWeatherMap.
 */
export function createHydrationAgent(admin: SupabaseClient): PillarAgent {
  return {
    pillar: 'hydration',
    agentId: 'pillar-hydration-agent',
    displayName: 'Pillar Agent — Hydration',
    version: 'v1',
    async computePillarSubscores(userId: string, _date: string): Promise<PillarAgentOutput> {
      const subscores = await computeAllSubscoresForPillar(admin, userId, 'hydration');
      return {
        pillar: 'hydration',
        subscores,
        metadata: { source: 'v1', integrations_connected: [] },
        agent_version: 'v1',
      };
    },
  };
}
