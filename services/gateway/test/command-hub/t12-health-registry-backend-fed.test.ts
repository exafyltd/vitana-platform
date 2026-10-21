/**
 * VTID-04087 (T12): Service Health panel's endpoint list is backend-fed,
 * with a fallback.
 *
 * app.js is a plain browser script with no build step and no render-test
 * harness, so — matching this repo's established pattern for app.js (see
 * test/command-hub/t5c-no-fabricated-fallback-rows.test.ts and
 * test/command-hub/dead-code-workflows-removed.test.ts) — this suite pins
 * the change by source text.
 *
 * Before this VTID, the panel's ~55-entry endpoint list lived ONLY as a
 * hardcoded array inline inside fetchServiceHealth() — a frontend-only
 * asset with no server-side counterpart, so a new health-check route could
 * ship and never appear on the panel unless someone remembered to
 * hand-edit this unrelated file too. Now GET /api/v1/admin/health-registry
 * (services/gateway/src/constants/service-health-registry.ts,
 * services/gateway/src/routes/admin-health.ts) is the canonical source;
 * app.js fetches it at runtime and falls back to its own last-known copy
 * (FALLBACK_HEALTH_ENDPOINTS) only if that fetch fails.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const APP_JS_PATH = join(__dirname, '../../src/frontend/command-hub/app.js');
const REGISTRY_TS_PATH = join(__dirname, '../../src/constants/service-health-registry.ts');
const ADMIN_HEALTH_TS_PATH = join(__dirname, '../../src/routes/admin-health.ts');

/** Slice the body of a top-level `async function <name>(...) { ... }` declaration. */
function asyncFunctionBody(src: string, name: string): string {
  const match = src.match(new RegExp('async function\\s+' + name + '\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}'));
  if (!match) throw new Error(`async function ${name}() not found in source`);
  return match[0];
}

describe('T12: Command Hub health-endpoint list is backend-fed', () => {
  const appJs = readFileSync(APP_JS_PATH, 'utf8');

  it('fetchServiceHealth() fetches the server-side registry before falling back', () => {
    const body = asyncFunctionBody(appJs, 'fetchServiceHealth');
    expect(body).toMatch(/\/api\/v1\/admin\/health-registry/);
    expect(body).toMatch(/FALLBACK_HEALTH_ENDPOINTS/);
    // The registry fetch must be wrapped so a network/route failure degrades
    // to the fallback list rather than throwing out of the whole function.
    expect(body).toMatch(/catch\s*\(\s*registryError\s*\)/);
  });

  it('the old hardcoded array no longer lives inline inside fetchServiceHealth()', () => {
    const body = asyncFunctionBody(appJs, 'fetchServiceHealth');
    // A handful of endpoint names that used to be typed directly into this
    // function's body — they must now only appear via FALLBACK_HEALTH_ENDPOINTS
    // (declared elsewhere in the file), not as a second inline literal here.
    expect(body).not.toMatch(/name:\s*'Gateway Alive'/);
    expect(body).not.toMatch(/name:\s*'Autopilot Pipeline'/);
  });

  it('FALLBACK_HEALTH_ENDPOINTS is declared once, at module scope, before the function that uses it', () => {
    const declIndex = appJs.indexOf('var FALLBACK_HEALTH_ENDPOINTS');
    const useIndex = appJs.indexOf('healthEndpoints = FALLBACK_HEALTH_ENDPOINTS');
    expect(declIndex).toBeGreaterThan(-1);
    expect(useIndex).toBeGreaterThan(-1);
    expect(declIndex).toBeLessThan(useIndex);

    const secondDecl = appJs.indexOf('var FALLBACK_HEALTH_ENDPOINTS', declIndex + 1);
    expect(secondDecl).toBe(-1);
  });

  it('the fallback list still carries the core checks the panel has always shown', () => {
    const declStart = appJs.indexOf('var FALLBACK_HEALTH_ENDPOINTS');
    const declEnd = appJs.indexOf('];', declStart);
    const declSrc = appJs.slice(declStart, declEnd);
    for (const name of ['Gateway', 'Gateway Alive', 'ORB Live', 'Autopilot', 'VTID', 'Screen Load Time']) {
      expect(declSrc).toContain(`name: '${name}'`);
    }
  });
});

describe('T12: server-side registry backs the frontend fetch', () => {
  it('service-health-registry.ts exports SERVICE_HEALTH_REGISTRY with the same core checks', () => {
    const src = readFileSync(REGISTRY_TS_PATH, 'utf8');
    expect(src).toMatch(/export const SERVICE_HEALTH_REGISTRY/);
    for (const name of ['Gateway', 'Gateway Alive', 'ORB Live', 'Autopilot', 'VTID', 'Screen Load Time']) {
      expect(src).toContain(`name: '${name}'`);
    }
  });

  it('admin-health.ts mounts an unauthenticated /health-registry route sourced from the registry module', () => {
    const src = readFileSync(ADMIN_HEALTH_TS_PATH, 'utf8');
    expect(src).toMatch(/import\s*\{\s*SERVICE_HEALTH_REGISTRY\b[^}]*\}\s*from\s*['"]\.\.\/constants\/service-health-registry['"]/);
    const routeMatch = src.match(/router\.get\(\s*['"]\/health-registry['"][\s\S]*?\n\}\);/);
    expect(routeMatch).toBeTruthy();
    const routeSrc = routeMatch![0];
    // Unauthenticated, matching /health and /build-info — no requireAdminAuth.
    expect(routeSrc).not.toMatch(/requireAdminAuth/);
    expect(routeSrc).toMatch(/SERVICE_HEALTH_REGISTRY/);
  });
});
