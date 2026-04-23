import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAgent, PillarAgentOutput } from '../types';
import { computeAllSubscoresForPillar } from '../base-agent';

/**
 * Sleep pillar agent (v1).
 *
 * v1: mirrors the compute RPC math for Sleep.
 * v2+: Oura, Whoop, Eight Sleep, Apple Sleep, Fitbit Sleep, Garmin Sleep.
 *      Personalised sleep-hygiene review, bedtime planner.
 */
export function createSleepAgent(admin: SupabaseClient): PillarAgent {
  return {
    pillar: 'sleep',
    agentId: 'pillar-sleep-agent',
    displayName: 'Pillar Agent — Sleep',
    version: 'v1',
    async computePillarSubscores(userId: string, _date: string): Promise<PillarAgentOutput> {
      const subscores = await computeAllSubscoresForPillar(admin, userId, 'sleep');
      return {
        pillar: 'sleep',
        subscores,
        metadata: { source: 'v1', integrations_connected: [] },
        agent_version: 'v1',
      };
    },
  };
}
