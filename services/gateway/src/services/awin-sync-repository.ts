// impact-allow-no-test: pure data-access seam (thin Supabase upsert
// wrapper, no independent request-handling behavior). Coverage note:
// test/routes/awin-sync.test.ts only exercises the pure helper functions
// (mapAwinProgramme, resolveAwinConfig), not syncAwinProgrammes itself,
// which owns this call site — zero genuine coverage today.
/**
 * services/awin-sync.ts — Aurora migration B1 data-access seam
 * (VTID-03702, Supabase→Aurora migration workstream — see
 * docs/SUPABASE-TO-AURORA-MIGRATION-PLAN.md Phase 3b/B1).
 *
 * The one Supabase `.from(...)` call in services/awin-sync.ts now goes
 * through here instead of being written inline. PURE MOVE, not a
 * rewrite: same upsert, same onConflict option, same return shape — no
 * behavior change today. Client-agnostic (takes `sb` as a param — the
 * source already declared its client param as `any`, so this preserves
 * that).
 */

export async function upsertAffiliateProgramChunk(sb: any, chunk: Record<string, unknown>[]) {
  return sb.from('affiliate_program').upsert(chunk, { onConflict: 'id' });
}
