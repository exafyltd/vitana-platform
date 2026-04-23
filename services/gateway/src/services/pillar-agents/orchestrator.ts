/**
 * Pillar Agent Orchestrator (Phase F v1).
 *
 * Runs all 5 pillar agents in parallel for a given user/date, writes their
 * outputs to `vitana_pillar_agent_outputs`, and updates each agent's
 * heartbeat in `agents_registry`. Never blocks the calling code — agent
 * failures are logged and swallowed per-agent.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrchestratorRunResult, PillarAgent, PillarAgentOutput, PillarKey } from './types';
import { createNutritionAgent } from './nutrition';
import { createHydrationAgent } from './hydration';
import { createExerciseAgent } from './exercise';
import { createSleepAgent } from './sleep';
import { createMentalAgent } from './mental';

export function buildAllAgents(admin: SupabaseClient): PillarAgent[] {
  return [
    createNutritionAgent(admin),
    createHydrationAgent(admin),
    createExerciseAgent(admin),
    createSleepAgent(admin),
    createMentalAgent(admin),
  ];
}

async function persistOutput(
  admin: SupabaseClient,
  userId: string,
  date: string,
  output: PillarAgentOutput,
): Promise<void> {
  const { error } = await admin
    .from('vitana_pillar_agent_outputs')
    .upsert({
      user_id: userId,
      pillar: output.pillar,
      date,
      outputs_jsonb: output.metadata,
      subscore_baseline:    output.subscores.baseline,
      subscore_completions: output.subscores.completions,
      subscore_data:        output.subscores.data,
      subscore_streak:      output.subscores.streak,
      agent_version: output.agent_version,
      computed_at: new Date().toISOString(),
    }, { onConflict: 'user_id,pillar,date' });

  if (error) {
    throw new Error(`vitana_pillar_agent_outputs upsert failed: ${error.message}`);
  }
}

async function heartbeat(
  admin: SupabaseClient,
  agentId: string,
  ok: boolean,
  errorMessage?: string,
): Promise<void> {
  try {
    await admin
      .from('agents_registry')
      .update({
        status: ok ? 'healthy' : 'degraded',
        last_heartbeat_at: new Date().toISOString(),
        last_error: ok ? null : (errorMessage ?? null),
        updated_at: new Date().toISOString(),
      })
      .eq('agent_id', agentId);
  } catch {
    // Heartbeat failures are never fatal.
  }
}

export async function runPillarAgentsForUser(
  admin: SupabaseClient,
  userId: string,
  date: string,
): Promise<OrchestratorRunResult> {
  const t0 = Date.now();
  const agents = buildAllAgents(admin);

  const results = await Promise.allSettled(agents.map(async (agent) => {
    const output = await agent.computePillarSubscores(userId, date);
    await persistOutput(admin, userId, date, output);
    await heartbeat(admin, agent.agentId, true);
    return { agent, output };
  }));

  const per_pillar: Partial<Record<PillarKey, PillarAgentOutput>> = {};
  const errors: Array<{ pillar: PillarKey; message: string }> = [];
  let agents_run = 0;
  let agents_failed = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const agent = agents[i];
    if (r.status === 'fulfilled') {
      per_pillar[agent.pillar] = r.value.output;
      agents_run++;
    } else {
      const message = r.reason instanceof Error ? r.reason.message : String(r.reason);
      errors.push({ pillar: agent.pillar, message });
      await heartbeat(admin, agent.agentId, false, message);
      agents_failed++;
    }
  }

  return {
    ok: agents_failed === 0,
    user_id: userId,
    date,
    agents_run,
    agents_failed,
    per_pillar,
    errors,
    duration_ms: Date.now() - t0,
  };
}
