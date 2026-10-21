/**
 * Context source inventory — Phase 1 W3-D1 PR 1 (VTID-03238).
 *
 * Read-only. Defines the canonical inventory of context sources that
 * the Vitana brain pulls from when assembling a recommendation,
 * match, or assistant turn, then queries prod for coverage signals
 * (row counts, freshness, consent gating) so the cockpit can show
 * "what does the system know about the user right now".
 *
 * No production behavior change. No mutation. The companion
 * context-quality-score script (PR 2) consumes this inventory.
 *
 * Output:
 *   stdout: JSON (ContextSourceInventoryReport)
 *   $REPORT_MARKDOWN_PATH (optional): Markdown report
 *
 * Env (provided by the workflow):
 *   PROD_SUPABASE_URL            (required)
 *   PROD_SUPABASE_SERVICE_ROLE   (required)
 *   REPORT_MARKDOWN_PATH         (optional)
 */

import { promises as fs } from 'fs';

const PROD_SUPABASE_URL = process.env.PROD_SUPABASE_URL;
const PROD_SUPABASE_KEY = process.env.PROD_SUPABASE_SERVICE_ROLE;
const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

/**
 * Canonical context source definitions. The brain's context pack is
 * assembled by querying a subset of these sources, scored by role
 * policy. This inventory is the authoritative list that downstream
 * code (context-quality-score, role-aware context pack, recommendation
 * trace) reads from.
 *
 * Each entry maps to a real prod table; queries here are SELECT-COUNT
 * only with a small time-window filter. If a table doesn't exist
 * in prod (introspection mismatch), the query is skipped cleanly and
 * the inventory row reports `available: false` with the reason.
 */
interface ContextSourceSpec {
  id: string;
  label: string;
  category:
    | 'engagement'           // ORB turns, sessions
    | 'memory'               // facts, diary, notes
    | 'health_signal'        // labs, wearables, vitals
    | 'graph'                // relationship, community, partners
    | 'commerce'             // marketplace, orders
    | 'index_outcome';       // vitana index + recommendation outcomes
  table_name: string;
  freshness_window_hours: number;  // "recent" cutoff for daily reporting
  consent_required: boolean;       // gated by data_export_ok? (Track C C1 gate)
  user_scoped: boolean;            // has a per-user id column?
  notes: string;
}

const SOURCES: ContextSourceSpec[] = [
  {
    id: 'orb_turns',
    label: 'ORB voice turns',
    category: 'engagement',
    table_name: 'oasis_events',
    freshness_window_hours: 24,
    consent_required: true,
    user_scoped: true,
    notes: 'topic in (orb.turn.received, orb.turn.responded)',
  },
  {
    id: 'orb_sessions',
    label: 'ORB session summaries',
    category: 'engagement',
    table_name: 'oasis_events',
    freshness_window_hours: 168,
    consent_required: true,
    user_scoped: true,
    notes: 'topic = orb.session.summary',
  },
  {
    id: 'memory_facts',
    label: 'Memory facts',
    category: 'memory',
    table_name: 'memory_items',
    freshness_window_hours: 168,
    consent_required: true,
    user_scoped: true,
    notes: 'persistent memory store',
  },
  {
    id: 'memory_writes_24h',
    label: 'Memory writes (24h)',
    category: 'memory',
    table_name: 'oasis_events',
    freshness_window_hours: 24,
    consent_required: true,
    user_scoped: true,
    notes: 'topic in (memory.write.user_message, memory.write.assistant_message)',
  },
  {
    id: 'assistant_state',
    label: 'Assistant state (interaction style, concept mastery, etc.)',
    category: 'memory',
    table_name: 'user_assistant_state',
    freshness_window_hours: 720,
    consent_required: false,
    user_scoped: true,
    notes: 'distilled state used by decision-contract spine',
  },
  {
    id: 'autopilot_recs',
    label: 'Autopilot recommendations (user-facing)',
    category: 'index_outcome',
    table_name: 'autopilot_recs',
    freshness_window_hours: 168,
    consent_required: false,
    user_scoped: true,
    notes: 'community-side recommendations queue',
  },
  {
    id: 'vitana_index',
    label: 'Vitana Index values',
    category: 'index_outcome',
    table_name: 'vitana_index_values',
    freshness_window_hours: 720,
    consent_required: false,
    user_scoped: true,
    notes: 'time-series per (user_id, axis)',
  },
  {
    id: 'intent_created',
    label: 'Intent creations (24h)',
    category: 'engagement',
    table_name: 'oasis_events',
    freshness_window_hours: 24,
    consent_required: true,
    user_scoped: true,
    notes: 'topic = autopilot.intent.created',
  },
  {
    id: 'safety_guardrails',
    label: 'Safety guardrail events (excluded from training)',
    category: 'engagement',
    table_name: 'oasis_events',
    freshness_window_hours: 24,
    consent_required: false,
    user_scoped: true,
    notes: 'topic like safety.guardrail.* — filtered OUT of consented exports',
  },
  {
    id: 'tenant_consent',
    label: 'Tenant consent flag (data_export_ok)',
    category: 'memory',
    table_name: 'tenant_settings',
    freshness_window_hours: 24,
    consent_required: false,
    user_scoped: false,
    notes: 'feature_flags->>data_export_ok — gates everything downstream',
  },
];

interface SourceReport {
  id: string;
  label: string;
  category: ContextSourceSpec['category'];
  table_name: string;
  freshness_window_hours: number;
  consent_required: boolean;
  user_scoped: boolean;
  available: boolean;
  row_count_total: number | null;
  row_count_in_window: number | null;
  latest_at: string | null;
  query_filter: string | null;
  error: string | null;
  notes: string;
}

interface ContextSourceInventoryReport {
  generated_at: string;
  source: 'prod_supabase';
  totals: {
    sources_total: number;
    sources_available: number;
    sources_unavailable: number;
    sources_consent_gated: number;
    user_scoped_sources: number;
  };
  sources: SourceReport[];
  notes: string[];
}

function topicFilterFor(spec: ContextSourceSpec): string | null {
  switch (spec.id) {
    case 'orb_turns':
      return 'topic=in.(orb.turn.received,orb.turn.responded)';
    case 'orb_sessions':
      return 'topic=eq.orb.session.summary';
    case 'memory_writes_24h':
      return 'topic=in.(memory.write.user_message,memory.write.assistant_message)';
    case 'intent_created':
      return 'topic=eq.autopilot.intent.created';
    case 'safety_guardrails':
      return 'topic=like.safety.guardrail.*';
    default:
      return null;
  }
}

async function queryOne(spec: ContextSourceSpec): Promise<SourceReport> {
  const base: SourceReport = {
    id: spec.id,
    label: spec.label,
    category: spec.category,
    table_name: spec.table_name,
    freshness_window_hours: spec.freshness_window_hours,
    consent_required: spec.consent_required,
    user_scoped: spec.user_scoped,
    available: false,
    row_count_total: null,
    row_count_in_window: null,
    latest_at: null,
    query_filter: topicFilterFor(spec),
    error: null,
    notes: spec.notes,
  };
  if (!PROD_SUPABASE_URL || !PROD_SUPABASE_KEY) {
    base.error = 'prod creds missing';
    return base;
  }
  const sinceIso = new Date(Date.now() - spec.freshness_window_hours * 3600_000).toISOString();
  const topicFilter = topicFilterFor(spec);

  // 1) latest row's created_at (also confirms table exists)
  const latestUrl = `${PROD_SUPABASE_URL}/rest/v1/${spec.table_name}`
    + (topicFilter ? `?${topicFilter}` : '?')
    + `${topicFilter ? '&' : ''}order=created_at.desc&limit=1&select=created_at`;
  try {
    const latestResp = await fetch(latestUrl, {
      headers: { apikey: PROD_SUPABASE_KEY, Authorization: `Bearer ${PROD_SUPABASE_KEY}` },
    });
    if (!latestResp.ok) {
      base.error = `latest query: HTTP ${latestResp.status}`;
      return base;
    }
    const latest = (await latestResp.json()) as Array<{ created_at?: string }>;
    base.available = true;
    base.latest_at = latest[0]?.created_at ?? null;
  } catch (err) {
    base.error = `latest query threw: ${(err as Error).message}`;
    return base;
  }

  // 2) in-window count (uses count=exact HEAD)
  const countUrl = `${PROD_SUPABASE_URL}/rest/v1/${spec.table_name}`
    + (topicFilter ? `?${topicFilter}` : '?')
    + `${topicFilter ? '&' : ''}created_at=gte.${encodeURIComponent(sinceIso)}&select=created_at&limit=1`;
  try {
    const countResp = await fetch(countUrl, {
      method: 'HEAD',
      headers: {
        apikey: PROD_SUPABASE_KEY,
        Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    if (countResp.ok) {
      const cr = countResp.headers.get('content-range') ?? '';
      const m = cr.match(/\/(\d+)$/);
      if (m) base.row_count_in_window = Number(m[1]);
    }
  } catch {
    // best-effort; null is fine
  }

  // 3) total row count (also HEAD count=exact)
  const totalUrl = `${PROD_SUPABASE_URL}/rest/v1/${spec.table_name}`
    + (topicFilter ? `?${topicFilter}` : '?')
    + `${topicFilter ? '&' : ''}select=created_at&limit=1`;
  try {
    const totalResp = await fetch(totalUrl, {
      method: 'HEAD',
      headers: {
        apikey: PROD_SUPABASE_KEY,
        Authorization: `Bearer ${PROD_SUPABASE_KEY}`,
        Prefer: 'count=exact',
      },
    });
    if (totalResp.ok) {
      const cr = totalResp.headers.get('content-range') ?? '';
      const m = cr.match(/\/(\d+)$/);
      if (m) base.row_count_total = Number(m[1]);
    }
  } catch {
    // best-effort
  }
  return base;
}

async function generate(): Promise<ContextSourceInventoryReport> {
  const sources = await Promise.all(SOURCES.map(queryOne));
  const totals = {
    sources_total: sources.length,
    sources_available: sources.filter((s) => s.available).length,
    sources_unavailable: sources.filter((s) => !s.available).length,
    sources_consent_gated: sources.filter((s) => s.consent_required).length,
    user_scoped_sources: sources.filter((s) => s.user_scoped).length,
  };
  const notes: string[] = [];
  if (totals.sources_unavailable > 0) {
    notes.push(
      `${totals.sources_unavailable} source(s) unavailable: ` +
      sources.filter((s) => !s.available).map((s) => `${s.id} (${s.error ?? 'no error msg'})`).join('; '),
    );
  }
  notes.push(
    'Consent-gated sources are filtered downstream by data_export_ok. ' +
    'Until selected prod tenants opt in, those sources contribute zero to the consented dataset pipeline (Track C C1 fail-closed gate).',
  );
  return {
    generated_at: new Date().toISOString(),
    source: 'prod_supabase',
    totals,
    sources,
    notes,
  };
}

function fmtCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString();
}

function renderMarkdown(report: ContextSourceInventoryReport): string {
  const lines: string[] = [];
  lines.push('# Context source inventory');
  lines.push('');
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- Sources: ${report.totals.sources_available}/${report.totals.sources_total} available; ${report.totals.sources_consent_gated} consent-gated`);
  lines.push(`- User-scoped sources: ${report.totals.user_scoped_sources}`);
  lines.push('');
  lines.push('## Sources by category');
  lines.push('');
  const byCat = new Map<string, SourceReport[]>();
  for (const s of report.sources) {
    const arr = byCat.get(s.category) ?? [];
    arr.push(s);
    byCat.set(s.category, arr);
  }
  for (const [cat, items] of byCat.entries()) {
    lines.push(`### ${cat}`);
    lines.push('');
    lines.push('| id | label | available | total | in window | latest_at | consent | notes |');
    lines.push('| --- | --- | :---: | ---: | ---: | --- | :---: | --- |');
    for (const s of items) {
      lines.push(
        `| \`${s.id}\` | ${s.label} | ${s.available ? 'yes' : 'no'} | ${fmtCount(s.row_count_total)} | ${fmtCount(s.row_count_in_window)} | ${s.latest_at ?? '—'} | ${s.consent_required ? 'yes' : 'no'} | ${s.notes} |`,
      );
    }
    lines.push('');
  }
  lines.push('## Notes');
  lines.push('');
  for (const n of report.notes) lines.push(`- ${n}`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const report = await generate();
  console.log(JSON.stringify(report, null, 2));
  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(report), 'utf-8');
    console.error(`[context-source-inventory] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[context-source-inventory] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown, SOURCES };
export type { ContextSourceInventoryReport, ContextSourceSpec, SourceReport };
