/**
 * complete_task tool
 * Marks a task as completed in OASIS
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
