/**
 * VTID-04562 — the developer Vitana's two knowledge tools.
 *
 *   dev_system_status  — the live system snapshot (builds on each stack,
 *                        Dev Autopilot state, last hour of errors), fresh
 *                        on request instead of the one the session opened
 *                        with.
 *   dev_domain_atlas   — the map of the whole system: one domain's code,
 *                        tables, flags and docs, or the index of domains.
 *
 * Read-only, developer-gated (developerGate). They tell the assistant where
 * to dig; the deep-dive tools read the code, rows and logs themselves.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate } from './developer-tools';
import {
  getSystemSnapshot, buildSystemSnapshot, defaultSystemSnapshotDeps,
} from '../../orb/developer/system-snapshot';
import { DOMAIN_ATLAS, findDomain, renderAtlasDomain, renderAtlasIndex } from '../../orb/developer/domain-atlas';

type Handler = (args: OrbToolArgs, id: OrbToolIdentity, sb: SupabaseClient) => Promise<OrbToolResult>;

export const dev_system_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const fresh = args.fresh === true;
  const snap = fresh ? await buildSystemSnapshot(defaultSystemSnapshotDeps()) : await getSystemSnapshot();
  return {
    ok: true,
    result: { as_of: snap.asOf, highlights: snap.highlights, snapshot: snap.text },
    text: snap.text,
  };
};

export const dev_domain_atlas: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const query = typeof args.domain === 'string' ? args.domain.trim() : '';
  if (!query) {
    return { ok: true, result: { domains: DOMAIN_ATLAS.map((d) => d.key) }, text: renderAtlasIndex() };
  }
  const d = findDomain(query);
  if (!d) {
    return {
      ok: true,
      result: { found: false, domains: DOMAIN_ATLAS.map((x) => x.key) },
      text: `No domain matches "${query}". Domains: ${DOMAIN_ATLAS.map((x) => x.key).join(', ')}.`,
    };
  }
  return {
    ok: true,
    result: { found: true, key: d.key, title: d.title, code: d.code, tables: d.tables, flags: d.flags, docs: d.docs },
    text: renderAtlasDomain(d),
  };
};

export const DEVELOPER_KNOWLEDGE_TOOL_HANDLERS: Record<string, Handler> = {
  dev_system_status,
  dev_domain_atlas,
};

export const DEVELOPER_KNOWLEDGE_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_system_status',
    description: 'DEVELOPER ONLY. Live system snapshot: which build staging and production serve, the Dev Autopilot state (kill switch, provider outage, executions in flight and waiting for approval, 7-day success rate, alerts) and the last hour of error events and voice sessions. Pass fresh:true to bypass the 90-second cache.',
    parameters: { type: 'object', properties: { fresh: { type: 'boolean' } } },
  },
  {
    name: 'dev_domain_atlas',
    description: 'DEVELOPER ONLY. The map of Vitanaland: with no domain, one line per part of the system; with a domain or topic (voice, autopilot, agents, oasis, deploy, llm, memory, community, support, health, commerce, payments, admin, backoffice, infra), its code locations, tables, flags and docs.',
    parameters: { type: 'object', properties: { domain: { type: 'string', description: 'A domain key or a topic, e.g. "voice" or "knowledge graph".' } } },
  },
];
