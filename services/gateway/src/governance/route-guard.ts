/**
 * VTID-01063: Gateway Duplicate Route Guard (Governance Hard Gate)
 *
 * This module prevents duplicate route registration in the Gateway.
 * Platform invariant: One endpoint = one authoritative handler.
 *
 * Problem solved: VTID-01058 where /api/v1/commandhub/board was served by
 * two different routes (commandhub.ts and board-adapter.ts), causing
 * route ambiguity, silent overrides, and ghost data.
 */

import { Application, Router, IRouter } from 'express';
import { emitOasisEvent } from '../services/oasis-event-service';

/**
 * Route registration entry
 */
interface RouteRegistration {
  owner: string;
  file?: string;
  registeredAt: string;
}

/**
 * Route registry: key = "METHOD /full/path", value = registration info
 */
const routeRegistry: Map<string, RouteRegistration> = new Map();

/**
 * Environment detection
 */
const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';
const isProd = process.env.NODE_ENV === 'production';
const allowDuplicates = process.env.ROUTE_GUARD_ALLOW_DUPLICATES === 'true';

/**
 * Normalize path to ensure consistent key format
 * - Remove trailing slashes
 * - Ensure leading slash
 */
function normalizePath(path: string): string {
  let normalized = path.replace(/\/+$/, ''); // Remove trailing slashes
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  return normalized || '/';
}

/**
 * Build the route key for the registry
 */
function buildRouteKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${normalizePath(path)}`;
}

/**
 * Register a route in the guard registry
 * Returns true if registration succeeded, false if duplicate detected
 */
function registerRoute(
  method: string,
  fullPath: string,
  owner: string,
  file?: string
): { success: boolean; existing?: RouteRegistration } {
  const key = buildRouteKey(method, fullPath);
  const existing = routeRegistry.get(key);

  if (existing) {
    return { success: false, existing };
  }

  routeRegistry.set(key, {
    owner,
    file,
    registeredAt: new Date().toISOString(),
  });

  return { success: true };
}

/**
 * Handle duplicate route detection
 */
async function handleDuplicate(
  method: string,
  fullPath: string,
  firstOwner: string,
  secondOwner: string
): Promise<void> {
  const message = `[RouteGuard] DUPLICATE ROUTE DETECTED: ${method.toUpperCase()} ${fullPath} - first registered by "${firstOwner}", attempted re-registration by "${secondOwner}"`;

  console.error(message);

  // Emit OASIS event for observability
  try {
    await emitOasisEvent({
      vtid: 'VTID-01063',
      type: 'governance.route.duplicate.detected',
      source: 'gateway-route-guard',
      status: 'error',
      message: `Duplicate route detected: ${method.toUpperCase()} ${fullPath}`,
      payload: {
        method: method.toUpperCase(),
        path: fullPath,
        first_owner: firstOwner,
        second_owner: secondOwner,
        detected_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    console.error('[RouteGuard] Failed to emit OASIS event:', err);
  }

  // In DEV/TEST: throw to crash startup
  // In PROD: only throw if ROUTE_GUARD_ALLOW_DUPLICATES is not true
  if (isDev || !allowDuplicates) {
    throw new Error(message);
  }
}

/**
 * Extract routes from an Express router
 * Handles nested routers and parameterized routes
 */
function extractRoutes(
  router: IRouter,
  basePath: string = ''
): Array<{ method: string; path: string }> {
  const routes: Array<{ method: string; path: string }> = [];
  const stack = (router as any).stack || [];

  for (const layer of stack) {
    if (layer.route) {
      // Direct route definition
      const routePath = normalizePath(basePath + (layer.route.path || ''));
      const methods = Object.keys(layer.route.methods || {}).filter(
        (m) => layer.route.methods[m]
      );

      for (const method of methods) {
        routes.push({ method: method.toUpperCase(), path: routePath });
      }
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      // Nested router
      const nestedPath = layer.regexp
        ? extractPathFromRegexp(layer.regexp, layer.keys)
        : '';
      const nestedRoutes = extractRoutes(
        layer.handle,
        normalizePath(basePath + nestedPath)
      );
      routes.push(...nestedRoutes);
    }
  }

  return routes;
}

/**
 * Extract path pattern from Express regexp
 * This is a simplified extraction that handles common patterns
 */
function extractPathFromRegexp(
  regexp: RegExp,
  keys: Array<{ name: string }> = []
): string {
  // Get the source and try to extract path
  const source = regexp.source;

  // Handle common patterns
  if (source === '^\\/?(?=\\/|$)') {
    return '/';
  }

  // Try to extract literal path segments
  let path = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\(\?:\(\[\^\\\/\]\+\?\)\)/g, ':param')
    .replace(/\\\//g, '/');

  // Add parameter names if available
  let paramIndex = 0;
  path = path.replace(/:param/g, () => {
    const key = keys[paramIndex++];
    return key ? `:${key.name}` : ':param';
  });

  return path;
}

/**
 * Mount options for the route guard
 */
export interface MountOptions {
  owner: string;
  file?: string;
}

/**
 * Mount a router with route guard protection
 *
 * This is the primary API for mounting routers in the Gateway.
 * It inspects all routes in the router, registers them with the guard,
 * and only mounts the router if no duplicates are detected.
 *
 * @param app Express application
 * @param mountPath Base path for the router
 * @param router Express router to mount
 * @param options Mount options including owner name
 */
export async function mountRouter(
  app: Application,
  mountPath: string,
  router: IRouter,
  options: MountOptions
): Promise<void> {
  const { owner, file } = options;
  const normalizedMountPath = normalizePath(mountPath);

  // Extract all routes from the router
  const routes = extractRoutes(router, normalizedMountPath);

  // Register each route with the guard
  for (const route of routes) {
    const result = registerRoute(route.method, route.path, owner, file);

    if (!result.success && result.existing) {
      await handleDuplicate(
        route.method,
        route.path,
        result.existing.owner,
        owner
      );
    }
  }

  // If we get here, no duplicates were detected (or allowed in prod)
  // Mount the router
  app.use(mountPath, router);
}

/**
 * Synchronous version of mountRouter for use in non-async contexts
 * Note: OASIS event emission will be fire-and-forget in this version
 */
export function mountRouterSync(
  app: Application,
  mountPath: string,
  router: IRouter,
  options: MountOptions
): void {
  const { owner, file } = options;
  const normalizedMountPath = normalizePath(mountPath);

  // Extract all routes from the router
  const routes = extractRoutes(router, normalizedMountPath);

  // Track if we have duplicates
  const duplicates: Array<{
    method: string;
    path: string;
    firstOwner: string;
  }> = [];

  // Register each route with the guard
  for (const route of routes) {
    const result = registerRoute(route.method, route.path, owner, file);

    if (!result.success && result.existing) {
      duplicates.push({
        method: route.method,
        path: route.path,
        firstOwner: result.existing.owner,
      });
    }
  }

  // Handle duplicates
  if (duplicates.length > 0) {
    for (const dup of duplicates) {
      const message = `[RouteGuard] DUPLICATE ROUTE DETECTED: ${dup.method} ${dup.path} - first registered by "${dup.firstOwner}", attempted re-registration by "${owner}"`;
      console.error(message);

      // Emit OASIS event (fire-and-forget)
      emitOasisEvent({
        vtid: 'VTID-01063',
        type: 'governance.route.duplicate.detected',
        source: 'gateway-route-guard',
        status: 'error',
        message: `Duplicate route detected: ${dup.method} ${dup.path}`,
        payload: {
          method: dup.method,
          path: dup.path,
          first_owner: dup.firstOwner,
          second_owner: owner,
          detected_at: new Date().toISOString(),
        },
      }).catch((err) => {
        console.error('[RouteGuard] Failed to emit OASIS event:', err);
      });

      // Throw in DEV/TEST or if duplicates not allowed
      if (isDev || !allowDuplicates) {
        throw new Error(message);
      }
    }
  }

  // Mount the router
  app.use(mountPath, router);
}

/**
 * Get the count of registered routes
 */
export function getRegisteredRouteCount(): number {
  return routeRegistry.size;
}

/**
 * Get all registered routes (for debugging/testing)
 */
export function getRegisteredRoutes(): Map<string, RouteRegistration> {
  return new Map(routeRegistry);
}

/**
 * Clear the route registry (for testing only)
 */
export function clearRouteRegistry(): void {
  if (process.env.NODE_ENV !== 'test') {
    console.warn(
      '[RouteGuard] clearRouteRegistry() should only be used in tests'
    );
  }
  routeRegistry.clear();
}

/**
 * Log startup summary
 */
export function logStartupSummary(): void {
  const count = routeRegistry.size;
  console.log(`RouteGuard: registered ${count} routes, 0 duplicates`);
}

export default {
  mountRouter,
  mountRouterSync,
  getRegisteredRouteCount,
  getRegisteredRoutes,
  clearRouteRegistry,
  logStartupSummary,
};
