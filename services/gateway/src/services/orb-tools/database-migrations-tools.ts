/**
 * Developer voice tools — Database & Migrations (Wave 6, plan section C11,
 * final wave of docs/VOICE_TOOLS_EXPANSION_PLAN.md).
 *
 * All four tools dispatch real GitHub Actions workflows / a real gateway
 * route — no new backend behaviour:
 *   - dev_run_staging_migration → RUN-STAGING-MIGRATION.yml (workflow_dispatch)
 *   - dev_run_prod_migration    → RUN-MIGRATION.yml (workflow_dispatch, prod DB)
 *   - dev_migration_status      → githubService.getWorkflowRuns() on either file
 *   - dev_run_backfill          → JOURNEY-TRANSLATIONS-BACKFILL.yml, or
 *                                 POST /api/v1/admin/embeddings/backfill
 *
 * dev_list_pending_migrations and dev_schema_info are SKIPPED: there is no
 * runtime-accessible "list applied vs pending migrations" or "describe schema"
 * mechanism in the deployed gateway container — migrations are plain .sql
 * files applied ad hoc via the workflows above, with no migration-tracking
 * table read back anywhere. Both stay `status: planned`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrbToolArgs, OrbToolIdentity, OrbToolResult } from '../orb-tools-shared';
import { developerGate, clampLimit, relAge, gatewayApiCall } from './developer-tools';
import { adminGate, authHeaders } from './admin-users-rbac-tools';
import githubService from '../github-service';

type Handler = (
  args: OrbToolArgs,
  id: OrbToolIdentity,
  sb: SupabaseClient,
) => Promise<OrbToolResult>;

const DEFAULT_REPO = 'exafyltd/vitana-platform';

function repoArg(args: OrbToolArgs): string {
  return String(args.repo ?? DEFAULT_REPO);
}

function requireExafyAdmin(id: OrbToolIdentity): OrbToolResult | null {
  const denied = adminGate(id);
  if (denied) return denied;
  if (String(id.role ?? '').toLowerCase() !== 'exafy_admin') {
    return { ok: false, error: 'This tool requires an exafy_admin session (operator-only).' };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. dev_run_staging_migration — RUN-STAGING-MIGRATION.yml (workflow_dispatch)
// ---------------------------------------------------------------------------

export const dev_run_staging_migration: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const migrationFile = String(args.migration_file ?? '').trim();
  if (!migrationFile.startsWith('supabase/migrations/') || !migrationFile.endsWith('.sql')) {
    return { ok: false, error: 'dev_run_staging_migration requires migration_file matching supabase/migrations/*.sql.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, migration_file: migrationFile, target: 'staging' },
      text: `About to apply ${migrationFile} to STAGING (project rsdakjqpvcpgomltdmxu). Confirm, then call again with confirm=true.`,
    };
  }
  try {
    await githubService.triggerWorkflow(repoArg(args), 'RUN-STAGING-MIGRATION.yml', String(args.ref ?? 'main'), {
      migration_file: migrationFile,
      confirm: 'I-mean-staging',
    });
    return { ok: true, result: { triggered: true, migration_file: migrationFile }, text: `Dispatched the staging migration run for ${migrationFile}.` };
  } catch (err) {
    return { ok: false, error: `dev_run_staging_migration failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 2. dev_run_prod_migration — RUN-MIGRATION.yml (workflow_dispatch, prod DB)
// ---------------------------------------------------------------------------

export const dev_run_prod_migration: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const migrationFile = String(args.migration_file ?? '').trim();
  const reason = String(args.reason ?? '').trim();
  if (!migrationFile.startsWith('supabase/migrations/') || !migrationFile.endsWith('.sql')) {
    return { ok: false, error: 'dev_run_prod_migration requires migration_file matching supabase/migrations/*.sql.' };
  }
  if (!reason) {
    return { ok: false, error: 'dev_run_prod_migration requires a reason — this runs against the PRODUCTION database directly, with no staging step. State why this is justified as a prod migration.' };
  }
  if (args.confirm !== true) {
    return {
      ok: true,
      result: { requires_confirmation: true, migration_file: migrationFile, reason, target: 'production' },
      text: `About to apply ${migrationFile} DIRECTLY TO PRODUCTION, reason: "${reason}". This has no built-in staging guard — confirm only if you mean it, then call again with confirm=true.`,
    };
  }
  try {
    await githubService.triggerWorkflow(repoArg(args), 'RUN-MIGRATION.yml', String(args.ref ?? 'main'), {
      migration_file: migrationFile,
    });
    return { ok: true, result: { triggered: true, migration_file: migrationFile, reason }, text: `Dispatched the PRODUCTION migration run for ${migrationFile}.` };
  } catch (err) {
    return { ok: false, error: `dev_run_prod_migration failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 3. dev_migration_status — githubService.getWorkflowRuns() for either file
// ---------------------------------------------------------------------------

export const dev_migration_status: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const target = String(args.target ?? 'staging').toLowerCase();
  const workflowId = target === 'production' || target === 'prod' ? 'RUN-MIGRATION.yml' : 'RUN-STAGING-MIGRATION.yml';
  try {
    const { workflow_runs } = await githubService.getWorkflowRuns(repoArg(args), workflowId);
    const limit = clampLimit(args.limit, 5, 20);
    const runs = workflow_runs.slice(0, limit);
    if (runs.length === 0) return { ok: true, result: { runs: [] }, text: `No ${workflowId} runs found.` };
    const lines = runs.map((r) => `run ${r.id} — ${r.conclusion ?? r.status} (${relAge(r.created_at)})`);
    return { ok: true, result: { runs, target: workflowId === 'RUN-MIGRATION.yml' ? 'production' : 'staging' }, text: `Recent ${workflowId === 'RUN-MIGRATION.yml' ? 'production' : 'staging'} migration runs: ${lines.join('. ')}` };
  } catch (err) {
    return { ok: false, error: `dev_migration_status failed: ${String((err as Error)?.message || err)}` };
  }
};

// ---------------------------------------------------------------------------
// 4. dev_run_backfill — JOURNEY-TRANSLATIONS-BACKFILL.yml or embeddings backfill
// ---------------------------------------------------------------------------

export const dev_run_backfill: Handler = async (args, id) => {
  const denied = developerGate(id);
  if (denied) return denied;
  const name = String(args.name ?? '').trim().toLowerCase();

  if (name === 'journey_translations') {
    if (args.confirm !== true) {
      return {
        ok: true,
        result: { requires_confirmation: true, name, locales: args.locales ?? 'en,es,sr' },
        text: `About to run the Journey Translations backfill (locales: ${String(args.locales ?? 'en,es,sr')}). Confirm, then call again with confirm=true.`,
      };
    }
    try {
      await githubService.triggerWorkflow(repoArg(args), 'JOURNEY-TRANSLATIONS-BACKFILL.yml', String(args.ref ?? 'main'), {
        locales: String(args.locales ?? 'en,es,sr'),
        curriculum: String(args.curriculum ?? 'v2'),
        limit: args.limit !== undefined ? String(args.limit) : '',
        dry_run: args.dry_run === true ? 'true' : 'false',
      });
      return { ok: true, result: { triggered: true, name }, text: 'Dispatched the Journey Translations backfill.' };
    } catch (err) {
      return { ok: false, error: `dev_run_backfill (journey_translations) failed: ${String((err as Error)?.message || err)}` };
    }
  }

  if (name === 'embeddings') {
    // The real route (routes/admin-embeddings-backfill.ts) is gated
    // requireAuth + requireExafyAdmin at the Express layer — mirror that
    // gate here rather than the plain developerGate above.
    const exafyDenied = requireExafyAdmin(id);
    if (exafyDenied) return exafyDenied;
    if (!id.user_jwt) return { ok: true, result: { reason: 'no_admin_session' }, text: "This needs a signed-in admin session — I don't have one for this voice session." };
    const batchSize = clampLimit(args.batch_size, 50, 200);
    const dryRun = args.dry_run === true;
    if (!dryRun && args.confirm !== true) {
      return {
        ok: true,
        result: { requires_confirmation: true, name, batch_size: batchSize },
        text: `About to backfill embeddings for up to ${batchSize} memory items. Confirm, then call again with confirm=true (or pass dry_run=true to preview).`,
      };
    }
    const { ok, status, body } = await gatewayApiCall('/api/v1/admin/embeddings/backfill', {
      method: 'POST',
      headers: authHeaders(id),
      body: { batch_size: batchSize, dry_run: dryRun },
    });
    if (!ok) return { ok: true, result: { ran: false, status, detail: body }, text: `Embeddings backfill failed: ${String(body.error ?? `gateway returned ${status}`)}.` };
    if (dryRun) return { ok: true, result: body, text: `Dry run: would process ${Number(body.would_process ?? 0)} items.` };
    return { ok: true, result: body, text: `Backfilled ${Number(body.processed_count ?? 0)} items, ${Number(body.errors_count ?? 0)} errors.` };
  }

  return { ok: false, error: 'dev_run_backfill requires name to be one of: journey_translations, embeddings.' };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const DATABASE_MIGRATIONS_TOOL_HANDLERS: Record<string, Handler> = {
  dev_run_staging_migration,
  dev_run_prod_migration,
  dev_migration_status,
  dev_run_backfill,
};

export const DATABASE_MIGRATIONS_TOOL_DECLARATIONS: Array<Record<string, unknown>> = [
  {
    name: 'dev_run_staging_migration',
    description: 'DEVELOPER ONLY. Apply a SQL migration file to STAGING via RUN-STAGING-MIGRATION.yml. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        migration_file: { type: 'string', description: 'Path under supabase/migrations/, e.g. supabase/migrations/20260601_foo.sql. Required.' },
        ref: { type: 'string', description: 'Branch/ref. Default main.' },
        repo: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['migration_file'],
    },
  },
  {
    name: 'dev_run_prod_migration',
    description: 'DEVELOPER ONLY. Apply a SQL migration file DIRECTLY TO PRODUCTION via RUN-MIGRATION.yml — no staging step. Requires a stated reason. TWO-STEP confirm.',
    parameters: {
      type: 'object',
      properties: {
        migration_file: { type: 'string', description: 'Path under supabase/migrations/. Required.' },
        reason: { type: 'string', description: 'Why this must run against prod directly. Required.' },
        ref: { type: 'string', description: 'Branch/ref. Default main.' },
        repo: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['migration_file', 'reason'],
    },
  },
  {
    name: 'dev_migration_status',
    description: 'DEVELOPER ONLY. Recent staging or production migration workflow runs.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', description: '"staging" (default) or "production".' },
        limit: { type: 'integer' },
        repo: { type: 'string' },
      },
    },
  },
  {
    name: 'dev_run_backfill',
    description: 'DEVELOPER ONLY (embeddings additionally requires exafy_admin). Run a named backfill job: "journey_translations" or "embeddings". TWO-STEP confirm (embeddings skips confirm when dry_run=true).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'One of: journey_translations, embeddings. Required.' },
        locales: { type: 'string', description: 'journey_translations only. Default en,es,sr.' },
        curriculum: { type: 'string', description: 'journey_translations only. Default v2.' },
        limit: { type: 'integer', description: 'journey_translations only.' },
        batch_size: { type: 'number', description: 'embeddings only. 1-200, default 50.' },
        dry_run: { type: 'boolean' },
        ref: { type: 'string' },
        repo: { type: 'string' },
        confirm: { type: 'boolean', description: 'Set true only after explicit confirmation.' },
      },
      required: ['name'],
    },
  },
];
