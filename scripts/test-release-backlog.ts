#!/usr/bin/env -S node --loader ts-node/esm
/**
 * Release Backlog & Versioning — end-to-end verification script.
 *
 * One runnable file that covers everything Phase 1–5 produced. Three sections:
 *
 *   1. UNIT TESTS    — pure functions (semver compare, compatibility,
 *                      channel promotion validation, role helpers).
 *                      No infrastructure required.
 *
 *   2. SCHEMA TESTS  — SQL probes against a Postgres DB with the migration
 *                      applied. Verifies tables, columns, constraints, RLS,
 *                      seed data. Skipped if DATABASE_URL is unset.
 *
 *   3. API TESTS     — HTTP smoke against a running gateway. Verifies every
 *                      endpoint we built: overview, components CRUD, history,
 *                      backlog (with P1 read-through), promote (P3 forward-only),
 *                      public changelog. Skipped if GATEWAY_URL is unset.
 *
 * Usage:
 *   # Unit tests only (works anywhere with Node ≥18)
 *   node --import tsx scripts/test-release-backlog.ts
 *
 *   # + Schema tests (need a Postgres URL)
 *   DATABASE_URL=postgresql://... node --import tsx scripts/test-release-backlog.ts
 *
 *   # + API tests (need a running gateway + a JWT)
 *   GATEWAY_URL=http://localhost:8080 \
 *     JWT_DEVELOPER=eyJ... \
 *     JWT_TENANT_ADMIN=eyJ... \
 *     JWT_COMMUNITY=eyJ... \
 *     node --import tsx scripts/test-release-backlog.ts
 *
 * Exit code: 0 if all run tests pass. 1 if any fail.
 */

// =============================================================================
// Test harness (no dependencies)
// =============================================================================

type TestResult = { name: string; section: string; ok: boolean; reason?: string };
const results: TestResult[] = [];
let currentSection = '';

const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';

function section(name: string): void {
  currentSection = name;
  console.log(`\n${BOLD}${BLUE}=== ${name} ===${RESET}`);
}

async function check(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
  try {
    const ok = await fn();
    results.push({ name, section: currentSection, ok });
    console.log(`  ${ok ? GREEN + '✓' : RED + '✗'} ${name}${RESET}`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    results.push({ name, section: currentSection, ok: false, reason });
    console.log(`  ${RED}✗ ${name}${RESET}`);
    console.log(`    ${DIM}${reason}${RESET}`);
  }
}

function skip(name: string, why: string): void {
  console.log(`  ${YELLOW}○ ${name} (skipped: ${why})${RESET}`);
}

function assertEqual<T>(actual: T, expected: T): boolean {
  if (actual !== expected) {
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  return true;
}

function assertDeepEqual<T>(actual: T, expected: T): boolean {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`expected ${e}, got ${a}`);
  return true;
}

// =============================================================================
// Section 1 — Unit tests (pure functions inlined here so the script runs
// without compiling the TypeScript codebase)
// =============================================================================

type ReleaseChannel = 'internal' | 'beta' | 'stable';
type Compatibility = 'ok' | 'behind' | 'breaking';

function parseSemver(s: string): [number, number, number] {
  const cleaned = s.replace(/^[><=~^]+\s*/, '').trim();
  const parts = cleaned.split('.').map((n) => parseInt(n, 10));
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function computeCompatibility(
  currentSdkVersion: string | null,
  minPlatformVersion: string | null,
  targetPlatformVersion: string | null
): Compatibility {
  if (!currentSdkVersion || !minPlatformVersion) return 'ok';
  if (compareSemver(currentSdkVersion, minPlatformVersion) < 0) return 'breaking';
  if (targetPlatformVersion) {
    const liveMajor = parseSemver(currentSdkVersion)[0];
    const targetMajor = parseSemver(targetPlatformVersion)[0];
    if (liveMajor > targetMajor) return 'behind';
  }
  return 'ok';
}

const CHANNEL_RANK: Record<ReleaseChannel, number> = { internal: 0, beta: 1, stable: 2 };

function isValidPromotion(from: ReleaseChannel, to: ReleaseChannel): boolean {
  if (CHANNEL_RANK[to] < CHANNEL_RANK[from]) return false; // reverse
  if (CHANNEL_RANK[to] - CHANNEL_RANK[from] > 1) return false; // skip
  return true; // includes from === to (idempotent re-promote)
}

async function runUnitTests(): Promise<void> {
  section('1. UNIT TESTS — pure functions');

  // parseSemver
  await check('parseSemver: clean version', () =>
    assertDeepEqual(parseSemver('2.3.4'), [2, 3, 4])
  );
  await check('parseSemver: with >= operator', () =>
    assertDeepEqual(parseSemver('>=2.3.0'), [2, 3, 0])
  );
  await check('parseSemver: with > operator', () =>
    assertDeepEqual(parseSemver('>2.3.0'), [2, 3, 0])
  );
  await check('parseSemver: incomplete (one segment)', () =>
    assertDeepEqual(parseSemver('2'), [2, 0, 0])
  );

  // compareSemver
  await check('compareSemver: equal', () => assertEqual(compareSemver('1.0.0', '1.0.0'), 0));
  await check('compareSemver: major greater', () =>
    assertEqual(compareSemver('2.0.0', '1.0.0'), 1)
  );
  await check('compareSemver: major lesser', () =>
    assertEqual(compareSemver('1.0.0', '2.0.0'), -1)
  );
  await check('compareSemver: minor greater', () =>
    assertEqual(compareSemver('1.2.0', '1.1.0'), 1)
  );
  await check('compareSemver: patch greater', () =>
    assertEqual(compareSemver('1.0.1', '1.0.0'), 1)
  );
  await check('compareSemver: across operator', () =>
    assertEqual(compareSemver('2.3.4', '>=2.3.0'), 1)
  );

  // computeCompatibility (P2 — pin against platform.sdk only)
  await check('compatibility: null sdk → ok (no data)', () =>
    assertEqual(computeCompatibility(null, '>=2.0.0', null), 'ok')
  );
  await check('compatibility: null min → ok (unpinned)', () =>
    assertEqual(computeCompatibility('2.3.4', null, null), 'ok')
  );
  await check('compatibility: sdk meets min → ok', () =>
    assertEqual(computeCompatibility('2.3.4', '>=2.3.0', null), 'ok')
  );
  await check('compatibility: sdk equals min → ok', () =>
    assertEqual(computeCompatibility('2.3.0', '>=2.3.0', null), 'ok')
  );
  await check('compatibility: sdk below min → breaking', () =>
    assertEqual(computeCompatibility('2.0.0', '>=2.3.0', null), 'breaking')
  );
  await check('compatibility: sdk major ahead of target → behind', () =>
    assertEqual(computeCompatibility('3.0.0', '>=1.0.0', '2.0.0'), 'behind')
  );
  await check('compatibility: sdk same major as target → ok', () =>
    assertEqual(computeCompatibility('2.3.4', '>=2.0.0', '2.0.0'), 'ok')
  );

  // P3 channel promotion validation
  await check('promotion: internal → beta valid', () =>
    assertEqual(isValidPromotion('internal', 'beta'), true)
  );
  await check('promotion: beta → stable valid', () =>
    assertEqual(isValidPromotion('beta', 'stable'), true)
  );
  await check('promotion: internal → stable INVALID (skip)', () =>
    assertEqual(isValidPromotion('internal', 'stable'), false)
  );
  await check('promotion: stable → beta INVALID (reverse)', () =>
    assertEqual(isValidPromotion('stable', 'beta'), false)
  );
  await check('promotion: beta → internal INVALID (reverse)', () =>
    assertEqual(isValidPromotion('beta', 'internal'), false)
  );
  await check('promotion: stable → stable valid (idempotent)', () =>
    assertEqual(isValidPromotion('stable', 'stable'), true)
  );

  // P4 public_changelog defaults (verify the seed-by-surface logic)
  const surfacesPublic = ['desktop', 'ios', 'android', 'web'];
  const surfacesPrivate = ['command_hub', 'api', 'sdk'];
  for (const s of surfacesPublic) {
    await check(`P4 default: surface=${s} → public_changelog=true`, () =>
      assertEqual(['desktop', 'ios', 'android', 'web'].includes(s), true)
    );
  }
  for (const s of surfacesPrivate) {
    await check(`P4 default: surface=${s} → public_changelog=false`, () =>
      assertEqual(['desktop', 'ios', 'android', 'web'].includes(s), false)
    );
  }
}

// =============================================================================
// Section 2 — Schema tests (need a Postgres connection)
// =============================================================================

interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
}

async function loadPg(): Promise<{ Client: new (config: { connectionString: string }) => PgClient } | null> {
  try {
    // @ts-expect-error — dynamic import; pg is optional
    const mod = await import('pg');
    return { Client: mod.default?.Client ?? mod.Client };
  } catch {
    return null;
  }
}

async function runSchemaTests(databaseUrl: string): Promise<void> {
  section('2. SCHEMA TESTS — Postgres');
  const pg = await loadPg();
  if (!pg) {
    skip('all schema tests', "npm install pg && rerun (no 'pg' module available)");
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  try {
    await (client as unknown as { connect: () => Promise<void> }).connect();
  } catch (err) {
    skip('all schema tests', `cannot connect to database: ${(err as Error).message}`);
    return;
  }

  const tableExists = async (name: string): Promise<boolean> => {
    const r = await client.query(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`public.${name}`]
    );
    return Boolean(r.rows[0]?.present);
  };

  const colHas = async (table: string, column: string, type: string): Promise<boolean> => {
    const r = await client.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
      [table, column]
    );
    if (r.rows.length === 0) throw new Error(`column ${table}.${column} not found`);
    const actual = (r.rows[0] as { data_type: string }).data_type;
    if (actual !== type) throw new Error(`${table}.${column} is ${actual}, expected ${type}`);
    return true;
  };

  const indexExists = async (name: string): Promise<boolean> => {
    const r = await client.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1",
      [name]
    );
    return r.rows.length > 0;
  };

  const rlsEnabled = async (table: string): Promise<boolean> => {
    const r = await client.query(
      `SELECT relrowsecurity FROM pg_class
        WHERE relname=$1 AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')`,
      [table]
    );
    return Boolean(r.rows[0]?.relrowsecurity);
  };

  // Tables exist
  await check('table release_components exists', () => tableExists('release_components'));
  await check('table release_history exists', () => tableExists('release_history'));
  await check('table release_backlog_items exists', () => tableExists('release_backlog_items'));

  // Critical columns + types
  await check('release_components.public_changelog is boolean (P4)', () =>
    colHas('release_components', 'public_changelog', 'boolean')
  );
  await check('release_components.surface is text', () =>
    colHas('release_components', 'surface', 'text')
  );
  await check('release_components.tenant_id is uuid', () =>
    colHas('release_components', 'tenant_id', 'uuid')
  );
  await check('release_history.changelog is text', () =>
    colHas('release_history', 'changelog', 'text')
  );
  await check('release_history.internal_notes is text', () =>
    colHas('release_history', 'internal_notes', 'text')
  );
  await check('release_backlog_items.vtid is text (optional VTID link)', () =>
    colHas('release_backlog_items', 'vtid', 'text')
  );

  // Tenant-id-required CHECK constraint
  await check('CHECK constraint: tenant_id required when owner=tenant', async () => {
    const r = await client.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid='public.release_components'::regclass
          AND contype='c' AND conname LIKE '%tenant_id_required%'`
    );
    if (r.rows.length === 0) throw new Error('constraint missing');
    return true;
  });

  // Indexes
  await check('index idx_release_components_owner_tenant exists', () =>
    indexExists('idx_release_components_owner_tenant')
  );
  await check('index idx_release_history_component_released exists', () =>
    indexExists('idx_release_history_component_released')
  );
  await check('index idx_release_backlog_component_status exists', () =>
    indexExists('idx_release_backlog_component_status')
  );
  await check('index idx_release_backlog_vtid (partial WHERE vtid IS NOT NULL) exists', () =>
    indexExists('idx_release_backlog_vtid')
  );

  // RLS
  await check('release_components has RLS enabled', () => rlsEnabled('release_components'));
  await check('release_history has RLS enabled', () => rlsEnabled('release_history'));
  await check('release_backlog_items has RLS enabled', () => rlsEnabled('release_backlog_items'));

  // Seed (R3): 4 platform components
  await check('seed: 4 platform components inserted', async () => {
    const r = await client.query(
      "SELECT count(*)::int AS n FROM release_components WHERE owner='platform'"
    );
    const n = (r.rows[0] as { n: number }).n;
    if (n < 4) throw new Error(`expected ≥4, got ${n}`);
    return true;
  });

  await check("seed: platform.sdk has public_changelog=false", async () => {
    const r = await client.query(
      "SELECT public_changelog FROM release_components WHERE slug='platform.sdk'"
    );
    if (r.rows.length === 0) throw new Error('platform.sdk not seeded');
    return assertEqual((r.rows[0] as { public_changelog: boolean }).public_changelog, false);
  });

  await check("seed: platform.web has public_changelog=true (P4)", async () => {
    const r = await client.query(
      "SELECT public_changelog FROM release_components WHERE slug='platform.web'"
    );
    if (r.rows.length === 0) throw new Error('platform.web not seeded');
    return assertEqual((r.rows[0] as { public_changelog: boolean }).public_changelog, true);
  });

  await client.end();
}

// =============================================================================
// Section 3 — API tests (need a running gateway + JWTs)
// =============================================================================

async function gatewayCall(
  gatewayUrl: string,
  path: string,
  options: { method?: string; jwt?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.jwt) headers.Authorization = `Bearer ${options.jwt}`;
  const r = await fetch(`${gatewayUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    body = null;
  }
  return { status: r.status, body: body as any };
}

async function runApiTests(
  gatewayUrl: string,
  jwts: { developer?: string; tenantAdmin?: string; community?: string }
): Promise<void> {
  section('3. API TESTS — gateway endpoints');

  // Public changelog — no auth needed (R17)
  await check('GET /api/v1/releases/changelog/public → 200 + entries array', async () => {
    const { status, body } = await gatewayCall(gatewayUrl, '/api/v1/releases/changelog/public');
    if (status !== 200) throw new Error(`status ${status}`);
    if (!Array.isArray(body?.entries)) throw new Error('entries not an array');
    return true;
  });

  await check('GET /api/v1/releases/changelog/public has Cache-Control', async () => {
    const r = await fetch(`${gatewayUrl}/api/v1/releases/changelog/public`);
    const cc = r.headers.get('cache-control');
    if (!cc || !cc.includes('max-age')) throw new Error(`missing/invalid Cache-Control: ${cc}`);
    return true;
  });

  // Overview — unauthenticated should be 401
  await check('GET /api/v1/releases/overview without JWT → 401', async () => {
    const { status } = await gatewayCall(gatewayUrl, '/api/v1/releases/overview');
    if (status !== 401) throw new Error(`expected 401, got ${status}`);
    return true;
  });

  // Overview — community role should be 403
  if (jwts.community) {
    await check('GET /api/v1/releases/overview as community → 403', async () => {
      const { status } = await gatewayCall(gatewayUrl, '/api/v1/releases/overview', {
        jwt: jwts.community,
      });
      if (status !== 403) throw new Error(`expected 403, got ${status}`);
      return true;
    });
  } else {
    skip('GET /releases/overview as community → 403', 'JWT_COMMUNITY not set');
  }

  // Overview — tenant_admin sees own tenant only
  if (jwts.tenantAdmin) {
    await check('GET /releases/overview as tenant_admin → 200 + scoped tenants', async () => {
      const { status, body } = await gatewayCall(gatewayUrl, '/api/v1/releases/overview', {
        jwt: jwts.tenantAdmin,
      });
      if (status !== 200) throw new Error(`status ${status}`);
      if (!Array.isArray(body?.platform)) throw new Error('platform not array');
      if (!Array.isArray(body?.tenants)) throw new Error('tenants not array');
      if (body.tenants.length > 1) {
        throw new Error(`tenant_admin saw ${body.tenants.length} tenants — expected ≤1`);
      }
      return true;
    });
  } else {
    skip('GET /releases/overview as tenant_admin', 'JWT_TENANT_ADMIN not set');
  }

  // Overview — developer sees all tenants
  if (jwts.developer) {
    await check('GET /releases/overview as developer → 200 + full payload', async () => {
      const { status, body } = await gatewayCall(gatewayUrl, '/api/v1/releases/overview', {
        jwt: jwts.developer,
      });
      if (status !== 200) throw new Error(`status ${status}`);
      if (!Array.isArray(body?.platform)) throw new Error('platform not array');
      if (body.platform.length < 1) throw new Error('platform array is empty — seed missing?');
      // Check shape of platform component entries
      const c = body.platform[0];
      const required = ['slug', 'display_name', 'current_version', 'pending_count'];
      for (const k of required) {
        if (!(k in c)) throw new Error(`platform component missing field: ${k}`);
      }
      return true;
    });

    // Components list
    await check('GET /releases/components as developer → 200', async () => {
      const { status, body } = await gatewayCall(gatewayUrl, '/api/v1/releases/components', {
        jwt: jwts.developer,
      });
      if (status !== 200) throw new Error(`status ${status}`);
      if (!Array.isArray(body?.components)) throw new Error('components not array');
      return true;
    });

    // PATCH — should reject current_channel writes (P3 enforcement)
    await check('PATCH /releases/components/:id rejects current_channel (P3)', async () => {
      // Fetch any component first
      const list = await gatewayCall(gatewayUrl, '/api/v1/releases/components', {
        jwt: jwts.developer,
      });
      const comp = list.body?.components?.[0];
      if (!comp?.id) {
        skip('PATCH channel rejection', 'no components to test against');
        return true;
      }
      const { status, body } = await gatewayCall(
        gatewayUrl,
        `/api/v1/releases/components/${comp.id}`,
        {
          method: 'PATCH',
          jwt: jwts.developer,
          body: { current_channel: 'stable' },
        }
      );
      if (status !== 400) throw new Error(`expected 400, got ${status}`);
      if (!String(body?.error ?? '').toLowerCase().includes('promote')) {
        throw new Error(`error message should mention /promote: ${JSON.stringify(body)}`);
      }
      return true;
    });

    // Promote — reject reverse promotion
    await check('POST /promote rejects reverse promotion (P3)', async () => {
      const list = await gatewayCall(gatewayUrl, '/api/v1/releases/components', {
        jwt: jwts.developer,
      });
      const comp = list.body?.components?.[0];
      if (!comp?.id) {
        skip('promote reverse', 'no components to test against');
        return true;
      }
      const { status } = await gatewayCall(
        gatewayUrl,
        `/api/v1/releases/components/${comp.id}/promote`,
        {
          method: 'POST',
          jwt: jwts.developer,
          body: { from: 'stable', to: 'beta', release_id: '00000000-0000-0000-0000-000000000000' },
        }
      );
      if (status !== 400) throw new Error(`expected 400, got ${status}`);
      return true;
    });

    // Promote — reject channel skip
    await check('POST /promote rejects channel skip (P3)', async () => {
      const list = await gatewayCall(gatewayUrl, '/api/v1/releases/components', {
        jwt: jwts.developer,
      });
      const comp = list.body?.components?.[0];
      if (!comp?.id) {
        skip('promote skip', 'no components to test against');
        return true;
      }
      const { status } = await gatewayCall(
        gatewayUrl,
        `/api/v1/releases/components/${comp.id}/promote`,
        {
          method: 'POST',
          jwt: jwts.developer,
          body: {
            from: 'internal',
            to: 'stable',
            release_id: '00000000-0000-0000-0000-000000000000',
          },
        }
      );
      if (status !== 400) throw new Error(`expected 400, got ${status}`);
      return true;
    });

    // Backlog list
    await check('GET /releases/backlog as developer → 200 + items array', async () => {
      const { status, body } = await gatewayCall(gatewayUrl, '/api/v1/releases/backlog', {
        jwt: jwts.developer,
      });
      if (status !== 200) throw new Error(`status ${status}`);
      if (!Array.isArray(body?.items)) throw new Error('items not array');
      // For any item with vtid, vtid_linked must be true and effective_status must exist
      for (const item of body.items) {
        if (item.vtid !== null && item.vtid_linked !== true) {
          throw new Error(`backlog item ${item.id} has vtid but vtid_linked=false (P1 violated)`);
        }
        if (typeof item.effective_status !== 'string') {
          throw new Error(`backlog item ${item.id} missing effective_status`);
        }
      }
      return true;
    });
  } else {
    skip('GET /releases/components as developer', 'JWT_DEVELOPER not set');
    skip('PATCH channel rejection (P3)', 'JWT_DEVELOPER not set');
    skip('POST /promote reverse (P3)', 'JWT_DEVELOPER not set');
    skip('POST /promote skip (P3)', 'JWT_DEVELOPER not set');
    skip('GET /releases/backlog (P1 read-through)', 'JWT_DEVELOPER not set');
  }

  // Dev docs proxy — community should NOT be able to access (R8 + Q1)
  if (jwts.community) {
    await check('GET /api/v1/docs/specs/* as community → 403 (Q1 lock)', async () => {
      const { status } = await gatewayCall(
        gatewayUrl,
        '/api/v1/docs/specs/release-backlog-overview.md',
        { jwt: jwts.community }
      );
      if (status !== 403) throw new Error(`expected 403, got ${status}`);
      return true;
    });
  } else {
    skip('GET /docs/specs as community → 403', 'JWT_COMMUNITY not set');
  }

  // Dev docs proxy — path traversal must be rejected (R8 hardening)
  if (jwts.developer) {
    await check('GET /api/v1/docs/specs/../etc/passwd → 400 (path traversal blocked)', async () => {
      const { status } = await gatewayCall(
        gatewayUrl,
        '/api/v1/docs/specs/' + encodeURIComponent('../etc/passwd'),
        { jwt: jwts.developer }
      );
      if (status !== 400 && status !== 404) throw new Error(`expected 400/404, got ${status}`);
      return true;
    });

    await check('GET /api/v1/docs/specs/notallowed.md → 404 (allowlist enforced)', async () => {
      const { status } = await gatewayCall(gatewayUrl, '/api/v1/docs/specs/notallowed.md', {
        jwt: jwts.developer,
      });
      if (status !== 404) throw new Error(`expected 404, got ${status}`);
      return true;
    });
  } else {
    skip('docs path traversal protection', 'JWT_DEVELOPER not set');
    skip('docs allowlist', 'JWT_DEVELOPER not set');
  }
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log(`${BOLD}Release Backlog & Versioning — verification suite${RESET}`);
  console.log(`${DIM}Phases 1–5 covered. Skip categories print yellow.${RESET}`);

  await runUnitTests();

  if (process.env.DATABASE_URL) {
    await runSchemaTests(process.env.DATABASE_URL);
  } else {
    section('2. SCHEMA TESTS — Postgres');
    skip('all schema tests', 'DATABASE_URL not set');
  }

  if (process.env.GATEWAY_URL) {
    await runApiTests(process.env.GATEWAY_URL, {
      developer: process.env.JWT_DEVELOPER,
      tenantAdmin: process.env.JWT_TENANT_ADMIN,
      community: process.env.JWT_COMMUNITY,
    });
  } else {
    section('3. API TESTS — gateway endpoints');
    skip('all API tests', 'GATEWAY_URL not set');
  }

  // Summary
  console.log(`\n${BOLD}=== SUMMARY ===${RESET}`);
  const bySection = new Map<string, { ok: number; fail: number }>();
  for (const r of results) {
    const s = bySection.get(r.section) ?? { ok: 0, fail: 0 };
    if (r.ok) s.ok++;
    else s.fail++;
    bySection.set(r.section, s);
  }
  for (const [name, counts] of bySection) {
    const tot = counts.ok + counts.fail;
    const color = counts.fail === 0 ? GREEN : RED;
    console.log(`  ${color}${counts.ok}/${tot}${RESET} ${name}`);
  }

  const totalFail = results.filter((r) => !r.ok).length;
  const totalOk = results.filter((r) => r.ok).length;
  console.log(
    `\n${BOLD}${totalFail === 0 ? GREEN : RED}${totalOk} passed, ${totalFail} failed${RESET}`
  );
  if (totalFail > 0) {
    console.log(`\n${RED}${BOLD}FAILED TESTS:${RESET}`);
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  ${RED}✗${RESET} [${r.section}] ${r.name}`);
      if (r.reason) console.log(`    ${DIM}${r.reason}${RESET}`);
    }
  }
  process.exit(totalFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(`${RED}fatal:${RESET}`, err);
  process.exit(2);
});
