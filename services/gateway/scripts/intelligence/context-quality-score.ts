/**
 * Context quality score — Phase 1 W3-D1 PR 2 (VTID-03246).
 *
 * Read-only. Consumes the context source inventory (PR 1) and assigns
 * a transparent 0..1 score per source on four dimensions:
 *   - freshness  (is the latest row inside the freshness window?)
 *   - trust      (is the source available + free of fetch errors?)
 *   - coverage   (does the in-window row count clear a minimum bar?)
 *   - consent    (are consent-gated sources unblocked by tenant_consent?)
 * plus a `conflict` dimension reserved for a future cross-source
 * contradiction check (v1 = always 1.0; documented in the report).
 *
 * Each source gets an overall = weighted blend of the four dimensions;
 * the report's `context_quality_score` is the mean of the overalls
 * across applicable (`available || consent-blocked`) sources, scaled
 * to 0..100 for cockpit readability.
 *
 * No production behavior change. No mutation. Pure functions are
 * exported so PR 5 (Command Hub cockpit spine) can render the same
 * scores without re-fetching prod.
 *
 * Output:
 *   stdout: JSON (ContextQualityReport)
 *   $REPORT_MARKDOWN_PATH (optional): Markdown rendering
 *
 * Env (provided by the workflow):
 *   PROD_SUPABASE_URL            (required — passed through to inventory)
 *   PROD_SUPABASE_SERVICE_ROLE   (required — passed through to inventory)
 *   REPORT_MARKDOWN_PATH         (optional)
 */

import { promises as fs } from 'fs';
import { generate as generateInventory } from './context-source-inventory';
import type {
  ContextSourceInventoryReport,
  SourceReport,
} from './context-source-inventory';

const REPORT_MARKDOWN_PATH = process.env.REPORT_MARKDOWN_PATH;

// ── Scoring weights ────────────────────────────────────────────────
// Tuned for transparency, not optimisation. Sum to 1.0. Conflict is
// reserved (placeholder = 1.0 in v1) and intentionally excluded from
// the weighted blend so adding it later doesn't move historical
// numbers. When the cross-source conflict check ships, redistribute
// these weights in the same PR that introduces it.
const WEIGHTS = {
  freshness: 0.3,
  trust: 0.2,
  coverage: 0.3,
  consent: 0.2,
} as const;

interface DimensionScores {
  freshness: number;   // 0..1
  trust: number;       // 0..1
  coverage: number;    // 0..1
  consent: number;     // 0..1
  conflict: number;    // 0..1 — reserved; v1 always 1.0
}

interface SourceQualityScore {
  id: string;
  label: string;
  category: SourceReport['category'];
  applicable: boolean;        // false ⇒ excluded from overall blend
  applicable_reason: string | null;
  overall: number;            // 0..1
  scores: DimensionScores;
  inputs: {
    available: boolean;
    latest_at: string | null;
    row_count_in_window: number | null;
    consent_required: boolean;
    tenant_consent_satisfied: boolean;
    error: string | null;
  };
}

interface ContextQualityReport {
  generated_at: string;
  context_quality_score: number;  // 0..100, cockpit-friendly
  per_source: SourceQualityScore[];
  totals: {
    sources_scored: number;
    sources_applicable: number;
    sources_with_full_signal: number;       // overall >= 0.8
    sources_with_partial_signal: number;    // 0.4..0.8
    sources_failing: number;                // < 0.4
    tenant_consent_satisfied: boolean;
  };
  notes: string[];
  inventory_generated_at: string;
}

// ── Pure dimension scorers ─────────────────────────────────────────

export function scoreFreshness(
  latestAt: string | null,
  windowHours: number,
  nowMs: number,
): number {
  if (!latestAt) return 0;
  const ts = Date.parse(latestAt);
  if (!Number.isFinite(ts)) return 0;
  const ageHours = (nowMs - ts) / 3600_000;
  if (ageHours <= 0) return 1;
  if (ageHours <= windowHours) return 1;
  if (ageHours >= windowHours * 2) return 0;
  // Linear decay from 1.0 at windowHours to 0.0 at 2 × windowHours.
  return Math.max(0, 1 - (ageHours - windowHours) / windowHours);
}

export function scoreTrust(source: SourceReport): number {
  if (!source.available) return 0;
  if (source.error) return 0;
  // Engagement/memory/index_outcome are first-party; graph/commerce
  // partner data is held to a slightly lower trust default in v1
  // because the partner integrations are not yet contract-bound.
  switch (source.category) {
    case 'engagement':
    case 'memory':
    case 'index_outcome':
      return 1.0;
    case 'graph':
    case 'commerce':
      return 0.9;
    case 'health_signal':
      return 1.0;
  }
}

export function scoreCoverage(rowCountInWindow: number | null): number {
  if (rowCountInWindow === null) return 0;
  if (rowCountInWindow <= 0) return 0;
  if (rowCountInWindow < 10) return 0.3;
  if (rowCountInWindow < 100) return 0.6;
  return 1.0;
}

export function scoreConsent(
  consentRequired: boolean,
  tenantConsentSatisfied: boolean,
): number {
  if (!consentRequired) return 1.0;
  return tenantConsentSatisfied ? 1.0 : 0.0;
}

export function blendOverall(s: DimensionScores): number {
  return (
    s.freshness * WEIGHTS.freshness +
    s.trust * WEIGHTS.trust +
    s.coverage * WEIGHTS.coverage +
    s.consent * WEIGHTS.consent
  );
}

// ── Scoring driver ────────────────────────────────────────────────

function tenantConsentSatisfiedFrom(inv: ContextSourceInventoryReport): boolean {
  const row = inv.sources.find((s) => s.id === 'tenant_consent');
  // The inventory reports row_count_total against tenant_settings; the
  // PR 1 query is a structural existence probe (it does NOT filter for
  // data_export_ok=true). v1 treats "tenant_consent row visible" as a
  // weak proxy. PR 5 cockpit will replace this with an explicit
  // consented-tenant count once the gating SQL lands.
  if (!row) return false;
  if (!row.available) return false;
  return (row.row_count_total ?? 0) > 0;
}

export function scoreSource(
  source: SourceReport,
  tenantConsentSatisfied: boolean,
  nowMs: number,
): SourceQualityScore {
  const freshness = scoreFreshness(source.latest_at, source.freshness_window_hours, nowMs);
  const trust = scoreTrust(source);
  const coverage = scoreCoverage(source.row_count_in_window);
  const consent = scoreConsent(source.consent_required, tenantConsentSatisfied);
  const conflict = 1.0; // reserved — see v1 note in WEIGHTS comment

  const scores: DimensionScores = { freshness, trust, coverage, consent, conflict };
  const overall = blendOverall(scores);

  // A source is "applicable" if it ran cleanly OR was consent-blocked
  // (which is a real signal we want to surface, not a fetch failure).
  let applicable = true;
  let applicable_reason: string | null = null;
  if (!source.available && !(source.consent_required && !tenantConsentSatisfied)) {
    applicable = false;
    applicable_reason = source.error ?? 'source unavailable';
  }

  return {
    id: source.id,
    label: source.label,
    category: source.category,
    applicable,
    applicable_reason,
    overall,
    scores,
    inputs: {
      available: source.available,
      latest_at: source.latest_at,
      row_count_in_window: source.row_count_in_window,
      consent_required: source.consent_required,
      tenant_consent_satisfied: tenantConsentSatisfied,
      error: source.error,
    },
  };
}

export function computeContextQualityScore(
  inv: ContextSourceInventoryReport,
  nowMs: number,
): ContextQualityReport {
  const tenantConsentSatisfied = tenantConsentSatisfiedFrom(inv);
  const per_source = inv.sources.map((s) =>
    scoreSource(s, tenantConsentSatisfied, nowMs),
  );

  const applicable = per_source.filter((p) => p.applicable);
  const overall =
    applicable.length === 0
      ? 0
      : applicable.reduce((sum, p) => sum + p.overall, 0) / applicable.length;

  const full = applicable.filter((p) => p.overall >= 0.8).length;
  const partial = applicable.filter((p) => p.overall >= 0.4 && p.overall < 0.8).length;
  const failing = applicable.filter((p) => p.overall < 0.4).length;

  const notes: string[] = [];
  if (!tenantConsentSatisfied) {
    notes.push(
      'Tenant consent (data_export_ok) is NOT satisfied. Consent-gated sources score 0 on the consent dimension; this is the correct fail-closed posture from Track C.',
    );
  }
  if (per_source.some((p) => !p.applicable)) {
    notes.push(
      `${per_source.filter((p) => !p.applicable).length} source(s) excluded from the overall blend (fetch failures, not consent gating).`,
    );
  }
  notes.push(
    'Conflict dimension reserved for v2 (cross-source contradiction detection). v1 reports conflict=1.0 for every source and excludes it from the weighted blend.',
  );

  return {
    generated_at: new Date(nowMs).toISOString(),
    context_quality_score: Math.round(overall * 1000) / 10, // one decimal, 0..100
    per_source,
    totals: {
      sources_scored: per_source.length,
      sources_applicable: applicable.length,
      sources_with_full_signal: full,
      sources_with_partial_signal: partial,
      sources_failing: failing,
      tenant_consent_satisfied: tenantConsentSatisfied,
    },
    notes,
    inventory_generated_at: inv.generated_at,
  };
}

// ── Markdown renderer ─────────────────────────────────────────────

function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function renderMarkdown(report: ContextQualityReport): string {
  const lines: string[] = [];
  lines.push('# Context quality score');
  lines.push('');
  lines.push(`- Generated: ${report.generated_at}`);
  lines.push(`- **Context quality score: ${report.context_quality_score.toFixed(1)} / 100**`);
  lines.push(`- Sources scored: ${report.totals.sources_scored} (applicable: ${report.totals.sources_applicable})`);
  lines.push(
    `- Signal distribution: full=${report.totals.sources_with_full_signal} · partial=${report.totals.sources_with_partial_signal} · failing=${report.totals.sources_failing}`,
  );
  lines.push(`- Tenant consent satisfied: ${report.totals.tenant_consent_satisfied ? 'yes' : 'no'}`);
  lines.push('');
  lines.push('## Per-source scores');
  lines.push('');
  lines.push('| id | label | applicable | overall | fresh | trust | cover | consent |');
  lines.push('| --- | --- | :---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.per_source) {
    lines.push(
      `| \`${s.id}\` | ${s.label} | ${s.applicable ? 'yes' : 'no'} | **${fmtPct(s.overall)}** | ${fmtPct(s.scores.freshness)} | ${fmtPct(s.scores.trust)} | ${fmtPct(s.scores.coverage)} | ${fmtPct(s.scores.consent)} |`,
    );
  }
  lines.push('');
  if (report.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const n of report.notes) lines.push(`- ${n}`);
  }
  return lines.join('\n');
}

// ── Entrypoint ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  const inv = await generateInventory();
  const report = computeContextQualityScore(inv, Date.now());
  console.log(JSON.stringify(report, null, 2));
  if (REPORT_MARKDOWN_PATH) {
    await fs.writeFile(REPORT_MARKDOWN_PATH, renderMarkdown(report), 'utf-8');
    console.error(`[context-quality-score] markdown written: ${REPORT_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[context-quality-score] FAILED:', err);
    process.exit(1);
  });
}

export type {
  ContextQualityReport,
  SourceQualityScore,
  DimensionScores,
};
