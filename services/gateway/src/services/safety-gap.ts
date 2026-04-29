import { Request } from 'express';

/**
 * A no-op placeholder for future safety checks.
 * This function's presence is verified by tests to ensure a safety contract.
 * It can be enriched with checks for authentication, tenancy, rate limiting, etc.
 *
 * @param _req - The Express request object.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function checkSafetyGap(_req: Request): void {
  // This is a placeholder. Future safety checks go here.
  // The goal is to have this call at the entry point of every sensitive route handler.
}