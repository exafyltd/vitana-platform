/**
 * report_progress tool
 * Emits an OASIS event to track progress on a task
 */

import { gatewayClient } from '../lib/gateway-client.js';

export interface ReportProgressParams {
  vtid: string;
  message: string;
}

export interface ReportProgressResult {
  ok: boolean;
  event_id?: string;
  error?: string;
}

export async function reportProgress(params: ReportProgressParams): Promise<ReportProgressResult> {
  const { vtid, message } = params;

  try {
    const result = await gatewayClient.emitEvent(
      vtid,
      'task.progress',
      message,
      {
        source: 'claude-code',
        timestamp: new Date().toISOString(),
      }
    );

    return {
      ok: result.ok,
      event_id: result.event_id,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
