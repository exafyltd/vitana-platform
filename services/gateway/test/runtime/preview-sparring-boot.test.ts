/**
 * Behavioural proof for GATEWAY_RUNTIME_PROFILE=preview-sparring.
 *
 * Boots the real src/index.ts on a free port with the profile set and asserts:
 *  - /alive answers 200 (the HTTP API is up);
 *  - no timer is created after the listen callback runs;
 *  - no outbound HTTP(S) or fetch happens during import or boot.
 * A control boot in the full profile must create background activity, so the
 * probe is known to detect workers.
 */
import http from 'http';
import https from 'https';

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      const port = typeof a === 'object' && a ? a.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, timeout: 5000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      })
      .on('error', reject);
  });
}

async function boot(profile: string | undefined, doneLog: RegExp) {
  const port = await freePort();
  const saved = { PORT: process.env.PORT, NODE_ENV: process.env.NODE_ENV, P: process.env.GATEWAY_RUNTIME_PROFILE };
  process.env.PORT = String(port);
  process.env.NODE_ENV = 'development';
  if (profile === undefined) delete process.env.GATEWAY_RUNTIME_PROFILE;
  else process.env.GATEWAY_RUNTIME_PROFILE = profile;

  const origSI = global.setInterval;
  const origST = global.setTimeout;
  const origLog = console.log;
  const origHttpReq = http.request;
  const origHttpsReq = https.request;
  const origFetch = (globalThis as any).fetch;
  const timers: unknown[] = [];
  const net: string[] = [];
  let reached = false;

  // Count outbound calls from before import, so import-time calls are seen too.
  (http as any).request = (...a: any[]) => { net.push('http'); return (origHttpReq as any)(...a); };
  (https as any).request = (...a: any[]) => { net.push('https'); return (origHttpsReq as any)(...a); };
  if (origFetch) (globalThis as any).fetch = (...a: any[]) => { net.push('fetch'); return origFetch(...a); };

  console.log = (...args: unknown[]) => {
    const line = args.map(String).join(' ');
    if (doneLog.test(line)) reached = true;
  };
  try {
    jest.isolateModules(() => {
      require('../../src/index');
    });
    // The listen callback runs on a later tick. Count timers created from here on.
    global.setInterval = ((...a: any[]) => { timers.push(a); return (origSI as any)(...a); }) as any;
    global.setTimeout = ((...a: any[]) => { timers.push(a); return (origST as any)(...a); }) as any;
    const deadline = Date.now() + 25000;
    while (!reached && Date.now() < deadline) await new Promise((r) => origST(r, 25));
    await new Promise((r) => origST(r, 300));
    return { reached, port, timers, net: [...net] };
  } finally {
    global.setInterval = origSI;
    global.setTimeout = origST;
    console.log = origLog;
    (http as any).request = origHttpReq;
    (https as any).request = origHttpsReq;
    if (origFetch) (globalThis as any).fetch = origFetch;
    for (const [k, v] of Object.entries({ PORT: saved.PORT, NODE_ENV: saved.NODE_ENV, GATEWAY_RUNTIME_PROFILE: saved.P })) {
      if (v === undefined) delete (process.env as any)[k];
      else (process.env as any)[k] = v;
    }
  }
}

describe('GATEWAY_RUNTIME_PROFILE=preview-sparring: real boot', () => {
  jest.setTimeout(90000);

  it('serves /alive and starts zero timers and zero outbound calls after the guard', async () => {
    const r = await boot('preview-sparring', /Gateway server running on port/);
    expect(r.reached).toBe(true);
    const alive = await get(r.port, '/alive');
    expect(alive.status).toBe(200);
    expect(alive.body).toContain('"status":"ok"');
    expect(r.timers.length).toBe(0);
    expect(r.net).toEqual([]);
  });

  it('control: the full profile creates background timers, so the probe detects workers', async () => {
    const r = await boot(undefined, /Gateway server running on port/);
    expect(r.reached).toBe(true);
    expect(r.timers.length).toBeGreaterThan(0);
  });
});
