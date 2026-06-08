/**
 * Session B (orb-live-refactor): structural guard — no production call site
 * is allowed to switch to LiveKit yet.
 *
 * This test is intentionally narrow:
 *   - The only files in `services/gateway/src/` that may reference
 *     `LiveKitLiveClient` are the skeleton itself and the provider-selection
 *     seam.
 *   - `routes/orb-live.ts` (the Vertex call site) must NOT import the
 *     skeleton or the selection layer.
 *   - The selection seam itself must continue to default to vertex.
 *
 * If a future PR wires LiveKit into a real session, that PR should DELETE
 * this test (or split it) as part of the wiring step — not just amend the
 * allow-list silently.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  selectUpstreamProvider,
} from '../../../../src/orb/live/upstream/provider-selection';

const SRC_ROOT = path.resolve(__dirname, '../../../../src');

const ALLOWED_SRC_IMPORTERS = new Set([
  path.join(SRC_ROOT, 'orb/live/upstream/livekit-live-client.ts'),
  path.join(SRC_ROOT, 'orb/live/upstream/provider-selection.ts'),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip generated / vendored dirs.
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      out.push(...walk(full));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('LiveKit production wiring guard', () => {
  it('no production src file outside the upstream seam imports LiveKitLiveClient', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_ROOT)) {
      if (ALLOWED_SRC_IMPORTERS.has(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('LiveKitLiveClient')) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('routes/orb-live.ts does not import the upstream selection seam (still uses inline connectToLiveAPI)', () => {
    const file = path.join(SRC_ROOT, 'routes/orb-live.ts');
    const text = fs.readFileSync(file, 'utf8');

    // The seam ships ahead of the call-site swap. When the swap lands,
    // delete these assertions in the same PR that wires it.
    expect(text).not.toMatch(/from\s+['"][^'"]*upstream\/provider-selection['"]/);
    expect(text).not.toMatch(/from\s+['"][^'"]*upstream\/livekit-live-client['"]/);
    expect(text).not.toMatch(/createUpstreamLiveClient/);
    expect(text).not.toMatch(/selectUpstreamProvider/);
  });

  it('default selection (no env override) is vertex — production rollouts cannot accidentally pick LiveKit', () => {
    expect(selectUpstreamProvider({}).provider).toBe('vertex');
  });
});
