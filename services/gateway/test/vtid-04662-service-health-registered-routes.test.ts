/**
 * VTID-04662 — Service Health Phase 1: health routes that already existed in
 * the gateway but were never registered on the Command Hub panel.
 *
 * The route-existence half of this is proven on staging (every URL answers
 * JSON, not Express's HTML 404) by docs/validation/VTID-04662/staging-tests.json;
 * here we pin the registry contents and that each URL is served by a router
 * file that really declares the path.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { SERVICE_HEALTH_REGISTRY, SERVICE_HEALTH_GROUPS } from '../src/constants/service-health-registry';

const P1: Array<[string, string, string, string]> = [
  // name, url, group, router file + declared path
  ['Nova Sonic', '/api/v1/orb/nova-sonic/health', 'AI & Assistant', "orb-livekit.ts|'/orb/nova-sonic/health'"],
  ['LLM Providers', '/api/v1/llm/providers/health', 'AI & Assistant', "llm.ts|'/providers/health'"],
  ['Voice Tools Catalog', '/api/v1/voice-tools/health', 'AI & Assistant', "voice-tools-catalog.ts|'/health'"],
  ['Self-Healing', '/api/v1/self-healing/health', 'Self-Healing & Ops', "self-healing.ts|'/health'"],
  ['Watcher', '/api/v1/watcher/health', 'Self-Healing & Ops', "watcher.ts|'/health'"],
  ['Worker Orchestrator', '/api/v1/worker/orchestrator/health', 'Self-Healing & Ops', "worker-orchestrator.ts|'/api/v1/worker/orchestrator/health'"],
  ['Aurora Memory', '/api/v1/admin/aurora-memory/health', 'Data & Memory', "admin-aurora-memory-health.ts|'/admin/aurora-memory/health'"],
  ['Aurora RLS', '/api/v1/admin/aurora-rls-health', 'Data & Memory', "admin-health.ts|'/aurora-rls-health'"],
  ['ORB Session State', '/api/v1/admin/orb-session-state-health', 'Data & Memory', "admin-health.ts|'/orb-session-state-health'"],
  ['Reminders', '/api/v1/reminders/_health/check', 'Automation & Scheduling', "reminders.ts|'/_health/check'"],
  ['Calendar', '/api/v1/calendar/health', 'Automation & Scheduling', "calendar.ts|'/health'"],
  ['Integrations', '/api/v1/integrations/health', 'Domain & Context', "integrations.ts|'/health'"],
  ['Pillar Agents', '/api/v1/pillar-agents/health', 'Domain & Context', "pillar-agents.ts|'/health'"],
  ['Catalog Ingest', '/api/v1/catalog/ingest/health', 'Commerce', "catalog-ingest.ts|'/health'"],
  ['Shop Feed', '/api/v1/shop-feed/health', 'Commerce', "shop-feed.ts|'/health'"],
  ['Shopping Agent', '/api/v1/shopping-agent/health', 'Commerce', "shopping-agent.ts|'/health'"],
  ['Universal Cart', '/api/v1/universal-cart/health', 'Commerce', "universal-cart.ts|'/health'"],
];

describe('VTID-04662: existing health routes are registered', () => {
  it.each(P1)('%s is on the panel at %s in %s', (name, url, group) => {
    expect(SERVICE_HEALTH_REGISTRY).toContainEqual({ name, url, group });
    expect(SERVICE_HEALTH_GROUPS).toContain(group);
  });

  it.each(P1)('%s is declared by its router', (_name, _url, _group, where) => {
    const [file, path] = where.split('|');
    const src = readFileSync(join(__dirname, '../src/routes', file), 'utf8');
    expect(src).toMatch(new RegExp(`\\.get\\(\\s*${path.replace(/[/.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('the panel now carries 117 checks and no duplicate URL or name', () => {
    expect(SERVICE_HEALTH_REGISTRY).toHaveLength(117);
    expect(new Set(SERVICE_HEALTH_REGISTRY.map((e) => e.url)).size).toBe(117);
    expect(new Set(SERVICE_HEALTH_REGISTRY.map((e) => e.name)).size).toBe(117);
  });

  it('the Memory Broker dashboard feed is not polled as a health check (15 table counts per call)', () => {
    expect(SERVICE_HEALTH_REGISTRY.map((e) => e.url)).not.toContain('/api/v1/admin/memory/health');
  });

  it('the Nova Sonic route reports a status that follows readiness, not its always-true ok', () => {
    const src = readFileSync(join(__dirname, '../src/routes/orb-livekit.ts'), 'utf8');
    expect(src).toMatch(/status: payload\.ready \? 'ok' : payload\.enabled \? 'down' : 'not_configured'/);
  });
});
