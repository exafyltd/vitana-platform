/**
 * VTID-0521: Automatic VTID Ledger Writer
 *
 * This module syncs OASIS events to the vtid_ledger table.
 * It processes events with VTIDs and maintains the ledger
 * with current status, service, and event tracking info.
 */

import { Database } from './database';
import { logger } from './logger';

// OASIS event structure from the oasis_events table
interface OasisEvent {
  id: string;
  vtid?: string;
  topic?: string;      // Event type (used by /api/v1/events/ingest)
  event?: string;      // Event name (used by Prisma OasisEvent model)
  service: string;
  status: string;
  message?: string;
  metadata?: Record<string, any>;
  created_at: Date;
  layer?: string;
  module?: string;
  kind?: string;
  source?: string;
  title?: string;
  ref?: string;
}

// Status mapping from OASIS event types to VTID ledger statuses
const STATUS_MAPPING: Record<string, string> = {
  // Deployment events
  'deployment_started': 'active',
  'deployment_succeeded': 'complete',
  'deployment_failed': 'blocked',
  'deployment_validated': 'complete',
  'deployment.started': 'active',
  'deployment.succeeded': 'complete',
  'deployment.failed': 'blocked',
  'deployment.validated': 'complete',

  // Task events
  'task_created': 'pending',
  'task_started': 'active',
  'task_completed': 'complete',
  'task_failed': 'blocked',
  'task_cancelled': 'cancelled',
  'task.created': 'pending',
  'task.started': 'active',
  'task.completed': 'complete',
  'task.failed': 'blocked',
  'task.cancelled': 'cancelled',

  // PR events
  'pr_created': 'active',
  'pr_merged': 'complete',
  'pr_closed': 'cancelled',
  'pr.created': 'active',
  'pr.merged': 'complete',
  'pr.closed': 'cancelled',

  // Build events
  'build_started': 'active',
  'build_succeeded': 'complete',
  'build_failed': 'blocked',
  'build.started': 'active',
  'build.succeeded': 'complete',
  'build.failed': 'blocked',

  // Workflow events
  'workflow_started': 'active',
  'workflow_completed': 'complete',
  'workflow_failed': 'blocked',
  'workflow.started': 'active',
  'workflow.completed': 'complete',
  'workflow.failed': 'blocked',

  // Generic status-based mapping (fallback)
  'start': 'active',
  'success': 'complete',
  'fail': 'blocked',
  'failure': 'blocked',
  'error': 'blocked',
  'blocked': 'blocked',
  'cancelled': 'cancelled',
  'in_progress': 'active',
  'queued': 'pending',
  'info': 'active',        // Info events keep it active
  'warning': 'active',     // Warning events keep it active
};

// Status priority for preventing status downgrades
const STATUS_PRIORITY: Record<string, number> = {
  'pending': 1,
  'active': 2,
  'blocked': 3,
  'cancelled': 4,
  'complete': 5,
};

export interface LedgerWriterResult {
  processed: number;
  updated: number;
  created: number;
  errors: number;
  lastEventId?: string;
  lastEventTime?: Date;
}

export class LedgerWriter {
  private readonly BATCH_SIZE = 100;
  private readonly PROJECTOR_NAME = 'vtid_ledger_writer';
  private isRunning = false;
  private pollInterval = 5000; // 5 seconds

  /**
   * Start the ledger writer loop
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('LedgerWriter is already running');
      return;
    }

    this.isRunning = true;
    logger.info('Starting VTID Ledger Writer (VTID-0521)');

    this.writerLoop().catch((error) => {
      logger.error('Ledger writer loop failed', error);
      this.isRunning = false;
    });
  }

  /**
   * Stop the ledger writer loop
   */
  async stop(): Promise<void> {
    this.isRunning = false;
    logger.info('Stopping VTID Ledger Writer');
  }

  /**
   * Main processing loop
   */
  private async writerLoop(): Promise<void> {
    while (this.isRunning) {
      try {
        const result = await this.processBatch();
        if (result.processed > 0) {
          logger.info('Ledger sync batch complete', {
            processed: result.processed,
            updated: result.updated,
            created: result.created,
            errors: result.errors,
          });

          // Emit ledger_sync event
          await this.emitSyncEvent(result);
        }
      } catch (error) {
        logger.error('Error in ledger writer loop', error);
      }

      await this.sleep(this.pollInterval);
    }
  }

  /**
   * Process a batch of unprocessed OASIS events
   */
  async processBatch(): Promise<LedgerWriterResult> {
    const db = Database.getInstance();
    const result: LedgerWriterResult = {
      processed: 0,
      updated: 0,
      created: 0,
      errors: 0,
    };

    try {
      // Get current offset
      const offset = await db.projectionOffset.findUnique({
        where: { projectorName: this.PROJECTOR_NAME },
      });

      // Query OASIS events that haven't been processed by this projector
      // We use the raw oasis_events table via Supabase REST API pattern
      // But since we're in the projector, we use Prisma's OasisEvent model
      const events = await db.oasisEvent.findMany({
        where: {
          createdAt: {
            gt: offset?.lastEventTime || new Date(0),
          },
        },
        orderBy: { createdAt: 'asc' },
        take: this.BATCH_SIZE,
      });

      if (events.length === 0) {
        return result;
      }

      logger.info(`Processing ${events.length} OASIS events for ledger sync`, {
        firstEventTime: events[0].createdAt,
        lastEventTime: events[events.length - 1].createdAt,
      });

      // Process each event
      for (const event of events) {
        try {
          const updated = await this.processEvent(event as unknown as OasisEvent);
          result.processed++;
          if (updated === 'created') {
            result.created++;
          } else if (updated === 'updated') {
            result.updated++;
          }
        } catch (error) {
          logger.error(`Failed to process event ${event.id}`, error);
          result.errors++;
        }
      }

      // Update projection offset
      const lastEvent = events[events.length - 1];
      result.lastEventId = lastEvent.id;
      result.lastEventTime = lastEvent.createdAt;

      await db.projectionOffset.upsert({
        where: { projectorName: this.PROJECTOR_NAME },
        update: {
          lastEventId: lastEvent.id,
          lastEventTime: lastEvent.createdAt,
          lastProcessedAt: new Date(),
          eventsProcessed: { increment: events.length },
        },
        create: {
          projectorName: this.PROJECTOR_NAME,
          lastEventId: lastEvent.id,
          lastEventTime: lastEvent.createdAt,
          lastProcessedAt: new Date(),
          eventsProcessed: events.length,
        },
      });

      return result;
    } catch (error) {
      logger.error('Failed to process batch', error);
      throw error;
    }
  }

  /**
   * Process a single OASIS event and update the ledger
   */
  private async processEvent(event: OasisEvent): Promise<'created' | 'updated' | 'skipped'> {
    // Extract VTID from event - check multiple possible locations
    const vtid = this.extractVtid(event);

    if (!vtid) {
      logger.debug(`Event ${event.id} has no VTID, skipping`);
      return 'skipped';
    }

    // Validate VTID format
    if (!this.isValidVtid(vtid)) {
      logger.debug(`Event ${event.id} has invalid VTID format: ${vtid}, skipping`);
      return 'skipped';
    }

    const db = Database.getInstance();

    // Check if VTID already exists
    const existingEntry = await db.vtidLedger.findUnique({
      where: { vtid },
    });

    // Determine status from event
    const newStatus = this.mapEventToStatus(event);

    // Extract metadata from event
    const metadata = this.extractMetadata(event);
    const service = event.service || event.source || 'unknown';
    const environment = this.extractEnvironment(event);

    if (existingEntry) {
      // Check if we should update (newer event or higher priority status)
      const shouldUpdate = this.shouldUpdate(existingEntry, event, newStatus);

      if (!shouldUpdate) {
        logger.debug(`Skipping update for ${vtid}: existing status has higher priority`);
        return 'skipped';
      }

      // Update existing entry
      await db.vtidLedger.update({
        where: { vtid },
        data: {
          status: newStatus,
          service,
          environment,
          lastEventId: event.id,
          lastEventAt: event.created_at,
          // Only update these if present in event
          ...(metadata.description && { description: metadata.description }),
          ...(metadata.taskFamily && { taskFamily: metadata.taskFamily }),
          ...(metadata.taskType && { taskType: metadata.taskType }),
          ...(metadata.assignedTo && { assignedTo: metadata.assignedTo }),
          // Merge metadata
          metadata: {
            ...(existingEntry.metadata as Record<string, any> || {}),
            ...metadata.extra,
            lastEventType: event.topic || event.event,
          },
        },
      });

      logger.info(`Updated VTID ${vtid} from event ${event.id}`, {
        status: newStatus,
        service,
      });

      return 'updated';
    } else {
      // Create new entry
      await db.vtidLedger.create({
        data: {
          vtid,
          status: newStatus,
          service,
          environment,
          taskFamily: metadata.taskFamily || 'auto',
          taskType: metadata.taskType || 'event',
          description: metadata.description || `Auto-created from OASIS event: ${event.topic || event.event}`,
          tenant: event.metadata?.tenant || 'system',
          assignedTo: metadata.assignedTo,
          lastEventId: event.id,
          lastEventAt: event.created_at,
          metadata: {
            autoCreated: true,
            sourceEvent: event.id,
            sourceType: event.topic || event.event,
            ...metadata.extra,
          },
        },
      });

      logger.info(`Created VTID ${vtid} from event ${event.id}`, {
        status: newStatus,
        service,
      });

      return 'created';
    }
  }

  /**
   * Extract VTID from event - checks multiple possible locations
   */
  private extractVtid(event: OasisEvent): string | undefined {
    // Direct vtid field
    if (event.vtid) {
      return event.vtid;
    }

    // Check metadata
    if (event.metadata?.vtid) {
      return event.metadata.vtid;
    }

    // Check ref field
    if (event.ref && this.isValidVtid(event.ref)) {
      return event.ref;
    }

    // Check message for VTID pattern
    if (event.message) {
      const match = event.message.match(/VTID-\d{4}(-\d+)?/);
      if (match) {
        return match[0];
      }
    }

    return undefined;
  }

  /**
   * Validate VTID format
   */
  private isValidVtid(vtid: string): boolean {
    // Matches patterns like:
    // - VTID-0521
    // - VTID-0521-0001
    // - VTID-0521-TEST-0001
    // - DEV-OASIS-0010
    // Pattern: PREFIX-SEGMENT(-SEGMENT)*
    return /^[A-Z]+-[A-Z0-9]+(-[A-Z0-9]+)*$/i.test(vtid);
  }

  /**
   * Map OASIS event to vtid_ledger status
   */
  private mapEventToStatus(event: OasisEvent): string {
    const eventType = event.topic || event.event || '';
    const eventStatus = event.status || '';

    // First try to match event type
    if (STATUS_MAPPING[eventType]) {
      return STATUS_MAPPING[eventType];
    }

    // Then try lowercase
    if (STATUS_MAPPING[eventType.toLowerCase()]) {
      return STATUS_MAPPING[eventType.toLowerCase()];
    }

    // Try event status
    if (STATUS_MAPPING[eventStatus]) {
      return STATUS_MAPPING[eventStatus];
    }

    if (STATUS_MAPPING[eventStatus.toLowerCase()]) {
      return STATUS_MAPPING[eventStatus.toLowerCase()];
    }

    // Default based on event status
    switch (eventStatus.toLowerCase()) {
      case 'success':
      case 'complete':
      case 'completed':
        return 'complete';
      case 'fail':
      case 'failed':
      case 'failure':
      case 'error':
        return 'blocked';
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      case 'start':
      case 'started':
      case 'in_progress':
      case 'running':
        return 'active';
      case 'queued':
      case 'pending':
        return 'pending';
      default:
        return 'active'; // Default to active for unknown statuses
    }
  }

  /**
   * Check if we should update the existing entry
   */
  private shouldUpdate(
    existing: { status: string; lastEventAt: Date | null },
    event: OasisEvent,
    newStatus: string
  ): boolean {
    // Always update if this event is newer
    if (existing.lastEventAt && event.created_at > existing.lastEventAt) {
      return true;
    }

    // Don't downgrade status unless event is newer
    const existingPriority = STATUS_PRIORITY[existing.status] || 0;
    const newPriority = STATUS_PRIORITY[newStatus] || 0;

    return newPriority >= existingPriority;
  }

  /**
   * Extract additional metadata from event
   */
  private extractMetadata(event: OasisEvent): {
    description?: string;
    taskFamily?: string;
    taskType?: string;
    assignedTo?: string;
    extra: Record<string, any>;
  } {
    const meta = event.metadata || {};

    return {
      description: meta.description || meta.summary || event.title || event.message,
      taskFamily: meta.taskFamily || meta.task_family || event.layer,
      taskType: meta.taskType || meta.task_type || event.kind || event.topic || event.event,
      assignedTo: meta.assignedTo || meta.assigned_to || meta.assignee,
      extra: {
        layer: event.layer,
        module: event.module,
        kind: event.kind,
        source: event.source,
        ref: event.ref,
        ...meta,
      },
    };
  }

  /**
   * Extract environment from event
   */
  private extractEnvironment(event: OasisEvent): string {
    const meta = event.metadata || {};
    return meta.environment || meta.env || 'dev';
  }

  /**
   * Emit a ledger_sync event to OASIS
   */
  private async emitSyncEvent(result: LedgerWriterResult): Promise<void> {
    try {
      const db = Database.getInstance();

      await db.oasisEvent.create({
        data: {
          rid: `ledger-sync-${Date.now()}`,
          service: 'oasis-projector',
          event: 'ledger_sync',
          tenant: 'system',
          status: result.errors > 0 ? 'warning' : 'success',
          notes: `Processed ${result.processed} events: ${result.updated} updated, ${result.created} created, ${result.errors} errors`,
          metadata: {
            processed: result.processed,
            updated: result.updated,
            created: result.created,
            errors: result.errors,
            lastEventId: result.lastEventId,
            lastEventTime: result.lastEventTime?.toISOString(),
            vtid: null, // Bulk operation
          },
        },
      });
    } catch (error) {
      logger.error('Failed to emit ledger_sync event', error);
    }
  }

  /**
   * Manual sync trigger - processes all pending events
   */
  async syncNow(): Promise<LedgerWriterResult> {
    const totalResult: LedgerWriterResult = {
      processed: 0,
      updated: 0,
      created: 0,
      errors: 0,
    };

    let hasMore = true;
    while (hasMore) {
      const batchResult = await this.processBatch();
      totalResult.processed += batchResult.processed;
      totalResult.updated += batchResult.updated;
      totalResult.created += batchResult.created;
      totalResult.errors += batchResult.errors;
      totalResult.lastEventId = batchResult.lastEventId || totalResult.lastEventId;
      totalResult.lastEventTime = batchResult.lastEventTime || totalResult.lastEventTime;

      hasMore = batchResult.processed === this.BATCH_SIZE;
    }

    if (totalResult.processed > 0) {
      await this.emitSyncEvent(totalResult);
    }

    return totalResult;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
