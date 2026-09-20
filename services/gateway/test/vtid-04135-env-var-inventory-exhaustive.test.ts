/**
 * VTID-04135 — the feature-flag inventory must actually be exhaustive.
 *
 * `KNOWN_FEATURE_FLAGS` (services/gateway/src/routes/admin-health.ts) is what
 * `GET /api/v1/admin/feature-flags` serves, and its own comment says it is
 * "only useful for drift detection if it is exhaustive". VTID-04098 found that
 * claim false on two real, in-use env vars:
 *
 *   - ORB_NOVA_PREWARM          (isFeatureLive, routes/orb-live.ts; off in prod)
 *   - REALTIME_RELAY_CHAT_MESSAGES (isFeatureLive, routes/realtime-relay.ts)
 *
 * Both are now in the list. This suite is the guard that keeps the list from
 * silently drifting again — on its own, a missing entry is indistinguishable
 * from a flag nobody reads, which is exactly how the gap survived.
 *
 * Two independent checks, deliberately:
 *   1. BEHAVIOR — the endpoint's real response carries both flags, in the
 *      same shape as every other entry (`env_var: FEATURE_<NAME>_ENV`).
 *   2. SOURCE — every literal `isFeatureLive('NAME')` call site in the gateway
 *      source appears in the inventory. A new flag that is read but not
 *      listed fails here instead of shipping an inventory that lies.
 */

import * as fs from 'fs';
import * as path from 'path';
import request from 'supertest';
import express from 'express';

// Same pattern as test/routes/admin-feature-flags.test.ts: buildApp() calls
// jest.resetModules(), which hands the route a FRESH copy of this mock, so
// delegate through a stable holder rather than an imported reference.
const mockAdminGuard: { impl: (req: any, res: any, next: any) => void } = {
  impl: (_req, _res, next) => next(),
};

jest.mock('../src/middleware/auth-supabase-jwt', () => ({
  requireAdminAuth: (req: any, res: any, next: any) => mockAdminGuard.impl(req, res, next),
}));

const SRC_DIR = path.join(__dirname, '../src');
const ADMIN_HEALTH_TS = path.join(SRC_DIR, 'routes/admin-health.ts');

// The two vars VTID-04098 found missing from the inventory.
const REQUIRED_FLAGS = ['ORB_NOVA_PREWARM', 'REALTIME_RELAY_CHAT_MESSAGES'];

/** The literal `KNOWN_FEATURE_FLAGS = [ ... ] as const;` block. */
function inventorySource(): string {
  const src = fs.readFileSync(ADMIN_HEALTH_TS, 'utf8');
  const start = src.indexOf('const KNOWN_FEATURE_FLAGS = [');
  if (start === -1) throw new Error('KNOWN_FEATURE_FLAGS declaration not found in routes/admin-health.ts');
  const end = src.indexOf('] as const;', start);
  if (end === -1) throw new Error('KNOWN_FEATURE_FLAGS is not declared `as const` — the close of the array changed');
  return src.slice(start, end);
}

/** The flag stems listed in the inventory, comments excluded. */
function inventoryNames(): string[] {
  const block = inventorySource();
  return [...block.matchAll(/^\s*'([A-Z0-9_]+)',\s*$/gm)].map((m) => m[1]);
}

function buildApp() {
  // Required after env mutation — VITANA_ENV is resolved at import time by ../env.
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const router = require('../src/routes/admin-health').default;
  const app = express();
  app.use('/api/v1/admin', router);
  return app;
}

describe('VTID-04135: KNOWN_FEATURE_FLAGS lists both previously-missing flags', () => {
  it('is parsed from the source at all — otherwise every assertion below is vacuous', () => {
    const names = inventoryNames();
    expect(names.length).toBeGreaterThan(10);
    expect(names).toContain('VOICE_RANKING_SHADOW');
  });

  for (const flag of REQUIRED_FLAGS) {
    it(`includes ${flag}`, () => {
      expect(inventoryNames()).toContain(flag);
    });
  }

  it('keeps every entry in the existing format — one quoted stem per line', () => {
    const block = inventorySource();
    const entryLines = block
      .split('\n')
      .slice(1)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('//'));
    expect(entryLines.length).toBe(inventoryNames().length);
    for (const line of entryLines) {
      expect(line).toMatch(/^'[A-Z0-9_]+',$/);
    }
  });

  it('has no duplicate entries — a duplicate reads as coverage that is not there', () => {
    const names = inventoryNames();
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('VTID-04135: the endpoint serves both flags with the standard shape', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    mockAdminGuard.impl = (_req: any, _res: any, next: any) => next();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('reports ORB_NOVA_PREWARM and REALTIME_RELAY_CHAT_MESSAGES alongside the rest', async () => {
    const res = await request(buildApp()).get('/api/v1/admin/feature-flags');
    expect(res.status).toBe(200);

    for (const flag of REQUIRED_FLAGS) {
      const entry = res.body.flags.find((f: any) => f.name === flag);
      expect(entry).toBeDefined();
      // The exact shape every other entry has — this is what makes the list
      // machine-comparable for drift detection.
      expect(entry.env_var).toBe(`FEATURE_${flag}_ENV`);
      expect(typeof entry.env_var_present).toBe('boolean');
      expect(typeof entry.live).toBe('boolean');
      expect(typeof entry.invalid_value).toBe('boolean');
      expect(['off', 'staging-only', 'staging+prod']).toContain(entry.setting);
    }
  });
});

describe('VTID-04135: the inventory covers every literal isFeatureLive() call site', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('a flag read via a literal isFeatureLive(\'NAME\') is always in the inventory', () => {
    const listed = new Set(inventoryNames());
    const unlisted = new Set<string>();

    for (const file of sourceFiles(SRC_DIR)) {
      const src = fs.readFileSync(file, 'utf8');
      // Literal stems only. Flags read through a const (LATENCY_TELEMETRY,
      // VOICE_SPECULATION, the shadow-flag FEATURE_NAME constants) are not
      // matched here — this asserts exactly what it can see.
      for (const m of src.matchAll(/isFeatureLive\(\s*'([A-Z0-9_]+)'\s*\)/g)) {
        if (!listed.has(m[1])) unlisted.add(m[1]);
      }
    }

    // Read-but-unlisted is the VTID-04098 defect: the endpoint shows nothing
    // for a flag the gateway is genuinely gating on.
    expect([...unlisted]).toEqual([]);
  });
});
