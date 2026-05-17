/**
 * VTID-03025: parity coverage between `tool-manifest.json` (live tools)
 * and `livekit_test_cases` (tests covering those tools).
 *
 * The hourly suite must keep parity with the live catalog — as new tools
 * land (50 → 70 → 147 over the next couple of weeks), this endpoint
 * exposes the gap so the Voice LAB panel can flag uncovered tools.
 *
 * "Tested" means the tool name appears in EITHER `expected.tools[]` OR
 * `expected.tools_any[]` on an enabled case row. Cases scoped to
 * `intent: 'free_text'` cover NO tool by definition and are excluded.
 */

import fs from 'fs';
import path from 'path';

import { getSupabase } from '../../lib/supabase';

export interface ToolManifestEntry {
  name: string;
  surface?: string;
  category?: string;
  status?: 'live' | 'wip' | 'planned' | string;
  description?: string;
  wired_in?: string[];
  role?: string[];
  owner_vtid?: string | null;
}

interface ToolManifestFile {
  generated_at?: string;
  total?: number;
  tools: ToolManifestEntry[];
}

export interface CoverageReport {
  manifest_generated_at: string | null;
  manifest_total: number;
  live_total: number;
  tested_total: number;
  uncovered_total: number;
  coverage_pct: number;
  surfaces: Array<{ surface: string; live: number; tested: number }>;
  uncovered: Array<{ name: string; surface: string; wired_in: string[] }>;
  // Tests whose tool names aren't in the manifest live set — informative
  // (e.g. `get_life_compass` exists in the catalog but not in this manifest).
  orphan_tested: string[];
}

let cached: { manifest: ToolManifestFile; loadedAt: number } | null = null;
const MANIFEST_TTL_MS = 60_000;

/**
 * Read `tool-manifest.json` from disk with a 60s cache. The file lives at
 * `services/gateway/src/services/tool-manifest.json` and is copied to
 * `dist/services/tool-manifest.json` by the build's `copy-data` step.
 */
export function loadToolManifest(): ToolManifestFile {
  if (cached && Date.now() - cached.loadedAt < MANIFEST_TTL_MS) {
    return cached.manifest;
  }
  // __dirname at runtime is .../dist/services/voice-lab/ — go up one to
  // reach .../dist/services/tool-manifest.json. In dev (tsx) __dirname
  // points at src/, where the file sits one level up too.
  const candidates = [
    path.resolve(__dirname, '..', 'tool-manifest.json'),
    path.resolve(__dirname, '..', '..', 'services', 'tool-manifest.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw) as ToolManifestFile;
        cached = { manifest: parsed, loadedAt: Date.now() };
        return parsed;
      }
    } catch {
      // try the next candidate
    }
  }
  // Fail open with empty manifest so the endpoint can still respond.
  return { tools: [] };
}

/**
 * Compute parity coverage by joining the manifest live-tool set with the
 * union of `expected.tools[]` + `expected.tools_any[]` across all enabled
 * test cases.
 */
export async function getCoverage(): Promise<CoverageReport> {
  const sb = getSupabase();
  if (!sb) throw new Error('getCoverage: Supabase client not configured');

  const manifest = loadToolManifest();
  const liveTools = manifest.tools.filter((t) => t.status === 'live');

  const { data: rows, error } = await sb
    .from('livekit_test_cases')
    .select('expected, enabled')
    .eq('enabled', true);
  if (error) throw new Error(`getCoverage: ${error.message}`);

  const tested = new Set<string>();
  for (const row of rows ?? []) {
    const exp = (row as { expected?: unknown }).expected as Record<string, unknown> | null;
    if (!exp || typeof exp !== 'object') continue;
    const tools = exp.tools;
    const toolsAny = (exp as Record<string, unknown>).tools_any;
    if (Array.isArray(tools)) for (const t of tools) if (typeof t === 'string') tested.add(t);
    if (Array.isArray(toolsAny)) for (const t of toolsAny) if (typeof t === 'string') tested.add(t);
  }

  const liveNames = new Set(liveTools.map((t) => t.name));

  const uncovered = liveTools
    .filter((t) => !tested.has(t.name))
    .map((t) => ({
      name: t.name,
      surface: t.surface ?? '',
      wired_in: t.wired_in ?? [],
    }));

  const orphanTested = Array.from(tested).filter((t) => !liveNames.has(t));

  // Per-surface aggregation.
  const surfaceCounts = new Map<string, { live: number; tested: number }>();
  for (const t of liveTools) {
    const s = t.surface ?? '(none)';
    const entry = surfaceCounts.get(s) ?? { live: 0, tested: 0 };
    entry.live += 1;
    if (tested.has(t.name)) entry.tested += 1;
    surfaceCounts.set(s, entry);
  }
  const surfaces = Array.from(surfaceCounts.entries())
    .map(([surface, counts]) => ({ surface, ...counts }))
    .sort((a, b) => b.live - a.live);

  const testedLiveCount = liveTools.filter((t) => tested.has(t.name)).length;
  const coveragePct = liveTools.length === 0
    ? 0
    : Math.round((testedLiveCount / liveTools.length) * 100);

  return {
    manifest_generated_at: manifest.generated_at ?? null,
    manifest_total: manifest.tools.length,
    live_total: liveTools.length,
    tested_total: testedLiveCount,
    uncovered_total: uncovered.length,
    coverage_pct: coveragePct,
    surfaces,
    uncovered,
    orphan_tested: orphanTested,
  };
}
