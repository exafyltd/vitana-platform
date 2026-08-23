/**
 * routes/testing.ts — Aurora migration B1 data-access seam (VTID-03702,
 * Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * Every Supabase call in routes/testing.ts against its three tables
 * (test_runs, test_cycles, test_results) now goes through here instead of
 * calling `supabase.from(...)` inline. PURE MOVE, not a rewrite: same
 * queries, same columns, same `{ data, error }` shapes — no behavior
 * change today. Mirrors the community-marketplace/universal-cart/
 * vcaop-portal repository precedents from the same workstream.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ==================== test_runs ====================

export async function fetchRuns(supabase: SupabaseClient, type: string, offset: number, limit: number) {
  return supabase
    .from('test_runs')
    .select('*')
    .eq('type', type)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
}

export async function fetchRunById(supabase: SupabaseClient, id: string) {
  return supabase.from('test_runs').select('*').eq('id', id).single();
}

export async function insertRun(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('test_runs').insert(row).select().single();
}

export async function updateRun(supabase: SupabaseClient, runId: string, fields: Record<string, unknown>) {
  return supabase.from('test_runs').update(fields).eq('id', runId);
}

// ==================== test_results ====================

export async function fetchResultsForRun(supabase: SupabaseClient, runId: string) {
  return supabase
    .from('test_results')
    .select('*')
    .eq('run_id', runId)
    .order('project', { ascending: true })
    .order('test_name', { ascending: true });
}

export async function insertTestResultsBatch(supabase: SupabaseClient, rows: Record<string, unknown>[]) {
  return supabase.from('test_results').insert(rows);
}

// ==================== test_cycles ====================

export async function fetchCycles(supabase: SupabaseClient) {
  return supabase.from('test_cycles').select('*').order('created_at', { ascending: true });
}

export async function insertCycle(supabase: SupabaseClient, row: Record<string, unknown>) {
  return supabase.from('test_cycles').insert(row).select().single();
}

export async function fetchCycleById(supabase: SupabaseClient, id: string) {
  return supabase.from('test_cycles').select('*').eq('id', id).single();
}

export async function updateCycle(supabase: SupabaseClient, cycleId: string, fields: Record<string, unknown>) {
  return supabase.from('test_cycles').update(fields).eq('id', cycleId);
}
