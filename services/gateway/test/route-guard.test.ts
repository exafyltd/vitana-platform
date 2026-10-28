/**
 * VTID-01063: Route Guard Unit Tests
 *
 * This test file validates the Duplicate Route Guard functionality.
 * These tests serve as a CI hard gate to prevent duplicate route registration.
 *
 * Platform invariant: One endpoint = one authoritative handler.
 */

import express, { Router } from 'express';
import {
  mountRouterSync,
  clearRouteRegistry,
  getRegisteredRouteCount,
  getRegisteredRoutes,
  logStartupSummary,
} from '../src/governance/route-guard';

// Set test environment
process.env.NODE_ENV = 'test';

// Mock the OASIS event service to avoid actual network calls
jest.mock('../src/services/oasis-event-service', () => ({
  emitOasisEvent: jest.fn().mockResolvedValue({ ok: true }),
}));

describe('VTID-01063: Route Guard', () => {
  let app: express.Application;

  beforeEach(() => {
    // Create fresh Express app and clear registry before each test
    app = express();
    clearRouteRegistry();
  });

  describe('Basic Route Registration', () => {
    it('should register a single route without error', () => {
      const router = Router();
      router.get('/test', (_req, res) => res.json({ ok: true }));

      expect(() => {
        mountRouterSync(app, '/api/v1', router, { owner: 'test-owner' });
      }).not.toThrow();

      expect(getRegisteredRouteCount()).toBe(1);
    });

    it('should register multiple distinct routes without error', () => {
      const router1 = Router();
      router1.get('/users', (_req, res) => res.json({ users: [] }));

      const router2 = Router();
      router2.get('/tasks', (_req, res) => res.json({ tasks: [] }));

      mountRouterSync(app, '/api/v1', router1, { owner: 'users-service' });
      mountRouterSync(app, '/api/v1', router2, { owner: 'tasks-service' });

      // Should have 2 routes registered
      expect(getRegisteredRouteCount()).toBe(2);
    });

    it('should track route owners correctly', () => {
      const router = Router();
      router.get('/items', (_req, res) => res.json({ items: [] }));

      mountRouterSync(app, '/api/v1', router, { owner: 'items-service' });

      const routes = getRegisteredRoutes();
      const registration = routes.get('GET /api/v1/items');

      expect(registration).toBeDefined();
      expect(registration?.owner).toBe('items-service');
    });
  });

  describe('Duplicate Route Detection (CI HARD GATE)', () => {
    it('should THROW when two routers define the same route', () => {
      // This is the exact scenario from VTID-01058
      // Router 1: defines GET /board under /api/v1/commandhub
      const router1 = Router();
      router1.get('/board', (_req, res) => res.json({ source: 'router1' }));

      // Router 2: defines GET / under /api/v1/commandhub/board
      // Both resolve to GET /api/v1/commandhub/board
      const router2 = Router();
      router2.get('/', (_req, res) => res.json({ source: 'router2' }));

      // First mount should succeed
      expect(() => {
        mountRouterSync(app, '/api/v1/commandhub', router1, { owner: 'commandhub' });
      }).not.toThrow();

      // Second mount should THROW because GET /api/v1/commandhub/board is duplicate
      expect(() => {
        mountRouterSync(app, '/api/v1/commandhub/board', router2, { owner: 'board-adapter' });
      }).toThrow(/DUPLICATE ROUTE DETECTED/);
    });

    it('should THROW when same route is registered twice with different owners', () => {
      const router1 = Router();
      router1.get('/data', (_req, res) => res.json({ v: 1 }));

      const router2 = Router();
      router2.get('/data', (_req, res) => res.json({ v: 2 }));

      // First registration
      mountRouterSync(app, '/api', router1, { owner: 'service-a' });

      // Second registration - should throw
      expect(() => {
        mountRouterSync(app, '/api', router2, { owner: 'service-b' });
      }).toThrow(/DUPLICATE ROUTE DETECTED.*GET \/api\/data/);
    });

    it('should identify first owner and second owner in error message', () => {
      const router1 = Router();
      router1.post('/submit', (_req, res) => res.status(201).end());

      const router2 = Router();
      router2.post('/submit', (_req, res) => res.status(201).end());

      mountRouterSync(app, '/forms', router1, { owner: 'forms-v1' });

      try {
        mountRouterSync(app, '/forms', router2, { owner: 'forms-v2' });
        fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('forms-v1');
        expect(error.message).toContain('forms-v2');
      }
    });

    it('should detect duplicates across different HTTP methods correctly', () => {
      const router1 = Router();
      router1.get('/resource', (_req, res) => res.json({}));
      router1.post('/resource', (_req, res) => res.status(201).end());

      const router2 = Router();
      router2.get('/resource', (_req, res) => res.json({})); // Duplicate GET

      mountRouterSync(app, '/api', router1, { owner: 'resource-service' });

      // POST is different from GET, but GET /api/resource is duplicate
      expect(() => {
        mountRouterSync(app, '/api', router2, { owner: 'resource-v2' });
      }).toThrow(/DUPLICATE ROUTE DETECTED.*GET \/api\/resource/);
    });
  });

  describe('Allowed Patterns (No False Positives)', () => {
    it('should allow same router mounted at different base paths', () => {
      const sharedRouter = Router();
      sharedRouter.get('/health', (_req, res) => res.json({ status: 'ok' }));
      sharedRouter.get('/info', (_req, res) => res.json({ version: '1.0' }));

      // Same router, different mount paths = different effective routes
      expect(() => {
        mountRouterSync(app, '/api/v1/service-a', sharedRouter, { owner: 'service-a' });
        mountRouterSync(app, '/api/v1/service-b', sharedRouter, { owner: 'service-b' });
      }).not.toThrow();

      // Should have 4 routes: 2 from each mount
      expect(getRegisteredRouteCount()).toBe(4);
    });

    it('should allow different HTTP methods on same path', () => {
      const router = Router();
      router.get('/items', (_req, res) => res.json([]));
      router.post('/items', (_req, res) => res.status(201).end());
      router.put('/items/:id', (_req, res) => res.status(200).end());
      router.delete('/items/:id', (_req, res) => res.status(204).end());

      expect(() => {
        mountRouterSync(app, '/api', router, { owner: 'items-crud' });
      }).not.toThrow();
    });

    it('should allow similar but distinct paths', () => {
      const router1 = Router();
      router1.get('/board', (_req, res) => res.json({}));

      const router2 = Router();
      router2.get('/boards', (_req, res) => res.json([]));

      const router3 = Router();
      router3.get('/board-settings', (_req, res) => res.json({}));

      expect(() => {
        mountRouterSync(app, '/api', router1, { owner: 'board' });
        mountRouterSync(app, '/api', router2, { owner: 'boards' });
        mountRouterSync(app, '/api', router3, { owner: 'board-settings' });
      }).not.toThrow();

      expect(getRegisteredRouteCount()).toBe(3);
    });
  });

  describe('Path Normalization', () => {
    it('should normalize trailing slashes', () => {
      const router1 = Router();
      router1.get('/test/', (_req, res) => res.json({}));

      const router2 = Router();
      router2.get('/test', (_req, res) => res.json({}));

      mountRouterSync(app, '/api', router1, { owner: 'service-1' });

      // Should detect as duplicate despite trailing slash difference
      expect(() => {
        mountRouterSync(app, '/api', router2, { owner: 'service-2' });
      }).toThrow(/DUPLICATE ROUTE DETECTED/);
    });

    it('should normalize mount paths with trailing slashes', () => {
      const router1 = Router();
      router1.get('/data', (_req, res) => res.json({}));

      const router2 = Router();
      router2.get('/data', (_req, res) => res.json({}));

      mountRouterSync(app, '/api/v1/', router1, { owner: 'service-1' });

      expect(() => {
        mountRouterSync(app, '/api/v1', router2, { owner: 'service-2' });
      }).toThrow(/DUPLICATE ROUTE DETECTED/);
    });
  });

  describe('Startup Summary', () => {
    it('should log startup summary without throwing', () => {
      const router = Router();
      router.get('/test', (_req, res) => res.json({}));

      mountRouterSync(app, '/api', router, { owner: 'test' });

      // Should not throw
      expect(() => logStartupSummary()).not.toThrow();
    });
  });

  describe('VTID-01058 Regression Prevention', () => {
    /**
     * This test specifically validates that the VTID-01058 issue
     * (duplicate /api/v1/commandhub/board handlers) can never silently reappear.
     */
    it('should prevent the VTID-01058 scenario: commandhub + board-adapter conflict', () => {
      // Simulate commandhub.ts with GET /board route
      const commandhubRouter = Router();
      commandhubRouter.get('/board', (_req, res) => {
        res.json({ source: 'commandhub', note: 'This is the OLD implementation' });
      });

      // Simulate board-adapter.ts with GET / route
      const boardAdapterRouter = Router();
      boardAdapterRouter.get('/', (_req, res) => {
        res.json({ source: 'board-adapter', note: 'This is the NEW implementation with VTID-01058 fixes' });
      });

      // Mount commandhub at /api/v1/commandhub
      // This registers: GET /api/v1/commandhub/board
      mountRouterSync(app, '/api/v1/commandhub', commandhubRouter, { owner: 'commandhub' });

      // Attempt to mount board-adapter at /api/v1/commandhub/board
      // This would register: GET /api/v1/commandhub/board (DUPLICATE!)
      expect(() => {
        mountRouterSync(app, '/api/v1/commandhub/board', boardAdapterRouter, { owner: 'board-adapter' });
      }).toThrow(/DUPLICATE ROUTE DETECTED.*commandhub.*board-adapter/);

      // Verify only the first route was registered
      expect(getRegisteredRouteCount()).toBe(1);

      const routes = getRegisteredRoutes();
      expect(routes.has('GET /api/v1/commandhub/board')).toBe(true);
      expect(routes.get('GET /api/v1/commandhub/board')?.owner).toBe('commandhub');
    });
  });
});
