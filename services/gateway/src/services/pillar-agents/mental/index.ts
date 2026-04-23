import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAgent, PillarAgentOutput } from '../types';
import { computeAllSubscoresForPillar } from '../base-agent';

/**
 * Mental pillar agent (v1).
 *
 * v1: mirrors the compute RPC math for Mental.
 * v2+: journal LLM analysis, HRV stress signals, Calm / Headspace logs,
 *      Apple Health Mindful Minutes, mood-tracking apps.
 */
export function createMentalAgent(admin: SupabaseClient): PillarAgent {
  return {
    pillar: 'mental',
    agentId: 'pillar-mental-agent',
    displayName: 'Pillar Agent — Mental',
    version: 'v1',
    async computePillarSubscores(userId: string, _date: string): Promise<PillarAgentOutput> {
      const subscores = await computeAllSubscoresForPillar(admin, userId, 'mental');
      return {
        pillar: 'mental',
        subscores,
        metadata: { source: 'v1', integrations_connected: [] },
        agent_version: 'v1',
      };
    },
  };
}
