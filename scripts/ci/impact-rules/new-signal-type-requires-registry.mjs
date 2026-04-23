/**
 * new-signal-type-requires-registry
 *
 * Guards the invariant: if services/gateway/src/services/dev-autopilot-synthesis.ts
 * gained a new value in its SignalType union, scripts/ci/scanners/registry.mjs
 * must ALSO have been updated with the scanner that emits it — otherwise
 * scans work but the Command Hub Scanners tab shows an orphan.
 *
 * Heuristic:
 *   - Extract all `| 'foo'` lines added to the diff in dev-autopilot-synthesis.ts.
 *   - For each added union value, check that scripts/ci/scanners/registry.mjs
 *     was ALSO touched in this PR.
 *   - (Coarse: we don't try to verify the exact scanner row exists — the
 *     'new-scanner-needs-seed-migration' rule covers the DB side.)
 */

import { extractAddedLines } from './_shared.mjs';

export const meta = {
  rule: 'new-signal-type-requires-registry',
  category: 'companion',
  severity: 'blocker',
};

export async function check({ diff, changedFiles }) {
  const synthTouched = changedFiles.some(f => f.path === 'services/gateway/src/services/dev-autopilot-synthesis.ts');
  if (!synthTouched) return [];

  // Added union values: lines matching `  | 'foo'`
  const added = extractAddedLines(diff, /services\/gateway\/src\/services\/dev-autopilot-synthesis\.ts$/);
  const newTypes = [];
  for (const l of added) {
    const m = /^\s*\|\s*'([a-z_][a-z0-9_]*)'/.exec(l.text);
    if (m) newTypes.push(m[1]);
  }
  if (newTypes.length === 0) return [];

  const registryTouched = changedFiles.some(f => f.path === 'scripts/ci/scanners/registry.mjs');
  if (registryTouched) return [];

  return [{
    rule: meta.rule,
    severity: meta.severity,
    file_path: 'services/gateway/src/services/dev-autopilot-synthesis.ts',
    line_number: null,
    message: `New SignalType value(s) [${newTypes.join(', ')}] added, but scripts/ci/scanners/registry.mjs was not updated. Scanner registry and synthesis types must evolve together.`,
    suggested_action: `Add corresponding entries to SCANNERS in scripts/ci/scanners/registry.mjs — one per new signal_type — so the Command Hub registry reflects the new detector(s).`,
    raw: { new_signal_types: newTypes },
  }];
}
