/**
 * VTID-02000: Catalog Ingestion API
 *
 * The surface Claude Code (and any other automated scraper or cron) calls to
 * populate the marketplace with merchants + products.
 *
 * Endpoints:
 *   POST /api/v1/catalog/ingest/start     — open a run, returns run_id
 *   POST /api/v1/catalog/ingest/merchants — bulk upsert merchants (<=500/call)
 *   POST /api/v1/catalog/ingest/products  — bulk upsert products (<=500/call)
 *   POST /api/v1/catalog/ingest/finish    — close a run, optionally deactivate stale
 *   POST /api/v1/catalog/ingest/dry-run   — validate payload without writing
 *   GET  /api/v1/catalog/ingest/health    — liveness
 *
 * Auth: Bearer token matching INGEST_API_KEY or SUPABASE_SERVICE_ROLE_KEY env var.
 * Scrapers (Claude Code, cron, marketplace-curator agent) all use INGEST_API_KEY.
 *
 * Design notes:
 *   - Product upsert is idempotent via (source_network, source_product_id).
 *   - content_hash drives drift detection; unchanged rows are skipped cheaply.
 *   - Merchant must exist (this run or a prior run) before products referencing
 *     it via source_merchant_id will insert — otherwise the row is skipped and
 *     counted in skipped_missing_merchant.
 *   - All fields are validated by Zod; unknown/missing required fields are
 *     surfaced per-row in the errors[] array so scrapers can self-correct.
 */

import { Router, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'crypto';
import { getSupabase } from '../lib/supabase';
import { emitOasisEvent } from '../services/oasis-event-service';
import {
  IngestStartRequestSchema,
  MerchantIngestRequestSchema,
  ProductIngestRequestSchema,
  IngestFinishRequestSchema,
  IngestDryRunRequestSchema,
  type ProductIngestRow,
  type ProductIngestError,
  type IngestStartResponse,
  type MerchantIngestResponse,
  type ProductIngestResponse,
  type IngestFinishResponse,
  type IngestDryRunResponse,
} from '../types/catalog-ingest';

const router = Router();

// ==================== Auth middleware ====================

function requireIngestAuth(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      ok: false,
      error: 'Missing Authorization Bearer token',
      code: 'UNAUTHORIZED',
    });
    return;
  }

  const token = authHeader.slice(7);
  const ingestKey = process.env.INGEST_API_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE;

  const candidates = [ingestKey, serviceRoleKey].filter((k): k is string => Boolean(k));
  if (candidates.length === 0) {
    res.status(500).json({
      ok: false,
      error: 'Server misconfigured: no INGEST_API_KEY or SUPABASE_SERVICE_ROLE_KEY set',
      code: 'INTERNAL_ERROR',
    });
    return;
  }

  const tokenBuf = Buffer.from(token);
  const match = candidates.some((candidate) => {
    const candBuf = Buffer.from(candidate);
    if (candBuf.length !== tokenBuf.length) return false;
    return timingSafeEqual(candBuf, tokenBuf);
  });

  if (!match) {
    res.status(401).json({
      ok: false,
      error: 'Invalid Authorization token',
      code: 'UNAUTHORIZED',
    });
    return;
  }
  next();
}

// ==================== Helpers ====================

/**
 * Compute a stable content hash for a product row. Fields in a fixed order so
 * the same logical product always hashes the same.
 */
function computeContentHash(p: ProductIngestRow): string {
  const canonical = {
    title: p.title ?? '',
    description: p.description ?? '',
    brand: p.brand ?? '',
    price_cents: p.price_cents,
    currency: p.currency,
    availability: p.availability,
    origin_country: p.origin_country,
    ships_to_countries: [...(p.ships_to_countries ?? [])].sort(),
    ships_to_regions: [...(p.ships_to_regions ?? [])].sort(),
    affiliate_url: p.affiliate_url,
    health_goals: [...p.health_goals].sort(),
    dietary_tags: [...p.dietary_tags].sort(),
    ingredients_primary: [...p.ingredients_primary].sort(),
    images_count: p.images.length,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ==================== POST /start ====================

router.post('/start', requireIngestAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable', code: 'INTERNAL_ERROR' });
    return;
  }

  const parsed = IngestStartRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { source_network, source_url, triggered_by, notes } = parsed.data;

  const { data, error } = await supabase
    .from('catalog_sources')
    .insert({
      source_network,
      source_url: source_url ?? null,
      triggered_by,
      notes: notes ?? null,
    })
    .select('run_id, started_at')
    .single();

  if (error || !data) {
    console.error('[catalog-ingest/start] insert failed:', error);
    res.status(500).json({ ok: false, error: error?.message ?? 'insert failed', code: 'INTERNAL_ERROR' });
    return;
  }

  await emitOasisEvent({
    vtid: 'VTID-02000',
    type: 'marketplace.ingest.run.started',
    source: 'gateway',
    status: 'info',
    message: `Ingestion run started for ${source_network}`,
    payload: { run_id: data.run_id, source_network, triggered_by },
  }).catch(() => {});

  const response: IngestStartResponse = {
    ok: true,
    run_id: data.run_id,
    started_at: data.started_at,
  };
  res.json(response);
});

// ==================== POST /merchants ====================

router.post('/merchants', requireIngestAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable', code: 'INTERNAL_ERROR' });
    return;
  }

  const parsed = MerchantIngestRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { run_id, source_network, merchants } = parsed.data;

  // Verify run exists and is not yet finished
  const { data: run, error: runErr } = await supabase
    .from('catalog_sources')
    .select('run_id, finished_at')
    .eq('run_id', run_id)
    .maybeSingle();
  if (runErr || !run) {
    res.status(404).json({ ok: false, error: 'run_id not found', code: 'RUN_NOT_FOUND' });
    return;
  }
  if (run.finished_at) {
    res.status(400).json({ ok: false, error: 'Run already finished', code: 'RUN_ALREADY_FINISHED' });
    return;
  }

  const result: MerchantIngestResponse = {
    ok: true,
    run_id,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  // Prepare upsert payload
  const rows = merchants.map((m) => ({
    source_network,
    source_merchant_id: m.source_merchant_id,
    name: m.name,
    slug: m.slug ?? null,
    storefront_url: m.storefront_url ?? null,
    merchant_country: m.merchant_country ?? null,
    ships_to_countries: m.ships_to_countries ?? null,
    ships_to_regions: m.ships_to_regions ?? null,
    currencies: m.currencies,
    avg_delivery_days_eu: m.avg_delivery_days_eu ?? null,
    avg_delivery_days_us: m.avg_delivery_days_us ?? null,
    avg_delivery_days_mena: m.avg_delivery_days_mena ?? null,
    affiliate_network: m.affiliate_network ?? null,
    commission_rate: m.commission_rate ?? null,
    quality_score: m.quality_score ?? 50,
    customs_risk: m.customs_risk ?? null,
    admin_notes: m.admin_notes ?? null,
  }));

  // Identify which rows exist already (so we can split inserted vs updated counts)
  const { data: existing } = await supabase
    .from('merchants')
    .select('source_network, source_merchant_id')
    .eq('source_network', source_network)
    .in(
      'source_merchant_id',
      rows.map((r) => r.source_merchant_id)
    );

  const existingSet = new Set((existing ?? []).map((e) => `${e.source_network}::${e.source_merchant_id}`));

  const { data: upserted, error: upsertErr } = await supabase
    .from('merchants')
    .upsert(rows, { onConflict: 'source_network,source_merchant_id' })
    .select('id, source_merchant_id');

  if (upsertErr) {
    result.ok = false;
    result.errors.push({ source_merchant_id: '(batch)', error: upsertErr.message });
    res.status(500).json(result);
    return;
  }

  for (const u of upserted ?? []) {
    if (existingSet.has(`${source_network}::${u.source_merchant_id}`)) {
      result.updated += 1;
    } else {
      result.inserted += 1;
    }
  }

  res.json(result);
});

// ==================== POST /products ====================

router.post('/products', requireIngestAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable', code: 'INTERNAL_ERROR' });
    return;
  }

  const parsed = ProductIngestRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { run_id, source_network, products } = parsed.data;

  const { data: run, error: runErr } = await supabase
    .from('catalog_sources')
    .select('run_id, finished_at')
    .eq('run_id', run_id)
    .maybeSingle();
  if (runErr || !run) {
    res.status(404).json({ ok: false, error: 'run_id not found', code: 'RUN_NOT_FOUND' });
    return;
  }
  if (run.finished_at) {
    res.status(400).json({ ok: false, error: 'Run already finished', code: 'RUN_ALREADY_FINISHED' });
    return;
  }

  const result: ProductIngestResponse = {
    ok: true,
    run_id,
    inserted: 0,
    updated: 0,
    skipped_unchanged: 0,
    skipped_missing_merchant: 0,
    errors: [],
  };

  // Resolve merchants: source_merchant_id -> merchants.id
  const uniqueMerchantIds = Array.from(new Set(products.map((p) => p.source_merchant_id)));
  const { data: merchantRows } = await supabase
    .from('merchants')
    .select('id, source_merchant_id')
    .eq('source_network', source_network)
    .in('source_merchant_id', uniqueMerchantIds);
  const merchantMap = new Map((merchantRows ?? []).map((r) => [r.source_merchant_id, r.id]));

  // Existing products by (source_network, source_product_id) to detect update vs insert and drift
  const { data: existing } = await supabase
    .from('products')
    .select('id, source_product_id, content_hash')
    .eq('source_network', source_network)
    .in(
      'source_product_id',
      products.map((p) => p.source_product_id)
    );
  const existingMap = new Map((existing ?? []).map((e) => [e.source_product_id, e]));

  const errors: ProductIngestError[] = [];
  const toUpsert: Array<Record<string, unknown>> = [];

  for (const p of products) {
    const merchantId = merchantMap.get(p.source_merchant_id);
    if (!merchantId) {
      result.skipped_missing_merchant += 1;
      errors.push({
        source_product_id: p.source_product_id,
        error: `Merchant not found for source_merchant_id=${p.source_merchant_id}. Ingest merchants first.`,
        field: 'source_merchant_id',
      });
      continue;
    }

    const contentHash = computeContentHash(p);
    const existingRow = existingMap.get(p.source_product_id);
    if (existingRow && existingRow.content_hash === contentHash) {
      result.skipped_unchanged += 1;
      // Still bump last_seen_at so staleness detection works correctly
      toUpsert.push({
        id: existingRow.id,
        source_network,
        source_product_id: p.source_product_id,
        merchant_id: merchantId,
        title: p.title,
        affiliate_url: p.affiliate_url,
        price_cents: p.price_cents,
        currency: p.currency,
        origin_country: p.origin_country,
        last_seen_at: new Date().toISOString(),
        content_hash: contentHash,
      });
      continue;
    }

    const row: Record<string, unknown> = {
      merchant_id: merchantId,
      source_network,
      source_product_id: p.source_product_id,
      gtin: p.gtin ?? null,
      sku: p.sku ?? null,
      asin: p.asin ?? null,
      title: p.title,
      description: p.description ?? null,
      brand: p.brand ?? null,
      category: p.category ?? null,
      subcategory: p.subcategory ?? null,
      topic_keys: p.topic_keys,
      price_cents: p.price_cents,
      currency: p.currency,
      compare_at_price_cents: p.compare_at_price_cents ?? null,
      images: p.images,
      affiliate_url: p.affiliate_url,
      availability: p.availability,
      rating: p.rating ?? null,
      review_count: p.review_count ?? null,
      origin_country: p.origin_country,
      ships_to_countries: p.ships_to_countries ?? null,
      ships_to_regions: p.ships_to_regions ?? null,
      excluded_from_regions: p.excluded_from_regions,
      customs_risk: p.customs_risk ?? null,
      health_goals: p.health_goals,
      dietary_tags: p.dietary_tags,
      form: p.form ?? null,
      certifications: p.certifications,
      ingredients_primary: p.ingredients_primary,
      target_audience: p.target_audience,
      contains_allergens: p.contains_allergens,
      contraindicated_with_conditions: p.contraindicated_with_conditions,
      contraindicated_with_medications: p.contraindicated_with_medications,
      raw: p.raw ?? null,
      content_hash: contentHash,
      last_seen_at: new Date().toISOString(),
      is_active: true,
    };
    toUpsert.push(row);
  }

  if (toUpsert.length > 0) {
    const { data: upserted, error: upsertErr } = await supabase
      .from('products')
      .upsert(toUpsert, { onConflict: 'source_network,source_product_id' })
      .select('source_product_id');

    if (upsertErr) {
      result.ok = false;
      errors.push({ source_product_id: '(batch)', error: upsertErr.message });
    } else {
      for (const u of upserted ?? []) {
        const existingRow = existingMap.get(u.source_product_id);
        if (existingRow) {
          // Unchanged rows are counted in skipped_unchanged, not updated.
          // So anything in existingMap that was not skipped_unchanged is a genuine update.
          // We've already counted skipped_unchanged above, so the remaining existing rows
          // in the upserted set are updates.
          const wasSkipped = result.skipped_unchanged > 0 &&
            toUpsert.find((r) => r.source_product_id === u.source_product_id && r.content_hash === existingRow.content_hash);
          if (!wasSkipped) result.updated += 1;
        } else {
          result.inserted += 1;
        }
      }
    }
  }

  result.errors = errors;

  // Increment run stats
  await supabase
    .from('catalog_sources')
    .update({
      products_inserted: result.inserted,
      products_updated: result.updated,
      products_skipped: result.skipped_unchanged + result.skipped_missing_merchant,
      errors: result.errors.length,
      error_sample: result.errors.slice(0, 10),
    })
    .eq('run_id', run_id);

  res.json(result);
});

// ==================== POST /finish ====================

router.post('/finish', requireIngestAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable', code: 'INTERNAL_ERROR' });
    return;
  }

  const parsed = IngestFinishRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { run_id, deactivate_stale, stale_threshold_days } = parsed.data;

  const { data: run, error: runErr } = await supabase
    .from('catalog_sources')
    .select('run_id, source_network, started_at, finished_at, products_inserted, products_updated, products_skipped, errors')
    .eq('run_id', run_id)
    .maybeSingle();
  if (runErr || !run) {
    res.status(404).json({ ok: false, error: 'run_id not found', code: 'RUN_NOT_FOUND' });
    return;
  }
  if (run.finished_at) {
    res.status(400).json({ ok: false, error: 'Run already finished', code: 'RUN_ALREADY_FINISHED' });
    return;
  }

  let deactivatedStale = 0;
  if (deactivate_stale) {
    const threshold = new Date(Date.now() - stale_threshold_days * 24 * 60 * 60 * 1000).toISOString();
    const { data: deactivated, error: deactErr } = await supabase
      .from('products')
      .update({ is_active: false })
      .eq('source_network', run.source_network)
      .eq('is_active', true)
      .lt('last_seen_at', threshold)
      .select('id');
    if (deactErr) {
      console.error('[catalog-ingest/finish] deactivate stale failed:', deactErr);
    } else {
      deactivatedStale = deactivated?.length ?? 0;
    }
  }

  const finishedAt = new Date().toISOString();
  await supabase
    .from('catalog_sources')
    .update({ finished_at: finishedAt })
    .eq('run_id', run_id);

  await emitOasisEvent({
    vtid: 'VTID-02000',
    type: 'marketplace.ingest.run.finished',
    source: 'gateway',
    status: 'info',
    message: `Ingestion run finished for ${run.source_network}`,
    payload: {
      run_id,
      source_network: run.source_network,
      products_inserted: run.products_inserted,
      products_updated: run.products_updated,
      products_skipped: run.products_skipped,
      errors: run.errors,
      deactivated_stale: deactivatedStale,
    },
  }).catch(() => {});

  const response: IngestFinishResponse = {
    ok: true,
    run_id,
    finished_at: finishedAt,
    stats: {
      products_inserted: run.products_inserted ?? 0,
      products_updated: run.products_updated ?? 0,
      products_skipped: run.products_skipped ?? 0,
      errors: run.errors ?? 0,
      deactivated_stale: deactivate_stale ? deactivatedStale : undefined,
    },
  };
  res.json(response);
});

// ==================== POST /dry-run ====================

router.post('/dry-run', requireIngestAuth, async (req: Request, res: Response) => {
  const supabase = getSupabase();
  if (!supabase) {
    res.status(500).json({ ok: false, error: 'Supabase unavailable', code: 'INTERNAL_ERROR' });
    return;
  }

  const parsed = IngestDryRunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'Validation failed',
      code: 'VALIDATION_FAILED',
      details: parsed.error.flatten(),
    });
    return;
  }

  const { source_network, products } = parsed.data;

  const result: IngestDryRunResponse = {
    ok: true,
    valid_rows: products.length,
    invalid_rows: 0,
    would_insert: 0,
    would_update: 0,
    would_skip_unchanged: 0,
    would_skip_missing_merchant: 0,
    errors: [],
    preview: [],
  };

  const uniqueMerchantIds = Array.from(new Set(products.map((p) => p.source_merchant_id)));
  const { data: merchantRows } = await supabase
    .from('merchants')
    .select('id, source_merchant_id')
    .eq('source_network', source_network)
    .in('source_merchant_id', uniqueMerchantIds);
  const merchantSet = new Set((merchantRows ?? []).map((r) => r.source_merchant_id));

  const { data: existing } = await supabase
    .from('products')
    .select('source_product_id, content_hash')
    .eq('source_network', source_network)
    .in(
      'source_product_id',
      products.map((p) => p.source_product_id)
    );
  const existingMap = new Map((existing ?? []).map((e) => [e.source_product_id, e.content_hash]));

  // Region resolution from a simple in-TS map mirror — approximation for dry-run only.
  // Production server writes and the derivation trigger handles the real mapping.
  const regionGroup = (country: string | undefined): string => {
    if (!country) return 'OTHER';
    const c = country.toUpperCase();
    if (['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE','NO','IS','CH','LI'].includes(c)) return 'EU';
    if (c === 'GB' || c === 'UK') return 'UK';
    if (c === 'US') return 'US';
    if (c === 'CA') return 'CA';
    if (c === 'CN' || c === 'HK' || c === 'MO') return 'APAC_CN';
    return 'OTHER';
  };

  for (const p of products) {
    const merchantResolved = merchantSet.has(p.source_merchant_id);
    const existingHash = existingMap.get(p.source_product_id);
    const contentHash = computeContentHash(p);

    let action: 'insert' | 'update' | 'skip_unchanged' | 'skip_missing_merchant';
    if (!merchantResolved) {
      action = 'skip_missing_merchant';
      result.would_skip_missing_merchant += 1;
      result.errors.push({
        source_product_id: p.source_product_id,
        error: `Merchant not found for source_merchant_id=${p.source_merchant_id}.`,
        field: 'source_merchant_id',
      });
    } else if (existingHash === contentHash) {
      action = 'skip_unchanged';
      result.would_skip_unchanged += 1;
    } else if (existingHash) {
      action = 'update';
      result.would_update += 1;
    } else {
      action = 'insert';
      result.would_insert += 1;
    }

    if (result.preview.length < 10) {
      result.preview.push({
        source_product_id: p.source_product_id,
        derived_origin_region: regionGroup(p.origin_country) as never,
        derived_merchant_resolved: merchantResolved,
        action,
      });
    }
  }

  result.invalid_rows = result.would_skip_missing_merchant;
  result.ok = result.errors.length === 0;

  res.json(result);
});

// ==================== GET /health ====================

router.get('/health', async (_req: Request, res: Response) => {
  const supabase = getSupabase();
  const dbReady = !!supabase;
  const authKeyPresent = !!(
    process.env.INGEST_API_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE
  );

  let tablesPresent = false;
  if (supabase) {
    const { error } = await supabase.from('catalog_sources').select('run_id').limit(1);
    tablesPresent = !error;
  }

  res.json({
    ok: dbReady && authKeyPresent && tablesPresent,
    vtid: 'VTID-02000',
    checks: {
      supabase_ready: dbReady,
      ingest_auth_configured: authKeyPresent,
      catalog_sources_reachable: tablesPresent,
    },
  });
});

export default router;
