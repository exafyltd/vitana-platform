/**
 * Recommendation Engine - VTID-01185
 *
 * Main entry point for the Autopilot Recommendation Engine.
 *
 * Components:
 * - Analyzers: Codebase, OASIS, Health, Roadmap
 * - Generator: Orchestrates analyzers and creates recommendations
 * - Scheduler: Handles scheduled and PR-triggered generation
 *
 * API Endpoints:
 * - POST /api/v1/autopilot/recommendations/generate
 * - GET /api/v1/autopilot/recommendations/sources
 * - GET /api/v1/autopilot/recommendations/history
 *
 * Schedule:
 * - Every 6 hours: OASIS event analysis
 * - Daily 2 AM UTC: Full codebase scan
 * - On PR merge: Changed files analysis
 */

export * from './analyzers';
export * from './recommendation-generator';
export * from './scheduler';
