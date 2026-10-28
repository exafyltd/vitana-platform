/**
 * OASIS Specs — serves the static spec JSON files under `services/gateway/specs/`
 * to the Command Hub docs UI. Before this router existed, the frontend call to
 * `/api/v1/oasis/specs/dev-screen-inventory` returned HTML 404 because no
 * backend handler was mounted, causing the "Error: Network response was not ok"
 * banner on the Docs → Screens tab.
 *
 * Endpoints:
 *   GET /api/v1/oasis/specs                          — list available specs
 *   GET /api/v1/oasis/specs/dev-screen-inventory     — the dev screen inventory
 *
 * The spec is wrapped in `{ ok: true, data: <spec> }` to match the shape the
 * frontend renderer (renderDocsScreensView → state.screenInventory) expects.
 *
 * No auth: these specs describe the platform surface and are already served to
 * authenticated Command Hub users. Public read aligns with the other
 * `/api/v1/oasis/*` operator endpoints that serve catalog-like data.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();

// Whitelist of supported spec keys → filenames (relative to services/gateway/specs/).
const SPEC_FILES: Record<string, string> = {
  'dev-screen-inventory': 'dev-screen-inventory-v1.json',
};

function specsDir(): string {
  // dist/routes/oasis-specs.js runs out of services/gateway/dist/; specs live
  // in services/gateway/specs/ (two dirs up from dist/routes).
  return path.resolve(__dirname, '..', '..', 'specs');
}

router.get('/', (_req: Request, res: Response) => {
  return res.status(200).json({
    ok: true,
    data: {
      available: Object.keys(SPEC_FILES),
    },
  });
});

router.get('/:specKey', (req: Request, res: Response) => {
  const key = req.params.specKey;
  const filename = SPEC_FILES[key];
  if (!filename) {
    return res.status(404).json({ ok: false, error: 'UNKNOWN_SPEC', key });
  }
  const fullPath = path.join(specsDir(), filename);
  try {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const data = JSON.parse(raw);
    return res.status(200).json({ ok: true, data });
  } catch (err: any) {
    console.error(`[oasis-specs] failed to read ${fullPath}:`, err.message);
    return res.status(500).json({ ok: false, error: 'SPEC_READ_FAILED' });
  }
});

export default router;
