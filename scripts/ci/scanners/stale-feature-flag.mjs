/**
 * stale-feature-flag-scanner-v1
 *
 * Feature flags that have been `true` or `false` for >90 days tend to
 * become invisible coupling — code references a flag that everyone has
 * forgotten about. This scanner looks at two flag sources:
 *
 *   1. dev_autopilot_config row (read from Supabase via the gateway's
 *      REST endpoint when SUPABASE_URL + SUPABASE_SERVICE_ROLE are set).
 *   2. Environment-variable-driven flags in source code (AUTOPILOT_*,
 *      EXECUTION_*, VTID_*) — if none of them have been touched in the
 *      last 90 days by commit, they're probably stale.
 *
 * This scanner runs in CI where `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE`
 * may not be available, so the DB-based check is best-effort.
 */

import fs from 'node:fs';
import path from 'node:path';
import { walk, readFileSafe, relFromRepo } from './_shared.mjs';

export const meta = {
  scanner: 'stale-feature-flag-scanner-v1',
  signal_type: 'stale_flag',
};

const STALE_DAYS = Number.parseInt(process.env.STALE_FLAG_DAYS || '90', 10);

async function checkDbFlags() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE;
  if (!url || !key) return [];
  try {
    const res = await fetch(`${url}/rest/v1/dev_autopilot_config?id=eq.1&limit=1`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return [];
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return [];
    const cfg = rows[0];
    const updatedAt = cfg.updated_at ? new Date(cfg.updated_at) : null;
    if (!updatedAt) return [];
    const daysOld = (Date.now() - updatedAt.getTime()) / 86_400_000;
    if (daysOld < STALE_DAYS) return [];
    // Look at the boolean / array flags specifically
    const stale = [];
    const candidates = [
      'kill_switch',
      'auto_approve_enabled',
    ];
    for (const c of candidates) {
      if (c in cfg) {
        stale.push({ name: c, value: cfg[c], daysOld: Math.round(daysOld) });
      }
    }
    return stale;
  } catch { return []; }
}

export async function run({ repoRoot }) {
  const signals = [];

  // DB-side check
  const staleDb = await checkDbFlags();
  if (staleDb.length > 0) {
    signals.push({
      type: 'stale_flag',
      severity: 'low',
      file_path: 'supabase/migrations/20260416100000_dev_autopilot.sql',
      line_number: 1,
      message: `dev_autopilot_config has not been updated in >${STALE_DAYS} days. Current flag state: ${staleDb.map(s => `${s.name}=${s.value}`).join(', ')}.`,
      suggested_action: `Review the autopilot config: are these flag values still correct, or can any be removed? If removal is safe, delete the column in a follow-up migration.`,
      scanner: 'stale-feature-flag-scanner-v1',
      raw: { flags: staleDb },
    });
  }

  // Source-side check — look for `process.env.X` references that read flag-shaped vars.
  // If a var is referenced in code but never mentioned in deploy configs (.github/workflows,
  // docker-compose.yml) that's a candidate for "dead flag in code".
  const srcRoots = ['services/gateway/src', 'services/autopilot-worker/src'];
  const envReferences = new Map(); // var -> first file/line
  for (const root of srcRoots) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
      if (/\.(test|spec)\.(ts|tsx|js|mjs)$/.test(file)) continue;
      const src = readFileSafe(file);
      if (!src) continue;
      const re = /process\.env\.([A-Z][A-Z0-9_]+)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const v = m[1];
        if (!/_(ENABLED|ENABLE|DISABLED|DRY_RUN|KILL|DEBUG|VERBOSE|OWNS_PR|USE_WORKER|LOOP)$/.test(v)
            && !/^(EXECUTION_DISARMED|AUTOPILOT_LOOP_ENABLED|VTID_ALLOCATOR_ENABLED)$/.test(v)) continue;
        if (envReferences.has(v)) continue;
        const lineNumber = src.slice(0, m.index).split('\n').length;
        envReferences.set(v, { file: relFromRepo(repoRoot, file), line: lineNumber });
      }
    }
  }

  // Cross-check against where vars are SET (deploy configs, workflows, .env.example)
  const configRoots = ['.github/workflows', 'services/gateway'];
  const mentioned = new Set();
  for (const root of configRoots) {
    const abs = path.join(repoRoot, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      if (!/\.(yml|yaml|env|env\.example|json|sh|md|toml)$/.test(file) && !/\.env/.test(path.basename(file))) continue;
      const src = readFileSafe(file);
      if (!src) continue;
      for (const v of envReferences.keys()) {
        if (new RegExp(`\\b${v}\\b`).test(src)) mentioned.add(v);
      }
    }
  }

  for (const [v, loc] of envReferences) {
    if (mentioned.has(v)) continue;
    signals.push({
      type: 'stale_flag',
      severity: 'low',
      file_path: loc.file,
      line_number: loc.line,
      message: `Feature-flag env var \`${v}\` is read in ${loc.file}:${loc.line} but never set in any .github/workflows/* or .env* file.`,
      suggested_action: `Either delete the flag (code path is dead) OR add it to the deploy config explicitly so it isn't implicit-undefined in production.`,
      scanner: 'stale-feature-flag-scanner-v1',
      raw: { env_var: v, referenced_in: loc },
    });
  }

  return signals;
}
