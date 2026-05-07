/**
 * VTID-02766 — Voice Tools Catalog (Command Hub > Assistant > Voice Tools).
 *
 * Read-only catalog of every voice tool the ORB exposes. Source of truth
 * is `services/gateway/src/services/tool-manifest.json` — a hand-curated
 * (initially) JSON file enumerating each tool with its metadata. Future
 * iterations will replace this with an AST-extractor that parses
 * orb-live.ts + orb-tool.ts at build time.
 *
 * Endpoints (all developer-tier — gated by middleware on the mount path):
 *   GET  /api/v1/voice-tools/catalog
 *   GET  /api/v1/voice-tools/catalog/:name
 *   GET  /api/v1/voice-tools/catalog/stats
 *
 * Privacy / role-gating: the catalog itself is dev-only; community/mobile
 * sessions never reach this route. The mount in index.ts uses the same
 * pattern as voice-lab.
 */

import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs';

const router = Router();
const VTID = 'VTID-02766';

interface ToolEntry {
  name: string;
  surface: string;
  category: string;
  role: string[];          // ['community'], ['developer'], etc.
  status: 'live' | 'wip' | 'planned';
  vtid?: string;           // VTID where the tool was added
  description: string;
  parameters?: Record<string, unknown>;
  backing_endpoint?: string;
  added_in_pr?: number;
}

interface ToolManifest {
  generated_at: string;
  source: 'manual' | 'ast-extracted';
  total: number;
  tools: ToolEntry[];
}

let cachedManifest: ToolManifest | null = null;

function loadManifest(): ToolManifest {
  if (cachedManifest) return cachedManifest;
  const manifestPath = path.join(__dirname, '../services/tool-manifest.json');
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    cachedManifest = JSON.parse(raw) as ToolManifest;
  } catch (err: any) {
    console.warn(`[${VTID}] tool-manifest.json missing — returning empty catalog: ${err?.message}`);
    cachedManifest = { generated_at: new Date().toISOString(), source: 'manual', total: 0, tools: [] };
  }
  return cachedManifest;
}

// ---------------------------------------------------------------------------
// GET /catalog — paginated list with filters
// ---------------------------------------------------------------------------

router.get('/catalog', (req: Request, res: Response) => {
  const m = loadManifest();
  const surface = (req.query.surface as string | undefined)?.toLowerCase();
  const role = (req.query.role as string | undefined)?.toLowerCase();
  const status = (req.query.status as string | undefined)?.toLowerCase();
  const q = (req.query.q as string | undefined)?.toLowerCase();
  const limit = Math.max(1, Math.min(200, parseInt(String(req.query.limit ?? '50'), 10) || 50));
  const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

  let filtered = m.tools;
  if (surface) filtered = filtered.filter((t) => t.surface.toLowerCase() === surface);
  if (role) filtered = filtered.filter((t) => t.role.map((r) => r.toLowerCase()).includes(role));
  if (status) filtered = filtered.filter((t) => t.status === status);
  if (q) {
    filtered = filtered.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.description.toLowerCase().includes(q),
    );
  }

  const page = filtered.slice(offset, offset + limit);
  return res.json({
    ok: true,
    total: filtered.length,
    grand_total: m.total,
    offset,
    limit,
    generated_at: m.generated_at,
    source: m.source,
    tools: page,
  });
});

// ---------------------------------------------------------------------------
// GET /catalog/stats — aggregate counts for header strip
// ---------------------------------------------------------------------------

router.get('/catalog/stats', (_req: Request, res: Response) => {
  const m = loadManifest();
  const bySurface: Record<string, number> = {};
  const byRole: Record<string, number> = {};
  const byStatus: Record<string, number> = { live: 0, wip: 0, planned: 0 };
  for (const t of m.tools) {
    bySurface[t.surface] = (bySurface[t.surface] ?? 0) + 1;
    for (const r of t.role) byRole[r] = (byRole[r] ?? 0) + 1;
    byStatus[t.status] = (byStatus[t.status] ?? 0) + 1;
  }
  return res.json({
    ok: true,
    total: m.total,
    by_surface: bySurface,
    by_role: byRole,
    by_status: byStatus,
    generated_at: m.generated_at,
    source: m.source,
  });
});

// ---------------------------------------------------------------------------
// GET /catalog/:name — single tool detail
// ---------------------------------------------------------------------------

router.get('/catalog/:name', (req: Request, res: Response) => {
  const m = loadManifest();
  const tool = m.tools.find((t) => t.name === req.params.name);
  if (!tool) return res.status(404).json({ ok: false, error: 'tool_not_found', vtid: VTID });
  return res.json({ ok: true, tool });
});

// ---------------------------------------------------------------------------
// GET /health — service health
// ---------------------------------------------------------------------------

router.get('/health', (_req: Request, res: Response) => {
  const m = loadManifest();
  return res.json({ ok: true, total: m.total, source: m.source, vtid: VTID });
});

export default router;
