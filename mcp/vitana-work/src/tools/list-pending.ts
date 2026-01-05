/**
 * list_pending_tasks tool
 * Lists pending work orders from Vitana Gateway
 */

import { gatewayClient } from '../lib/gateway-client.js';

export interface PendingTask {
  vtid: string;
  title: string;
  status: string;
  created_at: string;
}

export interface ListPendingResult {
  tasks: PendingTask[];
}

export async function listPendingTasks(): Promise<ListPendingResult> {
  const workOrders = await gatewayClient.listWorkOrders();

  // Filter to only pending/open tasks
  const pendingTasks = workOrders
    .filter((wo) => wo.status === 'pending' || wo.status === 'open')
    .map((wo) => ({
      vtid: wo.vtid,
      title: wo.title,
      status: wo.status,
      created_at: wo.created_at,
    }));

  return { tasks: pendingTasks };
}
