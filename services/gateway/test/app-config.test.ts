/**
 * VTID-05177 — GET /api/v1/app-config (native app remote config).
 *
 * No auth, static defaults with every flag off, system_controls
 * `native_app.kill.*` rows that can only switch a flag OFF, 503 when the kill
 * read fails, per-IP rate limit, 60 s public cache, mounted once.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { createAppConfigRouter } from '../src/routes/app-config';
import { APP_CONFIG_DEFAULTS, APP_CONFIG_FLAGS } from '../src/services/app-config/defaults';
import { applyKills, KILL_CACHE_TTL_MS } from '../src/services/app-config/app-config-service';
import { fetchNativeAppKillRows, type KillRowsResult } from '../src/services/app-config/app-config-repository';
import { domainsForRoute } from '../src/orb/developer/domain-atlas';

const NOW = new Date('2026-10-13T12:00:00.000Z');

function appWith(fetchKillRows: () => Promise<KillRowsResult>, clock: () => Date = () => NOW) {
  const app = express();
  app.use('/api/v1/app-config', createAppConfigRouter({ fetchKillRows, clock }));
  return app;
}

const kill = (key: string, extra: Partial<{ enabled: boolean; expires_at: string | null }> = {}) => ({
  key, enabled: true, expires_at: null, ...extra,
});

function deepKeys(v: unknown, out: string[] = []): string[] {
  if (v && typeof v === 'object') {
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      out.push(k);
      deepKeys(child, out);
    }
  }
  return out;
}

describe('GET /api/v1/app-config', () => {
  it('200 with the full shape, no auth header, public 60 s cache', async () => {
    const res = await request(appWith(async () => ({ rows: [] }))).get('/api/v1/app-config');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('public, max-age=60');
    expect(res.body).toEqual({
      ok: true,
      schema_version: 1,
      generated_at: NOW.toISOString(),
      ttl_seconds: 300,
      platforms: {
        ios: {
          min_supported_version: '0.0.0', recommended_version: null, update_url: null,
          flags: { push_enabled: false, health_sync_enabled: false, orb_native_enabled: false },
        },
        android: {
          min_supported_version: '0.0.0', recommended_version: null, update_url: null,
          flags: { push_enabled: false, health_sync_enabled: false, orb_native_enabled: false },
        },
      },
    });
  });

  it('every checked-in default flag is false and the minimum version is 0.0.0', () => {
    for (const p of Object.values(APP_CONFIG_DEFAULTS)) {
      expect(p.min_supported_version).toBe('0.0.0');
      for (const f of APP_CONFIG_FLAGS) expect(p.flags[f]).toBe(false);
    }
  });

  it('the response carries no member data (deep key scan)', async () => {
    const res = await request(appWith(async () => ({ rows: [kill('native_app.kill.all.push_enabled')] }))).get('/api/v1/app-config');
    const keys = deepKeys(res.body);
    for (const banned of ['user_id', 'email', 'tenant_id']) expect(keys).not.toContain(banned);
  });

  it('a kill repository error answers 503 config_unavailable with no platforms', async () => {
    const res = await request(appWith(async () => ({ error: 'timeout' }))).get('/api/v1/app-config');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: 'config_unavailable' });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the kill read is cached for 10 s; a failed read is not cached', async () => {
    let t = NOW.getTime();
    let calls = 0;
    let fail = true;
    const app = appWith(async () => { calls++; return fail ? { error: 'boom' } : { rows: [] }; }, () => new Date(t));
    expect((await request(app).get('/api/v1/app-config')).status).toBe(503);
    fail = false;
    expect((await request(app).get('/api/v1/app-config')).status).toBe(200);
    expect((await request(app).get('/api/v1/app-config')).status).toBe(200);
    expect(calls).toBe(2);
    t += KILL_CACHE_TTL_MS;
    await request(app).get('/api/v1/app-config');
    expect(calls).toBe(3);
  });

  it('request 121 from one IP within a minute gets 429 JSON', async () => {
    const app = appWith(async () => ({ rows: [] }));
    for (let i = 0; i < 120; i++) {
      const r = await request(app).get('/api/v1/app-config');
      expect(r.status).toBe(200);
    }
    const res = await request(app).get('/api/v1/app-config');
    expect(res.status).toBe(429);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ ok: false, error: 'TOO_MANY_REQUESTS' });
  });
});

describe('kill switches (system_controls native_app.kill.*)', () => {
  // A base with every flag ON, to prove a kill switches flags off.
  const allOn = () => {
    const p = JSON.parse(JSON.stringify(APP_CONFIG_DEFAULTS));
    for (const plat of Object.values<any>(p)) for (const f of APP_CONFIG_FLAGS) plat.flags[f] = true;
    return p;
  };

  it('an armed kill forces its flag off on its platform only', () => {
    const p = applyKills([kill('native_app.kill.ios.push_enabled')], NOW);
    expect(p.ios.flags.push_enabled).toBe(false);
    expect(p.android.flags.push_enabled).toBe(false); // default off anyway
    // with every flag on, only the iOS push flag goes off
    const q = applyKills([kill('native_app.kill.ios.push_enabled')], NOW, allOn());
    expect(q.ios.flags.push_enabled).toBe(false);
    expect(q.android.flags.push_enabled).toBe(true);
    expect(q.ios.flags.health_sync_enabled).toBe(true);
  });

  it('`all` applies to both platforms; expired, disarmed and unknown keys are ignored', () => {
    const q = applyKills(
      [
        kill('native_app.kill.all.orb_native_enabled'),
        kill('native_app.kill.ios.health_sync_enabled', { expires_at: '2026-10-13T11:59:59.000Z' }),
        kill('native_app.kill.android.health_sync_enabled', { enabled: false }),
        kill('native_app.kill.web.push_enabled'),
        kill('native_app.kill.ios.not_a_flag'),
        kill('native_app.kill.ios.push_enabled.extra'),
        kill('other.control.ios.push_enabled'),
      ],
      NOW,
      allOn(),
    );
    expect(q.ios.flags.orb_native_enabled).toBe(false);
    expect(q.android.flags.orb_native_enabled).toBe(false);
    expect(q.ios.flags.health_sync_enabled).toBe(true);
    expect(q.android.flags.health_sync_enabled).toBe(true);
    expect(q.ios.flags.push_enabled).toBe(true);
    expect(q.android.flags.push_enabled).toBe(true);
    expect(Object.keys(q.ios.flags).sort()).toEqual([...APP_CONFIG_FLAGS].sort());
  });

  it('a kill can never turn a flag on or change a version', () => {
    const p = applyKills(
      [
        kill('native_app.kill.ios.push_enabled', { enabled: false }),
        kill('native_app.kill.all.min_supported_version'),
        kill('native_app.kill.ios.recommended_version'),
      ],
      NOW,
    );
    expect(p).toEqual(APP_CONFIG_DEFAULTS);
  });

  it('an unexpired kill still applies', () => {
    const q = applyKills([kill('native_app.kill.android.push_enabled', { expires_at: '2026-10-14T00:00:00.000Z' })], NOW, allOn());
    expect(q.android.flags.push_enabled).toBe(false);
  });
});

describe('kill repository (read-only REST)', () => {
  const saved = global.fetch;
  afterEach(() => { global.fetch = saved; });

  it('GETs only native_app.kill.* rows and separates rows from errors', async () => {
    const calls: any[] = [];
    global.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), method: init?.method });
      return { ok: true, status: 200, json: async () => [kill('native_app.kill.ios.push_enabled')] } as any;
    }) as any;
    await expect(fetchNativeAppKillRows()).resolves.toEqual({ rows: [kill('native_app.kill.ios.push_enabled')] });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/rest/v1/system_controls?select=key,enabled,expires_at&key=like.native_app.kill.*');

    global.fetch = (async () => ({ ok: false, status: 500, json: async () => ({}) })) as any;
    await expect(fetchNativeAppKillRows()).resolves.toEqual({ error: 'http_500' });

    global.fetch = (async () => { throw new Error('net down'); }) as any;
    await expect(fetchNativeAppKillRows()).resolves.toEqual({ error: 'net down' });
  });
});

describe('mounting and atlas', () => {
  const index = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  it('GET /api/v1/app-config is mounted exactly once, through mountRouterSync', () => {
    const mounts = index.match(/mountRouterSync\(app, '\/api\/v1\/app-config', appConfigRouter, \{ owner: 'app-config' \}\)/g) || [];
    expect(mounts).toHaveLength(1);
    expect(index.match(/'\/api\/v1\/app-config'/g) || []).toHaveLength(1);
  });

  it('the infra domain claims routes/app-config.ts', () => {
    expect(domainsForRoute('app-config.ts').map((d) => d.key)).toEqual(['infra']);
  });
});
