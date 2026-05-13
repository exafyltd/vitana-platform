/**
 * A9.1 (orb-live-refactor / VTID-02957): runtime tests for the WebSocket
 * transport module — `orb/live/transport/websocket-handler.ts`.
 *
 * Replaces the inline structural assertions from the prior A0.3 test —
 * those assertions are now exercised against the real module here.
 *
 * Approach: spin up a real HTTP server on an ephemeral port, mount the
 * transport, and connect a real `ws` client. Every assertion exercises
 * the actual wire path — same as production.
 */

import * as http from 'http';
import { AddressInfo } from 'net';
import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import {
  mountOrbWebSocketTransport,
  ORB_WS_MOUNT_PATH,
} from '../../../../src/orb/live/transport/websocket-handler';

interface FixtureHandle {
  server: http.Server;
  url: string;
  transport: ReturnType<typeof mountOrbWebSocketTransport>;
  connectionCalls: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders }>;
  cleanup: () => Promise<void>;
}

async function startFixture(
  pathOverride?: string,
  onServerError?: (err: Error) => void,
): Promise<FixtureHandle> {
  const httpServer = http.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const { port } = httpServer.address() as AddressInfo;

  const connectionCalls: Array<{ url: string | undefined; headers: http.IncomingHttpHeaders }> = [];

  const transport = mountOrbWebSocketTransport(httpServer, {
    handleConnection: (_ws: WebSocket, req: IncomingMessage) => {
      connectionCalls.push({ url: req.url, headers: req.headers });
    },
    path: pathOverride,
    onServerError,
  });

  const url = `ws://127.0.0.1:${port}${transport.path}`;

  return {
    server: httpServer,
    url,
    transport,
    connectionCalls,
    cleanup: async () => {
      await transport.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (e) => reject(e));
  });
}

describe('A9.1: mountOrbWebSocketTransport', () => {
  it('mounts at the canonical /api/v1/orb/live/ws path by default', () => {
    expect(ORB_WS_MOUNT_PATH).toBe('/api/v1/orb/live/ws');
  });

  it('attaches to the supplied HTTP server (single-port, no separate listen)', async () => {
    const fx = await startFixture();
    try {
      const { port } = fx.server.address() as AddressInfo;
      // The HTTP server's port is the only listener; the WS upgrade
      // shares it. Connect using that port to prove it.
      const client = new WebSocket(`ws://127.0.0.1:${port}/api/v1/orb/live/ws`);
      await waitForOpen(client);
      expect(client.readyState).toBe(WebSocket.OPEN);
      client.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('forwards each accepted connection (ws, req) into handleConnection', async () => {
    const fx = await startFixture();
    try {
      const client = new WebSocket(fx.url, {
        headers: { 'x-test-header': 'a9.1' },
      });
      await waitForOpen(client);
      // Give the server a tick to dispatch.
      await new Promise((resolve) => setImmediate(resolve));
      expect(fx.connectionCalls).toHaveLength(1);
      expect(fx.connectionCalls[0].url).toBe('/api/v1/orb/live/ws');
      expect(fx.connectionCalls[0].headers['x-test-header']).toBe('a9.1');
      client.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('returns a handle that exposes the underlying WebSocketServer + path', async () => {
    const fx = await startFixture();
    try {
      expect(fx.transport.path).toBe('/api/v1/orb/live/ws');
      expect(fx.transport.server).toBeDefined();
      expect(typeof fx.transport.server.on).toBe('function');
    } finally {
      await fx.cleanup();
    }
  });

  it('honors a path override (test-only / alternate deployments)', async () => {
    const fx = await startFixture('/test/path/ws');
    try {
      expect(fx.transport.path).toBe('/test/path/ws');
      const { port } = fx.server.address() as AddressInfo;
      const client = new WebSocket(`ws://127.0.0.1:${port}/test/path/ws`);
      await waitForOpen(client);
      expect(client.readyState).toBe(WebSocket.OPEN);
      client.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('rejects upgrade requests on other paths (does not bind everything)', async () => {
    const fx = await startFixture();
    try {
      const { port } = fx.server.address() as AddressInfo;
      const wrongPath = new WebSocket(`ws://127.0.0.1:${port}/some/other/path`);
      const result = await new Promise<'opened' | 'rejected'>((resolve) => {
        wrongPath.once('open', () => resolve('opened'));
        wrongPath.once('unexpected-response', () => resolve('rejected'));
        wrongPath.once('error', () => resolve('rejected'));
      });
      expect(result).toBe('rejected');
      try {
        wrongPath.close();
      } catch {
        /* already errored */
      }
    } finally {
      await fx.cleanup();
    }
  });

  it('allows multiple concurrent connections', async () => {
    const fx = await startFixture();
    try {
      const c1 = new WebSocket(fx.url);
      const c2 = new WebSocket(fx.url);
      const c3 = new WebSocket(fx.url);
      await Promise.all([waitForOpen(c1), waitForOpen(c2), waitForOpen(c3)]);
      await new Promise((resolve) => setImmediate(resolve));
      expect(fx.connectionCalls).toHaveLength(3);
      c1.close();
      c2.close();
      c3.close();
    } finally {
      await fx.cleanup();
    }
  });

  it('async handleConnection rejections are caught (do not crash the process)', async () => {
    const httpServer = http.createServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const transport = mountOrbWebSocketTransport(httpServer, {
      handleConnection: async () => {
        throw new Error('boom from handler');
      },
    });

    try {
      const client = new WebSocket(`ws://127.0.0.1:${port}${transport.path}`);
      await waitForOpen(client);
      await new Promise((resolve) => setImmediate(resolve));
      // Give the rejection a microtask to surface.
      await new Promise((resolve) => setImmediate(resolve));
      const sawHandlerError = errorSpy.mock.calls.some(
        (c) =>
          typeof c[0] === 'string' &&
          c[0].includes('handleConnection threw') &&
          c[1] instanceof Error &&
          (c[1] as Error).message === 'boom from handler',
      );
      expect(sawHandlerError).toBe(true);
      client.close();
    } finally {
      errorSpy.mockRestore();
      await transport.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });

  it('close() is idempotent', async () => {
    const fx = await startFixture();
    await fx.transport.close();
    await fx.transport.close();
    await fx.transport.close();
    await new Promise<void>((resolve) => fx.server.close(() => resolve()));
  });
});
