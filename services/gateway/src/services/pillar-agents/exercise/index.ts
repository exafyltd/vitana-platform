import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAgent, PillarAgentOutput } from '../types';
import { computeAllSubscoresForPillar } from '../base-agent';

/**
 * Exercise pillar agent (v1).
 *
 * v1: mirrors the compute RPC math for Exercise.
 * v2+: Apple Health, Google Fit, Strava, Whoop, Oura, Garmin Connect,
 *      Fitbit, Polar. VO2-max estimation. Zone-2 vs. HIIT detection.
 */
export function createExerciseAgent(admin: SupabaseClient): PillarAgent {
  return {
    pillar: 'exercise',
    agentId: 'pillar-exercise-agent',
    displayName: 'Pillar Agent — Exercise',
    version: 'v1',
    async computePillarSubscores(userId: string, _date: string): Promise<PillarAgentOutput> {
      const subscores = await computeAllSubscoresForPillar(admin, userId, 'exercise');
      return {
        pillar: 'exercise',
        subscores,
        metadata: { source: 'v1', integrations_connected: [] },
        agent_version: 'v1',
      };
    },
  };
}
