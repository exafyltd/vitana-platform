import type { SupabaseClient } from '@supabase/supabase-js';
import type { PillarAgent, PillarAgentOutput, PillarAnswer } from '../types';
import { computeAllSubscoresForPillar, defaultPillarAnswer } from '../base-agent';

/**
 * Nutrition pillar agent (v1).
 *
 * v1: mirrors the compute RPC math for Nutrition + Q&A delegates to the
 *     deterministic defaultPillarAnswer (sub-scores + Book ch 1 citation).
 * v2+: parse meal photos (LLM vision), import MyFitnessPal/Cronometer,
 *      read biomarker labs (HbA1c, lipid panels), CGM glucose trends.
 */
export function createNutritionAgent(admin: SupabaseClient): PillarAgent {
  return {
    pillar: 'nutrition',
    agentId: 'pillar-nutrition-agent',
    displayName: 'Pillar Agent — Nutrition',
    version: 'v1',
    async computePillarSubscores(userId: string, _date: string): Promise<PillarAgentOutput> {
      const subscores = await computeAllSubscoresForPillar(admin, userId, 'nutrition');
      return {
        pillar: 'nutrition',
        subscores,
        metadata: { source: 'v1', integrations_connected: [] },
        agent_version: 'v1',
      };
    },
    async answerQuestion(userId: string, question: string): Promise<PillarAnswer> {
      return defaultPillarAnswer(admin, userId, 'nutrition', question, 'v1');
    },
  };
}
