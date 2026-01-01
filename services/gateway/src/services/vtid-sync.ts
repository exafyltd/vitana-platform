/**
 * VTID Status Synchronization Service
 * VTID: DEV-AICOR-EVENT-VTID-SYNC
 * 
 * Automatically updates VTID statuses based on OASIS events.
 * Listens to events like task.completed, deployment.success, etc.
 * and updates corresponding VTID records in the ledger.
 */

interface OasisEvent {
  vtid?: string;
  topic: string;
  service: string;
  status: string;
  message: string;
  created_at?: string;
}

interface VtidStatusMapping {
  [key: string]: string;
}

// Event topic to VTID status mappings
// VTID-01005: Added terminal lifecycle events as authoritative terminal states
// VTID-01111: Added deploy.success/failed from CI/CD telemetry action
const STATUS_MAPPINGS: VtidStatusMapping = {
  'task.started': 'active',
  'task.in_progress': 'active',
  'task.review': 'review',
  'task.completed': 'complete',
  'task.failed': 'blocked',
  'task.cancelled': 'cancelled',
  'workflow.started': 'active',
  'workflow.success': 'complete',
  'workflow.failure': 'blocked',
  'deployment.started': 'active',
  'deployment.success': 'complete',
  'deployment.failed': 'blocked',
  'pr.opened': 'review',
  'pr.merged': 'complete',
  'pr.closed': 'cancelled',
  // VTID-01005: Terminal lifecycle events (MANDATORY - highest authority)
  'vtid.lifecycle.completed': 'complete',
  'vtid.lifecycle.failed': 'failed',
  // VTID-01005: Also handle deploy success/failed from CICD
  'cicd.deploy.service.succeeded': 'complete',
  'cicd.deploy.service.failed': 'blocked',
  'deploy.gateway.success': 'complete',
  'deploy.gateway.failed': 'blocked',
  // VTID-01111: CI/CD telemetry action events
  'deploy.success': 'complete',
  'deploy.failed': 'blocked',
  'cicd.merge.success': 'complete',
  'cicd.merge.failed': 'blocked',
};

// Status hierarchy (prevent downgrading)
// VTID-01005: Added 'failed' status and increased 'complete' priority
const STATUS_PRIORITY: Record<string, number> = {
  'pending': 1,
  'active': 2,
  'review': 3,
  'blocked': 4,
  'cancelled': 4,
  'failed': 5,    // VTID-01005: Terminal failure state
  'complete': 6,  // VTID-01005: Terminal success state (highest priority)
};

export class VtidSyncService {
  private supabaseUrl: string;
  private supabaseKey: string;

  constructor(supabaseUrl: string, supabaseKey: string) {
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
  }

  /**
   * Process an OASIS event and update corresponding VTID if applicable
   */
  async processEvent(event: OasisEvent): Promise<void> {
    // Skip if no VTID in event
    if (!event.vtid) {
      return;
    }

    // Skip if event topic doesn't map to a status change
    if (!STATUS_MAPPINGS[event.topic]) {
      return;
    }

    const targetStatus = STATUS_MAPPINGS[event.topic];

    try {
      // Get current VTID record
      const currentRecord = await this.getVtid(event.vtid);
      
      if (!currentRecord) {
        console.warn(`⚠️ VTID not found: ${event.vtid}`);
        return;
      }

      // Check if status change is valid (no downgrading)
      const currentPriority = STATUS_PRIORITY[currentRecord.status] || 0;
      const targetPriority = STATUS_PRIORITY[targetStatus] || 0;

      if (targetPriority < currentPriority) {
        console.log(`⏭️ Skipping status downgrade: ${event.vtid} (${currentRecord.status} -> ${targetStatus})`);
        return;
      }

      // Skip if already at target status
      if (currentRecord.status === targetStatus) {
        return;
      }

      // Update VTID status
      await this.updateVtidStatus(event.vtid, targetStatus, {
        last_event_topic: event.topic,
        last_event_service: event.service,
        last_event_ts: event.created_at || new Date().toISOString(),
      });

      console.log(`✅ VTID status synced: ${event.vtid} -> ${targetStatus} (via ${event.topic})`);

      // Emit OASIS event for the status change
      await this.emitStatusChangeEvent(event.vtid, currentRecord.status, targetStatus, event.topic);

    } catch (error: any) {
      console.error(`❌ Failed to sync VTID ${event.vtid}:`, error.message);
    }
  }

  /**
   * Get VTID record from ledger
   * VTID-01005: Fixed table name from VtidLedger to vtid_ledger
   */
  private async getVtid(vtid: string): Promise<any | null> {
    const resp = await fetch(
      `${this.supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`,
      {
        method: "GET",
        headers: {
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
        },
      }
    );

    if (!resp.ok) {
      throw new Error(`Failed to fetch VTID: ${resp.status}`);
    }

    const data = await resp.json() as any[];
    return data.length > 0 ? data[0] : null;
  }

  /**
   * Update VTID status in ledger
   * VTID-01005: Fixed table name from VtidLedger to vtid_ledger
   */
  private async updateVtidStatus(vtid: string, status: string, metadata: any): Promise<void> {
    const updatePayload = {
      status,
      metadata: metadata,
      updated_at: new Date().toISOString(),
    };

    const resp = await fetch(
      `${this.supabaseUrl}/rest/v1/vtid_ledger?vtid=eq.${vtid}`,
      {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
          Prefer: "return=representation",
        },
        body: JSON.stringify(updatePayload),
      }
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Failed to update VTID: ${resp.status} - ${text}`);
    }
  }

  /**
   * Emit OASIS event for status change
   */
  private async emitStatusChangeEvent(vtid: string, fromStatus: string, toStatus: string, trigger: string): Promise<void> {
    const eventPayload = {
      vtid,
      topic: 'vtid.status.updated',
      service: 'vtid-sync',
      role: 'SYSTEM',
      status: 'info',
      message: `VTID ${vtid} status: ${fromStatus} → ${toStatus}`,
      metadata: {
        from_status: fromStatus,
        to_status: toStatus,
        trigger_event: trigger,
        synced_at: new Date().toISOString(),
      },
    };

    // Insert into oasis_events table
    await fetch(
      `${this.supabaseUrl}/rest/v1/oasis_events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: this.supabaseKey,
          Authorization: `Bearer ${this.supabaseKey}`,
        },
        body: JSON.stringify(eventPayload),
      }
    );
  }
}
