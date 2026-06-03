/**
 * Phase evidence digest — BOOTSTRAP-EVIDENCE-ARTIFACTS.
 *
 * Rolls the four standing Phase 1 evidence sources into ONE dated digest
 * artifact for the operator's daily rhythm:
 *
 *   1. Phase gate status      (eval/phase-gate-status-report.ts → generate())
 *   2. Shadow comparison      (eval/shadow-comparison-report.ts → fetchReport())
 *   3. Canary readiness       (eval/canary-readiness-report.ts → generate())
 *   4. Dataset preview counts (datasets/*.ts extractors in DATASET_PREVIEW mode)
 *
 * The first three are reused as-is via their exported generators, so the
 * digest never duplicates their logic — it only aggregates. The dataset
 * preview reuses each target's projection predicate through the extractors'
 * own preview path.
 *
 * READ-ONLY. Calls the same read-only endpoints/queries the underlying
 * reports already use. Emits NO oasis_events, writes NO GCS/JSONL, flips
 * NO state. Each sub-report is wrapped so a missing creds/token or a network
 * blip degrades that one section to "unavailable" instead of failing the
 * whole digest — the digest is meant to run unattended every day.
 *
 * Output:
 *   stdout: JSON (one digest object)
 *   $DIGEST_MARKDOWN_PATH (env, optional): Markdown digest file
 *   $DIGEST_JSON_PATH     (env, optional): JSON digest file
 *
 * Env (all optional — each maps to the underlying report's own env):
 *   STAGING_GATEWAY_URL, PROD_GATEWAY_URL, GATEWAY_SERVICE_TOKEN,
 *   PROD_SUPABASE_URL, PROD_SUPABASE_SERVICE_ROLE, VERTEX_IAM_CHECK_RESULT,
 *   AWS_BUCKET, AWS_ROLE_ARN, AWS_SMOKE_RESULT, FINETUNE_STATUS,
 *   FEATURE_TARGET, WINDOW_HOURS
 *   DATASET_PREVIEW_ENABLED=1 → run the dataset preview section (default off;
 *     it queries prod Supabase, so the workflow only enables it when creds
 *     resolve).
 */

import { promises as fs } from 'fs';
import {
  generate as generatePhaseGate,
  type PhaseGateReport,
} from './phase-gate-status-report';
import {
  generate as generateCanary,
  type CanaryReadinessReport,
} from './canary-readiness-report';
import { fetchReport as fetchShadowReport } from './shadow-comparison-report';

const DIGEST_MARKDOWN_PATH = process.env.DIGEST_MARKDOWN_PATH;
const DIGEST_JSON_PATH = process.env.DIGEST_JSON_PATH;
const DATASET_PREVIEW_ENABLED = process.env.DATASET_PREVIEW_ENABLED === '1';

/** Shadow report shape (mirrors shadow-comparison-report's ReportResponse). */
interface ShadowReportShape {
  ok: boolean;
  env?: string;
  window_hours?: number;
  total_events: number;
  insufficient_data?: boolean;
  message?: string;
  features: Array<{
    feature: string;
    total_comparisons: number;
    agreement_rate: number | null;
    candidate_p95_ms: number;
    candidate_error_rate: number;
  }>;
}

/** Dataset preview shape (mirrors datasets/types.ts DatasetExtractionPreview). */
interface DatasetPreviewShape {
  target: string;
  preview: true;
  rows_total: number;
  rows_projected: number;
  rows_after_dedup: number;
}

type SectionStatus = 'ok' | 'unavailable';

interface Section<T> {
  status: SectionStatus;
  /** Present when status === 'unavailable'. */
  error?: string;
  /** Present when status === 'ok'. */
  data?: T;
}

interface DatasetPreviewSummary {
  total_rows_after_dedup: number;
  per_target: Array<{
    target: string;
    rows_total: number;
    rows_projected: number;
    rows_after_dedup: number;
  }>;
}

interface PhaseEvidenceDigest {
  generated_at: string;
  /** One-line operator headline derived from the sub-reports. */
  headline: string;
  sections: {
    phase_gate: Section<PhaseGateReport>;
    shadow_comparison: Section<ShadowReportShape>;
    canary_readiness: Section<CanaryReadinessReport>;
    dataset_preview: Section<DatasetPreviewSummary>;
  };
}

/** Run a sub-report generator, degrading any throw to an `unavailable` section. */
async function section<T>(fn: () => Promise<T>): Promise<Section<T>> {
  try {
    return { status: 'ok', data: await fn() };
  } catch (err) {
    return { status: 'unavailable', error: (err as Error).message };
  }
}

/**
 * Read-only dataset preview across the three targets. Reuses each extractor's
 * own preview path by importing them with DATASET_PREVIEW set, so the
 * projection logic is never duplicated here. Imported dynamically because the
 * extractors read process.env at module load — we must set the flag first.
 */
async function previewDatasets(): Promise<DatasetPreviewSummary> {
  process.env.DATASET_PREVIEW = '1';
  const [{ extract: voice }, { extract: intent }, { extract: pillar }] = await Promise.all([
    import('../datasets/voice-tool-routing'),
    import('../datasets/intent-kind'),
    import('../datasets/pillar-classification'),
  ]);
  const targets: Array<[string, () => Promise<unknown>]> = [
    ['voice-tool-routing', voice],
    ['intent-kind', intent],
    ['pillar-classification', pillar],
  ];
  const per_target: DatasetPreviewSummary['per_target'] = [];
  let total = 0;
  for (const [name, fn] of targets) {
    const p = (await fn()) as DatasetPreviewShape;
    const after = p.rows_after_dedup ?? 0;
    total += after;
    per_target.push({
      target: name,
      rows_total: p.rows_total ?? 0,
      rows_projected: p.rows_projected ?? 0,
      rows_after_dedup: after,
    });
  }
  return { total_rows_after_dedup: total, per_target };
}

function buildHeadline(d: PhaseEvidenceDigest['sections']): string {
  const parts: string[] = [];

  if (d.phase_gate.status === 'ok' && d.phase_gate.data) {
    const o = d.phase_gate.data.overall;
    parts.push(
      `gates ${o.gates_open}/${o.gates_total} open`
      + (o.first_blocker ? `, first blocker: ${o.first_blocker}` : ', no blockers'),
    );
  } else {
    parts.push('gates unavailable');
  }

  if (d.canary_readiness.status === 'ok' && d.canary_readiness.data) {
    parts.push(`canary: ${d.canary_readiness.data.verdict}`);
  } else {
    parts.push('canary unavailable');
  }

  if (d.shadow_comparison.status === 'ok' && d.shadow_comparison.data) {
    parts.push(`shadow events 24h: ${d.shadow_comparison.data.total_events}`);
  } else {
    parts.push('shadow unavailable');
  }

  if (d.dataset_preview.status === 'ok' && d.dataset_preview.data) {
    parts.push(`dataset preview rows: ${d.dataset_preview.data.total_rows_after_dedup}`);
  } else if (DATASET_PREVIEW_ENABLED) {
    parts.push('dataset preview unavailable');
  } else {
    parts.push('dataset preview skipped');
  }

  return parts.join(' | ');
}

async function generate(): Promise<PhaseEvidenceDigest> {
  const [phase_gate, shadow_comparison, canary_readiness] = await Promise.all([
    section<PhaseGateReport>(() => generatePhaseGate()),
    section<ShadowReportShape>(async () => (await fetchShadowReport()) as unknown as ShadowReportShape),
    section<CanaryReadinessReport>(() => generateCanary()),
  ]);

  const dataset_preview: Section<DatasetPreviewSummary> = DATASET_PREVIEW_ENABLED
    ? await section<DatasetPreviewSummary>(previewDatasets)
    : { status: 'unavailable', error: 'dataset preview not enabled (DATASET_PREVIEW_ENABLED!=1)' };

  const sections = { phase_gate, shadow_comparison, canary_readiness, dataset_preview };
  return {
    generated_at: new Date().toISOString(),
    headline: buildHeadline(sections),
    sections,
  };
}

function fmtSectionHeader(name: string, s: Section<unknown>): string {
  return `### ${name} — ${s.status === 'ok' ? 'OK' : 'UNAVAILABLE'}`;
}

function renderMarkdown(d: PhaseEvidenceDigest): string {
  const L: string[] = [];
  const date = d.generated_at.slice(0, 10);
  L.push(`# Phase evidence digest — ${date}`);
  L.push('');
  L.push(`- Generated: ${d.generated_at}`);
  L.push(`- Headline: **${d.headline}**`);
  L.push('');
  L.push('> Read-only roll-up of the four standing Phase 1 evidence sources.');
  L.push('> Emits no events, writes no datasets, flips no state.');
  L.push('');

  // 1. Phase gate
  L.push(fmtSectionHeader('Phase gate status', d.sections.phase_gate));
  L.push('');
  const pg = d.sections.phase_gate;
  if (pg.status === 'ok' && pg.data) {
    const o = pg.data.overall;
    L.push(`- Gates: ${o.gates_open} open / ${o.gates_blocked} blocked / ${o.gates_unknown} unknown`);
    L.push(`- Ready for W3-B..G wave: **${o.ready_for_w3_b_to_g ? 'YES' : 'NO'}**`);
    if (o.first_blocker) L.push(`- First blocker: **${o.first_blocker}**`);
    if (o.blocked_by_priority.length) {
      L.push(`- Blocked (priority order): ${o.blocked_by_priority.join(' → ')}`);
    }
    L.push('');
    L.push('| Gate | Status | Detail |');
    L.push('| --- | --- | --- |');
    for (const g of pg.data.gates) {
      L.push(`| ${g.name} | ${g.status.toUpperCase()} | ${g.detail.replace(/\|/g, '\\|')} |`);
    }
  } else {
    L.push(`Unavailable: ${pg.error ?? 'unknown error'}`);
  }
  L.push('');

  // 2. Shadow comparison
  L.push(fmtSectionHeader('Shadow comparison', d.sections.shadow_comparison));
  L.push('');
  const sh = d.sections.shadow_comparison;
  if (sh.status === 'ok' && sh.data) {
    L.push(`- Total comparisons (window): ${sh.data.total_events}`);
    if (sh.data.insufficient_data) {
      L.push('- **Insufficient shadow data** — expected until staging voice traffic accumulates.');
    } else if (sh.data.features.length) {
      L.push('');
      L.push('| Feature | n | Agreement | Candidate p95 | Err rate |');
      L.push('| --- | ---: | ---: | ---: | ---: |');
      for (const f of sh.data.features) {
        const ag = f.agreement_rate === null ? '—' : `${(f.agreement_rate * 100).toFixed(1)}%`;
        L.push(`| \`${f.feature}\` | ${f.total_comparisons} | ${ag} | ${f.candidate_p95_ms.toFixed(0)}ms | ${(f.candidate_error_rate * 100).toFixed(1)}% |`);
      }
    }
  } else {
    L.push(`Unavailable: ${sh.error ?? 'unknown error'}`);
  }
  L.push('');

  // 3. Canary readiness
  L.push(fmtSectionHeader('Canary readiness', d.sections.canary_readiness));
  L.push('');
  const cr = d.sections.canary_readiness;
  if (cr.status === 'ok' && cr.data) {
    L.push(`- Target: ${cr.data.target}`);
    L.push(`- Verdict: **${cr.data.verdict}**`);
    L.push(`- Next: ${cr.data.next_recommended_action}`);
    L.push('');
    for (const r of cr.data.reasons) {
      L.push(`- **[${r.ok ? 'PASS' : 'FAIL'}] ${r.rule}** — ${r.detail}`);
    }
  } else {
    L.push(`Unavailable: ${cr.error ?? 'unknown error'}`);
  }
  L.push('');

  // 4. Dataset preview
  L.push(fmtSectionHeader('Dataset preview counts', d.sections.dataset_preview));
  L.push('');
  const dp = d.sections.dataset_preview;
  if (dp.status === 'ok' && dp.data) {
    L.push(`- Total rows that WOULD extract (post-dedup): **${dp.data.total_rows_after_dedup}**`);
    L.push('');
    L.push('| Target | rows_total | rows_projected | rows_after_dedup |');
    L.push('| --- | ---: | ---: | ---: |');
    for (const t of dp.data.per_target) {
      L.push(`| ${t.target} | ${t.rows_total} | ${t.rows_projected} | ${t.rows_after_dedup} |`);
    }
  } else {
    L.push(`Unavailable: ${dp.error ?? 'unknown error'}`);
  }
  L.push('');

  return L.join('\n') + '\n';
}

async function main(): Promise<void> {
  const digest = await generate();
  const json = JSON.stringify(digest, null, 2);
  console.log(json);
  if (DIGEST_JSON_PATH) {
    await fs.writeFile(DIGEST_JSON_PATH, json + '\n', 'utf-8');
    console.error(`[phase-evidence-digest] json written: ${DIGEST_JSON_PATH}`);
  }
  if (DIGEST_MARKDOWN_PATH) {
    await fs.writeFile(DIGEST_MARKDOWN_PATH, renderMarkdown(digest), 'utf-8');
    console.error(`[phase-evidence-digest] markdown written: ${DIGEST_MARKDOWN_PATH}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[phase-evidence-digest] FAILED:', err);
    process.exit(1);
  });
}

export { generate, renderMarkdown };
export type { PhaseEvidenceDigest };
