#!/usr/bin/env node
// VTID-05167: prints the activity_catalog seed (SQL) generated from
// services/gateway/src/services/timeline/timeline-catalog.json. The migration
// carries this block verbatim between the GENERATED markers; the parity test
// (services/gateway/test/vtid-05167-timeline-catalog.test.ts) regenerates it
// and fails if the migration and the JSON disagree.
// Usage: node scripts/timeline/generate-activity-catalog-seed.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = path.join(here, '../../services/gateway/src/services/timeline/timeline-catalog.json');

export function renderSeed(catalog) {
  const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const arr = (a) => (a.length ? `ARRAY[${a.map(q).join(', ')}]::text[]` : `'{}'::text[]`);
  const rows = catalog.entries.map(
    (e) =>
      `  (${[q(e.type), q(e.match), q(e.tier), q(e.category), q(e.topic), q(e.pillar), q(e.secondary_pillar), q(e.icon), q(e.sensitivity), q(e.summary_key), arr(e.params)].join(', ')})`,
  );
  return [
    'INSERT INTO public.activity_catalog',
    '  (activity_type, match, tier, category, topic, pillar, secondary_pillar, icon, sensitivity, summary_key, params)',
    'VALUES',
    rows.join(',\n'),
    'ON CONFLICT (activity_type) DO UPDATE SET',
    '  match = EXCLUDED.match, tier = EXCLUDED.tier, category = EXCLUDED.category, topic = EXCLUDED.topic,',
    '  pillar = EXCLUDED.pillar, secondary_pillar = EXCLUDED.secondary_pillar, icon = EXCLUDED.icon,',
    '  sensitivity = EXCLUDED.sensitivity, summary_key = EXCLUDED.summary_key, params = EXCLUDED.params,',
    '  updated_at = now();',
    `DELETE FROM public.activity_catalog WHERE activity_type NOT IN (${catalog.entries.map((e) => q(e.type)).join(', ')});`,
  ].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.stdout.write(renderSeed(JSON.parse(readFileSync(jsonPath, 'utf8'))) + '\n');
}
