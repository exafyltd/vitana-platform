/**
 * Recommendation Engine - VTID-01185
 *
 * Main entry point for the Autopilot Recommendation Engine.
 *
 * Components:
 * - Analyzers: Codebase, OASIS, Health, Roadmap, LLM, User Behavior
 * - Generator: Orchestrates analyzers and creates recommendations
 * - Scheduler: Handles scheduled and PR-triggered generation
 * - Autonomous Engine: Closes the self-improvement loop (feedback, cleanup, auto-activate)
 *
 * API Endpoints:
 * - POST /api/v1/autopilot/recommendations/generate
 * - GET /api/v1/autopilot/recommendations/sources
 * - GET /api/v1/autopilot/recommendations/history
 *
 * Schedule:
 * - Every 5 minutes: Real-time signal polling (deploy failures, error spikes)
 * - Every 6 hours: OASIS event analysis
 * - Daily 2 AM UTC: Full scan (all 6 analyzers)
 * - Every 10 minutes: Feedback loop sync (VTID outcomes → recommendation status)
 * - On PR merge: Changed files analysis
 */

export * from './analyzers';
export * from './recommendation-generator';
export * from './scheduler';
export * from './autonomous-engine';
