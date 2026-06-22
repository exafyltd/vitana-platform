import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  CoverGenError,
  isCurrentAiCoverUrl,
  regenerateExistingAiCover,
} from '../services/intent-cover-service';

export interface AiCoverRow {
  intent_id: string;
  requester_user_id: string;
  category: string | null;
  cover_url: string;
}

export interface AiCoverBackfillSummary {
  scanned: number;
  selected: number;
  replaced: number;
  skipped_current: number;
  failed: number;
  failures: Array<{ intent_id: string; code: string; message: string }>;
}

type ReplaceAiCover = (row: AiCoverRow) => Promise<{ cover_url: string }>;
type LogEvent = (event: Record<string, unknown>) => void;

export function assertBackfillSafety(
  environment: string,
  confirmation: string,
  apply: boolean,
): void {
  if (environment !== 'staging') {
    throw new Error('AI cover backfill may run only from the staging environment');
  }
  if (confirmation !== 'replace-all-ai-covers') {
    throw new Error('AI cover backfill confirmation is missing or invalid');
  }
  if (!apply) {
    throw new Error('AI cover backfill requires the --apply flag');
  }
}

function errorDetails(error: unknown): { code: string; message: string } {
  if (error instanceof CoverGenError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    return { code: 'unknown', message: error.message };
  }
  return { code: 'unknown', message: String(error) };
}

export async function runAiCoverBackfill(
  rows: AiCoverRow[],
  replace: ReplaceAiCover,
  log: LogEvent = () => undefined,
): Promise<AiCoverBackfillSummary> {
  const legacy = rows.filter((row) => !isCurrentAiCoverUrl(row.cover_url));
  const summary: AiCoverBackfillSummary = {
    scanned: rows.length,
    selected: legacy.length,
    replaced: 0,
    skipped_current: rows.length - legacy.length,
    failed: 0,
    failures: [],
  };

  for (const row of legacy) {
    let replacementError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await replace(row);
        summary.replaced += 1;
        log({
          event: 'ai_cover_replaced',
          intent_id: row.intent_id,
          attempt,
          cover_url: result.cover_url,
        });
        replacementError = undefined;
        break;
      } catch (error) {
        replacementError = error;
        const details = errorDetails(error);
        log({
          event: 'ai_cover_replace_attempt_failed',
          intent_id: row.intent_id,
          attempt,
          ...details,
        });
        if (details.code === 'conflict') break;
      }
    }

    if (replacementError !== undefined) {
      const details = errorDetails(replacementError);
      summary.failed += 1;
      summary.failures.push({ intent_id: row.intent_id, ...details });
    }
  }

  return summary;
}

async function loadAiCoverRows(supabase: SupabaseClient): Promise<AiCoverRow[]> {
  const rows: AiCoverRow[] = [];
  const pageSize = 500;

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from('user_intents')
      .select('intent_id, requester_user_id, category, cover_url')
      .eq('cover_source', 'ai_generated')
      .not('cover_url', 'is', null)
      .order('intent_id', { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Failed to list AI covers: ${error.message}`);
    const page = (data ?? []) as AiCoverRow[];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function main(): Promise<void> {
  assertBackfillSafety(
    process.env.VITANA_ENV ?? '',
    process.env.REGENERATE_AI_COVERS_CONFIRM ?? '',
    process.argv.includes('--apply'),
  );

  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!,
  );
  const rows = await loadAiCoverRows(supabase);
  const log: LogEvent = (event) => console.log(JSON.stringify(event));
  const summary = await runAiCoverBackfill(
    rows,
    (row) =>
      regenerateExistingAiCover({
        intentId: row.intent_id,
        userId: row.requester_user_id,
        category: row.category,
        expectedCoverUrl: row.cover_url,
      }),
    log,
  );
  log({ event: 'ai_cover_backfill_summary', ...summary });

  const remainingRows = await loadAiCoverRows(supabase);
  const remainingLegacy = remainingRows.filter(
    (row) => !isCurrentAiCoverUrl(row.cover_url),
  );
  log({
    event: 'ai_cover_backfill_verification',
    ai_generated_total: remainingRows.length,
    legacy_remaining: remainingLegacy.length,
  });

  if (summary.failed > 0 || remainingLegacy.length > 0) {
    throw new Error(
      `AI cover backfill incomplete: ${summary.failed} failed, ${remainingLegacy.length} legacy remaining`,
    );
  }
}

if (require.main === module) {
  void main().catch((error: unknown) => {
    const details = errorDetails(error);
    console.error(JSON.stringify({ event: 'ai_cover_backfill_fatal', ...details }));
    process.exitCode = 1;
  });
}
