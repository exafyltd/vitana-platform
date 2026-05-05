/**
 * Dev Docs API (R8 from Phase 3b plan)
 *
 * Serves an allowlisted set of markdown spec/decision docs from this repo to
 * the in-app Command Hub doc viewer (vitana-v1 /dev/docs/backlog, R7).
 *
 * Auth: requires developer role or Exafy super-admin (matches Command Hub
 * gating from #351). Path-traversal protected by an explicit filename
 * allowlist — do NOT proxy arbitrary paths.
 *
 * Implementation note: reads from process.cwd()/specs at runtime. The build
 * pipeline must include the specs/ tree in the gateway image (see Dockerfile).
 */

import { Router, Request, Response } from 'express';
import * as fs from 'fs/promises';
import * as path from 'path';

export const devDocsRouter = Router();

// Allowlist — only these filenames are servable. Add new docs here as needed.
const SPECS_ALLOWLIST = new Set<string>([
  'release-backlog-overview.md',
  'release-backlog-spec-decisions.md',
]);

const SPECS_DIR_CANDIDATES = [
  path.resolve(process.cwd(), 'specs'),
  path.resolve(process.cwd(), '../../specs'),
  '/app/specs',
];

async function findSpecsDir(): Promise<string | null> {
  for (const candidate of SPECS_DIR_CANDIDATES) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function isAuthorized(req: Request): boolean {
  const user = (req as { user?: Record<string, unknown> }).user ?? null;
  if (!user) return false;
  if (Boolean(user.is_exafy_admin)) return true;
  return (user.role as string | undefined) === 'developer';
}

devDocsRouter.get('/api/v1/docs/specs/:filename', async (req: Request, res: Response) => {
  try {
    if (!isAuthorized(req)) {
      return res.status(403).json({ ok: false, error: 'Developer or super-admin required' });
    }
    const filename = req.params.filename;

    // Defense in depth: reject anything that's not a bare filename or not on the allowlist.
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
      return res.status(400).json({ ok: false, error: 'Invalid filename' });
    }
    if (!SPECS_ALLOWLIST.has(filename)) {
      return res.status(404).json({ ok: false, error: 'File not in allowlist' });
    }

    const specsDir = await findSpecsDir();
    if (!specsDir) {
      return res.status(500).json({ ok: false, error: 'specs/ directory not found in deploy image' });
    }

    const fullPath = path.join(specsDir, filename);
    // Final safety: ensure the resolved path is still within specsDir
    if (!fullPath.startsWith(specsDir + path.sep) && fullPath !== path.join(specsDir, filename)) {
      return res.status(400).json({ ok: false, error: 'Path escape attempted' });
    }

    const content = await fs.readFile(fullPath, 'utf-8');
    res.set('Content-Type', 'text/markdown; charset=utf-8');
    res.set('Cache-Control', 'private, max-age=60');
    return res.status(200).send(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ ok: false, error: message });
  }
});

devDocsRouter.get('/api/v1/docs/specs', (req: Request, res: Response) => {
  if (!isAuthorized(req)) {
    return res.status(403).json({ ok: false, error: 'Developer or super-admin required' });
  }
  return res.status(200).json({ ok: true, allowlist: Array.from(SPECS_ALLOWLIST).sort() });
});
