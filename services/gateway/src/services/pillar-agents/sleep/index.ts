import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAgent, PillarAgentOutput, PillarAnswer } from '../types';
import { computeAllSubscoresForPillar, defaultPillarAnswer } from '../base-agent';

/**
 * Sleep pillar agent (v1).
 *
 * v1: mirrors the compute RPC math for Sleep + Q&A delegates to the
 *     deterministic defaultPillarAnswer (sub-scores + Book ch 4 citation).
 * v2+: Oura, Whoop, Eight Sleep, Apple Sleep, Fitbit Sleep, Garmin Sleep.
 *      Personalised sleep-hygiene review, bedtime planner, narrative
 *      answers grounded in the user's connected sleep data.
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
    async answerQuestion(userId: string, question: string): Promise<PillarAnswer> {
      return defaultPillarAnswer(admin, userId, 'sleep', question, 'v1');
    },
  };
}
