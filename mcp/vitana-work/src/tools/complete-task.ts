/**
 * complete_task tool
 * Moves task to 'in_validation' status and emits task.ready_for_validation event.
 * Does NOT set terminal 'completed' status - that requires human validation.
 */

import { gatewayClient } from '../lib/gateway-client.js';

export interface CompleteTaskParams {
  vtid: string;
  summary: string;
}

export interface CompleteTaskResult {
  ok: boolean;
  error?: string;
}

export async function completeTask(params: CompleteTaskParams): Promise<CompleteTaskResult> {
  const { vtid, summary } = params;

  try {
    const result = await gatewayClient.completeTask(vtid, summary);

    return {
      ok: result.ok,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
