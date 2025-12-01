/**
 * VTID-0521: Tests for Automatic VTID Ledger Writer
 *
 * These tests verify the ledger writer correctly:
 * - Extracts VTIDs from OASIS events
 * - Maps event types/statuses to ledger statuses
 * - Creates and updates vtid_ledger entries
 * - Emits ledger_sync events
 */

import { LedgerWriter, LedgerWriterResult } from '../src/ledger-writer';

// Mock the database module
jest.mock('../src/database', () => ({
  Database: {
    getInstance: jest.fn(),
  },
}));

// Mock the logger module
jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import { Database } from '../src/database';

describe('LedgerWriter (VTID-0521)', () => {
  let ledgerWriter: LedgerWriter;
  let mockDb: any;
  let mockVtidLedgerStore: any[];
  let mockOasisEventStore: any[];
  let mockProjectionOffsetStore: any;

  beforeEach(() => {
    // Reset stores
    mockVtidLedgerStore = [];
    mockOasisEventStore = [];
    mockProjectionOffsetStore = {
      projectorName: 'vtid_ledger_writer',
      lastEventId: null,
      lastEventTime: null,
      lastProcessedAt: new Date(),
      eventsProcessed: 0,
    };

    // Create mock database
    mockDb = {
      oasisEvent: {
        findMany: jest.fn().mockImplementation(async (query: any) => {
          const lastTime = query?.where?.createdAt?.gt || new Date(0);
          return mockOasisEventStore
            .filter((e) => e.createdAt > lastTime)
            .slice(0, query?.take || 100);
        }),
        create: jest.fn().mockImplementation(async (args: any) => {
          const event = {
            id: `event-${Date.now()}`,
            ...args.data,
            createdAt: new Date(),
          };
          mockOasisEventStore.push(event);
          return event;
        }),
      },
      vtidLedger: {
        findUnique: jest.fn().mockImplementation(async (query: any) => {
          return mockVtidLedgerStore.find(
            (v) => v.vtid === query?.where?.vtid
          ) || null;
        }),
        create: jest.fn().mockImplementation(async (args: any) => {
          const entry = {
            id: `vtid-${Date.now()}`,
            ...args.data,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          mockVtidLedgerStore.push(entry);
          return entry;
        }),
        update: jest.fn().mockImplementation(async (args: any) => {
          const existing = mockVtidLedgerStore.find(
            (v) => v.vtid === args?.where?.vtid
          );
          if (existing) {
            Object.assign(existing, args.data, { updatedAt: new Date() });
            return existing;
          }
          return null;
        }),
      },
      projectionOffset: {
        findUnique: jest.fn().mockResolvedValue(mockProjectionOffsetStore),
        upsert: jest.fn().mockImplementation(async (args: any) => {
          Object.assign(mockProjectionOffsetStore, args.update);
          return mockProjectionOffsetStore;
        }),
      },
    };

    (Database.getInstance as jest.Mock).mockReturnValue(mockDb);

    ledgerWriter = new LedgerWriter();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('VTID Extraction', () => {
    it('should extract VTID from event.vtid field', async () => {
      mockOasisEventStore.push({
        id: 'event-1',
        vtid: 'VTID-0521',
        event: 'deployment.started',
        service: 'ci-cd',
        status: 'start',
        createdAt: new Date(),
      });

      const result = await ledgerWriter.processBatch();

      expect(result.created).toBe(1);
      expect(mockVtidLedgerStore[0].vtid).toBe('VTID-0521');
    });

    it('should extract VTID from event.metadata.vtid', async () => {
      mockOasisEventStore.push({
        id: 'event-2',
        event: 'task.completed',
        service: 'gateway',
        status: 'success',
        metadata: { vtid: 'VTID-0522' },
        createdAt: new Date(),
      });

      const result = await ledgerWriter.processBatch();

      expect(result.created).toBe(1);
      expect(mockVtidLedgerStore[0].vtid).toBe('VTID-0522');
    });

    it('should extract VTID from event.message with pattern matching', async () => {
      mockOasisEventStore.push({
        id: 'event-3',
        event: 'comment.added',
        service: 'github',
        status: 'info',
        message: 'Comment added to VTID-0523 PR',
        createdAt: new Date(),
      });

      const result = await ledgerWriter.processBatch();

      expect(result.created).toBe(1);
      expect(mockVtidLedgerStore[0].vtid).toBe('VTID-0523');
    });

    it('should skip events without valid VTID', async () => {
      mockOasisEventStore.push({
        id: 'event-4',
        event: 'system.health',
        service: 'monitor',
        status: 'info',
        message: 'System healthy',
        createdAt: new Date(),
      });

      const result = await ledgerWriter.processBatch();

      expect(result.processed).toBe(1);
      expect(result.created).toBe(0);
      expect(mockVtidLedgerStore.length).toBe(0);
    });
  });

  describe('Status Mapping', () => {
    const statusTestCases = [
      { eventType: 'deployment_started', expectedStatus: 'active' },
      { eventType: 'deployment_succeeded', expectedStatus: 'complete' },
      { eventType: 'deployment_failed', expectedStatus: 'blocked' },
      { eventType: 'deployment_validated', expectedStatus: 'complete' },
      { eventType: 'task_created', expectedStatus: 'pending' },
      { eventType: 'task_started', expectedStatus: 'active' },
      { eventType: 'task_completed', expectedStatus: 'complete' },
      { eventType: 'task_failed', expectedStatus: 'blocked' },
      { eventType: 'task_cancelled', expectedStatus: 'cancelled' },
      { eventType: 'pr_created', expectedStatus: 'active' },
      { eventType: 'pr_merged', expectedStatus: 'complete' },
      { eventType: 'pr_closed', expectedStatus: 'cancelled' },
      { eventType: 'build_started', expectedStatus: 'active' },
      { eventType: 'build_succeeded', expectedStatus: 'complete' },
      { eventType: 'build_failed', expectedStatus: 'blocked' },
    ];

    test.each(statusTestCases)(
      'should map $eventType to $expectedStatus',
      async ({ eventType, expectedStatus }) => {
        mockOasisEventStore.push({
          id: `event-${eventType}`,
          vtid: `VTID-${eventType}`,
          topic: eventType,
          service: 'test',
          status: 'info',
          createdAt: new Date(),
        });

        await ledgerWriter.processBatch();

        expect(mockVtidLedgerStore[0].status).toBe(expectedStatus);
      }
    );

    it('should fallback to event.status when event type is not mapped', async () => {
      mockOasisEventStore.push({
        id: 'event-fallback',
        vtid: 'VTID-FALLBACK',
        event: 'unknown.event',
        service: 'test',
        status: 'success',
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      expect(mockVtidLedgerStore[0].status).toBe('complete');
    });
  });

  describe('Ledger Updates', () => {
    it('should create new ledger entry for new VTID', async () => {
      mockOasisEventStore.push({
        id: 'event-new',
        vtid: 'VTID-NEW-001',
        topic: 'task_created',
        service: 'gateway',
        status: 'info',
        metadata: {
          description: 'New task created',
          taskFamily: 'governance',
          taskType: 'review',
        },
        createdAt: new Date(),
      });

      const result = await ledgerWriter.processBatch();

      expect(result.created).toBe(1);
      expect(result.updated).toBe(0);
      expect(mockVtidLedgerStore[0]).toMatchObject({
        vtid: 'VTID-NEW-001',
        status: 'pending',
        service: 'gateway',
      });
    });

    it('should update existing ledger entry when VTID exists', async () => {
      // Pre-populate with existing entry
      mockVtidLedgerStore.push({
        id: 'existing-1',
        vtid: 'VTID-EXISTING',
        status: 'active',
        service: 'gateway',
        taskFamily: 'deployment',
        taskType: 'deploy',
        description: 'Existing task',
        tenant: 'system',
        lastEventAt: new Date(Date.now() - 10000),
        createdAt: new Date(Date.now() - 20000),
        updatedAt: new Date(Date.now() - 10000),
      });

      mockOasisEventStore.push({
        id: 'event-update',
        vtid: 'VTID-EXISTING',
        topic: 'task_completed',
        service: 'ci-cd',
        status: 'success',
        createdAt: new Date(),
      });

      const result = await ledgerWriter.processBatch();

      expect(result.updated).toBe(1);
      expect(result.created).toBe(0);
      expect(mockVtidLedgerStore[0].status).toBe('complete');
    });

    it('should not downgrade status from complete to active', async () => {
      mockVtidLedgerStore.push({
        id: 'completed-1',
        vtid: 'VTID-COMPLETED',
        status: 'complete',
        service: 'gateway',
        taskFamily: 'deployment',
        taskType: 'deploy',
        description: 'Completed task',
        tenant: 'system',
        lastEventAt: new Date(Date.now() + 10000), // Future timestamp (newer)
        createdAt: new Date(Date.now() - 20000),
        updatedAt: new Date(Date.now() - 10000),
      });

      mockOasisEventStore.push({
        id: 'event-downgrade',
        vtid: 'VTID-COMPLETED',
        topic: 'deployment_started',
        service: 'ci-cd',
        status: 'start',
        createdAt: new Date(), // Earlier than existing lastEventAt
      });

      const result = await ledgerWriter.processBatch();

      // Should be skipped because existing event is newer
      expect(mockVtidLedgerStore[0].status).toBe('complete');
    });

    it('should update last_event_id and last_event_at', async () => {
      mockOasisEventStore.push({
        id: 'event-tracking',
        vtid: 'VTID-TRACKING',
        topic: 'task_started',
        service: 'gateway',
        status: 'start',
        createdAt: new Date('2025-11-29T10:00:00Z'),
      });

      await ledgerWriter.processBatch();

      expect(mockVtidLedgerStore[0].lastEventId).toBe('event-tracking');
      expect(mockVtidLedgerStore[0].lastEventAt).toEqual(
        new Date('2025-11-29T10:00:00Z')
      );
    });
  });

  describe('Batch Processing', () => {
    it('should process multiple events in order', async () => {
      mockOasisEventStore.push(
        {
          id: 'event-1',
          vtid: 'VTID-BATCH-1',
          topic: 'task_created',
          service: 'gateway',
          status: 'info',
          createdAt: new Date('2025-11-29T10:00:00Z'),
        },
        {
          id: 'event-2',
          vtid: 'VTID-BATCH-2',
          topic: 'deployment_started',
          service: 'ci-cd',
          status: 'start',
          createdAt: new Date('2025-11-29T10:01:00Z'),
        },
        {
          id: 'event-3',
          vtid: 'VTID-BATCH-1',
          topic: 'task_completed',
          service: 'gateway',
          status: 'success',
          createdAt: new Date('2025-11-29T10:02:00Z'),
        }
      );

      const result = await ledgerWriter.processBatch();

      expect(result.processed).toBe(3);
      expect(mockVtidLedgerStore.length).toBe(2);

      // VTID-BATCH-1 should be 'complete' (last event)
      const batch1 = mockVtidLedgerStore.find(
        (v) => v.vtid === 'VTID-BATCH-1'
      );
      expect(batch1?.status).toBe('complete');

      // VTID-BATCH-2 should be 'active'
      const batch2 = mockVtidLedgerStore.find(
        (v) => v.vtid === 'VTID-BATCH-2'
      );
      expect(batch2?.status).toBe('active');
    });

    it('should update projection offset after batch', async () => {
      mockOasisEventStore.push({
        id: 'event-offset',
        vtid: 'VTID-OFFSET',
        topic: 'task_started',
        service: 'gateway',
        status: 'start',
        createdAt: new Date('2025-11-29T11:00:00Z'),
      });

      await ledgerWriter.processBatch();

      expect(mockDb.projectionOffset.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { projectorName: 'vtid_ledger_writer' },
          update: expect.objectContaining({
            lastEventId: 'event-offset',
          }),
        })
      );
    });
  });

  describe('Ledger Sync Event', () => {
    it('should emit ledger_sync event after successful batch', async () => {
      mockOasisEventStore.push({
        id: 'event-sync',
        vtid: 'VTID-SYNC',
        topic: 'task_created',
        service: 'gateway',
        status: 'info',
        createdAt: new Date(),
      });

      await ledgerWriter.syncNow();

      // Check that a ledger_sync event was created
      const syncEvent = mockOasisEventStore.find(
        (e) => e.event === 'ledger_sync'
      );
      expect(syncEvent).toBeDefined();
      expect(syncEvent?.service).toBe('oasis-projector');
      expect(syncEvent?.status).toBe('success');
      expect(syncEvent?.metadata?.processed).toBe(1);
      expect(syncEvent?.metadata?.created).toBe(1);
    });

    it('should emit warning status when there are errors', async () => {
      // Create an event that will cause an error during processing
      mockOasisEventStore.push({
        id: 'event-error',
        vtid: 'VTID-ERROR',
        topic: 'task_created',
        service: 'gateway',
        status: 'info',
        createdAt: new Date(),
      });

      // Make the create throw an error
      mockDb.vtidLedger.create.mockRejectedValueOnce(new Error('DB Error'));

      await ledgerWriter.syncNow();

      const syncEvent = mockOasisEventStore.find(
        (e) => e.event === 'ledger_sync'
      );
      expect(syncEvent?.status).toBe('warning');
      expect(syncEvent?.metadata?.errors).toBe(1);
    });
  });

  describe('syncNow()', () => {
    it('should process all pending events', async () => {
      // Add multiple batches worth of events
      for (let i = 0; i < 5; i++) {
        mockOasisEventStore.push({
          id: `event-${i}`,
          vtid: `VTID-${i}`,
          topic: 'task_created',
          service: 'gateway',
          status: 'info',
          createdAt: new Date(Date.now() + i * 1000),
        });
      }

      const result = await ledgerWriter.syncNow();

      expect(result.processed).toBe(5);
      expect(result.created).toBe(5);
    });
  });
<<<<<<< HEAD

  // VTID-0522: Tests for tasks API column mapping
  describe('VTID-0522: Tasks API Column Mapping', () => {
    it('should populate layer, module, title, summary columns on create', async () => {
      mockOasisEventStore.push({
        id: 'event-columns',
        vtid: 'VTID-0522-TEST-001',
        topic: 'deployment_succeeded',
        service: 'gateway',
        status: 'success',
        message: 'Test deployment completed',
        metadata: {
          layer: 'OASIS',
          module: 'projector',
          title: 'Test Deployment',
          summary: 'VTID-0522 test deployment',
        },
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      const entry = mockVtidLedgerStore[0];
      expect(entry.vtid).toBe('VTID-0522-TEST-001');
      expect(entry.layer).toBe('OASIS');
      expect(entry.module).toBe('projector');
      expect(entry.title).toBe('Test Deployment');
      expect(entry.summary).toBe('VTID-0522 test deployment');
    });

    it('should derive layer from taskFamily if not provided', async () => {
      mockOasisEventStore.push({
        id: 'event-derive-layer',
        vtid: 'VTID-0522-TEST-002',
        topic: 'task_started',
        service: 'gateway',
        status: 'start',
        metadata: {
          taskFamily: 'governance',
        },
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      const entry = mockVtidLedgerStore[0];
      expect(entry.layer).toBe('GOVERNANCE');
    });

    it('should derive module from topic if not provided', async () => {
      mockOasisEventStore.push({
        id: 'event-derive-module',
        vtid: 'VTID-0522-TEST-003',
        topic: 'build_succeeded',
        service: 'ci-cd',
        status: 'success',
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      const entry = mockVtidLedgerStore[0];
      expect(entry.module).toBe('build_succeeded');
    });

    it('should use vtid as title if not provided', async () => {
      mockOasisEventStore.push({
        id: 'event-derive-title',
        vtid: 'VTID-0522-TEST-004',
        topic: 'task_created',
        service: 'gateway',
        status: 'info',
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      const entry = mockVtidLedgerStore[0];
      expect(entry.title).toBe('VTID-0522-TEST-004');
    });

    it('should derive summary from message if not provided', async () => {
      mockOasisEventStore.push({
        id: 'event-derive-summary',
        vtid: 'VTID-0522-TEST-005',
        topic: 'task_completed',
        service: 'gateway',
        status: 'success',
        message: 'Task completed successfully',
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      const entry = mockVtidLedgerStore[0];
      expect(entry.summary).toContain('Task completed successfully');
    });

    it('should preserve existing columns on update', async () => {
      // Pre-populate with existing entry that has tasks API columns
      mockVtidLedgerStore.push({
        id: 'existing-with-columns',
        vtid: 'VTID-0522-UPDATE',
        status: 'active',
        service: 'gateway',
        taskFamily: 'deployment',
        taskType: 'deploy',
        description: 'Existing task',
        tenant: 'system',
        layer: 'DEPLOYMENT',
        module: 'ci-cd',
        title: 'Original Title',
        summary: 'Original summary',
        lastEventAt: new Date(Date.now() - 10000),
        createdAt: new Date(Date.now() - 20000),
        updatedAt: new Date(Date.now() - 10000),
      });

      // Update event without tasks API columns in metadata
      mockOasisEventStore.push({
        id: 'event-update-preserve',
        vtid: 'VTID-0522-UPDATE',
        topic: 'deployment_succeeded',
        service: 'ci-cd',
        status: 'success',
        createdAt: new Date(),
      });

      await ledgerWriter.processBatch();

      const entry = mockVtidLedgerStore[0];
      expect(entry.status).toBe('complete');
      // Tasks API columns should be preserved
      expect(entry.layer).toBe('DEPLOYMENT');
      expect(entry.module).toBe('ci-cd');
      expect(entry.title).toBe('Original Title');
      expect(entry.summary).toBe('Original summary');
    });
  });
=======
>>>>>>> claude/auto-vtid-ledger-writer-014epsPGWZMwKqBJb1iJZrzg
});
