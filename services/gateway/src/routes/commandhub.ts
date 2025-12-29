import { Router } from "express";

export const commandhub = Router();

/**
 * VTID-01063: CommandHub Router
 *
 * NOTE: The /board route was REMOVED as part of VTID-01063 (Duplicate Route Guard).
 *
 * The /board endpoint is now EXCLUSIVELY served by board-adapter.ts which:
 * - Is mounted at /api/v1/commandhub/board
 * - Has VTID-01058 fixes (excludes deleted/voided tasks)
 * - Is the SINGLE SOURCE OF TRUTH for board data
 *
 * This prevents the route ambiguity that caused VTID-01058:
 * - Previously: commandhub.ts GET /board AND board-adapter.ts GET /
 *   both resolved to GET /api/v1/commandhub/board
 * - Now: Only board-adapter.ts serves this endpoint
 *
 * Platform invariant enforced by route-guard.ts:
 * One endpoint = one authoritative handler.
 */
